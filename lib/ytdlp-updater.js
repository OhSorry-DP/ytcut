import path from 'node:path';
import { createHash } from 'node:crypto';

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
  return settings.autoUpdateYtDlp !== false && exists
    ? { path: managedPath, source: 'managed' } : { path: 'yt-dlp', source: 'path' };
}
export function allowedAsset(url) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
    (parsed.hostname === 'github.com' || parsed.hostname === 'release-assets.githubusercontent.com' || parsed.hostname === 'objects.githubusercontent.com' || parsed.hostname.endsWith('.objects.githubusercontent.com'));
}
const fault = code => Object.assign(new Error(code), { code });
const messages = {
  NETWORK: '업데이트 정보를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.',
  VERIFY: '업데이트 파일 검증에 실패했습니다. 다시 확인해 주세요.',
  REPLACE: '업데이트 파일을 교체하지 못했습니다. 잠시 후 다시 확인해 주세요.',
};

export function createYtdlpUpdater({ fetch, spawn, fs, clock = globalThis, jobs, getSettings, managedPath, onChange = () => {} }) {
  const temporary = `${managedPath}.download`, backup = `${managedPath}.bak`;
  let state = { status: 'idle', source: 'path', currentVersion: null, latestVersion: null, percent: null, manual: false, error: null };
  let operation = null, pending = null, stopped = false, firstTimer, interval, progressTimer;
  let activeManual = false;
  let executionGate = Promise.resolve();
  function withExecution(callback) {
    const result = executionGate.then(callback);
    executionGate = result.catch(() => {});
    return result;
  }
  const getState = () => structuredClone(state);
  const publish = patch => { state = { ...state, ...patch }; onChange(getState()); };
  const exists = async file => Boolean((await fs.stat(file).catch(() => null))?.isFile());
  const effective = async () => resolveEffectivePath(getSettings(), managedPath, await exists(managedPath));
  const busy = () => jobs.list().some(item => ['running', 'waiting'].includes(item.status));
  const clearProgress = () => { if (progressTimer != null) clock.clearTimeout(progressTimer); progressTimer = null; };
  const discard = () => fs.unlink(temporary).catch(() => {});
  function version(file) {
    return new Promise(resolve => {
      let child, output = '', settled = false;
      const finish = value => { if (settled) return; settled = true; clock.clearTimeout(timer); resolve(value); };
      const timer = clock.setTimeout(() => { finish(null); child?.kill(); }, 5000);
      try {
        child = spawn(file, ['--version'], { shell: false, windowsHide: true });
        child.stdout.on('data', chunk => { output = (output + chunk).slice(0, 4096); });
        child.on('error', () => finish(null));
        child.on('close', code => { const value = output.trim(); finish(code === 0 && validVersion(value) ? value : null); });
      } catch { finish(null); }
    });
  }
  async function request(url, api = false) {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!(api ? url === releaseAPI : allowedAsset(url))) throw fault('NETWORK');
      const controller = new AbortController();
      const timer = clock.setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'streamcut', Accept: api ? 'application/vnd.github+json' : 'application/octet-stream' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (api) throw fault('NETWORK');
          url = new URL(response.headers.get('location'), url).href;
          await response.body?.cancel?.();
          clock.clearTimeout(timer);
          continue;
        }
        if (!response.ok || (response.url && !(api ? response.url === releaseAPI : allowedAsset(response.url)))) throw fault('NETWORK');
        // Keep the timeout active while the response body is consumed.
        return { response, close: () => clock.clearTimeout(timer) };
      } catch (error) { clock.clearTimeout(timer); throw error; }
    }
    throw fault('NETWORK');
  }
  async function consume(url, api, callback) {
    const result = await request(url, api);
    try { return await callback(result.response); } finally { result.close(); }
  }
  const replace = () => withExecution(replaceUnlocked);
  async function replaceUnlocked() {
    if (!pending || stopped || busy()) return;
    const selection = await effective();
    if (selection.source === 'custom' || getSettings().autoUpdateYtDlp === false) {
      pending = null; await discard();
      publish({ status: selection.source === 'custom' ? 'disabled' : 'available', source: selection.source, percent: null });
      return;
    }
    for (const delay of [0, 50, 100, 200]) {
      if (delay) await new Promise(resolve => clock.setTimeout(resolve, delay));
      if (stopped || busy()) return;
      let moved = false;
      try {
        if (await exists(managedPath)) {
          await fs.unlink(backup).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await fs.rename(managedPath, backup); moved = true;
        }
        await fs.rename(temporary, managedPath);
        const installed = pending; pending = null;
        publish({ status: 'updated', source: 'managed', currentVersion: installed, percent: null, error: null });
        return;
      } catch {
        if (moved) {
          try { await fs.rename(backup, managedPath); }
          catch { throw fault('REPLACE'); }
        }
        if (delay === 200) throw fault('REPLACE');
      }
    }
  }
  async function run(manual) {
    const selection = await effective();
    publish({ source: selection.source, manual: activeManual, error: null, percent: null, latestVersion: null });
    if (selection.source === 'custom') { publish({ status: 'disabled', currentVersion: null }); return; }
    if (!manual && getSettings().autoUpdateYtDlp === false) return;
    publish({ status: 'checking' });
    const currentVersion = await version(selection.path);
    publish({ currentVersion });
    const release = await consume(releaseAPI, true, response => response.json());
    if (!validVersion(release.tag_name) || !Array.isArray(release.assets)) throw fault('NETWORK');
    const latestVersion = release.tag_name;
    publish({ latestVersion });
    if (currentVersion && compareVersions(latestVersion, currentVersion) <= 0) { publish({ status: 'up-to-date' }); return; }
    if (getSettings().autoUpdateYtDlp === false) { publish({ status: 'available' }); return; }
    const binary = release.assets.find(asset => asset.name === 'yt-dlp.exe');
    const sums = release.assets.find(asset => asset.name === 'SHA2-256SUMS');
    if (!binary || !sums || !allowedAsset(binary.browser_download_url) || !allowedAsset(sums.browser_download_url)) throw fault('NETWORK');
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    await discard();
    publish({ status: 'downloading', percent: 0 });
    const hash = createHash('sha256');
    let bytes = 0, percent = 0;
    await consume(binary.browser_download_url, false, async response => {
      const file = await fs.open(temporary, 'w');
      const total = Number(binary.size) || Number(response.headers.get('content-length'));
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk); hash.update(buffer); bytes += buffer.length;
          await file.writeFile(buffer);
          percent = total > 0 ? Math.min(100, bytes / total * 100) : null;
          if (progressTimer == null) progressTimer = clock.setTimeout(() => { progressTimer = null; publish({ percent }); }, 250);
        }
      } finally { await file.close(); }
    });
    clearProgress(); publish({ percent: 100 });
    if (bytes < 5 * 1024 * 1024) throw fault('VERIFY');
    const checksum = await consume(sums.browser_download_url, false, response => response.text());
    let expected;
    try { expected = parseSums(checksum); } catch { throw fault('VERIFY'); }
    if (hash.digest('hex') !== expected || await version(temporary) !== latestVersion) throw fault('VERIFY');
    pending = latestVersion;
    publish({ status: 'downloaded-pending', percent: null });
    await replace();
  }
  async function guarded(callback) {
    try { await callback(); }
    catch (error) {
      clearProgress(); pending = null; await discard();
      const code = Object.hasOwn(messages, error.code) ? error.code : 'NETWORK';
      publish({ status: 'error', percent: null, error: { code, message: messages[code] } });
    }
    return getState();
  }
  function check(manual = false) {
    if (operation) {
      if (manual) { activeManual = true; if (!state.manual) publish({ manual: true }); }
      return operation;
    }
    if (stopped) return Promise.resolve(getState());
    if (manual && pending) publish({ manual: true });
    if (pending) return queueChanged();
    activeManual = manual;
    // Publish checking synchronously for the immediate IPC response.
    if (getSettings().ytDlpPath !== 'yt-dlp') publish({ status: 'disabled', source: 'custom', manual, error: null });
    else if (manual || getSettings().autoUpdateYtDlp !== false) publish({ status: 'checking', manual, error: null });
    operation = guarded(() => run(manual)).finally(() => { operation = null; });
    return operation;
  }
  function queueChanged() {
    if (operation || !pending) return operation || Promise.resolve(getState());
    operation = guarded(replace).finally(() => { operation = null; });
    return operation;
  }
  return {
    getState, effective, check, queueChanged, withExecution,
    async refreshSettings() {
      const selection = await effective();
      if (selection.source === 'custom') publish({ status: 'disabled', source: 'custom', currentVersion: null, error: null, percent: null });
      else if (state.status === 'disabled') publish({ status: 'idle', source: selection.source, error: null });
      else publish({ source: selection.source });
      return queueChanged();
    },
    start() {
      if (firstTimer != null || interval != null) return;
      stopped = false;
      firstTimer = clock.setTimeout(() => { firstTimer = null; void check(); }, 10000);
      interval = clock.setInterval(() => { void check(); }, 12 * 60 * 60 * 1000);
    },
    stop() { stopped = true; clock.clearTimeout(firstTimer); clock.clearInterval(interval); firstTimer = interval = null; clearProgress(); },
  };
}
