import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { getLegacyUserDataPath } from '../lib/updater.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { safeToolError } from '../lib/tool-errors.js';
import { createStore } from '../lib/store.js';
import { createRunner } from '../lib/runner.js';
import { createJobs } from '../lib/jobs.js';
import { startServer } from '../lib/server.js';
import { createApp } from '../renderer/app.js';
import { createTimelineView } from '../renderer/timeline-view.js';
import { createPlayer } from '../renderer/player.js';
import { normalizeYouTubeUrl } from '../lib/yt-args.js';
import { normalizeFileName, validateSnapshot as validateStateSnapshot } from '../lib/queue-state.js';

const snapshot = (format = 'mkv') => ({
  video: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', title: '영상', durationSec: 60 },
  timeline: { startSec: 0, endSec: 30, zoom: 1, scrollSec: 0, playheadSec: 0 }, cutMode: 'accurate', format, fileName: '',
});
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for queue state');
}
async function fixture(t, fileActions) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-integration-'));
  const store = createStore(path.join(directory, 'state.json'));
  const settings = { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', outputDir: directory, cutMode: 'accurate', format: 'mp4' };
  const children = [], notices = [], persistedAtSpawn = [];
  const runner = createRunner({ platform: 'linux', spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    children.push({ child, command, args, options });
    persistedAtSpawn.push(store.load());
    return child;
  } });
  const jobs = createJobs({ store, runner, uuid: randomUUID, fileActions, onChange: payload => notices.push(payload) });
  const instances = [jobs];
  await jobs.init(settings);
  t.after(async () => { for (const instance of instances.reverse()) await instance.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, settings, runner, jobs, children, notices, persistedAtSpawn, instances };
}
async function complete(f, index, item) {
  const file = path.join(f.directory, item.id, `attempt-${item.attempt}`, `clip.${item.snapshot.format}`);
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fake media');
  f.children[index].child.stdout.write(`ytcut-output:${JSON.stringify(file)}\n`);
  f.children[index].child.emit('close', 0);
  await until(() => f.jobs.list().find(row => row.id === item.id).status === 'completed');
  return file;
}

test('real store/jobs/runner persist add and running before spawn, report progress, then complete', async t => {
  const f = await fixture(t);
  const item = await f.jobs.add(snapshot(), f.settings);
  const atSpawn = (await f.persistedAtSpawn[0]).document;
  assert.equal(atSpawn.items[0].status, 'running');
  assert.ok(f.notices.some(event => event.items[0]?.status === 'waiting'));
  f.children[0].child.stdout.write('ytcut-progress:{"downloaded_bytes":25,"total_bytes":100,"speed":12,"eta":6}\n');
  await until(() => f.jobs.list()[0].progress === 25);
  assert.ok(f.notices.at(-1).revision > atSpawn.revision);
  const file = await complete(f, 0, item);
  const saved = (await f.store.load()).document;
  assert.equal(saved.items[0].status, 'completed');
  assert.equal(saved.items[0].execution.outputLayout, 'flat-v1');
  assert.equal(saved.items[0].outputPath, path.join(f.directory, '영상.mkv'));
  assert.equal(path.basename(saved.items[0].outputPath), '영상.mkv');
  assert.equal(await fs.readFile(saved.items[0].outputPath, 'utf8'), 'fake media');
  assert.equal(file, path.join(f.directory, item.id, 'attempt-1', 'clip.mkv'));
  assert.equal(saved.items[0].progress, 100); assert.equal(saved.items[0].phase, 'done');
  assert.equal(f.children[0].options.shell, false);
});

class RendererNode {
    open = false; modalCalls = 0; focused = false;
    focus() {
      if (this.ownerDocument) {
        if (this.ownerDocument.activeElement) this.ownerDocument.activeElement.focused = false;
        this.ownerDocument.activeElement = this;
      }
      this.focused = true;
    }
    selectionStart = 0; selectionEnd = 0; selectionDirection = 'none';
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    showModal() { this.open = true; this.modalCalls++; }
    close() { this.open = false; void this.emit('close'); }
    getBoundingClientRect() { return { left: 10, right: 730, top: 10, bottom: 470 }; }
    value = ''; disabled = false; style = {}; children = []; listeners = new Map();
    attributes = new Map();
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    append(node) { this.insertBefore(node, null); }
    removeChild(node) { const index = this.children.indexOf(node); assert.ok(index >= 0); this.children.splice(index, 1); node.parent = null; return node; }
    insertBefore(node, before) {
      if (node === before) return;
      if (node.parent) node.parent.removeChild(node);
      const index = before === null ? this.children.length : this.children.indexOf(before);
      assert.ok(index >= 0); this.children.splice(index, 0, node); node.parent = this;
    }
    replaceChildren() { for (const node of this.children) node.parent = null; this.children = []; }
    async emit(name, extra = {}) {
      let stopped = false;
      const event = { type: name, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...extra };
      const bubbles = !['blur', 'focus', 'pointerenter', 'pointerleave'].includes(name);
      for (let node = this; node; node = stopped || !bubbles ? null : node.parent) await node.listeners.get(name)?.(event);
      return stopped;
    }
}
function rendererDocument() {
  const nodes = new Map();
  const doc = { activeElement: null,
    getElementById(id) {
      if (!nodes.has(id)) {
        const node = doc.createElement(id.endsWith('-input') || id === 'output-dir' ? 'input' : 'div');
        if (id === 'file-name-input') node.type = 'text';
        nodes.set(id, node);
      }
      return nodes.get(id);
    },
    createElement(name) { const node = new RendererNode(); node.ownerDocument = doc; node.tagName = name.toUpperCase(); return node; },
    createElementNS(namespace, name) { const node = doc.createElement(name); node.namespaceURI = namespace; node.tagName = name; return node; } };
  return doc;
}

async function fallbackFixture(t, code = 150, prepareResult = { ok: true, value: { path: '/preview/token.mp4' } }) {
  const doc = rendererDocument(), localLoads = [], youtubeLoads = [];
  let app, initialDestroyed = 0, localDestroyed = 0, youtubeCreated = 0, localOptions;
  const label = new RendererNode();
  doc.getElementById('loading-overlay').querySelector = () => label;
  doc.getElementById('fallback-badge').hidden = true;
  const ytcut = {
    onQueueChanged() {}, async bootstrap() { return { ok: true, value: { settings: { alwaysUseLocalPlayer: false } } }; },
    async metadata({ requestId }) { return { ok: true, value: { requestId, video: snapshot().video } }; },
    async preparePreview(id) { assert.equal(id, 'abcdefghijk'); return prepareResult; },
  };
  const player = { destroy() { initialDestroyed++; }, load() {
    const error = Object.assign(new Error(`YouTube player error (${code})`), { code });
    app.onPlayerError(error);
    return Promise.reject(error);
  } };
  app = createApp({ player, document: doc, ytcut, timelineView: { set() {}, destroy() {} },
    youtubeFactory() { youtubeCreated++; return { destroy() {}, async load(...args) { youtubeLoads.push(args); } }; },
    localFactory(id, options) {
      localOptions = options;
      return { destroy() { localDestroyed++; }, async load(...args) {
        localLoads.push(args); await options.prepare(args[0].videoId);
      }, async pause() {}, async seek() {}, async seekAndPlay() {}, async togglePlay() {}, getTime() { return 12; } };
    },
  });
  t.after(() => app.dispose()); await app.bootstrapped;
  return { app, ytcut, label, doc, localLoads, youtubeLoads, node: id => doc.getElementById(id),
    stats: () => ({ initialDestroyed, localDestroyed, youtubeCreated }), options: () => localOptions };
}

for (const code of [150, 101, 153]) test(`embed error ${code} switches to local preview with badge and informational notice`, async t => {
  const f = await fallbackFixture(t, code);
  await f.app.edit(snapshot().video, { ...snapshot(), timeline: { ...snapshot().timeline, playheadSec: 12 } });
  await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.localLoads.length, 1); assert.equal(f.localLoads[0][1], 12);
  assert.equal(f.localLoads[0][0].durationSec, 60);
  assert.equal(f.stats().initialDestroyed, 1); assert.equal(f.node('fallback-badge').hidden, false);
  assert.equal(f.node('player-error').textContent, 'YouTube 임베드 오류로 대체 플레이어를 사용합니다.');
  assert.equal(f.node('player-error').className, 'player-info'); assert.equal(f.node('app-error').textContent, '');
  assert.equal(f.node('preview-button').disabled, false);
});

test('non-embed errors keep YouTube and disable preview while numeric download stays available', async t => {
  const f = await fallbackFixture(t, 100); await f.app.edit(snapshot().video);
  await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.localLoads.length, 0); assert.equal(f.stats().initialDestroyed, 0);
  assert.equal(f.node('fallback-badge').hidden, true); assert.equal(f.node('preview-button').disabled, true);
  assert.equal(f.node('download-button').disabled, false); assert.match(f.node('player-error').textContent, /100/);
});

test('another video or restored queue snapshot retries YouTube and ignores old local errors', async t => {
  const f = await fallbackFixture(t); await f.app.edit(snapshot().video);
  await until(() => f.node('loading-overlay').hidden);
  const oldOptions = f.options();
  await f.app.edit(snapshot().video, snapshot()); await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.stats().youtubeCreated, 1); assert.equal(f.stats().localDestroyed, 1);
  assert.equal(f.youtubeLoads.length, 1); assert.equal(f.node('fallback-badge').hidden, true);
  oldOptions.onError(new Error('stale')); assert.equal(f.node('app-error').textContent, '');
  assert.equal(f.node('player-error').textContent, ''); assert.equal(f.node('preview-button').disabled, false);
});

test('preparePreview failure falls back once to YouTube and leaves numeric editing and download available', async t => {
  const f = await fallbackFixture(t, 150, { ok: false, error: { code: 'PREVIEW_UNAVAILABLE', message: '대체 미리보기 준비 실패' } });
  await f.app.edit(snapshot().video); await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.stats().youtubeCreated, 1); assert.equal(f.youtubeLoads.length, 1);
  assert.equal(f.node('app-error').textContent, '');
  assert.equal(f.node('player-error').textContent, '대체 플레이어를 준비하지 못해 YouTube 플레이어로 전환합니다.');
  assert.equal(f.node('player-error').className, 'player-info'); assert.equal(f.node('preview-button').disabled, false);
  assert.equal(f.node('fallback-badge').hidden, true);
  assert.equal(f.node('start-input').disabled, false); assert.equal(f.node('download-button').disabled, false);
});

test('fallback keeps overlay until prepare resolves and late completion cannot replace a new video', async t => {
  const f = await fallbackFixture(t); let resolve;
  f.ytcut.preparePreview = () => new Promise(done => { resolve = done; });
  await f.app.edit(snapshot().video);
  await until(() => !!f.options());
  assert.equal(f.node('loading-overlay').hidden, false); assert.equal(f.label.textContent, '대체 플레이어 준비 중…');
  f.options().onBuffering(true);
  assert.equal(f.label.textContent, '대체 플레이어 준비 중…');
  f.options().onBuffering(false);
  assert.equal(f.node('loading-overlay').hidden, false);
  assert.equal(f.node('preview-button').disabled, true);
  await f.app.edit(snapshot().video); await until(() => f.node('loading-overlay').hidden);
  resolve({ ok: true, value: { path: '/preview/late.mp4' } }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.node('fallback-badge').hidden, true); assert.equal(f.node('player-error').textContent, '');
});

test('real YouTube error events propagate embed codes into app fallback; code 100 stays on YouTube', async t => {
  const previous = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  for (const code of [150, 101, 153, 100]) {
    const doc = rendererDocument(); doc.addEventListener = () => {}; doc.removeEventListener = () => {};
    let app, destroyed = 0, prepared = 0;
    globalThis.document = doc; globalThis.location = { origin: 'http://127.0.0.1:1234' };
    globalThis.window = {
      setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
      YT: { PlayerState: { PLAYING: 1, BUFFERING: 3, CUED: 5, PAUSED: 2 }, Player: class {
        constructor(id, options) { this.events = options.events; queueMicrotask(() => this.events.onReady()); }
        getIframe() { return { setAttribute() {} }; }
        cueVideoById() { this.events.onError({ data: code }); }
        destroy() { destroyed++; }
      } },
    };
    const player = createPlayer('player', { onError: error => app.onPlayerError(error) });
    app = createApp({ player, document: doc, timelineView: { set() {}, destroy() {} }, ytcut: {
      onQueueChanged() {}, async bootstrap() { return { ok: true, value: { settings: { alwaysUseLocalPlayer: false } } }; },
      async metadata({ requestId }) { return { ok: true, value: { requestId, video: snapshot().video } }; },
      async preparePreview() { prepared++; return { ok: true, value: { path: '/preview/token.mp4' } }; },
    }, localFactory(id, options) { return {
      destroy() {}, async load(video) { await options.prepare(video.videoId); },
    }; } });
    try {
      await app.bootstrapped; await app.edit(snapshot().video);
      await until(() => doc.getElementById('loading-overlay').hidden);
      assert.equal(prepared, code === 100 ? 0 : 1);
      assert.equal(destroyed, code === 100 ? 0 : 1);
      assert.equal(doc.getElementById('preview-button').disabled, code === 100);
      if (code !== 100) assert.equal(doc.getElementById('fallback-badge').hidden, false);
    } finally { app.dispose(); }
  }
});

async function ytdlpFixture(t, options = {}) {
  const doc = rendererDocument();
  const section = { hidden: true, removeAttribute() { this.hidden = false; } };
  doc.getElementById('ytdlp-check-button').parentElement = section;
  doc.getElementById('ytdlp-flash').hidden = true;
  let push, queuePush, saved, unsubscribed = 0;
  const state = { status: 'idle', source: 'managed', currentVersion: '2026.01.01', latestVersion: '2026.10.10', percent: null, manual: false, error: null };
  const ytcut = {
    onQueueChanged(fn) { queuePush = fn; return () => {}; },
    async bootstrap() { return { ok: true, value: { settings: options.settings || {}, tools: {
      ytDlp: { ok: true, version: '2026.01.01' }, ffmpeg: { ok: true, version: 'ffmpeg version 7.0 banner' },
    } } }; },
    async saveSettings(value) { saved = value; return { ok: true, value }; },
  };
  if (!options.missing) Object.assign(ytcut, {
    onYtdlpChanged(fn) { push = fn; return () => { unsubscribed++; }; },
    ytdlpState() { assert.equal(typeof push, 'function'); return options.query ? options.query() : Promise.resolve({ ok: true, value: state }); },
    async checkYtdlp() { return { ok: true, value: { ...state, status: 'up-to-date', manual: true } }; },
  });
  const app = createApp({ document: doc, ytcut, player: { destroy() {} }, timelineView: { destroy() {} } });
  t.after(() => app.dispose());
  await app.bootstrapped;
  if (!options.query) await app.ytdlpInitialized;
  return { app, ytcut, section, node: id => doc.getElementById(id), push: value => push({ ...state, ...value }),
    queuePush: value => queuePush(value), saved: () => saved, unsubscribed: () => unsubscribed };
}

test('yt-dlp settings default to true, load false and save the checkbox boolean', async t => {
  const f = await ytdlpFixture(t);
  assert.equal(f.node('auto-update-ytdlp').checked, true);
  await f.node('settings-form').emit('submit');
  assert.equal(f.saved().autoUpdateYtDlp, true);
  f.queuePush({ settings: { autoUpdateYtDlp: false } });
  assert.equal(f.node('auto-update-ytdlp').checked, false);
  await f.node('settings-form').emit('submit');
  assert.equal(f.saved().autoUpdateYtDlp, false);
});

test('yt-dlp renders checking, progress, pending, available, current and disabled states', async t => {
  const f = await ytdlpFixture(t);
  assert.equal(f.section.hidden, false);
  for (const [status, text] of [
    ['checking', '확인 중…'],
    ['downloading', '새 버전 2026.10.10 다운로드 중… 42.5%'],
    ['downloaded-pending', '2026.10.10 준비됨 — 진행 중인 다운로드가 끝나면 적용됩니다'],
    ['available', '새 버전 2026.10.10 이 있습니다(자동 업데이트가 꺼져 있습니다)'],
    ['up-to-date', '최신 버전입니다'],
    ['disabled', '사용자 지정 경로를 쓰므로 자동 업데이트하지 않습니다'],
  ]) {
    f.push({ status, percent: 42.5 });
    assert.equal(f.node('ytdlp-status').textContent, text);
    assert.equal(f.node('ytdlp-check-button').disabled, status === 'checking');
    assert.equal(f.node('ytdlp-check-button').textContent, status === 'checking' ? '확인 중…' : '지금 확인');
  }
});

test('yt-dlp automatic errors are hidden and manual errors and rejected checks are shown', async t => {
  const f = await ytdlpFixture(t);
  f.push({ status: 'error', error: { code: 'NETWORK', message: '연결 실패' } });
  assert.equal(f.node('ytdlp-status').textContent, '');
  f.push({ status: 'error', manual: true, error: { code: 'NETWORK', message: '연결 실패' } });
  assert.equal(f.node('ytdlp-status').textContent, '연결 실패');
  f.ytcut.checkYtdlp = async () => ({ ok: false, error: { message: '수동 확인 실패' } });
  await f.node('ytdlp-check-button').emit('click');
  assert.equal(f.node('ytdlp-status').textContent, '수동 확인 실패');
});

test('yt-dlp updated push refreshes tools and flashes for six seconds with timer cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await ytdlpFixture(t);
  f.push({ status: 'updated', currentVersion: '2026.10.10' });
  assert.equal(f.node('tools').textContent, 'yt-dlp 2026.10.10 · ffmpeg 7.0');
  assert.equal(f.node('ytdlp-status').textContent, '2026.10.10 으로 업데이트되었습니다');
  assert.equal(f.node('ytdlp-flash').hidden, false);
  f.queuePush({ tools: { ytDlp: { ok: true, version: 'old' }, ffmpeg: { ok: true, version: '7.0' } } });
  assert.equal(f.node('tools').textContent, 'yt-dlp 2026.10.10 · ffmpeg 7.0');
  t.mock.timers.tick(5999);
  assert.equal(f.node('ytdlp-flash').hidden, false);
  t.mock.timers.tick(1);
  assert.equal(f.node('ytdlp-flash').hidden, true);
  f.app.dispose();
  assert.equal(f.unsubscribed(), 1);
});

test('missing yt-dlp APIs quietly keep the section hidden', async t => {
  const f = await ytdlpFixture(t, { missing: true });
  assert.equal(f.section.hidden, true);
  assert.equal(f.node('ytdlp-flash').hidden, true);
  assert.equal(f.node('app-error').textContent || '', '');
});

test('yt-dlp pushes beat late initial queries and manual check responses', async t => {
  let resolve;
  const f = await ytdlpFixture(t, { query: () => new Promise(done => { resolve = done; }) });
  f.push({ status: 'downloading', percent: 88 });
  resolve({ ok: true, value: { status: 'idle', currentVersion: 'old' } });
  await f.app.ytdlpInitialized;
  assert.equal(f.node('ytdlp-status').textContent, '새 버전 2026.10.10 다운로드 중… 88%');
  f.ytcut.checkYtdlp = () => new Promise(done => { resolve = done; });
  const checking = f.node('ytdlp-check-button').emit('click');
  assert.equal(f.node('ytdlp-check-button').disabled, true);
  f.push({ status: 'up-to-date' });
  resolve({ ok: true, value: { status: 'error', manual: true, error: { message: 'stale' } } });
  await checking;
  assert.equal(f.node('ytdlp-status').textContent, '최신 버전입니다');
});

async function updateFixture(t, initial = {}, enabled = true) {
  const doc = rendererDocument();
  const state = { status: 'idle', currentVersion: '1.0.0', latestVersion: '1.1.0', releaseUrl: null,
    percent: null, canAutoUpdate: true, manual: false, error: null, ...initial };
  const calls = [];
  let push, unsubscribed = 0;
  const settings = { hidden: true, removeAttribute() { this.hidden = false; } };
  doc.getElementById('update-check-button').parentElement = settings;
  doc.getElementById('update-banner').hidden = true;
  const ytcut = { onQueueChanged() {}, async bootstrap() { return { ok: true, value: {} }; } };
  if (enabled) Object.assign(ytcut, {
    onUpdateChanged(fn) { push = fn; calls.push('subscribe'); return () => { unsubscribed++; }; },
    async updateState() { calls.push('state'); return { ok: true, value: state }; },
    async checkUpdate() { calls.push('check'); return { ok: true, value: { ...state, status: 'not-available', manual: true } }; },
    async downloadUpdate() { calls.push('download'); return { ok: true, value: { ...state, status: 'downloading', percent: 0 } }; },
    async installUpdate() { calls.push('install'); return { ok: true, value: { cancelled: true } }; },
  });
  const app = createApp({ document: doc, ytcut, player: { destroy() {} }, timelineView: { destroy() {} } });
  t.after(() => app.dispose());
  await Promise.all([app.bootstrapped, app.updateInitialized]);
  return { doc, app, ytcut, calls, settings, push: value => push({ ...state, ...value }),
    node: id => doc.getElementById(id), unsubscribed: () => unsubscribed };
}

test('update available banner downloads and offers release page for manual platforms', async t => {
  const f = await updateFixture(t, { status: 'available' });
  assert.equal(f.settings.hidden, false);
  assert.deepEqual(f.calls, ['subscribe', 'state']);
  assert.equal(f.node('update-banner').hidden, false);
  assert.equal(f.node('update-banner-text').textContent, '새 버전 v1.1.0 이 있습니다');
  assert.equal(f.node('update-banner-action').textContent, '다운로드');
  await f.node('update-banner-action').emit('click');
  assert.equal(f.calls.at(-1), 'download');
  f.push({ status: 'available', canAutoUpdate: false });
  assert.equal(f.node('update-banner-action').textContent, '릴리즈 페이지 열기');
  await f.node('update-banner-action').emit('click');
  assert.equal(f.calls.filter(value => value === 'download').length, 2);
});

test('update dismissal persists for the same version and a newer version reappears', async t => {
  const f = await updateFixture(t, { status: 'available' });
  await f.node('update-banner-dismiss').emit('click');
  f.push({ status: 'available' });
  assert.equal(f.node('update-banner').hidden, true);
  f.push({ status: 'downloaded' });
  assert.equal(f.node('update-banner').hidden, true);
  f.push({ status: 'available', latestVersion: '1.2.0' });
  assert.equal(f.node('update-banner').hidden, false);
});

test('update downloading renders percentage and progress without buttons', async t => {
  const f = await updateFixture(t, { status: 'downloading', percent: 42.5 });
  assert.equal(f.node('update-banner-text').textContent, '업데이트 다운로드 중… 42.5%');
  assert.equal(f.node('update-progress').value, 42.5);
  assert.equal(f.node('update-progress').hidden, false);
  assert.equal(f.node('update-banner-action').hidden, true);
  assert.equal(f.node('update-banner-dismiss').hidden, true);
});

test('downloaded update installs and cancellation keeps the banner available', async t => {
  const f = await updateFixture(t, { status: 'downloaded' });
  assert.equal(f.node('update-banner-action').textContent, '재시작하여 설치');
  await f.node('update-banner-action').emit('click');
  assert.equal(f.calls.at(-1), 'install');
  assert.equal(f.node('update-banner').hidden, false);
});

test('automatic update errors stay hidden and manual errors show safe text and close', async t => {
  const f = await updateFixture(t, { status: 'error', error: { message: 'https://secret.invalid\nError stack' } });
  assert.equal(f.node('update-banner').hidden, true);
  f.push({ status: 'error', manual: true });
  assert.equal(f.node('update-banner').hidden, false);
  assert.equal(f.node('update-banner-text').textContent, '업데이트 확인에 실패했습니다');
  assert.equal(f.node('update-check-result').textContent, '업데이트 확인에 실패했습니다');
  await f.node('update-banner-dismiss').emit('click');
  assert.equal(f.node('update-banner').hidden, true);
});

test('missing update APIs quietly leave the update UI hidden', async t => {
  const f = await updateFixture(t, {}, false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.settings.hidden, true);
  assert.equal(f.node('update-banner').hidden, true);
  assert.equal(f.node('app-error').textContent, undefined);
});

test('manual check disables its button and reports the latest version', async t => {
  const f = await updateFixture(t);
  let resolve;
  f.ytcut.checkUpdate = () => new Promise(done => { resolve = done; });
  const checking = f.node('update-check-button').emit('click');
  assert.equal(f.node('update-check-button').disabled, true);
  assert.equal(f.node('update-check-button').textContent, '확인 중…');
  assert.equal(f.node('update-banner').hidden, true);
  resolve({ ok: true, value: { status: 'not-available', manual: true, currentVersion: '1.0.0' } });
  await checking;
  assert.equal(f.node('update-check-button').disabled, false);
  assert.equal(f.node('update-check-result').textContent, '최신 버전입니다');
});

test('later update pushes beat pending responses and dispose unsubscribes', async t => {
  const f = await updateFixture(t);
  let resolve;
  f.ytcut.checkUpdate = () => new Promise(done => { resolve = done; });
  const checking = f.node('update-check-button').emit('click');
  f.push({ status: 'available', latestVersion: '2.0.0' });
  resolve({ ok: true, value: { status: 'not-available', manual: true } });
  await checking;
  assert.equal(f.node('update-banner-text').textContent, '새 버전 v2.0.0 이 있습니다');
  f.app.dispose();
  assert.equal(f.unsubscribed(), 1);
  f.push({ status: 'downloaded' });
  assert.equal(f.node('update-banner-text').textContent, '새 버전 v2.0.0 이 있습니다');
});

test('update subscription precedes initial query and push wins over a late initial response', async t => {
  const doc = rendererDocument();
  let push, resolve;
  const ytcut = { onQueueChanged() {}, async bootstrap() { return { ok: true, value: {} }; },
    onUpdateChanged(fn) { push = fn; return () => {}; },
    updateState() { assert.equal(typeof push, 'function'); return new Promise(done => { resolve = done; }); },
    async checkUpdate() {}, async downloadUpdate() {}, async installUpdate() {},
  };
  const app = createApp({ document: doc, ytcut, player: { destroy() {} }, timelineView: { destroy() {} } });
  t.after(() => app.dispose());
  await Promise.resolve();
  push({ status: 'available', currentVersion: '1.0.0', latestVersion: '2.0.0', canAutoUpdate: true });
  resolve({ ok: true, value: { status: 'idle', currentVersion: '1.0.0' } });
  await app.updateInitialized;
  assert.equal(doc.getElementById('update-banner').hidden, false);
  assert.equal(doc.getElementById('update-banner-text').textContent, '새 버전 v2.0.0 이 있습니다');
});

async function loadingFixture(t) {
  const doc = rendererDocument();
  const requests = [], loads = [];
  let push;
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const items = ['first', 'second'].map(id => ({ id, status: 'waiting', snapshot: snapshot() }));
  const app = createApp({ document: doc, timelineView: { set() {}, destroy() {} },
    player: { load() { const pending = deferred(); loads.push(pending); return pending.promise; }, destroy() {} },
    youtubeFactory() { return { load() { const pending = deferred(); loads.push(pending); return pending.promise; }, destroy() {} }; },
    ytcut: { onQueueChanged(fn) { push = fn; },
      async bootstrap() { return { ok: true, value: { settings: { alwaysUseLocalPlayer: false }, revision: 1, items } }; },
      metadata(input) { const pending = deferred(); requests.push({ ...pending, input }); return pending.promise; } },
  });
  t.after(() => app.dispose());
  await app.bootstrapped;
  const row = index => doc.getElementById('queue-list').children[index];
  const metadata = async index => {
    requests[index].resolve({ ok: true, value: { requestId: requests[index].input.requestId, video: snapshot().video } });
    await Promise.resolve(); await Promise.resolve();
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const assertLoading = (index, expected) => {
    assert.equal(doc.getElementById('loading-overlay').hidden, !expected);
    assert.equal(doc.getElementById('load-button').disabled, expected);
    if (index !== null) assert.equal(row(index).className.includes('is-loading'), expected);
  };
  return { doc, app, items, push: payload => push(payload), requests, loads, row, metadata, settle, assertLoading };
}

test('loading starts immediately on queue restore with accessible spinner and disabled load button', async t => {
  const f = await loadingFixture(t);
  f.assertLoading(0, false);
  await f.row(0).emit('click');
  f.assertLoading(0, true);
  assert.equal(f.doc.getElementById('editor').className, 'editor is-disabled');
  const badge = f.row(0).children[1].children[1];
  assert.equal(badge.getAttribute('role'), 'status');
  assert.equal(badge.getAttribute('aria-live'), 'polite');
  assert.equal(badge.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(badge.children[1].textContent, '불러오는 중');
});

test('loading persists through metadata and restores queue status only after player success', async t => {
  const f = await loadingFixture(t);
  await f.row(0).emit('click');
  await f.metadata(0);
  f.assertLoading(0, true);
  assert.equal(f.doc.getElementById('preview-button').disabled, true);
  f.loads[0].resolve(); await f.settle();
  f.assertLoading(0, false);
  assert.equal(f.row(0).children[1].children[1].textContent, '대기');
  assert.equal(f.doc.getElementById('preview-button').disabled, false);
});

test('metadata and player errors both hide loading and retain the error message', async t => {
  for (const stage of ['metadata', 'player']) {
    const f = await loadingFixture(t);
    await f.row(0).emit('click');
    if (stage === 'metadata') f.requests[0].resolve({ ok: false, error: new Error('metadata failed') });
    else { await f.metadata(0); f.loads[0].reject(new Error('player failed')); }
    await f.settle();
    f.assertLoading(0, false);
    assert.equal(f.doc.getElementById('app-error').textContent, stage + ' failed');
    assert.equal(f.row(0).children[1].children[1].textContent, '대기');
  }
});

test('superseded metadata, player success and player error cannot clear newer loading', async t => {
  for (const stage of ['metadata', 'player-success', 'player-error']) {
    const f = await loadingFixture(t);
    await f.row(0).emit('click');
    if (stage !== 'metadata') await f.metadata(0);
    await f.row(1).emit('click');
    assert.equal(f.row(0).className.includes('is-loading'), false);
    f.assertLoading(1, true);
    if (stage === 'metadata') await f.metadata(0);
    else if (stage === 'player-success') f.loads[0].resolve();
    else f.loads[0].reject(new Error('stale failure'));
    await f.settle(); f.assertLoading(1, true);
    assert.equal(f.doc.getElementById('app-error').textContent, '');
    await f.metadata(1);
    f.assertLoading(1, true);
    f.loads.at(-1).resolve(); await f.settle();
    f.assertLoading(1, false);
  }
});

test('queue push preserves loading row and completion restores the latest pushed status', async t => {
  const f = await loadingFixture(t);
  await f.row(0).emit('click');
  f.push({ revision: 2, items: [{ ...f.items[0], status: 'completed' }, f.items[1]] });
  f.assertLoading(0, true);
  assert.equal(f.row(0).children[1].children[1].children[1].textContent, '불러오는 중');
  await f.metadata(0); f.loads[0].resolve(); await f.settle();
  f.assertLoading(0, false);
  assert.equal(f.row(0).children[1].children[1].textContent, '완료');
});

test('same queue row replaces its request and URL load has no loading queue row', async t => {
  const f = await loadingFixture(t);
  await f.row(0).emit('click'); await f.row(0).emit('click');
  await f.metadata(0); f.assertLoading(0, true);
  await f.metadata(1); f.loads[0].resolve(); await f.settle(); f.assertLoading(0, false);
  f.doc.getElementById('url-input').value = snapshot().video.url;
  await f.doc.getElementById('load-button').emit('click');
  f.assertLoading(null, true);
  assert.ok(f.doc.getElementById('queue-list').children.every(row => !row.className.includes('is-loading')));
  await f.metadata(2); f.loads[1].resolve(); await f.settle(); f.assertLoading(null, false);
});

async function keyboardFixture(t, loaded = true, previewLoaded = true) {
  const doc = rendererDocument();
  const handlers = new Map();
  doc.addEventListener = (type, fn, capture) => { assert.equal(capture, true); handlers.set(type, fn); };
  doc.removeEventListener = type => handlers.delete(type);
  doc.defaultView = { addEventListener() {}, removeEventListener() {} };
  const ids = ['timeline-scroll', 'timeline-content', 'timeline-ticks', 'selection', 'playhead',
    'start-handle', 'end-handle', 'start-input', 'end-input', 'zoom-input'];
  const root = doc.getElementById('timeline');
  root.ownerDocument = doc;
  root.querySelector = selector => doc.getElementById(selector.slice(1));
  for (const id of ids) {
    const node = doc.getElementById(id);
    node.clientWidth = 600; node.scrollLeft = 0;
    node.getBoundingClientRect = () => ({ left: 0, width: 600 });
  }
  let app, time = 20, playing = false, adds = 0;
  const seeks = [], toggles = [], previews = [], pauses = [];
  let resolveLoad;
  const view = createTimelineView(root, { onChange: state => app.onChange(state), onSeek: sec => app.onSeek(sec) });
  app = createApp({ document: doc, timelineView: view,
    player: { async load() { if (!previewLoaded) await new Promise(resolve => { resolveLoad = resolve; }); }, getTime: () => time,
      async seekAndPlay(sec) { time = sec; playing = true; previews.push(['seek', sec], 'play'); },
      async pause() { playing = false; pauses.push('pause'); },
      async seek(sec) { time = sec; seeks.push(sec); },
      async togglePlay() { playing = !playing; toggles.push(playing); }, destroy() {} },
    ytcut: { onQueueChanged() {}, async bootstrap() { return { ok: true, value: { settings: { alwaysUseLocalPlayer: false } } }; },
      async metadata(input) { return { ok: true, value: { requestId: input.requestId, video: snapshot().video } }; },
      async add() { adds++; return { ok: true, value: {} }; } },
  });
  t.after(() => app.dispose());
  await app.bootstrapped;
  if (loaded) { await app.edit(snapshot().video); await Promise.resolve(); }
  const key = async (key, props = {}, type = 'keydown') => {
    const target = props.target || doc.getElementById('download-button');
    const event = { type, key, target, preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, ...props };
    handlers.get(type)?.(event);
    // Model the native focused button/summary/range Space activation.
    if (!event.defaultPrevented && key === ' ' && type === 'keyup') await target.emit('click');
    await Promise.resolve();
    return event;
  };
  return { doc, app, view, key, seeks, toggles, previews, pauses, resolveLoad: () => resolveLoad?.(), setTime: value => { time = value; },
    get adds() { return adds; } };
}

test('preview button and P restart at selection start and stop once at the latest end', async t => {
  const f = await keyboardFixture(t);
  f.app.onChange({ ...f.app.getState().timeline, startSec: 12, endSec: 30 });
  assert.equal(f.doc.getElementById('preview-button').disabled, false);
  await f.doc.getElementById('preview-button').emit('click');
  f.app.onTime(20);
  await f.doc.getElementById('preview-button').emit('click');
  await f.key('p'); await f.key('P');
  await f.key('p', { repeat: true }); await f.key('p', {}, 'keyup');
  assert.deepEqual(f.previews, Array.from({ length: 4 }, () => [['seek', 12], 'play']).flat());
  f.app.onChange({ ...f.app.getState().timeline, startSec: 15, endSec: 35 });
  f.app.onTime(30); assert.deepEqual(f.pauses, []);
  f.app.onTime(36); await Promise.resolve();
  assert.deepEqual(f.pauses, ['pause']); assert.deepEqual(f.seeks, [35]);
  assert.equal(f.app.getState().timeline.playheadSec, 35);
  assert.equal(f.view.getState().playheadSec, 35);
  f.app.onTime(35); assert.equal(f.pauses.length, 1);
  await f.key('p'); assert.deepEqual(f.previews.slice(-2), [['seek', 15], 'play']);
});

test('timeline click, either arrow and Space cancel preview automatic stopping', async t => {
  for (const action of ['click', 'ArrowLeft', 'ArrowRight', ' ']) {
    const f = await keyboardFixture(t);
    f.app.onChange({ ...f.app.getState().timeline, startSec: 5, endSec: 30 });
    f.view.set(snapshot().video, f.app.getState().timeline);
    await f.key('p');
    if (action === 'click') await f.doc.getElementById('timeline-scroll').emit('click', { clientX: 200 });
    else await f.key(action);
    f.app.onTime(40); await Promise.resolve();
    assert.deepEqual(f.pauses, [], action);
    assert.equal(f.app.getState().timeline.playheadSec, 40, action);
  }
});

test('P ignores text targets, modifiers, repeats, unloaded video and unavailable preview', async t => {
  const f = await keyboardFixture(t);
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' }, { isContentEditable: true }]) await f.key('P', { target });
  for (const props of [{ altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }]) await f.key('p', props);
  assert.deepEqual(f.previews, []);
  const unloaded = await keyboardFixture(t, false);
  await unloaded.key('p'); await unloaded.doc.getElementById('preview-button').emit('click');
  assert.deepEqual(unloaded.previews, []);
  assert.equal(unloaded.doc.getElementById('preview-button').disabled, true);
  const pending = await keyboardFixture(t, true, false);
  assert.equal(pending.doc.getElementById('download-button').disabled, false);
  assert.equal(pending.doc.getElementById('preview-button').disabled, true);
  await pending.key('p'); await pending.doc.getElementById('preview-button').emit('click');
  assert.deepEqual(pending.previews, []);
  pending.resolveLoad(); await Promise.resolve(); await Promise.resolve();
});

test('queue status shows percent, seconds, minutes, unknown ETA and processing; restored range previews', async t => {
  const doc = rendererDocument();
  let push;
  const previews = [];
  const app = createApp({ document: doc,
    player: { async load() {}, async seekAndPlay(sec) { previews.push(sec); }, destroy() {} },
    timelineView: { set() {}, destroy() {} },
    ytcut: { onQueueChanged(fn) { push = fn; }, async bootstrap() { return { ok: true, value: { settings: { alwaysUseLocalPlayer: false } } }; },
      async metadata(input) { return { ok: true, value: { requestId: input.requestId, video: snapshot().video } }; } },
  });
  t.after(() => app.dispose()); await app.bootstrapped;
  let revision = 0;
  for (const [etaSec, phase, expected] of [[5, 'download', '진행 41% · 5초 남음'],
    [25, 'download', '진행 41% · 25초 남음'], [65, 'download', '진행 41% · 1분 5초 남음'],
    [null, 'download', '진행 41%'], [25, 'processing', '후처리 중']]) {
    const saved = snapshot(); saved.timeline.startSec = 7;
    push({ revision: ++revision, items: [{ id: 'eta', snapshot: saved, status: 'running', progress: 41, etaSec, phase }] });
    const row = doc.getElementById('queue-list').children[0];
    assert.equal(row.children[1].children[1].textContent, expected);
    assert.equal(row.children[2].children[0].value, 41);
  }
  await doc.getElementById('queue-list').children[0].emit('click');
  await until(() => !doc.getElementById('preview-button').disabled);
  await doc.getElementById('preview-button').emit('click');
  assert.deepEqual(previews, [7]); assert.equal(app.getState().timeline.endSec, 30);
});

test('global I/O and mark buttons normalize boundaries, update inputs and reject crossed selections', async t => {
  const f = await keyboardFixture(t);
  await f.key('I');
  assert.equal(f.app.getState().timeline.startSec, 20);
  assert.equal(f.doc.getElementById('start-input').value, '00:00:20.000');
  f.setTime(40); await f.key('o');
  assert.equal(f.app.getState().timeline.endSec, 40);
  assert.equal(f.doc.getElementById('end-input').value, '00:00:40.000');
  f.setTime(40); await f.key('i');
  assert.equal(f.app.getState().timeline.startSec, 20);
  assert.equal(f.doc.getElementById('app-error').textContent, '시작은 끝보다 앞이어야 합니다');
  f.setTime(20); await f.key('O');
  assert.equal(f.app.getState().timeline.endSec, 40);
  assert.equal(f.doc.getElementById('app-error').textContent, '끝은 시작보다 뒤여야 합니다');
  f.setTime(-20); await f.doc.getElementById('mark-start-button').emit('click');
  assert.equal(f.app.getState().timeline.startSec, 0);
  f.setTime(100); await f.doc.getElementById('mark-end-button').emit('click');
  assert.equal(f.app.getState().timeline.endSec, 60);
  assert.equal(f.doc.getElementById('app-error').textContent, '');
});

test('global arrows seek 10/1 seconds, repeat, clamp and center an offscreen playhead', async t => {
  const f = await keyboardFixture(t);
  await f.key('ArrowLeft'); await f.key('ArrowRight');
  await f.key('ArrowLeft', { ctrlKey: true }); await f.key('ArrowRight', { ctrlKey: true });
  assert.deepEqual(f.seeks, [10, 20, 19, 20]);
  // Shift 는 1분 단위(영상 길이 60초라 양 끝으로 clamp 된다), Ctrl 이 함께 눌리면 1초가 우선한다.
  await f.key('ArrowRight', { shiftKey: true }); await f.key('ArrowLeft', { shiftKey: true });
  assert.deepEqual(f.seeks.slice(-2), [60, 0]);
  f.setTime(30); await f.key('ArrowRight', { shiftKey: true, ctrlKey: true });
  assert.equal(f.seeks.at(-1), 31);
  f.setTime(2); await f.key('ArrowLeft');
  f.setTime(59); await f.key('ArrowRight', { repeat: true });
  assert.deepEqual(f.seeks.slice(-2), [0, 60]);
  f.doc.getElementById('zoom-input').value = '4';
  await f.doc.getElementById('zoom-input').emit('input');
  const state = { ...f.app.getState().timeline, scrollSec: 0 };
  f.app.onChange(state); f.view.set(snapshot().video, state);
  f.setTime(25); await f.key('ArrowRight');
  assert.equal(f.app.getState().timeline.playheadSec, 35);
  assert.equal(f.app.getState().timeline.scrollSec, 27.5);
  assert.equal(f.doc.getElementById('timeline-scroll').scrollLeft, 1100);
  assert.deepEqual(f.toggles, []);
  await f.key(' ', {}, 'keydown');
  await f.key('ArrowLeft');
  assert.deepEqual(f.toggles, [true]);
});

test('[ starts a download like the button: once per press, not while typing or in the settings dialog', async t => {
  const f = await keyboardFixture(t);
  const event = await f.key('[');
  assert.equal(event.defaultPrevented, true); assert.equal(f.adds, 1);
  await f.key('[', { repeat: true }); assert.equal(f.adds, 1);
  assert.equal((await f.key('[', {}, 'keyup')).defaultPrevented, true); assert.equal(f.adds, 1);
  await f.key('[', { target: { tagName: 'INPUT', type: 'text' } }); assert.equal(f.adds, 1);
  await f.doc.getElementById('settings-button').emit('click');
  await f.key('[', { target: f.doc.getElementById('settings-tab-general') }); assert.equal(f.adds, 1);
  await f.doc.getElementById('settings-close-button').emit('click');
  await f.key('[', { ctrlKey: true }); assert.equal(f.adds, 2);
});

test('Space toggles once per press and suppresses focused button/summary/range defaults on both phases', async t => {
  const f = await keyboardFixture(t);
  const button = f.doc.getElementById('download-button'); button.tagName = 'BUTTON';
  await button.emit('click'); assert.equal(f.adds, 1);
  for (const target of [button, { tagName: 'SUMMARY' }, { tagName: 'INPUT', type: 'range' },
    { tagName: 'BUTTON', className: 'queue-action' }, { tagName: 'LI' }]) {
    for (const repeat of [false, true, true]) {
      const event = await f.key(' ', { target, repeat });
      assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    }
    assert.equal((await f.key(' ', { target }, 'keyup')).defaultPrevented, true);
  }
  assert.deepEqual(f.toggles, [true, false, true, false, true]);
  assert.equal(f.adds, 1);
});

test('global shortcuts ignore text inputs, select, textarea and contenteditable', async t => {
  const f = await keyboardFixture(t);
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'number' },
    { tagName: 'INPUT', type: 'url' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'SELECT' },
    { tagName: 'TEXTAREA' }, { tagName: 'SPAN', isContentEditable: true }]) {
    for (const key of ['ArrowLeft', 'ArrowRight', ' ', 'I', 'o']) {
      assert.equal((await f.key(key, { target })).defaultPrevented, undefined);
      // Don't simulate button activation for text controls.
      target.emit = async () => {};
      assert.equal((await f.key(key, { target }, 'keyup')).defaultPrevented, undefined);
    }
  }
  assert.deepEqual(f.seeks, []); assert.deepEqual(f.toggles, []);
  assert.equal(f.app.getState().timeline.startSec, 0);
  assert.equal(f.app.getState().timeline.endSec, 60);
});

test('global shortcuts do nothing before a video preview is loaded', async t => {
  const f = await keyboardFixture(t, false);
  for (const key of ['ArrowLeft', 'ArrowRight', ' ', 'I', 'o']) {
    assert.equal((await f.key(key)).defaultPrevented, undefined);
  }
  assert.deepEqual(f.seeks, []); assert.deepEqual(f.toggles, []);
  assert.equal(f.doc.getElementById('mark-start-button').disabled, true);
});

test('player seek preserves playback, toggle uses YT state and iframe focus is reclaimed and cleaned up', async t => {
  const previous = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  const winHandlers = new Map(), docHandlers = new Map();
  const calls = []; let playing = false, instance;
  const iframe = { setAttribute() {}, blur() { calls.push('blur'); globalThis.document.activeElement = null; } };
  globalThis.document = { activeElement: iframe,
    addEventListener(type, fn) { docHandlers.set(type, fn); }, removeEventListener(type) { docHandlers.delete(type); },
    getElementById() { return { focus(options) { assert.deepEqual(options, { preventScroll: true }); calls.push('focus'); } }; } };
  globalThis.location = { origin: 'http://localhost' };
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval,
    focus() {}, addEventListener(type, fn) { winHandlers.set(type, fn); }, removeEventListener(type) { winHandlers.delete(type); },
    YT: { PlayerState: { PLAYING: 1 }, Player: class {
      constructor(id, options) { instance = this; assert.equal(options.playerVars.disablekb, 1);
        queueMicrotask(() => options.events.onReady()); }
      getIframe() { return iframe; }
      seekTo(sec) { calls.push(['seek', sec]); }
      getPlayerState() { return playing ? 1 : 2; }
      playVideo() { playing = true; calls.push('play'); }
      pauseVideo() { playing = false; calls.push('pause'); }
      destroy() { calls.push('destroy'); }
    } } };
  const player = createPlayer('player');
  await player.seek(10); assert.ok(instance); assert.equal(playing, false);
  await player.togglePlay(); assert.equal(playing, true);
  await player.seek(11); assert.equal(playing, true);
  await player.togglePlay(); assert.equal(playing, false);
  winHandlers.get('blur')();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [['seek', 10], 'play', ['seek', 11], 'pause', 'blur', 'focus']);
  await player.seekAndPlay(12); assert.equal(playing, true);
  assert.deepEqual(calls.slice(-2), [['seek', 12], 'play']);
  await player.pause(); assert.equal(playing, false); assert.equal(calls.at(-1), 'pause');
  player.destroy(); assert.equal(winHandlers.size, 0); assert.equal(docHandlers.size, 0);
});
test('renderer uses canonical DOM, metadata envelopes, callbacks and queue revisions', async t => {
  const doc = rendererDocument();
  const settings = { ytDlpPath: 'yt', ffmpegPath: 'ff', outputDir: 'out', cutMode: 'accurate', format: 'mkv', alwaysUseLocalPlayer: false };
  let push, captured, loaded, timeline;
  const actions = [];
  const ytcut = {
    onQueueChanged(fn) { push = fn; return () => {}; },
    async bootstrap() { push({ revision: 3, items: [] }); return { ok: true, value: { settings, revision: 2, items: [{ snapshot: snapshot() }] } }; },
    async metadata(input) { assert.equal(typeof input.requestId, 'string'); return { ok: true, value: { requestId: input.requestId, video: snapshot().video } }; },
    async add(input) { captured = input.snapshot; return { ok: true, value: {} }; },
    async saveSettings(input) { return { ok: true, value: input }; },
    async chooseOutput() { return { ok: true, value: { outputDir: 'chosen' } }; },
    async cancel(id) { actions.push(['cancel', id]); return { ok: true, value: {} }; },
    async retry(id) { actions.push(['retry', id]); return { ok: true, value: {} }; },
    async openOutput(id) { actions.push(['openOutput', id]); return { ok: true, value: {} }; },
  };
  const app = createApp({ document: doc, ytcut,
    player: { async load(id, sec) { loaded = [id, sec]; }, async seekAndPlay() {}, destroy() {} },
    timelineView: { set(video, state) { timeline = state; }, destroy() {} },
  });
  t.after(() => app.dispose());
  assert.equal(app.getState().format, 'mp4');
  assert.equal(doc.getElementById('editor-format').disabled, true);
  assert.equal(doc.getElementById('start-handle').disabled, true);
  await app.bootstrapped;
  assert.equal(app.getState().format, 'mkv'); // Saved settings override the MP4 default.
  assert.equal(doc.getElementById('queue-list').children.length, 0);
  await app.edit(snapshot().video);
  assert.deepEqual(loaded, ['abcdefghijk', 0]);
  assert.equal(timeline.endSec, 60);
  assert.equal(doc.getElementById('download-button').disabled, false);
  doc.getElementById('editor-format').value = 'mp4'; await doc.getElementById('editor-format').emit('change');
  await doc.getElementById('download-button').emit('click');
  assert.equal(captured.format, 'mp4'); assert.equal(captured.video.durationSec, 60);
  doc.getElementById('settings-format').value = 'mkv'; await doc.getElementById('settings-form').emit('submit');
  assert.equal(app.getState().format, 'mp4');
  await doc.getElementById('choose-output-button').emit('click');
  assert.equal(doc.getElementById('output-dir').value, 'chosen');
  const queued = { id: 'queued', snapshot: snapshot('mkv'), status: 'running', progress: 25 };
  queued.snapshot.video.title = '<img src=x onerror=alert(1)>';
  push({ revision: 4, items: [queued] });
  const queue = doc.getElementById('queue-list');
  const row = queue.children[0];
  assert.equal(doc.getElementById('queue-count').textContent, '1');
  assert.equal(doc.getElementById('queue-empty').hidden, true);
  assert.equal(row.children[0].textContent, queued.snapshot.video.title);
  assert.match(row.title, /MKV/);
  assert.equal(row.children[1].children[1].textContent, '진행 25%');
  assert.equal(row.children[2].children[0].value, 25);
  const buttons = row.children.at(-1).children;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].getAttribute('data-action'), 'cancel');
  await buttons[0].emit('click');
  assert.deepEqual(actions, [['cancel', 'queued']]);
  await row.emit('click');
  await until(() => app.getState().format === 'mkv' && !doc.getElementById('download-button').disabled);
  assert.equal(app.getState().timeline.endSec, 30);
  assert.match(row.className, /active/);
  assert.equal(doc.getElementById('start-handle').disabled, false);
  assert.equal(doc.getElementById('editor-cut-mode').disabled, false);
  for (const status of ['waiting', 'completed', 'failed', 'cancelled']) {
    push({ revision: 5 + ['waiting', 'completed', 'failed', 'cancelled'].indexOf(status), items: [{ ...queued, status }] });
    const current = queue.children[0];
    assert.match(current.className, new RegExp('status-' + status));
    if (['failed', 'cancelled'].includes(status)) {
      assert.equal(current.children.at(-1).children[0].getAttribute('data-action'), 'retry');
      await current.children.at(-1).children[0].emit('click');
      assert.deepEqual(actions.at(-1), ['retry', 'queued']);
    }
  }
  push({ revision: 20, items: [] });
  assert.equal(doc.getElementById('queue-empty').hidden, false);
  assert.equal(doc.getElementById('queue-count').textContent, '0');
  push({ settings: { ...settings, format: undefined } });
  await app.edit(snapshot().video);
  assert.equal(app.getState().format, 'mp4');
});

test('queue renders newest first without mutating storage order and restores the sorted selection', async t => {
  const doc = rendererDocument();
  let push;
  const app = createApp({ document: doc,
    ytcut: { onQueueChanged(fn) { push = fn; }, async bootstrap() { return { ok: true, value: { settings: { alwaysUseLocalPlayer: false } } }; },
      async metadata(input) { return { ok: true, value: { requestId: input.requestId, video: snapshot().video } }; } },
    player: { async load() {}, destroy() {} }, timelineView: { set() {}, destroy() {} },
  });
  t.after(() => app.dispose()); await app.bootstrapped;
  const old = { id: 'old', status: 'waiting', createdAt: '2026-10-09T00:00:00Z', snapshot: snapshot() };
  const newest = { id: 'new', status: 'completed', createdAt: '2026-10-10T00:00:00Z', snapshot: snapshot('mp4') };
  newest.snapshot.timeline = { startSec: 4, endSec: 20, zoom: 8, scrollSec: 3, playheadSec: 7 };
  newest.snapshot.cutMode = 'fast'; newest.snapshot.video.title = 'Newest'; old.snapshot.video.title = 'Oldest';
  const items = [old, newest]; push({ revision: 1, items });
  const root = doc.getElementById('queue-list');
  assert.deepEqual(root.children.map(row => row.children[0].textContent), ['Newest', 'Oldest']);
  assert.deepEqual(items.map(item => item.id), ['old', 'new']);
  await root.children[0].emit('click');
  await until(() => !doc.getElementById('download-button').disabled);
  assert.deepEqual(app.getState().timeline, newest.snapshot.timeline);
  assert.equal(app.getState().format, 'mp4'); assert.equal(app.getState().cutMode, 'fast');
  assert.match(root.children[0].className, /active/); assert.doesNotMatch(root.children[1].className, /active/);
  const fresh = { ...newest, id: 'fresh', createdAt: Date.parse('2026-10-11T00:00:00Z'), snapshot: snapshot() };
  fresh.snapshot.video.title = 'Fresh'; push({ revision: 2, items: [...items, fresh] });
  assert.equal(root.children[0].children[0].textContent, 'Fresh');
  await root.children[2].emit('keydown', { key: 'Enter' });
  assert.match(root.children[2].className, /active/); assert.doesNotMatch(root.children[1].className, /active/);
});

test('queue status actions use SVG, stop bubbling, and surface backend errors', async t => {
  const doc = rendererDocument(); const calls = []; let push, metadataCalls = 0;
  const ytcut = { onQueueChanged(fn) { push = fn; }, async bootstrap() { return { ok: true, value: {} }; },
    async metadata() { metadataCalls++; throw new Error('Unexpected restore'); },
    async rename(id, fileName) { calls.push(['rename', id, fileName]); return { ok: true, value: { id, fileName } }; } };
  for (const action of ['cancel', 'retry', 'openOutput', 'openFile', 'deleteFile', 'remove']) {
    ytcut[action] = async id => { calls.push([action, id]); return action === 'deleteFile'
      ? { ok: false, error: { message: 'Delete failed' } } : { ok: true, value: {} }; };
  }
  const app = createApp({ document: doc, ytcut, player: { destroy() {} }, timelineView: { destroy() {} } });
  t.after(() => app.dispose()); await app.bootstrapped;
  const cases = [
    ['waiting', false, ['rename', 'cancel']], ['running', false, ['cancel']],
    ['completed', false, ['rename', 'openOutput', 'openFile', 'deleteFile', 'remove']],
    ['completed', true, ['openOutput', 'remove']],
    ['failed', false, ['rename', 'retry', 'openOutput', 'remove']], ['cancelled', false, ['rename', 'retry', 'openOutput', 'remove']],
  ];
  for (const [index, [status, fileDeleted, expected]] of cases.entries()) {
    push({ revision: index, items: [{ id: 'item', snapshot: snapshot(), status, fileDeleted, progress: 42,
      outputPath: status === 'completed' && !fileDeleted ? '/out/영상.mkv' : null,
      error: status === 'failed' ? { code: 'FAILED', message: 'Full error detail' } : null }] });
    const row = doc.getElementById('queue-list').children[0];
    assert.equal(row.children.length, 4);
    const buttons = row.children.at(-1).children;
    assert.deepEqual(buttons.map(button => button.getAttribute('data-action')), expected);
    if (fileDeleted) assert.equal(row.children[1].children[1].textContent, '삭제된 파일');
    // 예전 stderr 원문은 화면에 노출하지 않고 안전한 문구로 바꿔 보여 준다.
    if (status === 'failed') { assert.match(row.title, /콘텐츠 정보를 가져오지 못했습니다/); assert.doesNotMatch(row.title, /Full error detail/); }
    for (const button of buttons) {
      assert.equal(button.textContent, undefined);
      assert.equal(button.getAttribute('data-tip'), button.getAttribute('aria-label'));
      assert.equal(button.children[0].namespaceURI, 'http://www.w3.org/2000/svg');
      assert.equal(button.children[0].tagName, 'svg');
      assert.ok(button.children[0].children[0].getAttribute('d'));
      const action = button.getAttribute('data-action');
      assert.equal(button.className.includes('destructive'), ['deleteFile', 'remove'].includes(action));
      assert.equal(await button.emit('click'), true);
      if (action === 'rename') {
        const input = row.children[0].children[0]; assert.equal(input.tagName, 'INPUT');
        await input.emit('keydown', { key: 'Escape' });
        continue;
      }
      assert.deepEqual(calls.at(-1), [action, 'item']);
      if (action === 'deleteFile') assert.equal(doc.getElementById('app-error').textContent, 'Delete failed');
    }
    assert.doesNotMatch(row.className, /active/);
  }
  assert.equal(metadataCalls, 0);
  ytcut.openFile = async () => { throw new Error('Open failed'); };
  push({ revision: 10, items: [{ id: 'item', snapshot: snapshot(), status: 'completed', outputPath: '/out/영상.mkv' }] });
  await doc.getElementById('queue-list').children[0].children.at(-1).children[2].emit('click');
  assert.equal(doc.getElementById('app-error').textContent, 'Open failed');
});

test('settings modal resets saved fields, preserves categories, saves all values and returns focus', async t => {
  const doc = rendererDocument();
  const saved = { ytDlpPath: 'yt', ffmpegPath: 'ff', outputDir: 'out', cutMode: 'fast', format: 'mkv', autoUpdateYtDlp: false };
  let payload, fail = false;
  const app = createApp({ document: doc, player: { destroy() {} }, timelineView: { destroy() {} }, ytcut: {
    onQueueChanged() {}, async bootstrap() { return { ok: true, value: { settings: saved } }; },
    async saveSettings(input) { payload = input; return fail ? { ok: false, error: { message: 'Save failed' } } : { ok: true, value: input }; },
  } });
  t.after(() => app.dispose()); await app.bootstrapped;
  const node = id => doc.getElementById(id), dialog = node('settings-dialog');
  node('output-dir').value = 'unsaved';
  await node('settings-button').emit('click');
  assert.equal(dialog.modalCalls, 1); assert.equal(dialog.open, true);
  assert.equal(node('output-dir').value, 'out'); assert.equal(node('auto-update-ytdlp').checked, false);
  assert.equal(node('settings-panel-general').hidden, false);
  node('output-dir').value = 'new';
  await node('settings-tab-general').emit('keydown', { key: 'ArrowDown' });
  assert.equal(node('settings-tab-tools').getAttribute('aria-selected'), 'true');
  assert.equal(node('settings-tab-tools').tabIndex, 0); assert.equal(node('settings-tab-general').tabIndex, -1);
  assert.equal(node('settings-tab-tools').focused, true);
  node('yt-dlp-path').value = 'new-yt';
  await node('settings-tab-tools').emit('keydown', { key: 'End' });
  assert.equal(node('settings-panel-update').hidden, false);
  await node('settings-tab-update').emit('keydown', { key: 'Home' });
  assert.equal(node('output-dir').value, 'new');
  await node('settings-tab-general').emit('keydown', { key: 'ArrowUp' });
  assert.equal(node('settings-panel-update').hidden, false);
  fail = true; await node('settings-form').emit('submit');
  assert.equal(dialog.open, true); assert.equal(node('settings-error').textContent, 'Save failed');
  assert.equal(node('app-error').textContent, 'Save failed');
  fail = false; await node('settings-form').emit('submit');
  assert.deepEqual(payload, { ...saved, outputDir: 'new', ytDlpPath: 'new-yt', autoUpdateFfmpeg: false, previewResolution: 480, alwaysUseLocalPlayer: true });
  assert.equal(dialog.open, false); assert.equal(node('settings-button').focused, true);
  await node('settings-button').emit('click'); assert.equal(node('settings-panel-general').hidden, false);
  node('output-dir').value = 'discard'; await node('settings-close-button').emit('click');
  await node('settings-button').emit('click'); assert.equal(node('output-dir').value, 'new');
  await dialog.emit('click', { clientX: 20, clientY: 20 }); assert.equal(dialog.open, true);
  await dialog.emit('click', { clientX: 0, clientY: 0 }); assert.equal(dialog.open, false);
  await node('settings-button').emit('click'); await node('settings-dismiss-button').emit('click');
  assert.equal(dialog.open, false); assert.equal(node('settings-button').focused, true);
});

test('open settings dialog leaves global shortcuts untouched and closing restores them', async t => {
  const f = await keyboardFixture(t);
  await f.doc.getElementById('settings-button').emit('click');
  for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'I', 'O', 'P']) {
    for (const type of ['keydown', 'keyup']) {
      const event = await f.key(key, { target: f.doc.getElementById('settings-tab-general') }, type);
      assert.equal(event.defaultPrevented, undefined);
    }
  }
  assert.deepEqual(f.seeks, []); assert.deepEqual(f.toggles, []); assert.deepEqual(f.previews, []);
  assert.equal(f.app.getState().timeline.startSec, 0); assert.equal(f.app.getState().timeline.endSec, 60);
  await f.doc.getElementById('settings-close-button').emit('click');
  assert.equal(f.doc.getElementById('settings-button').focused, true);
  assert.equal((await f.key('ArrowRight')).defaultPrevented, true);
  assert.equal((await f.key(' ')).defaultPrevented, true);
  assert.equal((await f.key('I')).defaultPrevented, true);
  assert.equal((await f.key('O')).defaultPrevented, true);
  assert.equal((await f.key('P')).defaultPrevented, true);
  assert.equal(f.seeks.length, 1); assert.equal(f.toggles.length, 1); assert.ok(f.previews.length);
});

test('fallback buffering reuses loading overlay and ignores callbacks from old video', async t => {
  const f = await fallbackFixture(t);
  await f.app.edit(snapshot().video); await until(() => f.node('loading-overlay').hidden);
  const old = f.options();
  old.onBuffering(true); assert.equal(f.node('loading-overlay').hidden, false);
  assert.equal(f.label.textContent, '탐색 중…'); assert.equal(f.node('load-button').disabled, false);
  old.onBuffering(false); assert.equal(f.node('loading-overlay').hidden, true);
  await f.app.edit(snapshot().video); await until(() => f.node('loading-overlay').hidden);
  old.onBuffering(true); assert.equal(f.node('loading-overlay').hidden, true);
});

test('second add remains persisted waiting while the first process owns the slot', async t => {
  const f = await fixture(t);
  const a = await f.jobs.add(snapshot(), f.settings);
  const b = await f.jobs.add(snapshot('mp4'), f.settings);
  assert.equal(f.children.length, 1);
  assert.deepEqual((await f.store.load()).document.items.map(item => item.status), ['running', 'waiting']);
  await complete(f, 0, a);
  await until(() => f.children.length === 2);
  assert.equal(f.jobs.list().find(item => item.id === b.id).status, 'running');
});

test('new jobs with the same real store recover running as INTERRUPTED and resume waiting', async t => {
  const f = await fixture(t);
  const a = await f.jobs.add(snapshot(), f.settings);
  const b = await f.jobs.add(snapshot('mp4'), f.settings);
  // Preserve the crash image before graceful shutdown mutates it.
  const crash = (await f.store.load()).document;
  await f.jobs.shutdown(); await f.store.save(crash);
  const restarted = createJobs({ store: f.store, runner: f.runner, uuid: randomUUID });
  f.instances.push(restarted);
  await restarted.init();
  assert.equal(restarted.list().find(item => item.id === a.id).error.code, 'INTERRUPTED');
  assert.equal(restarted.list().find(item => item.id === a.id).status, 'failed');
  assert.equal(restarted.list().find(item => item.id === b.id).status, 'running');
  assert.equal(f.children.length, 2);
});

test('real runner argv follows immutable snapshot format rather than settings format', async t => {
  const f = await fixture(t);
  const input = snapshot('mkv'); const a = await f.jobs.add(input, f.settings);
  input.format = 'mp4';
  await f.jobs.add(snapshot('mp4'), { ...f.settings, format: 'mkv' });
  const mkv = f.children[0].args;
  assert.equal(mkv[mkv.indexOf('--merge-output-format') + 1], 'mkv');
  assert.equal(mkv.includes('--remux-video'), false);
  await complete(f, 0, a); await until(() => f.children.length === 2);
  const mp4 = f.children[1].args;
  assert.equal(mp4[mp4.indexOf('--merge-output-format') + 1], 'mp4');
  assert.equal(mp4[mp4.indexOf('--remux-video') + 1], 'mp4');
  assert.equal(mp4[mp4.indexOf('-S') + 1], 'vcodec:h264,acodec:aac');
  assert.match(mp4[mp4.indexOf('-f') + 1], /avc1.*mp4a/);
});

async function nameFixture(t) {
  const doc = rendererDocument(), calls = [], downloads = [], saves = [];
  let push, metadataCalls = 0, revision = 0;
  const ytcut = {
    onQueueChanged(fn) { push = fn; },
    async bootstrap() { return { ok: true, value: { settings: { outputDir: 'D:/old', format: 'mp4', cutMode: 'accurate', alwaysUseLocalPlayer: false } } }; },
    async metadata({ requestId }) { metadataCalls++; return { ok: true, value: { requestId, video: snapshot().video } }; },
    async add(input) { downloads.push(input); return { ok: true, value: {} }; },
    async saveSettings(input) { saves.push(input); return { ok: true, value: input }; },
    async chooseOutput() { return { ok: true, value: { outputDir: null } }; },
    async rename(id, fileName) { calls.push({ id, fileName }); return { ok: true, value: { id, fileName } }; },
  };
  const app = createApp({ document: doc, ytcut, player: { async load() {}, destroy() {} }, timelineView: { set() {}, destroy() {} } });
  t.after(() => app.dispose()); await app.bootstrapped;
  const node = id => doc.getElementById(id);
  const row = () => node('queue-list').children[0];
  const item = { id: 'name', status: 'waiting', fileName: '원래', snapshot: snapshot('mp4'), execution: { outputLayout: 'flat-v1' } };
  const show = value => { push({ revision: ++revision, items: [value] }); };
  const begin = async () => { await row().children.at(-1).children.find(button => button.getAttribute('data-action') === 'rename').emit('click'); return row().children[0].children[0]; };
  return { doc, app, ytcut, calls, downloads, saves, node, row, item, show, begin, metadataCalls: () => metadataCalls };
}

test('C-11 named download captures 여행 and selected mkv snapshot', async t => {
  const f = await nameFixture(t); await f.app.edit(snapshot().video);
  f.node('file-name-input').value = '여행'; await f.node('file-name-input').emit('input');
  f.node('editor-format').value = 'mkv'; await f.node('editor-format').emit('change');
  await f.node('download-button').emit('click');
  assert.deepEqual(f.downloads, [{ snapshot: { ...snapshot('mkv'), fileName: '여행', timeline: { ...snapshot().timeline, endSec: 60 } } }]);
});
test('C-11 empty download preserves empty fileName', async t => {
  const f = await nameFixture(t); await f.app.edit(snapshot().video); await f.node('download-button').emit('click');
  assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0].snapshot.fileName, '');
});
test('C-11 new video resets requested file name', async t => {
  const f = await nameFixture(t); await f.app.edit(snapshot().video);
  f.node('file-name-input').value = '여행'; await f.node('file-name-input').emit('input');
  await f.app.edit({ ...snapshot().video, url: 'https://youtu.be/lmnopqrstuv' });
  assert.equal(f.app.getState().fileName, ''); assert.equal(f.node('file-name-input').value, '');
});
test('C-11 queue restore uses current name over immutable snapshot name', async t => {
  const f = await nameFixture(t); f.show({ ...f.item, fileName: '현재', snapshot: { ...snapshot(), fileName: '생성' } });
  await f.row().emit('click'); await until(() => !f.node('download-button').disabled);
  assert.equal(f.app.getState().fileName, '현재'); assert.equal(f.node('file-name-input').value, '현재');
});
test('C-11 choose cancellation preserves outputDir and selection reaches save', async t => {
  const f = await nameFixture(t); await f.node('settings-button').emit('click');
  await f.node('choose-output-button').emit('click'); assert.equal(f.node('output-dir').value, 'D:/old');
  f.ytcut.chooseOutput = async () => ({ ok: true, value: { outputDir: 'D:/new' } });
  await f.node('choose-output-button').emit('click'); await f.node('settings-form').emit('submit');
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].outputDir, 'D:/new');
});
test('C-11 file name input excludes Space I O shortcuts and HTML remains accessible without inline CSP violations', async t => {
  const f = await keyboardFixture(t), input = f.doc.getElementById('file-name-input');
  const before = structuredClone(f.app.getState().timeline);
  for (const key of [' ', 'I', 'O']) for (const type of ['keydown', 'keyup']) assert.equal((await f.key(key, { target: input }, type)).defaultPrevented, undefined);
  assert.deepEqual(f.toggles, []); assert.deepEqual(f.seeks, []); assert.equal(f.adds, 0);
  assert.deepEqual(f.app.getState().timeline, before);
  const html = await fs.readFile('renderer/index.html', 'utf8');
  assert.match(html, /<label for="file-name-input">파일명<\/label>/);
  assert.match(html, /<input id="file-name-input"[^>]*maxlength="120"/);
  assert.doesNotMatch(html, /\bstyle\s*=|<style\b|\bon\w+\s*=/i);
});

test('C-12 waiting names retain specified extension and empty flat or legacy video titles', async t => {
  const f = await nameFixture(t);
  for (const execution of [{ outputLayout: 'flat-v1' }, {}]) {
    f.show({ ...f.item, execution, fileName: '여행' }); assert.equal(f.row().children[0].textContent, '여행.mp4');
    f.show({ ...f.item, execution, fileName: '' }); assert.equal(f.row().children[0].textContent, '영상');
  }
  const legacy = { ...f.item, execution: {}, snapshot: { ...snapshot('mp4') } }; delete legacy.fileName; delete legacy.snapshot.fileName;
  f.show(legacy); assert.equal(f.row().children[0].textContent, '영상');
});
test('C-12 completed actual output name and deleted label retain title and restore actions', async t => {
  const f = await nameFixture(t), completed = { ...f.item, status: 'completed', outputPath: '/out/여행 (2).mp4', outputFileName: '여행 (2).mp4' };
  f.show(completed); assert.equal(f.row().children[0].textContent, '여행 (2).mp4'); assert.ok(await f.begin());
  f.show({ ...completed, fileDeleted: true, outputPath: null });
  assert.equal(f.row().children[0].children.length, 0); assert.equal(f.row().children[0].textContent, '여행 (2).mp4');
  assert.equal(f.row().children[1].children[1].textContent, '삭제된 파일');
  assert.deepEqual(f.row().children.at(-1).children.map(node => node.getAttribute('data-action')), ['openOutput', 'remove']);
  assert.equal(f.calls.length, 0);
  f.show(completed); assert.ok(await f.begin());
});
test('C-12 Enter commits once while Escape and blur commit zero times', async t => {
  for (const [event, key, count] of [['keydown', 'Enter', 1], ['keydown', 'Escape', 0], ['blur', undefined, 0]]) {
    const f = await nameFixture(t); f.show(f.item); const input = await f.begin();
    input.value = '여행'; await input.emit('input'); await input.emit(event, { key });
    await until(() => f.row().children[0].children.length === 0);
    assert.equal(f.calls.length, count); if (count) assert.deepEqual(f.calls[0], { id: 'name', fileName: '여행' });
    assert.equal(f.row().children[0].textContent, count ? '여행.mp4' : '원래.mp4');
  }
});
test('C-12 progress push preserves draft focus and selection', async t => {
  const f = await nameFixture(t); f.show(f.item); const input = await f.begin();
  input.value = '여행 초안'; await input.emit('input'); input.setSelectionRange(1, 3, 'backward');
  f.show({ ...f.item, progress: 42 });
  assert.equal(f.row().children[0].children[0], input); assert.equal(f.doc.activeElement, input);
  assert.equal(input.value, '여행 초안'); assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 3, 'backward']);
  assert.equal(f.row().children[2].children[0].value, 42); assert.equal(f.calls.length, 0);
});
test('C-12 rename errors preserve draft and old title before successful reentry', async t => {
  for (const code of ['INVALID_FILE_NAME', 'OUTPUT_NAME_CONFLICT', 'OUTPUT_RENAME_FAILED']) {
    const f = await nameFixture(t); f.show({ ...f.item, status: 'completed', outputPath: '/out/원래.mp4', outputFileName: '원래.mp4' });
    const input = await f.begin(); input.value = '실패 초안'; await input.emit('input');
    let resolve; f.ytcut.rename = (id, fileName) => { f.calls.push({ id, fileName }); return new Promise(done => { resolve = done; }); };
    await input.emit('keydown', { key: 'Enter' }); await input.emit('keydown', { key: 'Enter' });
    assert.equal(f.calls.length, 1); assert.match(f.row().title, /^원래\.mp4\n/);
    resolve({ ok: false, error: { code, message: 'EPERM 파일 접근 거부' } });
    await until(() => f.row().children[1].children[2].textContent.includes(code));
    assert.equal(f.row().children[0].children[0], input); assert.equal(input.value, '실패 초안');
    assert.equal(f.row().children[1].children[2].textContent, code + ': EPERM 파일 접근 거부'); assert.match(f.row().title, /^원래\.mp4\n/);
    f.ytcut.rename = async (id, fileName) => { f.calls.push({ id, fileName }); return { ok: true, value: { id, fileName, outputFileName: fileName + '.mp4' } }; };
    input.value = '여행'; await input.emit('input'); await input.emit('keydown', { key: 'Enter' });
    await until(() => f.row().children[0].children.length === 0);
    assert.equal(f.row().children[0].textContent, '여행.mp4'); assert.equal(f.calls.length, 2);
  }
});
test('C-12 edit events never restore and running active transitions and IME block submission', async t => {
  const f = await nameFixture(t); f.show(f.item); const input = await f.begin();
  await input.emit('click'); input.value = '여행'; await input.emit('input');
  await input.emit('compositionstart'); await input.emit('keydown', { key: 'Enter' }); await input.emit('compositionend');
  await input.emit('keydown', { key: 'Enter', isComposing: true }); await input.emit('keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(f.calls.length, 0); assert.equal(f.metadataCalls(), 0);
  f.show({ ...f.item, status: 'running' }); assert.equal(f.row().children[0].children.length, 0);
  assert.equal(f.row().children.at(-1).children.some(node => node.getAttribute('data-action') === 'rename'), false);
  f.show({ ...f.item, renameAllowed: false });
  const button = f.row().children.at(-1).children[0]; assert.equal(button.disabled, true);
  await button.emit('click'); assert.equal(f.row().children[0].children.length, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.metadataCalls(), 0);
});

async function mainHarness(jobs, options = {}) {
  const handlers = new Map(), windows = [], opened = [], errors = [], sent = [];
  const createTestTool = (toolId, getSettings) => {
    const pathKey = toolId === 'ytDlp' ? 'ytDlpPath' : 'ffmpegPath';
    const defaultCommand = toolId === 'ytDlp' ? 'yt-dlp' : 'ffmpeg';
    const selected = () => {
      const binary = getSettings()[pathKey] ?? defaultCommand;
      return { path: binary, source: binary === defaultCommand ? 'path' : 'custom', usable: true, version: 'test' };
    };
    const getState = () => {
      const tool = selected();
      return { toolId, status: tool.source === 'custom' ? 'disabled' : 'idle', source: tool.source,
        usable: tool.usable, currentVersion: tool.version, revision: 0, latestVersion: null,
        currentReleaseTag: null, candidateId: null, downloadBytes: null, downloadedBytes: 0,
        percent: null, manual: false, needsInstall: false, canDownload: false, canRollback: false, error: null };
    };
    const settle = async () => getState();
    return { effective: async () => selected(), getState, refreshSettings: settle, ensureInstalled: settle,
      queueChanged: settle, check: settle, download: settle, start() {}, stop() {},
      withExecution: callback => callback(), withToolUse: callback => callback() };
  };
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: { url: 'http://127.0.0.1:1234/renderer/index.html' },
        send: (channel, value) => sent.push([channel, structuredClone(value)]),
        setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeSendHeaders() {} } } });
    }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
  }
  const source = (await fs.readFile('main.js', 'utf8')).split('async function initialize()')[0]
    .replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../main.js', import.meta.url).href));
  const context = vm.createContext({ path, fileURLToPath: url => new URL(url).pathname, URL, structuredClone,
    app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir(), setPath() {} }, getLegacyUserDataPath, AsyncLocalStorage, safeToolError, createYtdlpUpdater: () => ({}), createManagedTool: () => ({}), createFfmpegDescriptor: () => ({}), createRunner: () => options.runner || {}, createPreviewStream: () => options.preview || {}, updaterPkg: { autoUpdater: {} },
    stat: fs.stat, mkdir: fs.mkdir, access: fs.access, constants, isDeepStrictEqual, normalizeYouTubeUrl, normalizeFileName, validateStateSnapshot,
    BrowserWindow: Window, Menu: { setApplicationMenu() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { showItemInFolder: target => opened.push(['file', target]), openPath: async target => { opened.push(['folder', target]); return ''; } },
    console: { error: (...args) => errors.push(args) }, createTestTool, injectedJobs: jobs, injectedSettings: options.settings });
  vm.runInContext(source + '\njobs = injectedJobs; settings = injectedSettings || structuredClone(defaults); ytdlpUpdater = createTestTool("ytDlp", () => settings); ffmpegUpdater = createTestTool("ffmpeg", () => settings); mainURL = "http://127.0.0.1:1234/renderer/index.html"; installIPC(); globalThis.makeWindow = createWindow; globalThis.migrate = migrateSettings; globalThis.readSettings = () => structuredClone(settings); globalThis.reconcile = reconcileTools;', context);
  if (typeof jobs.resume === 'function') await context.reconcile();
  await context.makeWindow();
  const window = windows[0];
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { handlers, window, event, opened, errors, sent, context };
}

test('C-13 real store preserves UTF8 flat names missing paths and legacy nested format migration', async t => {
  const f = await fixture(t), item = await f.jobs.add({ ...snapshot(), fileName: '여행' }, f.settings);
  await complete(f, 0, item);
  const flat = f.jobs.list()[0]; await fs.unlink(flat.outputPath); await f.jobs.refreshCompletedFiles();
  const saved = (await f.store.load()).document;
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.items[0].snapshot.fileName, '여행');
  assert.equal(saved.items[0].fileName, '여행'); assert.equal(saved.items[0].execution.outputLayout, 'flat-v1');
  assert.equal(saved.items[0].missingOutputPath, path.join(f.directory, '여행.mkv'));
  assert.equal(saved.items[0].fileDeleted, true); assert.equal(saved.items[0].outputPath, null);
  await f.jobs.shutdown();
  const legacy = { ...saved.items[0], status: 'waiting', fileDeleted: false, outputPath: null };
  delete legacy.execution.outputLayout; delete legacy.snapshot.format; delete legacy.missingOutputPath;
  await f.store.save({ ...saved, settings: { ...f.settings, format: 'mkv' }, items: [legacy] });
  const restarted = createJobs({ store: f.store, runner: f.runner }); f.instances.push(restarted); await restarted.init();
  const running = restarted.list()[0]; assert.equal(running.snapshot.format, 'mkv'); assert.equal(running.execution.outputLayout, undefined);
  const file = path.join(f.directory, running.id, `attempt-${running.attempt}`, 'clip.mkv');
  await fs.mkdir(path.dirname(file), { recursive: true }); // flat 완료 뒤 임시 폴더는 정리되므로 legacy 시나리오용으로 다시 만든다
  await fs.writeFile(file, 'legacy media'); f.children[1].child.stdout.write(`ytcut-output:${JSON.stringify(file)}\n`); f.children[1].child.emit('close', 0);
  await until(() => restarted.list()[0].status === 'completed'); assert.equal(restarted.list()[0].outputPath, file);
});
test('C-13 title defaults collisions and waiting rename reach runner without mutating snapshot execution', async t => {
  const f = await fixture(t); const a = await f.jobs.add(snapshot(), f.settings);
  const b = await f.jobs.add(snapshot(), f.settings), c = await f.jobs.add(snapshot('mp4'), f.settings);
  const before = f.jobs.list().find(item => item.id === c.id);
  const response = await f.jobs.rename(c.id, '여행'); assert.equal(response.ok, true);
  assert.deepEqual(response.value.snapshot, before.snapshot); assert.deepEqual(response.value.execution, before.execution);
  await complete(f, 0, a); await until(() => f.children.length === 2); await complete(f, 1, f.jobs.list().find(item => item.id === b.id));
  await until(() => f.children.length === 3); await complete(f, 2, f.jobs.list().find(item => item.id === c.id));
  assert.deepEqual(f.jobs.list().map(item => item.outputPath), ['영상.mkv', '영상 (2).mkv', '여행.mp4'].map(name => path.join(f.directory, name)));
  for (const name of ['영상.mkv', '영상 (2).mkv', '여행.mp4']) assert.equal(await fs.readFile(path.join(f.directory, name), 'utf8'), 'fake media');
  const failures = [];
  if (f.jobs.list().some(item => item.outputFileName !== path.basename(item.outputPath))) failures.push('완료 항목 outputFileName 누락');
  for (const [title, expected] of [['여행: 바다?', '여행_ 바다_'], ['... ', 'clip']]) {
    try {
      const added = await f.jobs.add({ ...snapshot(), video: { ...snapshot().video, title } }, f.settings);
      assert.equal(added.fileName, '');
      await complete(f, f.children.length - 1, added);
      assert.equal(f.jobs.list().find(item => item.id === added.id).outputPath, path.join(f.directory, expected + '.mkv'));
    } catch (error) { failures.push(`${title}: ${error.message}`); }
  }
  assert.deepEqual(failures, [], '제목 기본명 정제와 완료 파일명 계약');
});
test('C-13 completed runtime name changes only after successful rename and persistence', async t => {
  let release;
  const f = await fixture(t, { rename: async (oldPath, newPath) => { await new Promise(done => { release = done; }); await fs.rename(oldPath, newPath); } });
  const item = await f.jobs.add({ ...snapshot('mp4'), fileName: '원래' }, f.settings); await complete(f, 0, item);
  const operation = f.jobs.rename(item.id, '여행'); await until(() => !!release);
  assert.equal(f.jobs.list()[0].fileName, '원래'); assert.equal((await f.store.load()).document.items[0].fileName, '원래');
  release(); const result = await operation; assert.equal(result.ok, true);
  assert.equal(f.jobs.list()[0].outputFileName, '여행.mp4'); assert.equal((await f.store.load()).document.items[0].fileName, '여행');
  assert.equal(f.jobs.list()[0].snapshot.fileName, '원래');
});
test('C-13 preload payload freeze listener and main refresh authorization focus close rejection run in VM', async () => {
  const calls = [], listeners = new Map(); let api, removed = 0;
  const electron = { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'ytcut'); api = value; } }, ipcRenderer: {
    invoke: async (channel, payload) => { calls.push([channel, structuredClone(payload)]); return { ok: true }; },
    on: (channel, listener) => listeners.set(channel, listener), removeListener(channel, listener) { assert.equal(listeners.get(channel), listener); listeners.delete(channel); removed++; },
  } };
  const preload = await fs.readFile('preload.cjs', 'utf8'); vm.runInNewContext(preload, { require: name => { assert.equal(name, 'electron'); return electron; }, process: { isMainFrame: true } });
  assert.equal(Object.isFrozen(api), true); await api.rename('id', '여행'); await api.refreshFiles();
  assert.deepEqual(calls, [['queue:rename', { id: 'id', fileName: '여행' }], ['queue:refresh-files', {}]]);
  let received; const unsubscribe = api.onQueueChanged(value => { received = value; });
  const payload = { revision: 4 }; listeners.get('queue:changed')({}, payload); assert.equal(received, payload);
  unsubscribe(); unsubscribe(); assert.equal(removed, 1);
  api = undefined; vm.runInNewContext(preload, { require: () => electron, process: { isMainFrame: false } }); assert.equal(api, undefined);
  let refreshes = 0, reject = false;
  const h = await mainHarness({ async refreshCompletedFiles() { refreshes++; if (reject) throw Object.assign(new Error('scan failed'), { code: 'SCAN_FAILED' }); }, async rename(id, fileName) { return { id, fileName }; } });
  const refresh = h.handlers.get('queue:refresh-files');
  assert.equal((await refresh(h.event(), {})).value.checked, true); assert.equal(refreshes, 1);
  for (const input of [null, [], undefined, { extra: true }]) assert.equal((await refresh(h.event(), input)).error.code, 'INVALID_UPDATE_REQUEST');
  for (const event of [{ ...h.event(), sender: {} }, { ...h.event(), senderFrame: {} }]) assert.equal((await refresh(event, {})).error.code, 'UNAUTHORIZED');
  h.window.webContents.mainFrame.url += '?wrong'; assert.equal((await refresh(h.event(), {})).error.code, 'UNAUTHORIZED'); h.window.webContents.mainFrame.url = 'http://127.0.0.1:1234/renderer/index.html';
  assert.equal((await h.handlers.get('queue:rename')(h.event(), { id: 'id', fileName: '여행' })).value.fileName, '여행');
  h.window.emit('focus'); await Promise.resolve(); assert.equal(refreshes, 2);
  reject = true; h.window.emit('focus'); await Promise.resolve(); assert.equal(h.errors.length, 1);
  assert.equal((await refresh(h.event(), {})).error.code, 'SCAN_FAILED');
  h.window.emit('closed'); h.window.emit('focus'); await Promise.resolve(); assert.equal(refreshes, 4);
  assert.equal((await refresh(h.event(), {})).error.code, 'UNAUTHORIZED');
});
test('C-13 pointerenter trailing debounce ignores child start focus progress and dispose', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = await nameFixture(t); let refreshes = 0;
  f.app.dispose();
  const app = createApp({ document: f.doc, ytcut: { ...f.ytcut, async refreshFiles() { refreshes++; return { ok: true, value: { checked: true } }; } }, player: { destroy() {} }, timelineView: { destroy() {} } });
  t.after(() => app.dispose()); await app.bootstrapped;
  const root = f.node('queue-list'); const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
  t.mock.timers.tick(2000); await settle(); assert.equal(refreshes, 0);
  await root.emit('focusin'); await root.emit('pointerenter', { target: new RendererNode() }); f.show(f.item);
  t.mock.timers.tick(1000); await settle(); assert.equal(refreshes, 0);
  await root.emit('pointerenter'); t.mock.timers.tick(700); await root.emit('pointerenter');
  t.mock.timers.tick(999); await settle(); assert.equal(refreshes, 0); t.mock.timers.tick(1); await settle(); assert.equal(refreshes, 1);
  await root.children[0].emit('pointerenter'); await root.emit('focusin'); f.show({ ...f.item, progress: 50 });
  t.mock.timers.tick(1500); await settle(); assert.equal(refreshes, 1);
  await root.emit('pointerenter'); app.dispose(); t.mock.timers.tick(1000); await settle(); assert.equal(refreshes, 1);
});
test('C-13 real single file deletion preserves sibling and main opens normal file or deleted folder', async t => {
  const trashed = []; const f = await fixture(t, { confirmDelete: async () => true, trashItem: async target => { trashed.push(target); await fs.unlink(target); } });
  const item = await f.jobs.add({ ...snapshot('mp4'), fileName: '여행' }, f.settings); await complete(f, 0, item);
  const output = f.jobs.list()[0].outputPath, sibling = path.join(f.directory, '보존.mp4'); await fs.writeFile(sibling, 'sibling');
  const h = await mainHarness(f.jobs), open = h.handlers.get('queue:open-output');
  const normal = await open(h.event(), { id: item.id });
  await f.jobs.deleteFile(item.id); assert.deepEqual(trashed, [output]); assert.equal(await fs.readFile(sibling, 'utf8'), 'sibling');
  assert.equal(f.jobs.list()[0].missingOutputPath, output); assert.equal(f.jobs.list()[0].fileDeleted, true);
  const deleted = await open(h.event(), { id: item.id });
  assert.deepEqual({ normal: structuredClone(normal), deleted: structuredClone(deleted), opened: h.opened }, {
    normal: { ok: true, value: { opened: true } }, deleted: { ok: true, value: { opened: true } },
    opened: [['file', output], ['folder', f.directory]],
  });
});

test('P main settings migrate once, persist 360 false, reject invalid values without mutation and accept legacy saves', async t => {
  const f = await fixture(t);
  const h = await mainHarness(f.jobs, { settings: f.jobs.getSettings() });
  await h.context.migrate();
  assert.equal(h.context.readSettings().previewResolution, 480);
  assert.equal(h.context.readSettings().alwaysUseLocalPlayer, true);
  const revision = f.jobs.revision;
  await h.context.migrate(); assert.equal(f.jobs.revision, revision);
  const save = value => h.handlers.get('settings:save')(h.event(), value);
  const next = { ...h.context.readSettings(), previewResolution: 360, alwaysUseLocalPlayer: false, unknown: 'discard' };
  assert.equal((await save(next)).ok, true);
  assert.equal(h.context.readSettings().unknown, undefined);
  const restarted = createJobs({ store: f.store, runner: f.runner }); f.instances.push(restarted); await restarted.init(f.settings);
  const restored = await mainHarness(restarted, { settings: restarted.getSettings() }); await restored.context.migrate();
  assert.equal(restored.context.readSettings().previewResolution, 360); assert.equal(restored.context.readSettings().alwaysUseLocalPlayer, false);
  const saved = await fs.readFile(path.join(f.directory, 'state.json'), 'utf8');
  const before = JSON.stringify(h.context.readSettings());
  for (const value of [null, '480', NaN, 1080, 0, true]) {
    assert.equal((await save({ ...next, previewResolution: value })).error.code, 'INVALID_SETTINGS');
  }
  for (const value of [null, 0, 'false', 1]) {
    assert.equal((await save({ ...next, alwaysUseLocalPlayer: value })).error.code, 'INVALID_SETTINGS');
  }
  assert.equal(JSON.stringify(h.context.readSettings()), before);
  assert.equal(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'), saved);
  for (const height of [360, 480, 720]) assert.equal((await save({ ...next, previewResolution: height })).ok, true);
  const legacy = { ...next }; delete legacy.previewResolution; delete legacy.alwaysUseLocalPlayer;
  assert.equal((await save(legacy)).ok, true);
  assert.equal(h.context.readSettings().previewResolution, 480); assert.equal(h.context.readSettings().alwaysUseLocalPlayer, true);
  assert.equal((await f.store.load()).document.schemaVersion, 1);
});

test('P stored invalid preview values reject migration without saving missing fields', async () => {
  for (const field of ['previewResolution', 'alwaysUseLocalPlayer']) {
    let writes = 0;
    const h = await mainHarness({ async saveSettings() { writes++; } }, { settings: { [field]: null } });
    await assert.rejects(h.context.migrate(), { code: 'INVALID_SETTINGS' });
    assert.equal(writes, 0); assert.equal(h.context.readSettings()[field], null);
    assert.equal(h.context.readSettings().autoUpdateYtDlp, undefined);
  }
});

test('P main prepare forwards whitelist and current default and preload supports one or two arguments', async () => {
  const calls = [], h = await mainHarness({}, { preview: { prepare(...args) { calls.push(args); return { path: '/preview/token.mp4' }; } } });
  const prepare = input => h.handlers.get('preview:prepare')(h.event(), input);
  for (const height of [360, 480, 720]) assert.equal((await prepare({ videoId: 'abcdefghijk', previewResolution: height })).ok, true);
  assert.equal((await prepare({ videoId: 'abcdefghijk' })).ok, true);
  assert.deepEqual(calls.map(args => args[1]), [360, 480, 720, 480]);
  for (const value of [null, '480', NaN, 1080, 0, false]) assert.equal((await prepare({ videoId: 'abcdefghijk', previewResolution: value })).error.code, 'INVALID_PREVIEW_RESOLUTION');
  assert.equal(calls.length, 4);
  const selected = await mainHarness({}, { settings: { previewResolution: 720 }, preview: { prepare(id, height) { assert.equal(height, 720); return {}; } } });
  assert.equal((await selected.handlers.get('preview:prepare')(selected.event(), { videoId: 'abcdefghijk' })).ok, true);
  let api; const payloads = [];
  vm.runInNewContext(await fs.readFile('preload.cjs', 'utf8'), { process: { isMainFrame: true }, require: () => ({
    contextBridge: { exposeInMainWorld(name, value) { api = value; } }, ipcRenderer: { invoke(channel, input) { payloads.push([channel, structuredClone(input)]); } },
  }) });
  api.preparePreview('abcdefghijk'); api.preparePreview('abcdefghijk', 720);
  assert.deepEqual(payloads, [['preview:prepare', { videoId: 'abcdefghijk', previewResolution: undefined }], ['preview:prepare', { videoId: 'abcdefghijk', previewResolution: 720 }]]);
});

test('P main metadata retains Video snapshot verification and hides formats while queue execution excludes preview settings', async t => {
  const f = await fixture(t), cached = [], video = snapshot().video;
  const raw = [{ url: 'https://v.googlevideo.com/private', height: 720 }];
  const h = await mainHarness(f.jobs, { settings: { ...f.settings, autoUpdateYtDlp: true, previewResolution: 720, alwaysUseLocalPlayer: true },
    runner: { async metadataWithStreams(url, settings) { assert.equal(settings.previewResolution, 720); return { video, formats: raw, streams: { muxed: raw[0].url } }; } },
    preview: { cacheFormats(...args) { cached.push(args); } },
  });
  const add = snapshot => h.handlers.get('queue:add')(h.event(), { snapshot });
  assert.equal((await add(snapshot())).error.code, 'INVALID_SNAPSHOT');
  const result = await h.handlers.get('video:metadata')(h.event(), { url: video.url, requestId: 'request' });
  assert.deepEqual(structuredClone(result.value), { requestId: 'request', video });
  assert.deepEqual(cached, [[video.videoId, raw]]); assert.doesNotMatch(JSON.stringify(result), /googlevideo|formats|streams/);
  for (const input of [{ ...snapshot(), video: { ...video, title: 'forged' } }, { ...snapshot(), timeline: { ...snapshot().timeline, endSec: 61 } }]) {
    assert.equal((await add(input)).error.code, 'INVALID_SNAPSHOT');
  }
  const added = await add(snapshot()); assert.equal(added.ok, true);
  assert.equal(added.value.execution.previewResolution, undefined); assert.equal(added.value.execution.alwaysUseLocalPlayer, undefined);
  assert.equal(added.value.snapshot.previewResolution, undefined); assert.equal(added.value.snapshot.alwaysUseLocalPlayer, undefined);
  assert.equal(f.children.length, 1);
});

function deferredPreview() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function previewFixture(t, options = {}) {
  const doc = rendererDocument(), local = [], youtube = [], caps = [];
  const label = new RendererNode(); doc.getElementById('loading-overlay').querySelector = () => label;
  let push;
  const ytcut = {
    onQueueChanged(fn) { push = fn; },
    bootstrap: () => options.bootstrap || Promise.resolve({ ok: true, value: { settings: options.settings || {} } }),
    async metadata({ requestId }) { return options.metadataFailure ? { ok: false, error: new Error('metadata failed') } : { ok: true, value: { requestId, video: snapshot().video } }; },
    async preparePreview(videoId, cap) { caps.push(cap); return options.prepare || { ok: true, value: { path: '/preview/token.mp4' } }; },
    async saveSettings(value) { return { ok: true, value }; },
  };
  const factory = (kind, list) => (id, callbacks) => {
    const record = { callbacks, destroyed: 0, loads: [] }; list.push(record);
    if (options[`${kind}Throw`]) throw new Error('factory failed');
    return record.player = {
      destroy() { record.destroyed++; }, async load(...args) {
        record.loads.push(args);
        if (kind === 'local') await callbacks.prepare(args[0].videoId);
        if (options[`${kind}Load`]) await options[`${kind}Load`](record);
      }, async pause() {}, async seek() {}, async seekAndPlay() {}, getTime() { return 12; },
    };
  };
  const app = createApp({ document: doc, ytcut, timelineView: { set() {}, destroy() {} }, youtubeFactory: factory('youtube', youtube), localFactory: factory('local', local) });
  t.after(() => app.dispose());
  if (!options.bootstrap) await app.bootstrapped;
  return { app, doc, ytcut, local, youtube, caps, label, push: value => push(value), node: id => doc.getElementById(id) };
}

test('P default local mode never creates YouTube, freezes cap and queue restoration uses latest settings without snapshot fields', async t => {
  const f = await previewFixture(t);
  assert.equal(f.local.length, 0); assert.equal(f.youtube.length, 0);
  await f.app.edit(snapshot().video); await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.youtube.length, 0); assert.equal(f.local.length, 1); assert.deepEqual(f.caps, [480]);
  assert.equal(f.local[0].loads[0][0].videoId, 'abcdefghijk');
  assert.equal(f.node('fallback-badge').hidden, false); assert.equal(f.node('player-error').textContent, '');
  f.push({ settings: { previewResolution: 720, alwaysUseLocalPlayer: true } });
  assert.equal(f.local.length, 1);
  await f.local[0].callbacks.prepare('abcdefghijk'); assert.deepEqual(f.caps, [480, 480]);
  const saved = { ...snapshot(), fileName: '현재 이름', timeline: { ...snapshot().timeline, startSec: 5, endSec: 20, playheadSec: 12 } };
  f.push({ revision: 1, items: [{ id: 'queued', status: 'waiting', snapshot: saved }] });
  const row = f.node('queue-list').children[0];
  for (const key of ['Enter', ' ']) {
    await row.emit('keydown', { key }); await until(() => f.node('loading-overlay').hidden);
    assert.equal(f.caps.at(-1), 720); assert.equal(f.app.getState().timeline.playheadSec, 12);
    assert.equal(f.app.getState().format, 'mkv'); assert.equal(f.app.getState().cutMode, 'accurate'); assert.equal(f.app.getState().fileName, '현재 이름');
  }
  assert.equal(f.youtube.length, 0); assert.deepEqual(Object.keys(f.app.getState()).sort(), ['cutMode', 'fileName', 'format', 'timeline', 'video']);
});

test('P bootstrap gates an early edit and respects saved false and 360', async t => {
  const pending = deferredPreview(); const f = await previewFixture(t, { bootstrap: pending.promise });
  const editing = f.app.edit(snapshot().video);
  await Promise.resolve(); assert.equal(f.youtube.length, 0); assert.equal(f.local.length, 0);
  pending.resolve({ ok: true, value: { settings: { alwaysUseLocalPlayer: false, previewResolution: 360 } } });
  await editing; await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.youtube.length, 1); assert.equal(f.local.length, 0);
  f.youtube[0].callbacks.onError({ code: 153, message: 'embed' }); await until(() => f.local.length === 1 && f.node('loading-overlay').hidden);
  assert.deepEqual(f.caps, [360]);
});

for (const failure of ['throw', 'prepare', 'duplicate', 'runtime']) test(`P local ${failure} failure falls back once, ignores stale identity callbacks and does not loop`, async t => {
  const pending = deferredPreview();
  const f = await previewFixture(t, {
    localThrow: failure === 'throw', prepare: failure === 'prepare' ? { ok: false, error: new Error('prepare failed') } : undefined,
    localLoad: failure === 'duplicate' ? record => { const error = new Error('MSE failed'); record.callbacks.onBuffering(true); record.callbacks.onError(error); throw error; } : undefined,
    youtubeLoad: () => pending.promise,
  });
  await f.app.edit(snapshot().video);
  if (failure === 'runtime') {
    await until(() => f.node('loading-overlay').hidden);
    f.local[0].callbacks.onBuffering(true); f.local[0].callbacks.onError(new Error('runtime failed'));
  }
  await until(() => f.youtube.length === 1);
  assert.equal(f.node('loading-overlay').hidden, false); assert.equal(f.label.textContent, 'YouTube 플레이어 불러오는 중…');
  assert.equal(f.node('preview-button').disabled, true); assert.equal(f.node('download-button').disabled, false); assert.equal(f.node('start-input').disabled, false);
  assert.equal(f.node('fallback-badge').hidden, true); assert.equal(f.node('player-error').getAttribute('role'), 'status');
  assert.equal(f.node('player-error').textContent, '대체 플레이어를 준비하지 못해 YouTube 플레이어로 전환합니다.');
  const before = f.app.getState();
  f.local[0].callbacks.onError(new Error('stale')); f.local[0].callbacks.onTime(55); f.local[0].callbacks.onBuffering(true);
  assert.deepEqual(f.app.getState(), before); assert.equal(f.label.textContent, 'YouTube 플레이어 불러오는 중…');
  pending.resolve(); await until(() => f.node('loading-overlay').hidden);
  assert.equal(f.node('preview-button').disabled, false);
  f.youtube[0].callbacks.onError({ code: 150, message: 'iframe failed' });
  assert.equal(f.local.length, 1); assert.equal(f.youtube.length, 1); assert.equal(f.node('player-error').getAttribute('role'), 'alert');
  assert.equal(f.node('preview-button').disabled, true); assert.equal(f.node('download-button').disabled, false);
});

test('P metadata failure creates no player and dispose ignores late local resolution and callbacks', async t => {
  const failed = await previewFixture(t, { metadataFailure: true });
  await failed.app.edit(snapshot().video); assert.equal(failed.local.length, 0); assert.equal(failed.youtube.length, 0);
  assert.equal(failed.node('loading-overlay').hidden, true);
  const pending = deferredPreview(), f = await previewFixture(t, { prepare: pending.promise });
  await f.app.edit(snapshot().video); await until(() => f.local.length === 1);
  f.app.dispose(); const before = f.app.getState();
  pending.resolve({ ok: true, value: { path: '/preview/late.mp4' } });
  f.local[0].callbacks.onError(new Error('late')); f.local[0].callbacks.onBuffering(true); f.local[0].callbacks.onTime(59);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.deepEqual(f.app.getState(), before); assert.equal(f.youtube.length, 0); assert.equal(f.node('loading-overlay').hidden, true); assert.equal(f.node('load-button').disabled, false);
});

test('P iframe fallback duplicate rejection and late success cannot reenable a failed preview', async t => {
  for (const outcome of ['reject', 'late success']) {
    const pending = deferredPreview(), f = await previewFixture(t, { localThrow: true, youtubeLoad: () => pending.promise });
    await f.app.edit(snapshot().video); await until(() => f.youtube.length === 1);
    f.youtube[0].callbacks.onError({ code: 153, message: 'iframe failed' });
    if (outcome === 'reject') pending.reject({ code: 153, message: 'duplicate iframe failure' }); else pending.resolve();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    assert.equal(f.youtube.length, 1); assert.equal(f.local.length, 1); assert.equal(f.node('preview-button').disabled, true);
    assert.equal(f.node('download-button').disabled, false); assert.equal(f.node('loading-overlay').hidden, true); assert.equal(f.node('load-button').disabled, false);
    assert.equal(f.node('player-error').textContent, 'iframe failed'); assert.equal(f.node('player-error').getAttribute('role'), 'alert');
  }
});

test('P modal preview controls save numbers and false, discard cancellation, preserve failure and reopen', async t => {
  const f = await previewFixture(t);
  await f.node('settings-button').emit('click');
  assert.equal(f.node('preview-resolution').value, '480'); assert.equal(f.node('always-use-local-player').checked, true);
  f.node('preview-resolution').value = '720'; f.node('always-use-local-player').checked = false;
  await f.node('settings-close-button').emit('click'); await f.node('settings-button').emit('click');
  assert.equal(f.node('preview-resolution').value, '480'); assert.equal(f.node('always-use-local-player').checked, true);
  f.node('preview-resolution').value = '360'; f.node('always-use-local-player').checked = false;
  f.ytcut.saveSettings = async () => ({ ok: false, error: new Error('save failed') });
  await f.node('settings-form').emit('submit');
  assert.equal(f.node('settings-dialog').open, true); assert.equal(f.node('preview-resolution').value, '360'); assert.equal(f.node('always-use-local-player').checked, false);
  let saved; f.ytcut.saveSettings = async value => { saved = value; return { ok: true, value }; };
  await f.node('settings-form').emit('submit'); assert.equal(saved.previewResolution, 360); assert.equal(saved.alwaysUseLocalPlayer, false);
  assert.equal(f.doc.activeElement, f.node('settings-button'));
  await f.node('settings-button').emit('click'); assert.equal(f.node('preview-resolution').value, '360'); assert.equal(f.node('always-use-local-player').checked, false);
  const html = await fs.readFile('renderer/index.html', 'utf8');
  assert.match(html, /<label for="preview-resolution">미리보기 해상도<\/label>/);
  assert.match(html, /id="preview-resolution"[^>]*aria-describedby="preview-resolution-help"/);
  assert.match(html, /<option value="360">360p<\/option><option value="480" selected>480p<\/option><option value="720">720p<\/option>/);
  assert.match(html, /미리보기에만 적용, 다운로드 화질과 무관/);
  assert.match(html, /<label for="always-use-local-player"><input[^>]*checked[^>]*aria-describedby="always-use-local-player-help"> 항상 대체 플레이어 사용<\/label>/);
});

test('actual server serves every renderer import with YouTube CSP and document referrer policy', async t => {
  const html = await fs.readFile('renderer/index.html', 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const required = new Set();
  for (const file of ['renderer/app.js', 'renderer/timeline-view.js']) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\b(?:el|find|listen|getElementById)\(\s*'([^']+)'/g)) required.add(match[1]);
    for (const id of ['yt-dlp-path', 'ffmpeg-path', 'output-dir', 'cut-mode', 'settings-format', 'player']) required.add(id);
  }
  for (const id of required) assert.ok(ids.has(id), 'Missing HTML id: ' + id);
  for (const key of ['ytDlpPath', 'ffmpegPath', 'outputDir', 'cutMode', 'format', 'autoUpdateYtDlp']) {
    const source = await fs.readFile('renderer/app.js', 'utf8');
    const id = source.match(new RegExp(key + ": '([^']+)'"))[1];
    assert.ok(ids.has(id), 'Missing settings id: ' + id);
  }
  assert.equal(ids.size, [...html.matchAll(/\bid="([^"]+)"/g)].length, 'No duplicate IDs');
  assert.doesNotMatch(html, /\bstyle\s*=|<style\b|\bon\w+\s*=/i);
  assert.doesNotMatch(html, /<details\b/);
  assert.match(html, /<dialog id="settings-dialog"/);
  assert.match(html, /form="settings-form"/);
  for (const category of ['general', 'tools', 'update']) {
    assert.ok(ids.has(`settings-tab-${category}`));
    assert.ok(ids.has(`settings-panel-${category}`));
  }
  assert.equal([...html.matchAll(/<option value="mp4" selected>/g)].length, 2);
  const main = await fs.readFile('main.js', 'utf8');
  assert.match(main, /format: 'mp4'/);
  const server = await startServer(path.resolve('.')); t.after(() => server.close());
  for (const file of ['renderer/index.html', 'renderer/style.css', 'renderer/app.js', 'renderer/player.js', 'renderer/timeline-view.js', 'lib/time.js', 'lib/timeline.js']) {
    const response = await fetch(`${server.origin}/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self' https:\/\/www.youtube.com https:\/\/s.ytimg.com/);
    assert.match(response.headers.get('content-security-policy'), /frame-src https:\/\/www.youtube.com/);
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    await response.text();
  }
});
