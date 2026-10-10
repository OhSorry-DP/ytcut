import path from 'node:path';

export function getLegacyUserDataPath(appDataPath) {
  return path.join(appDataPath, 'YT Cut');
}

export const RELEASE_URL = 'https://github.com/OhSorry-DP/streamcut/releases/latest';
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export function createUpdater({ autoUpdater, currentVersion, isPackaged, portable = false,
  openExternal, onChange = () => {}, hasActiveJobs = () => false,
  confirmInstall = async () => true, prepareInstall = async () => {},
  clock = { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval } }) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  let state = { status: 'idle', currentVersion, latestVersion: null, releaseUrl: null,
    percent: null, canAutoUpdate: Boolean(isPackaged && !portable), manual: false, error: null };
  let checking, downloading, installing, initialTimer, intervalTimer, progressTimer;
  let lastProgress = -Infinity;
  const getState = () => structuredClone(state);
  const push = () => onChange(getState());
  function cancelProgress() {
    if (progressTimer !== undefined) clock.clearTimeout(progressTimer);
    progressTimer = undefined;
  }
  function change(values) { cancelProgress(); state = { ...state, ...values }; push(); }
  function failure(code = 'UPDATE_FAILED') {
    change({ status: 'error', percent: null, error: { code, message: '업데이트 작업을 완료하지 못했습니다. 잠시 후 다시 시도하세요.' } });
  }
  const listeners = {
    'checking-for-update': () => change({ status: 'checking', error: null, percent: null }),
    'update-available': info => change({ status: info.version === currentVersion ? 'not-available' : 'available',
      latestVersion: info.version, releaseUrl: RELEASE_URL, error: null, percent: null }),
    'update-not-available': info => change({ status: 'not-available', latestVersion: info?.version || currentVersion,
      releaseUrl: RELEASE_URL, error: null, percent: null }),
    'download-progress': info => {
      if (state.status !== 'downloading' || !Number.isFinite(info.percent)) return;
      state = { ...state, percent: Math.max(0, Math.min(100, info.percent)) };
      const delay = Math.max(0, 250 - (clock.now() - lastProgress));
      if (!delay) { cancelProgress(); lastProgress = clock.now(); push(); }
      else if (progressTimer === undefined) progressTimer = clock.setTimeout(() => {
        progressTimer = undefined; lastProgress = clock.now(); push();
      }, delay);
    },
    'update-downloaded': info => change({ status: 'downloaded', latestVersion: info?.version || state.latestVersion,
      releaseUrl: RELEASE_URL, percent: 100, error: null }),
    error: () => failure(),
  };
  for (const [event, listener] of Object.entries(listeners)) autoUpdater.on(event, listener);

  function check(manual = false) {
    if (!isPackaged) return Promise.resolve(getState());
    if (checking) {
      if (manual && !state.manual) change({ manual: true });
      return checking;
    }
    if (downloading || state.status === 'downloaded' || installing) return Promise.resolve(getState());
    change({ status: 'checking', manual, error: null, percent: null });
    checking = Promise.resolve().then(() => autoUpdater.checkForUpdates())
      .catch(() => failure()).then(getState).finally(() => { checking = undefined; });
    return checking;
  }
  async function download() {
    if (!state.canAutoUpdate) {
      // Only the fixed repository URL can reach the external browser.
      const url = state.releaseUrl || RELEASE_URL;
      if (!url.startsWith('https://github.com/OhSorry-DP/streamcut/releases/')) throw new Error('Invalid release URL');
      change({ manual: true, releaseUrl: url });
      try { await openExternal(url); } catch { failure('UPDATE_OPEN_FAILED'); }
      return getState();
    }
    if (downloading) return downloading;
    if (state.status !== 'available' || checking || installing) return getState();
    change({ status: 'downloading', manual: true, percent: 0, error: null });
    lastProgress = clock.now();
    downloading = Promise.resolve().then(() => autoUpdater.downloadUpdate())
      .catch(() => failure('UPDATE_DOWNLOAD_FAILED')).then(getState).finally(() => { downloading = undefined; });
    return downloading;
  }
  function install() {
    if (installing) return installing;
    if (!state.canAutoUpdate || state.status !== 'downloaded') return Promise.resolve({ cancelled: true });
    installing = (async () => {
      try {
        if (hasActiveJobs() && !await confirmInstall()) return { cancelled: true };
        await prepareInstall();
        autoUpdater.quitAndInstall();
        return { installing: true };
      } catch {
        failure('UPDATE_INSTALL_FAILED');
        return { cancelled: true };
      } finally { installing = undefined; }
    })();
    return installing;
  }
  function start() {
    if (!isPackaged || initialTimer !== undefined || intervalTimer !== undefined) return;
    initialTimer = clock.setTimeout(() => { initialTimer = undefined; void check(); }, 5000);
    intervalTimer = clock.setInterval(() => { void check(); }, CHECK_INTERVAL);
  }
  function stop() {
    cancelProgress();
    if (initialTimer !== undefined) clock.clearTimeout(initialTimer);
    if (intervalTimer !== undefined) clock.clearInterval(intervalTimer);
    initialTimer = intervalTimer = undefined;
  }
  return { getState, check, download, install, start, stop };
}
