import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { access, stat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createStore } from './lib/store.js';
import { startServer } from './lib/server.js';
import { createJobs } from './lib/jobs.js';
import { createRunner } from './lib/runner.js';
import { normalizeYouTubeUrl } from './lib/yt-args.js';
import { normalizeFileName, validateSnapshot as validateStateSnapshot } from './lib/queue-state.js';
import updaterPkg from 'electron-updater';
import { createUpdater, getLegacyUserDataPath } from './lib/updater.js';
import fs from 'node:fs/promises';
import { createYtdlpUpdater } from './lib/ytdlp-updater.js';
import { createPreviewStream } from './lib/preview-stream.js';

const { autoUpdater } = updaterPkg;

// 표시 이름을 바꿔도 기존 설정·대기열과 관리 도구를 계속 읽도록 데이터 폴더를 고정한다.
app.setPath('userData', getLegacyUserDataPath(app.getPath('appData')));

const root = path.dirname(fileURLToPath(import.meta.url));
const formats = new Set(['mkv', 'mp4']);
const cutModes = new Set(['fast', 'accurate']);
const defaults = { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', outputDir: path.join(app.getPath('videos'), 'ytcut'), cutMode: 'accurate', format: 'mp4', autoUpdateYtDlp: true, previewResolution: 480, alwaysUseLocalPlayer: true };
const runner = createRunner();
function checkTools(settings) {
  return Promise.all(['ytDlp', 'ffmpeg'].map(key => new Promise(resolve => {
    let settled = false, output = '', child;
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); resolve([key, { ok, version: ok ? output.trim().split('\n')[0] : null }]); };
    const timer = setTimeout(() => { finish(false); child?.kill(); }, 5000);
    try {
      const binary = settings[key === 'ytDlp' ? 'ytDlpPath' : 'ffmpegPath'];
      stat(binary).catch(() => null).then(info => {
      if (settled) return;
      child = spawn(key === 'ffmpeg' && info?.isDirectory() ? path.join(binary, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : binary, [key === 'ytDlp' ? '--version' : '-version'], { shell: false, windowsHide: true });
      child.stdout.on('data', data => { output = (output + data).slice(0, 4096); });
      child.on('error', () => finish(false)); child.on('close', code => finish(code === 0));
      }).catch(() => finish(false));
    } catch { finish(false); }
  }))).then(Object.fromEntries);
}
let window;
let store;
let settings;
let jobs;
let server;
let mainURL;
let quitting = false;
let shutdownPromise;
let updater;
let ytdlpUpdater;
const preview = createPreviewStream({
  getYtdlpPath: async () => (await ytdlpUpdater.effective()).path,
  getFfmpegPath: async () => {
    const binary = settings.ffmpegPath || 'ffmpeg';
    const info = await stat(binary).catch(() => null);
    return info?.isDirectory() ? path.join(binary, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : binary;
  },
});
async function executionSettings() {
  return { ...settings, ytDlpPath: (await ytdlpUpdater.effective()).path };
}
const metadataCache = new Map();

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const RENAME_MESSAGES = {
  INVALID_FILE_NAME: '파일명이 올바르지 않습니다. \\ / : * ? " < > | 문자와 확장자는 쓸 수 없고 120자 이하여야 합니다.',
  OUTPUT_NAME_CONFLICT: '같은 이름의 파일이 이미 있어 이름을 바꾸지 못했습니다.',
  NOT_RENAMABLE: '다운로드 중인 항목은 이름을 바꿀 수 없습니다.',
  NO_OUTPUT_FILE: '파일이 없어 이름을 바꿀 수 없습니다.',
  INVALID_QUEUE_ID: '대기열에서 항목을 찾지 못했습니다.',
};

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function executable(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\0\r\n]/.test(value) || /\.(cmd|bat)$/i.test(value)) {
    throw invalid('INVALID_SETTINGS', `${label}: 실행 파일 또는 PATH 명령 이름을 지정하세요.`);
  }
  if (path.isAbsolute(value)) {
    if (!/\.exe$/i.test(value) || !(await stat(value).catch(() => null))?.isFile()) throw invalid('INVALID_SETTINGS', `${label}: 유효한 exe 파일이 필요합니다.`);
    await access(value, constants.X_OK).catch(() => { throw invalid('INVALID_SETTINGS', `${label}: 실행 파일에 접근할 수 없습니다.`); });
  } else if (!/^[\w.-]+$/.test(value)) {
    throw invalid('INVALID_SETTINGS', `${label}: 절대 경로나 PATH 명령 이름이 필요합니다.`);
  }
  return value;
}

async function validateSettings(value) {
  if (record(value)) value = { ...value, previewResolution: value.previewResolution === undefined ? defaults.previewResolution : value.previewResolution, alwaysUseLocalPlayer: value.alwaysUseLocalPlayer === undefined ? defaults.alwaysUseLocalPlayer : value.alwaysUseLocalPlayer };
  validatePreviewSettings(value);
  if (record(value)) value = { ...value, outputDir: value.outputDir === undefined || value.outputDir === '' ? defaults.outputDir : value.outputDir };
  if (!record(value) || typeof value.autoUpdateYtDlp !== 'boolean') throw invalid('INVALID_SETTINGS', '자동 업데이트 설정은 참 또는 거짓이어야 합니다.');
  if (!record(value) || !formats.has(value.format) || !cutModes.has(value.cutMode)) throw invalid('INVALID_SETTINGS', 'format은 mkv 또는 mp4, cutMode는 fast 또는 accurate여야 합니다.');
  await executable(value.ytDlpPath, 'yt-dlp');
  if (!(path.isAbsolute(value.ffmpegPath) && (await stat(value.ffmpegPath).catch(() => null))?.isDirectory())) await executable(value.ffmpegPath, 'ffmpeg');
  if (typeof value.outputDir === 'string' && path.isAbsolute(value.outputDir) && !/[\0\r\n]/.test(value.outputDir)) await mkdir(value.outputDir, { recursive: true });
  if (typeof value.outputDir !== 'string' || /[\0\r\n]/.test(value.outputDir) || !path.isAbsolute(value.outputDir) || !(await stat(value.outputDir).catch(() => null))?.isDirectory()) throw invalid('INVALID_SETTINGS', 'outputDir은 존재하는 절대 폴더 경로여야 합니다.');
  await access(value.outputDir, constants.W_OK).catch(() => { throw invalid('INVALID_SETTINGS', '출력 폴더에 쓸 수 없습니다.'); });
  return Object.fromEntries(Object.keys(defaults).map(key => [key, value[key]]));
}

function validatePreviewSettings(value) {
  if (!record(value) || ![360, 480, 720].includes(value.previewResolution) || typeof value.alwaysUseLocalPlayer !== 'boolean') throw invalid('INVALID_SETTINGS', '미리보기 해상도는 360, 480, 720이며 항상 대체 플레이어 사용은 참 또는 거짓이어야 합니다.');
}

async function migrateSettings() {
  const next = { ...settings };
  for (const key of ['autoUpdateYtDlp', 'previewResolution', 'alwaysUseLocalPlayer']) {
    if (next[key] === undefined) next[key] = defaults[key];
  }
  if (typeof next.autoUpdateYtDlp !== 'boolean') throw invalid('INVALID_SETTINGS', '저장된 자동 업데이트 설정이 올바르지 않습니다.');
  validatePreviewSettings(next);
  if (!isDeepStrictEqual(next, settings)) await jobs.saveSettings(next);
  settings = next;
}

function authorize(event) {
  if (quitting || shutdownPromise || !window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw invalid('UNAUTHORIZED', '허용되지 않은 IPC 요청입니다.');
  let actual;
  try { actual = new URL(event.senderFrame.url); } catch { throw invalid('UNAUTHORIZED', '허용되지 않은 IPC 요청입니다.'); }
  const expected = new URL(mainURL);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) throw invalid('UNAUTHORIZED', '허용되지 않은 IPC 요청입니다.');
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, input) => {
    try {
      authorize(event);
      return { ok: true, value: await callback(input) };
    } catch (error) {
      return { ok: false, error: { code: error.code || 'OPERATION_FAILED', message: error.code ? error.message : '작업을 완료하지 못했습니다. 도구 설정과 출력 경로를 확인하세요.' } };
    }
  });
}

function validateSnapshot(snapshot) {
  if (!record(snapshot) || !formats.has(snapshot.format) || !cutModes.has(snapshot.cutMode) || !record(snapshot.video) || !record(snapshot.timeline)) throw invalid('INVALID_SNAPSHOT', '영상, 구간, cutMode와 format이 필요합니다.');
  snapshot = structuredClone(snapshot);
  try { snapshot.fileName = normalizeFileName(snapshot.fileName, snapshot.video.title); }
  catch (error) { if (error.code === 'INVALID_FILE_NAME') throw error; throw invalid('INVALID_FILE_NAME', error.message); }
  const { startSec, endSec } = snapshot.timeline;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) throw invalid('INVALID_SNAPSHOT', '잘라낼 구간이 올바르지 않습니다.');
  try { validateStateSnapshot(snapshot); } catch (error) { if (error.code === 'INVALID_FILE_NAME') throw error; throw invalid('INVALID_SNAPSHOT', '영상과 타임라인이 올바르지 않습니다.'); }
  const cached = metadataCache.get(snapshot.video.videoId);
  if (!cached || !isDeepStrictEqual(cached, snapshot.video) || !Number.isFinite(cached.durationSec) || endSec > cached.durationSec) throw invalid('INVALID_SNAPSHOT', '현재 세션에서 확인한 영상과 구간이 필요합니다.');
  return snapshot;
}

function installIPC() {
  handle('preview:prepare', input => {
    const maxHeight = input?.previewResolution === undefined ? settings.previewResolution : input.previewResolution;
    if (![360, 480, 720].includes(maxHeight)) throw invalid('INVALID_PREVIEW_RESOLUTION', '미리보기 해상도는 360, 480, 720이어야 합니다.');
    return preview.prepare(input?.videoId, maxHeight);
  });
  const updateHandle = (channel, callback) => handle(channel, input => {
    if (!record(input) || Object.keys(input).length) throw invalid('INVALID_UPDATE_REQUEST', '업데이트 요청이 올바르지 않습니다.');
    return callback();
  });
  updateHandle('update:state', () => updater.getState());
  updateHandle('update:check', () => { void updater.check(true); return updater.getState(); });
  updateHandle('update:download', () => updater.download());
  updateHandle('update:install', () => updater.install());
  updateHandle('ytdlp:state', () => ytdlpUpdater.getState());
  updateHandle('ytdlp:check', () => { void ytdlpUpdater.check(true); return ytdlpUpdater.getState(); });
  handle('app:bootstrap', async () => { const tools = await checkTools(await executionSettings()); return { settings: structuredClone(settings), items: jobs.list(), revision: jobs.revision, tools }; });
  handle('settings:save', async input => {
    const next = await validateSettings(input);
    await jobs.saveSettings(next);
    settings = next;
    await ytdlpUpdater.refreshSettings();
    return structuredClone(settings);
  });
  handle('video:metadata', async input => {
    let normalized;
    try { normalized = normalizeYouTubeUrl(input?.url); } catch { throw invalid('INVALID_URL', 'YouTube 주소가 필요합니다.'); }
    if (typeof input?.requestId !== 'string') throw invalid('INVALID_REQUEST', 'requestId가 필요합니다.');
    let video, formats;
    try { ({ video, formats } = await runner.metadataWithStreams(normalized, await executionSettings())); }
    catch (error) { throw invalid(error.code || 'METADATA_FAILED', '영상 정보를 가져오지 못했습니다. URL과 도구 설정을 확인하세요.'); }
    if (video.videoId !== new URL(normalized).searchParams.get('v')) throw invalid('INVALID_METADATA', '영상 ID가 일치하지 않습니다.');
    metadataCache.set(video.videoId, structuredClone(video));
    preview.cacheFormats(video.videoId, formats);
    return { requestId: input.requestId, video };
  });
  handle('queue:add', async input => {
    const snapshot = validateSnapshot(input?.snapshot);
    return ytdlpUpdater.withExecution(async () => jobs.add(snapshot, await executionSettings()));
  });
  handle('queue:retry', async input => ytdlpUpdater.withExecution(() => jobs.retry(input?.id)));
  handle('queue:rename', async input => {
    if (!record(input) || typeof input.id !== 'string' || typeof input.fileName !== 'string') throw invalid('INVALID_REQUEST', '이름 변경 요청이 올바르지 않습니다.');
    try { return await jobs.rename(input.id, input.fileName); }
    catch (error) {
      const code = error instanceof RangeError && error.message === 'INVALID_FILE_NAME' ? 'INVALID_FILE_NAME' : error?.code;
      if (RENAME_MESSAGES[code]) throw invalid(code, RENAME_MESSAGES[code]);
      throw error;
    }
  });
  handle('queue:open-file', async input => jobs.openFile(input?.id));
  handle('queue:delete-file', async input => jobs.deleteFile(input?.id));
  handle('queue:remove', async input => jobs.remove(input?.id));
  handle('queue:cancel', async input => {
    if (typeof input?.id !== 'string') throw invalid('INVALID_QUEUE_ID', '큐 항목 ID가 필요합니다.');
    return jobs.cancel(input.id);
  });
  handle('settings:choose-output', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.outputDir });
    return { outputDir: result.canceled ? null : result.filePaths[0] };
  });
  handle('queue:open-output', async input => {
    const target = await jobs.resolveOpenOutput(input?.id);
    if (target?.kind === 'file') {
      try { shell.showItemInFolder(target.path); }
      catch { throw invalid('OPEN_OUTPUT_FAILED', '출력 파일을 열지 못했습니다.'); }
      return { opened: true };
    }
    if (!target || target.kind !== 'folder') throw invalid('INVALID_QUEUE_ID', '큐 항목이 없습니다.');
    let error;
    try { error = await shell.openPath(target.path); }
    catch { throw invalid('OPEN_OUTPUT_FAILED', '출력 폴더를 열지 못했습니다. 경로를 확인하세요.'); }
    if (error) throw invalid('OPEN_OUTPUT_FAILED', '출력 폴더를 열지 못했습니다. 경로를 확인하세요.');
    return { opened: true };
  });
  handle('queue:refresh-files', async input => {
    if (!record(input) || Object.keys(input).length) throw invalid('INVALID_UPDATE_REQUEST', '파일 확인 요청은 빈 객체여야 합니다.');
    await jobs.refreshCompletedFiles();
    return { checked: true };
  });
}

async function createWindow() {
  Menu.setApplicationMenu(null); // 상단 메뉴바 제거
  window = new BrowserWindow({ width: 1200, height: 850, icon: path.join(root, 'build', 'icon.png'), webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (url !== mainURL) event.preventDefault(); });
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame && event.url !== mainURL) event.preventDefault();
  });
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/embed/*', 'https://www.youtube-nocookie.com/embed/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.webContentsId === contents.id && !Object.keys(headers).some(key => key.toLowerCase() === 'referer')) headers.Referer = `${new URL(mainURL).origin}/`;
    callback({ requestHeaders: headers });
  });
  window.on('closed', () => { window = undefined; metadataCache.clear(); });
  window.on('focus', () => {
    if (!window || window.isDestroyed() || quitting || shutdownPromise) return;
    void jobs.refreshCompletedFiles().catch(error => console.error('Queue file refresh:', error.code || error.message));
  });
  await window.loadURL(mainURL);
}

async function initialize() {
  await mkdir(app.getPath('userData'), { recursive: true });
  await mkdir(defaults.outputDir, { recursive: true });
  store = createStore(path.join(app.getPath('userData'), 'state.json'));
  server = await startServer(root, { preview });
  mainURL = new URL('/renderer/index.html', server.origin).href;
  if (new URL(mainURL).protocol !== 'http:' || new URL(mainURL).hostname !== '127.0.0.1') throw invalid('INVALID_SERVER', '로컬 HTTP 서버 주소가 필요합니다.');
  jobs = createJobs({ store, runner, uuid: randomUUID, fileActions: {
    openPath: target => shell.openPath(target),
    trashItem: target => shell.trashItem(target),
    confirmDelete: async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'question', message: '파일을 휴지통으로 보낼까요?',
        buttons: ['확인', '취소'], defaultId: 1, cancelId: 1, noLink: true,
      });
      return result.response === 0;
    },
  }, onChange: (payload, error) => {
    if (error) { console.error('Queue persistence:', error.code || error.message); return; }
    if (window && !window.isDestroyed()) window.webContents.send('queue:changed', payload);
    void ytdlpUpdater?.queueChanged();
  } });
  await jobs.init(defaults);
  settings = jobs.getSettings();
  await migrateSettings();
  ytdlpUpdater = createYtdlpUpdater({
    fetch: globalThis.fetch, spawn, fs, jobs, getSettings: () => settings,
    managedPath: path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe'),
    onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('ytdlp:changed', state); },
  });
  await ytdlpUpdater.refreshSettings();
  updater = createUpdater({
    autoUpdater, currentVersion: app.getVersion(), isPackaged: app.isPackaged,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    openExternal: url => shell.openExternal(url),
    onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('update:changed', state); },
    hasActiveJobs: () => jobs.list().some(item => ['running', 'waiting'].includes(item.status)),
    confirmInstall: async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'question', message: '진행 중인 다운로드가 있습니다. 지금 설치하면 중단됩니다. 계속할까요?',
        buttons: ['설치', '취소'], defaultId: 1, cancelId: 1, noLink: true,
      });
      return result.response === 0;
    },
    prepareInstall: async () => {
      try { await shutdown(); quitting = true; }
      catch (error) { shutdownPromise = undefined; throw error; }
    },
  });
  const tools = await checkTools(await executionSettings());
  installIPC();
  await createWindow();
  updater.start();
  ytdlpUpdater.start();
  if (!tools.ffmpeg?.ok) await dialog.showMessageBox(window, { type: 'warning', title: 'FFmpeg 설정', message: 'FFmpeg를 찾지 못했습니다. 설정에서 ffmpeg.exe 경로를 지정하거나 PATH에 설치하세요.' });
}

app.on('second-instance', () => {
  if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
});
app.on('window-all-closed', () => app.quit());
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  updater?.stop();
  ytdlpUpdater?.stop();
  preview.close();
  shutdownPromise = (async () => {
    await jobs?.shutdown(); // shutdown includes the store flush.
    await server?.close();
  })();
  return shutdownPromise;
}
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdown().then(() => { quitting = true; app.quit(); }).catch(() => {
    shutdownPromise = undefined;
    dialog.showErrorBox('종료 오류', '작업 상태 저장 또는 로컬 서버 종료를 완료하지 못했습니다. 다시 시도하세요.');
  });
});

// ESM 진입점에서 최상위 await 로 ready 를 기다리면 ready 이벤트가 영영 오지 않으므로 then 으로 이어 붙인다.
app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    quitting = true;
    app.quit();
    return;
  }
  try { await initialize(); }
  catch (error) {
    dialog.showErrorBox('시작 오류', error.code ? error.message : '앱을 시작하지 못했습니다. 설정과 도구 설치를 확인하세요.');
    app.quit();
  }
});
