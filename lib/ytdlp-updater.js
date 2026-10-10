import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const releaseAPI = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const validVersion = value => typeof value === 'string' && /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(value);
export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) throw new TypeError('Invalid version');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0n, y = right[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
export function parseSums(text) {
  const matches = String(text).split(/\r?\n/).map(line => /^([a-f\d]{64})\s+\*?yt-dlp\.exe\s*$/i.exec(line)).filter(Boolean);
  if (matches.length !== 1) throw new Error('Invalid checksum');
  return matches[0][1].toLowerCase();
}
export function resolveEffectivePath(settings, managedPath, exists) {
  if (settings.ytDlpPath !== 'yt-dlp') return { path: settings.ytDlpPath, source: 'custom' };
  return exists ? { path: managedPath, source: 'managed' } : { path: 'yt-dlp', source: 'path' };
}
export function allowedAsset(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
    (parsed.hostname === 'github.com' || parsed.hostname === 'release-assets.githubusercontent.com' || parsed.hostname === 'objects.githubusercontent.com' || parsed.hostname.endsWith('.objects.githubusercontent.com'));
}
const fault = code => Object.assign(new Error(code), { code });
const messages = {
  NETWORK: '업데이트 정보를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.',
  VERIFY: '업데이트 파일 검증에 실패했습니다. 다시 확인해 주세요.',
  REPLACE: '업데이트 파일을 교체하지 못했습니다. 잠시 후 다시 확인해 주세요.',
  REPLACE_BUSY: '실행 중인 도구가 끝나지 않아 적용을 보류했습니다. 잠시 후 다시 시도해 주세요.',
  EXTRACT: '압축 파일을 안전하게 준비하지 못했습니다.',
  DISCOVER: '업데이트 정보를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.',
  UNSUPPORTED_PLATFORM: '이 환경에서는 관리형 도구 설치를 지원하지 않습니다.',
  REPLACE_RECOVERY_REQUIRED: '도구 복구가 필요합니다. 기존 백업 파일을 보존했습니다.',
  TOOL_NOT_READY: '도구 설치가 끝난 뒤 다시 시도해 주세요.',
};
const now = clock => new Promise(resolve => clock.setTimeout(resolve, 0));

export function createManagedTool(options) {
  const { fetch, spawn, fs, clock = globalThis, jobs = { list: () => [] }, getSettings = () => ({}), managedPath, onChange = () => {}, descriptor, sharedGate, withToolUse } = options;
  if (!fetch || !spawn || !fs || !managedPath) throw new TypeError('필수 관리 도구 옵션이 없습니다.');
  const isDescriptor = Boolean(descriptor);
  const tool = descriptor || {
    id: 'ytDlp', pathKey: 'ytDlpPath', autoUpdateKey: 'autoUpdateYtDlp', defaultCommand: 'yt-dlp',
    probe: async file => { const value = await version(file); return { usable: Boolean(value), version: value, capabilities: [] }; },
    discover: async ({ consume }) => {
      const release = await consume(releaseAPI, true, response => response.json());
      if (!validVersion(release.tag_name) || !Array.isArray(release.assets)) throw fault('NETWORK');
      const binary = release.assets.find(asset => asset.name === 'yt-dlp.exe');
      const sums = release.assets.find(asset => asset.name === 'SHA2-256SUMS');
      if (!binary || !sums || !allowedAsset(binary.browser_download_url) || !allowedAsset(sums.browser_download_url) || !Number.isSafeInteger(Number(binary.size)) || Number(binary.size) <= 0) throw fault('NETWORK');
      const downloadBytes = Number(binary.size);
      const candidateId = createHash('sha256').update(`${binary.id ?? ''}\n${binary.updated_at || ''}\n${downloadBytes}\n${release.tag_name}`).digest('hex');
      return { repo: 'yt-dlp/yt-dlp', channel: 'stable', releaseTag: release.tag_name, releasePublishedAt: release.published_at || null, assetId: binary.id ?? null, assetName: binary.name, assetUpdatedAt: binary.updated_at || null, downloadBytes, candidateId, checksumAsset: { id: sums.id ?? null, name: sums.name }, downloadURL: binary.browser_download_url, checksumURL: sums.browser_download_url, version: release.tag_name };
    },
    compare: (current, candidate) => current?.version && candidate?.version ? (compareVersions(candidate.version, current.version) > 0 ? 'newer' : compareVersions(candidate.version, current.version) < 0 ? 'older' : 'same') : 'unknown',
    verifyAndStage: async (file, candidate) => {
      const digest = await hashFile(file);
      const checksum = await consume(candidate.checksumURL, false, response => response.text());
      if (digest !== parseSums(checksum) || await version(file) !== candidate.version) throw fault('VERIFY');
      return { candidateExe: file, binarySha256: digest, packageSha256: digest, version: candidate.version, capabilities: [] };
    },
  };
  const id = tool.id || 'ytDlp';
  const pathKey = tool.pathKey || 'ytDlpPath';
  const autoUpdateKey = tool.autoUpdateKey || 'autoUpdateYtDlp';
  const defaultCommand = tool.defaultCommand || 'yt-dlp';
  const metaPath = `${managedPath}.meta.json`, backup = `${managedPath}.bak`, backupMeta = `${metaPath}.bak`;
  const temporary = `${managedPath}.download`, metaTemporary = `${metaPath}.tmp`;
  const settingsEpoch = () => JSON.stringify(getSettings()[pathKey] ?? defaultCommand);
  let state = { toolId: id, status: 'idle', source: 'none', usable: false, revision: 0, currentVersion: null, latestVersion: null, currentReleaseTag: null, candidateId: null, downloadBytes: null, downloadedBytes: 0, percent: null, manual: false, needsInstall: false, canDownload: false, canRollback: false, error: null };
  let operation = null, candidate = null, staged = null, stopped = false, firstTimer, interval, progressTimer, activeManual = false, currentController = null, installAttempted = false;
  let executionGate = Promise.resolve();
  const getState = () => structuredClone(state);
  const publish = patch => { state = { ...state, ...patch, revision: state.revision + 1 }; onChange(getState()); };
  const exists = async file => Boolean((await fs.stat(file).catch(() => null))?.isFile());
  const readMeta = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
  const busy = () => jobs.list().some(item => ['running', 'waiting'].includes(item.status));
  const clearProgress = () => { if (progressTimer != null) clock.clearTimeout(progressTimer); progressTimer = null; };
  const discard = async () => { await fs.unlink(temporary).catch(() => {}); if (staged?.candidateExe && staged.candidateExe !== temporary) await fs.unlink(staged.candidateExe).catch(() => {}); staged = null; };
  async function hashFile(file) {
    const data = await fs.readFile(file);
    return createHash('sha256').update(data).digest('hex');
  }
  function version(file) {
    return new Promise(resolve => {
      let child, output = '', settled = false;
      const finish = value => { if (settled) return; settled = true; clock.clearTimeout(timer); resolve(value); };
      const timer = clock.setTimeout(() => { finish(null); child?.kill(); }, 5000);
      try {
        child = spawn(file, isDescriptor ? ['-version'] : ['--version'], { shell: false, windowsHide: true });
        child.stdout?.on('data', chunk => { output = (output + chunk).slice(0, 8192); });
        child.stderr?.on('data', chunk => { if (isDescriptor) output = (output + chunk).slice(0, 8192); });
        child.on('error', () => finish(null));
        child.on('close', code => finish(code === 0 ? output.trim() : null));
      } catch { finish(null); }
    });
  }
  async function request(url, api = false, controller = new AbortController(), mode = {}) {
    const headerTimeout = mode.headerTimeout ?? 30000;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!(api ? url === releaseAPI : allowedAsset(url))) throw fault(isDescriptor ? 'DISCOVER' : 'NETWORK');
      const timer = clock.setTimeout(() => controller.abort(), headerTimeout);
      try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'streamcut', Accept: api ? 'application/vnd.github+json' : 'application/octet-stream' } });
        clock.clearTimeout(timer);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (api) throw fault('NETWORK');
          const location = response.headers.get('location');
          if (!location) throw fault('NETWORK');
          url = new URL(location, url).href; await response.body?.cancel?.(); continue;
        }
        if (!response.ok || (response.url && !(api ? response.url === releaseAPI : allowedAsset(response.url)))) throw fault('NETWORK');
        return response;
      } catch (error) { clock.clearTimeout(timer); if (controller.signal.aborted) throw fault('NETWORK'); throw error; }
    }
    throw fault('NETWORK');
  }
  async function consume(url, api, callback, controller = currentController, mode = {}) {
    const own = controller || new AbortController();
    const response = await request(url, api, own, mode);
    const totalTimer = clock.setTimeout(() => own.abort(), mode.totalTimeout ?? 15 * 60 * 1000);
    try {
      if (mode.stream) return await callback(response);
      if (mode.body === false) return await callback(response);
      // 기존 yt-dlp 주입 응답은 json/text와 다운로드 스트림을 따로 제공한다.
      if (!isDescriptor) {
        const limit = mode.limit ?? 2 * 1024 * 1024;
        return await callback({
          ...response,
          json: async () => {
            const value = await response.json();
            if (Buffer.byteLength(JSON.stringify(value)) > limit) throw fault('VERIFY');
            return value;
          },
          text: async () => {
            const value = await response.text();
            if (Buffer.byteLength(value) > limit) throw fault('VERIFY');
            return value;
          },
        });
      }
      if (!response.body) return await callback(response);
      const chunks = [];
      let size = 0, idleTimer;
      const resetIdle = () => { if (idleTimer != null) clock.clearTimeout(idleTimer); idleTimer = clock.setTimeout(() => own.abort(), mode.idleTimeout ?? 30000); };
      resetIdle();
      try {
        for await (const chunk of response.body) { resetIdle(); chunks.push(Buffer.from(chunk)); size += chunk.length; if (size > (mode.limit ?? 2 * 1024 * 1024)) throw fault('VERIFY'); }
      } finally { if (idleTimer != null) clock.clearTimeout(idleTimer); }
      const data = Buffer.concat(chunks);
      if (mode.binary) return await callback(response, data);
      const wrapped = { ...response, text: async () => data.toString('utf8'), json: async () => JSON.parse(data.toString('utf8')), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
      return await callback(wrapped);
    } finally { clock.clearTimeout(totalTimer); }
  }
  async function probe(file) {
    if (typeof tool.probe === 'function') return tool.probe(file);
    const value = await version(file); return { usable: Boolean(value), version: value, capabilities: [] };
  }
  async function effective() {
    const settings = getSettings();
    const configured = settings[pathKey] ?? defaultCommand;
    if (configured !== defaultCommand) {
      const info = await probe(configured).catch(() => ({ usable: false, version: null, capabilities: [] }));
      return { path: configured, source: 'custom', ...info };
    }
    const managedExists = await exists(managedPath);
    if (managedExists) {
      let meta = await readMeta(metaPath);
      if (meta?.binarySha256) {
        try { if (await hashFile(managedPath) !== meta.binarySha256) meta = null; }
        catch { meta = null; }
      }
      const info = await probe(managedPath).catch(() => ({ usable: false, version: null, capabilities: [] }));
      if (info.usable) return { path: managedPath, source: 'managed', ...info, meta };
      // 실행 불가인 관리본은 보존하고 PATH 탐지를 허용한다.
    }
    const info = await probe(defaultCommand).catch(() => ({ usable: false, version: null, capabilities: [] }));
    return info.usable ? { path: defaultCommand, source: 'path', ...info } : { path: defaultCommand, source: 'none', ...info };
  }
  async function syncEffective() {
    const selected = await effective();
    publish({ source: selected.source, usable: Boolean(selected.usable), currentVersion: selected.version || null, needsInstall: selected.source === 'none', canRollback: await exists(backup) && await exists(backupMeta), error: null });
    return selected;
  }
  const withExecution = callback => {
    if (typeof sharedGate === 'function') return sharedGate(callback);
    if (sharedGate?.run) return sharedGate.run(callback);
    const result = executionGate.then(callback); executionGate = result.catch(() => {}); return result;
  };
  const useTool = callback => withToolUse ? withToolUse(id, callback) : callback();
  async function replaceYtdlp() {
    const epoch = settingsEpoch();
    if (getSettings()[autoUpdateKey] === false) { publish({ status: 'available', percent: null }); return; }
    for (const delay of [0, 50, 100, 200]) {
      if (delay) await new Promise(resolve => clock.setTimeout(resolve, delay));
      if (stopped || busy()) { publish({ status: 'downloaded-pending', percent: null }); return; }
      if (settingsEpoch() !== epoch || getSettings()[autoUpdateKey] === false) { publish({ status: 'available', percent: null }); return; }
      let moved = false;
      try {
        await fs.unlink(backup).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (await exists(managedPath)) { await fs.rename(managedPath, backup); moved = true; }
        // 임시 실행 파일의 버전과 스트림 해시는 교체 전에 검증되어 있다.
        await fs.rename(staged.candidateExe, managedPath);
        const installedVersion = staged.version;
        candidate = null; staged = null;
        publish({ status: 'updated', source: 'managed', usable: true, currentVersion: installedVersion, currentReleaseTag: installedVersion, candidateId: null, downloadBytes: null, downloadedBytes: 0, percent: null, needsInstall: false, canDownload: false, canRollback: moved, error: null });
        return;
      } catch (error) {
        if (moved) await fs.rename(backup, managedPath).catch(() => { throw fault('REPLACE_RECOVERY_REQUIRED'); });
        if (delay === 200) throw fault('REPLACE');
      }
    }
  }
  async function replaceUnlocked() {
    if (!staged || stopped) return;
    if (busy()) { publish({ status: 'downloaded-pending', percent: null }); return; }
    const epoch = settingsEpoch();
    if (getSettings()[pathKey] != null && getSettings()[pathKey] !== defaultCommand) { publish({ status: 'available', source: 'custom', percent: null }); return; }
    if (!isDescriptor) return replaceYtdlp();
    if (await tool.beforeReplace) await tool.beforeReplace();
    let movedBinary = false, movedMeta = false, installed = false;
    try {
      if (stopped || settingsEpoch() !== epoch || busy()) { publish({ status: 'downloaded-pending', percent: null }); return; }
      for (const delay of [0, 50, 100, 200]) {
        if (delay) await new Promise(resolve => clock.setTimeout(resolve, delay));
        if (stopped || busy()) { publish({ status: 'downloaded-pending', percent: null }); return; }
        try {
          await fs.unlink(backup).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await fs.unlink(backupMeta).catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (await exists(managedPath)) { await fs.rename(managedPath, backup); movedBinary = true; }
          if (await exists(metaPath)) { await fs.rename(metaPath, backupMeta); movedMeta = true; }
          await fs.rename(staged.candidateExe, managedPath); installed = true;
          const check = await probe(managedPath);
          if (!check.usable || check.version !== staged.version) throw fault('VERIFY');
          const meta = { schemaVersion: 1, toolId: id, repo: candidate?.repo || 'yt-dlp/yt-dlp', channel: candidate?.channel || 'stable', branch: candidate?.branch || null, releaseTag: candidate?.releaseTag || staged.version, releasePublishedAt: candidate?.releasePublishedAt || null, assetId: candidate?.assetId ?? null, assetName: candidate?.assetName || 'yt-dlp.exe', assetUpdatedAt: candidate?.assetUpdatedAt || null, downloadBytes: candidate?.downloadBytes ?? staged.downloadedBytes, packageSha256: staged.packageSha256, binarySha256: staged.binarySha256, version: staged.version, installedAt: new Date().toISOString(), transactionId: randomUUID() };
          await fs.writeFile(metaTemporary, JSON.stringify(meta), 'utf8');
          await fs.rename(metaTemporary, metaPath);
          candidate = null; staged = null;
          publish({ status: movedBinary ? 'updated' : 'installed', source: 'managed', usable: true, currentVersion: check.version, currentReleaseTag: meta.releaseTag, candidateId: null, downloadBytes: null, downloadedBytes: 0, percent: null, needsInstall: false, canRollback: movedBinary && movedMeta, error: null });
          return;
        } catch (error) {
          if (installed) await fs.unlink(managedPath).catch(() => {});
          await fs.unlink(metaPath).catch(() => {});
          if (movedBinary) await fs.rename(backup, managedPath).catch(() => { throw fault('REPLACE_RECOVERY_REQUIRED'); });
          if (movedMeta) await fs.rename(backupMeta, metaPath).catch(() => { throw fault('REPLACE_RECOVERY_REQUIRED'); });
          installed = movedBinary = movedMeta = false;
          if (delay === 200) throw error.code ? error : fault('REPLACE');
        }
      }
    } finally { if (tool.afterReplace) await tool.afterReplace(); }
  }
  const replace = () => withExecution(replaceUnlocked);
  async function downloadManaged() {
    if (!candidate || stopped) return;
    const picked = candidate, epoch = settingsEpoch();
    if (!picked.downloadBytes || !Number.isSafeInteger(picked.downloadBytes) || picked.downloadBytes <= 0 || picked.candidateId !== state.candidateId || state.downloadBytes !== picked.downloadBytes) throw fault('VERIFY');
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    const controller = new AbortController(); currentController = controller;
    const hash = createHash('sha256'); let bytes = 0, lastProgress = 0;
    publish({ status: 'downloading', downloadedBytes: 0, percent: 0, error: null });
    try {
      await consume(picked.downloadURL, false, async response => {
        const file = await fs.open(temporary, 'w');
        let idleTimer;
        const resetIdle = () => { if (idleTimer != null) clock.clearTimeout(idleTimer); idleTimer = clock.setTimeout(() => controller.abort(), 30000); };
        resetIdle();
        try {
          for await (const raw of response.body) {
            resetIdle();
            if (stopped) throw fault('NETWORK');
            const chunk = Buffer.from(raw); bytes += chunk.length;
            if (bytes > picked.downloadBytes || bytes > (isDescriptor ? 512 * 1024 * 1024 : picked.downloadBytes)) throw fault('VERIFY');
            hash.update(chunk); await file.writeFile(chunk);
            if (bytes - lastProgress >= 256 * 1024) { lastProgress = bytes; publish({ downloadedBytes: bytes, percent: Math.min(100, bytes / picked.downloadBytes * 100) }); }
          }
        } finally { if (idleTimer != null) clock.clearTimeout(idleTimer); await file.close(); }
      }, controller, { stream: true, totalTimeout: 15 * 60 * 1000 });
      clearProgress();
      if (stopped || settingsEpoch() !== epoch || bytes !== picked.downloadBytes) throw fault('VERIFY');
      if (!isDescriptor && bytes < 5 * 1024 * 1024) throw fault('VERIFY');
      if (isDescriptor) {
        const latest = await tool.discover({ consume: (url, api, cb, mode) => consume(url, api, cb, controller, mode || { limit: 2 * 1024 * 1024 }) });
        if (latest.candidateId !== picked.candidateId || latest.downloadBytes !== picked.downloadBytes || hash.digest('hex') !== picked.packageSha256) throw fault('VERIFY');
        publish({ status: 'verifying', downloadedBytes: bytes, percent: null });
        const result = await tool.verifyAndStage(temporary, picked);
        staged = { ...result, downloadedBytes: bytes };
        await fs.unlink(temporary).catch(() => {});
      } else {
        const current = await tool.discover({ consume: (url, api, cb) => consume(url, api, cb, controller, { limit: 2 * 1024 * 1024 }) });
        if (current.candidateId !== picked.candidateId || current.downloadBytes !== picked.downloadBytes) throw fault('VERIFY');
        const checksumText = await consume(picked.checksumURL, false, response => response.text(), controller, { limit: 256 * 1024 });
        const digest = hash.digest('hex');
        if (digest !== parseSums(checksumText) || await version(temporary) !== picked.version) throw fault('VERIFY');
        staged = { candidateExe: temporary, binarySha256: digest, packageSha256: digest, version: picked.version, downloadedBytes: bytes };
      }
      if (stopped) { await discard(); return; }
      publish({ status: 'downloaded-pending', downloadedBytes: bytes, percent: null });
      await replace();
    } finally { if (currentController === controller) currentController = null; clearProgress(); }
  }
  async function run(manual) {
    const selected = await syncEffective();
    publish({ manual: activeManual, error: null, percent: null, latestVersion: null });
    if (selected.source === 'custom') { publish({ status: 'disabled' }); return; }
    if (!manual && !isDescriptor && getSettings()[autoUpdateKey] === false) return;
    publish({ status: 'checking' });
    const controller = new AbortController(); currentController = controller;
    try {
      const meta = selected.source === 'managed' ? await readMeta(metaPath) : null;
      const discovered = await tool.discover({ consume: (url, api, cb) => consume(url, api, cb, controller, { limit: api ? 2 * 1024 * 1024 : 256 * 1024 }) });
      if (!discovered.downloadBytes || !Number.isSafeInteger(discovered.downloadBytes) || discovered.downloadBytes <= 0) throw fault('DISCOVER');
      const choice = tool.compare ? tool.compare(isDescriptor ? meta : selected, discovered) : 'unknown';
      candidate = { ...discovered };
      publish({ latestVersion: discovered.version || discovered.releaseTag || null, currentReleaseTag: meta?.releaseTag || null, candidateId: discovered.candidateId, downloadBytes: discovered.downloadBytes, downloadedBytes: 0, canDownload: true });
      if (choice === 'same' || (!isDescriptor && choice === 'older')) { publish({ status: 'up-to-date', canDownload: false }); return; }
      if (choice === 'older') { publish({ status: 'available', canDownload: false }); return; }
      if (isDescriptor) {
        publish({ status: selected.source === 'none' ? 'available' : 'available', needsInstall: selected.source === 'none', canDownload: true });
        return;
      }
      if (getSettings()[autoUpdateKey] === false) { publish({ status: 'available', canDownload: true }); return; }
      await downloadManaged();
    } finally { if (currentController === controller) currentController = null; }
  }
  async function guarded(callback) {
    try { await callback(); }
    catch (error) {
      clearProgress();
      if (stopped || error?.name === 'AbortError') { await discard(); return getState(); }
      const code = Object.hasOwn(messages, error.code) ? error.code : (error.code === 'VERIFY' ? 'VERIFY' : 'NETWORK');
      if (code !== 'REPLACE_BUSY' && code !== 'REPLACE_RECOVERY_REQUIRED') { candidate = null; await discard(); }
      publish({ status: 'error', percent: null, error: { code, message: messages[code] } });
    }
    return getState();
  }
  function enqueue(callback) {
    if (operation) return operation;
    operation = guarded(callback).finally(() => { operation = null; });
    return operation;
  }
  function check(manual = false) {
    if (operation) { if (manual && !state.manual) { activeManual = true; publish({ manual: true }); } return operation; }
    if (stopped) return Promise.resolve(getState());
    if (manual && staged) { publish({ manual: true }); return queueChanged(); }
    if (manual && getSettings()[pathKey] !== defaultCommand) { publish({ status: 'disabled', source: 'custom', manual: true }); return Promise.resolve(getState()); }
    activeManual = manual;
    if (getSettings()[pathKey] !== defaultCommand) publish({ status: 'disabled', source: 'custom', manual, error: null });
    else if (manual || getSettings()[autoUpdateKey] !== false || isDescriptor) publish({ status: 'checking', manual, error: null });
    return enqueue(() => run(manual));
  }
  function download({ candidateId, acknowledgedBytes } = {}) {
    if (operation) return operation;
    if (stopped || !candidate || candidateId !== state.candidateId || acknowledgedBytes !== state.downloadBytes || !state.canDownload) return Promise.resolve(getState());
    return enqueue(downloadManaged);
  }
  function ensureInstalled() {
    if (!isDescriptor) return check(false);
    if (state.source !== 'none' || installAttempted) return Promise.resolve(getState());
    installAttempted = true;
    if (busy()) { publish({ status: 'unavailable', error: { code: 'TOOL_NOT_READY', message: '기존 대기 항목을 취소한 뒤 설치를 준비해 주세요.' } }); return Promise.resolve(getState()); }
    return check(false);
  }
  function queueChanged() {
    if (operation) return operation;
    if (staged) return enqueue(replace);
    if (candidate && state.canDownload && !isDescriptor && getSettings()[autoUpdateKey] !== false) return enqueue(downloadManaged);
    return Promise.resolve(getState());
  }
  async function refreshSettings() {
    const selected = await syncEffective();
    if (selected.source === 'custom') publish({ status: 'disabled', source: 'custom', canDownload: false });
    else if (state.status === 'disabled') publish({ status: selected.source === 'none' ? 'missing' : 'idle', source: selected.source });
    return queueChanged();
  }
  function start() {
    stopped = false;
    if (firstTimer != null || interval != null) return;
    if (!isDescriptor) {
      firstTimer = clock.setTimeout(() => { firstTimer = null; void check(); }, 10000);
      interval = clock.setInterval(() => { void check(); }, 12 * 60 * 60 * 1000);
    } else {
      void ensureInstalled();
      if (getSettings()[autoUpdateKey] !== false) {
        firstTimer = clock.setTimeout(() => { firstTimer = null; void check(); }, 10000);
        interval = clock.setInterval(() => { void check(); }, 12 * 60 * 60 * 1000);
      }
    }
  }
  function stop() {
    stopped = true; currentController?.abort();
    clock.clearTimeout(firstTimer); clock.clearInterval(interval); firstTimer = interval = null; clearProgress();
    candidate = null;
  }
  return { effective, getState, check, download, ensureInstalled, queueChanged, withExecution, withToolUse: useTool, refreshSettings, start, stop };
}

export function createYtdlpUpdater(options) {
  return createManagedTool({ ...options, descriptor: options.descriptor });
}
