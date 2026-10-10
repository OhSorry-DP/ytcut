import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'BtbN/FFmpeg-Builds';
const BRANCH = '9.0';
const API_URL = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest';
const ZIP_NAME = 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip';
const CHECKSUM_NAME = 'checksums.sha256';
const MAX_ZIP = 512 * 1024 * 1024;
const MAX_EXE = 256 * 1024 * 1024;
const MAX_CHECKSUM = 256 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_LIST = 1024 * 1024;
const MAX_ENTRIES = 4096;
const API_HOST = 'api.github.com';
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw toolError('DISCOVER', '릴리즈 주소를 확인하지 못했습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw toolError('DISCOVER', '허용되지 않은 릴리즈 주소입니다.');
  if (kind === 'api' && (url.hostname !== API_HOST || url.pathname !== '/repos/BtbN/FFmpeg-Builds/releases/tags/latest')) throw toolError('DISCOVER', '허용되지 않은 API 주소입니다.');
  if (kind === 'asset' && (url.hostname !== 'github.com' || !url.pathname.startsWith('/BtbN/FFmpeg-Builds/releases/download/'))) throw toolError('DISCOVER', '허용되지 않은 자산 주소입니다.');
  if (kind === 'redirect' && !(DOWNLOAD_HOSTS.has(url.hostname) || (url.hostname.endsWith('.objects.githubusercontent.com') && url.hostname.length > '.objects.githubusercontent.com'.length))) throw toolError('DISCOVER', '허용되지 않은 다운로드 주소입니다.');
  return url;
}

function readResponse(response, limit, label) {
  if (!response || response.ok === false) throw toolError('DISCOVER', `${label}을(를) 가져오지 못했습니다.`);
  if (typeof response.text === 'function') return response.text().then((text) => {
    if (Buffer.byteLength(text) > limit) throw toolError('VERIFY', `${label} 크기가 제한을 넘었습니다.`);
    return text;
  });
  if (typeof response.arrayBuffer === 'function') return response.arrayBuffer().then((data) => {
    if (data.byteLength > limit) throw toolError('VERIFY', `${label} 크기가 제한을 넘었습니다.`);
    return Buffer.from(data);
  });
  throw toolError('DISCOVER', `${label} 응답을 읽을 수 없습니다.`);
}

function parseChecksum(text, assetName) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CHECKSUM) throw toolError('VERIFY', '체크섬 파일 형식이 올바르지 않습니다.');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const hits = lines.filter((line) => new RegExp(`^([a-fA-F0-9]{64}) [ *]${assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(line));
  if (hits.length !== 1) throw toolError('VERIFY', '체크섬 파일 형식을 확인할 수 없습니다.');
  return hits[0].slice(0, 64).toLowerCase();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseVersion(text) {
  const match = /^ffmpeg version n?9\.0(?:[.+-][^\s]*)?/.exec(text.trim());
  if (!match || !text.includes('--enable-gpl') || !text.includes('--enable-libx264')) return null;
  return match[0].replace(/^ffmpeg version /, '');
}

function createFfmpegDescriptor({ fetch, spawn, fs, clock = () => new Date(), platform = process.platform, arch = process.arch, stageRoot }) {
  if (typeof fetch !== 'function' || typeof spawn !== 'function' || !fs || typeof stageRoot !== 'string' || !path.isAbsolute(stageRoot)) throw new TypeError('필수 의존성과 절대 임시 경로를 전달해야 합니다.');

  function assertPlatform() {
    if (platform !== 'win32' || arch !== 'x64') throw toolError('UNSUPPORTED_PLATFORM', '이 환경은 관리형 ffmpeg 설치를 지원하지 않습니다.');
  }

  async function probe(file) {
    assertPlatform();
    const run = (args) => new Promise((resolve) => {
      let child;
      try { child = spawn(file, args, { shell: false, windowsHide: true }); } catch { resolve(null); return; }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.once('error', () => { clearTimeout(timer); resolve(null); });
      child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 ? stdout + stderr : null); });
    });
    const versionOutput = await run(['-version']);
    const version = versionOutput && parseVersion(versionOutput);
    if (!version) return { usable: false, version: null, capabilities: [] };
    const encoderOutput = await run(['-encoders']);
    if (!encoderOutput || !/(?:^|\s)V?\.{1,3}\s+libx264\s/m.test(encoderOutput) && !/\blibx264\b/.test(encoderOutput)) return { usable: false, version, capabilities: [] };
    return { usable: true, version, capabilities: ['libx264', 'gpl'] };
  }

  async function discover({ consume } = {}) {
    assertPlatform();
    const apiURL = safeUrl(API_URL, 'api').href;
    const jsonText = typeof consume === 'function'
      ? await consume(apiURL, true, response => readResponse(response, MAX_JSON, '릴리즈 정보'), { limit: MAX_JSON })
      : await readResponse(await fetch(apiURL, { headers: { accept: 'application/vnd.github+json' }, redirect: 'error' }), MAX_JSON, '릴리즈 정보');
    if (typeof jsonText !== 'string') throw toolError('DISCOVER', '릴리즈 정보를 읽을 수 없습니다.');
    let release;
    try { release = JSON.parse(jsonText); } catch { throw toolError('DISCOVER', '릴리즈 정보 형식이 올바르지 않습니다.'); }
    if (!Array.isArray(release.assets)) throw toolError('DISCOVER', '릴리즈 자산을 확인할 수 없습니다.');
    const packageAsset = release.assets.filter((asset) => asset.name === ZIP_NAME);
    const checksumAsset = release.assets.filter((asset) => asset.name === CHECKSUM_NAME);
    if (packageAsset.length !== 1 || checksumAsset.length !== 1) throw toolError('DISCOVER', '필수 릴리즈 자산을 확인할 수 없습니다.');
    const asset = packageAsset[0];
    const checksum = checksumAsset[0];
    if (!Number.isSafeInteger(asset.id) || !Number.isSafeInteger(checksum.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ZIP || typeof asset.updated_at !== 'string' || typeof checksum.updated_at !== 'string') throw toolError('DISCOVER', '릴리즈 자산 정보가 올바르지 않습니다.');
    const assetURL = safeUrl(asset.browser_download_url, 'asset').href;
    let checksumText;
    if (typeof consume === 'function') checksumText = await consume(safeUrl(checksum.browser_download_url, 'asset').href, false, response => readResponse(response, MAX_CHECKSUM, '체크섬 파일'), { limit: MAX_CHECKSUM });
    else {
      const checksumResponse = await fetch(safeUrl(checksum.browser_download_url, 'asset').href);
      checksumText = await readResponse(checksumResponse, MAX_CHECKSUM, '체크섬 파일');
    }
    if (Buffer.isBuffer(checksumText)) checksumText = checksumText.toString('utf8');
    const packageSha256 = parseChecksum(checksumText, ZIP_NAME);
    const candidateId = digest(`${asset.id}\n${asset.updated_at}\n${asset.size}\n${packageSha256}`);
    return { repo: REPO, channel: 'release', releaseTag: release.tag_name, releasePublishedAt: release.published_at || null, assetId: asset.id, assetName: ZIP_NAME, assetUpdatedAt: asset.updated_at, downloadBytes: asset.size, checksumAsset: { id: checksum.id, name: CHECKSUM_NAME, updatedAt: checksum.updated_at }, packageSha256, candidateId, downloadURL: assetURL, branch: BRANCH };
  }

  function compare(currentMeta, candidate) {
    if (!currentMeta || !candidate || !currentMeta.assetId || !candidate.assetId) return 'unknown';
    if (String(currentMeta.assetId) === String(candidate.assetId) && currentMeta.packageSha256 === candidate.packageSha256) return 'same';
    const oldTime = Date.parse(currentMeta.assetUpdatedAt);
    const newTime = Date.parse(candidate.assetUpdatedAt);
    if (!Number.isFinite(oldTime) || !Number.isFinite(newTime) || oldTime === newTime) return 'unknown';
    return newTime > oldTime ? 'newer' : 'older';
  }

  async function verifyAndStage(packagePath, candidate) {
    assertPlatform();
    if (!candidate || candidate.assetName !== ZIP_NAME || candidate.branch !== BRANCH || !/^[a-f0-9]{64}$/.test(candidate.packageSha256 || '') || !Number.isSafeInteger(candidate.downloadBytes) || candidate.downloadBytes <= 0 || candidate.downloadBytes > MAX_ZIP) throw toolError('VERIFY', '릴리즈 후보를 검증할 수 없습니다.');
    const packageStat = await fs.promises.stat(packagePath);
    if (!packageStat.isFile() || packageStat.size !== candidate.downloadBytes || packageStat.size > MAX_ZIP) throw toolError('VERIFY', '다운로드 파일 크기가 일치하지 않습니다.');
    const packageBuffer = await fs.promises.readFile(packagePath);
    if (digest(packageBuffer) !== candidate.packageSha256) throw toolError('VERIFY', 'ZIP 체크섬이 일치하지 않습니다.');
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const runTar = (args, binary = false) => new Promise((resolve, reject) => {
      let child;
      try { child = spawn(tar, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { reject(toolError('EXTRACT', 'Windows tar를 실행하지 못했습니다.')); return; }
      const chunks = [];
      let size = 0;
      let stderr = '';
      let timer = setTimeout(() => { child.kill(); reject(toolError('EXTRACT', '압축 파일 검사가 시간 제한을 넘었습니다.')); }, 90000);
      child.stdout?.on('data', (chunk) => { size += chunk.length; if (size > (binary ? MAX_EXE : MAX_LIST)) { child.kill(); reject(toolError('EXTRACT', '압축 파일 항목이 제한을 넘었습니다.')); return; } chunks.push(Buffer.from(chunk)); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
      child.once('error', () => { clearTimeout(timer); reject(toolError('EXTRACT', 'Windows tar 실행에 실패했습니다.')); });
      child.once('close', (code) => { clearTimeout(timer); if (code !== 0) reject(toolError('EXTRACT', '압축 파일 처리에 실패했습니다.')); else resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')); });
    });
    const list = await runTar(['-tf', packagePath]);
    const entries = list.split(/\r?\n/).filter(Boolean);
    if (entries.length > MAX_ENTRIES || Buffer.byteLength(list) > MAX_LIST) throw toolError('EXTRACT', '압축 파일 항목 수가 제한을 넘었습니다.');
    const invalid = entries.some((entry) => !entry || entry.includes('\\') || /[\x00-\x1f\x7f]/.test(entry) || entry.startsWith('/') || /^[a-zA-Z]:/.test(entry) || entry.split('/').includes('..'));
    if (invalid || new Set(entries).size !== entries.length) throw toolError('EXTRACT', '안전하지 않은 압축 경로가 있습니다.');
    const targets = entries.filter((entry) => /^[^/]+\/bin\/ffmpeg\.exe$/.test(entry));
    if (targets.length !== 1) throw toolError('EXTRACT', 'ffmpeg 실행 파일 항목을 하나로 확정할 수 없습니다.');
    const verbose = await runTar(['-tvf', packagePath]);
    const verboseLines = verbose.split(/\r?\n/).filter(Boolean);
    const fileLine = verboseLines.filter((line) => line.startsWith('-') && line.trimEnd().endsWith(targets[0]));
    if (fileLine.length !== 1 || verboseLines.length !== entries.length) throw toolError('EXTRACT', '압축 항목 종류를 검증할 수 없습니다.');
    const binary = await runTar(['-xOf', packagePath, targets[0]], true);
    if (binary.length === 0 || binary.length > MAX_EXE) throw toolError('EXTRACT', 'ffmpeg 실행 파일 크기가 제한을 넘었습니다.');
    const root = path.resolve(stageRoot);
    const stageDir = path.resolve(root, `ffmpeg-${candidate.candidateId}`);
    if (!(stageDir.startsWith(root + path.sep))) throw toolError('VERIFY', '임시 설치 경로가 안전하지 않습니다.');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.mkdir(stageDir, { recursive: true });
    const candidateExe = path.join(stageDir, 'candidate.exe');
    await fs.promises.writeFile(candidateExe, binary, { flag: 'wx' });
    const realRoot = await fs.promises.realpath(root);
    const realStage = await fs.promises.realpath(stageDir);
    if (!realStage.startsWith(realRoot + path.sep)) throw toolError('VERIFY', '임시 실행 파일이 지정 경로 밖에 있습니다.');
    const stat = await fs.promises.stat(candidateExe);
    if (!stat.isFile() || stat.size !== binary.length) throw toolError('VERIFY', '임시 실행 파일을 확인할 수 없습니다.');
    const check = await probe(candidateExe);
    if (!check.usable) throw toolError('VERIFY', 'GPL 및 libx264 실행 검증에 실패했습니다.');
    return { candidateExe, binarySha256: digest(binary), packageSha256: candidate.packageSha256, version: check.version, capabilities: check.capabilities };
  }

  return { id: 'ffmpeg', apiURL: API_URL, pathKey: 'ffmpegPath', autoUpdateKey: 'autoUpdateFfmpeg', defaultCommand: 'ffmpeg', branch: BRANCH, probe, discover, compare, verifyAndStage };
}

export { createFfmpegDescriptor };
