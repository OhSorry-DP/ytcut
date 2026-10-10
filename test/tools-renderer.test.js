import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../renderer/app.js';

class FakeElement {
  constructor(id = '') { this.id = id; this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.className = ''; this.open = false; this.style = {}; this.listeners = new Map(); this.children = []; this.attributes = new Map(); this.classList = { add() {}, remove() {}, toggle() {} }; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
  dispatch(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  querySelector() { return null; }
  set innerHTML(_value) { this.children = []; }
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function tool(status = 'idle', extra = {}) { return { toolId: 'ffmpeg', status, source: 'none', usable: false, revision: 1, currentVersion: null, latestVersion: null, currentReleaseTag: null, candidateId: null, downloadBytes: 0, downloadedBytes: 0, percent: 0, manual: false, needsInstall: false, canDownload: false, canRollback: false, error: null, ...extra }; }
function state(revision, ffmpeg, ytDlp = tool('idle', { toolId: 'ytDlp' })) { return { revision, ffmpeg, ytDlp }; }

function setup({ bootstrap = Promise.resolve({ ok: true, value: { settings: {}, items: [], revision: 0 } }), initialTools = state(1, tool()), download = async () => ({ ok: true, value: state(3, tool('installed', { revision: 3 })) }), saveSettings = async value => ({ ok: true, value }), metadata = async ({ requestId }) => ({ ok: true, value: { requestId, video: { title: 'Sample', url: 'https://source.invalid/video', durationSec: 30 }, warnings: [] } }) } = {}) {
  const elements = new Map();
  const document = { visibilityState: 'visible', defaultView: { requestAnimationFrame: fn => queueMicrotask(fn) }, addEventListener() {}, removeEventListener() {}, getElementById(id) { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id); }, createElement(tag) { return new FakeElement(tag); }, createElementNS(_ns, tag) { return new FakeElement(tag); }, querySelector() { return null; } };
  const calls = { downloads: [], saves: [], checks: [] };
  let onQueue, onTools;
  const ytcut = {
    onQueueChanged(fn) { onQueue = fn; return () => {}; },
    onToolsChanged(fn) { onTools = fn; return () => {}; },
    toolsState: async () => ({ ok: true, value: initialTools }),
    checkTool: async id => { calls.checks.push(id); return { ok: true, value: state(2, tool('available', { toolId: id, revision: 2, candidateId: 'candidate-a', downloadBytes: 193970776, canDownload: true })) }; },
    downloadTool: async request => { calls.downloads.push(request); return download(request); },
    saveSettings: async value => { calls.saves.push(value); return saveSettings(value); },
    metadata,
    bootstrap: () => bootstrap,
  };
  const player = { destroy() {}, load: async () => {}, seek: async () => {}, togglePlay: async () => {}, pause() {} };
  const timelineView = { set() {}, destroy() {} };
  const app = createApp({ player, timelineView, ytcut, document, youtubeFactory: () => ({ load: async () => {}, destroy() {}, seek: async () => {}, togglePlay: async () => {} }), localFactory: () => ({ load: async () => {}, destroy() {}, seek: async () => {}, togglePlay: async () => {} }) });
  return { app, document, elements, calls, push: value => onTools(value), queue: value => onQueue(value) };
}

test('ffmpeg 자동 갱신 기본값은 false이고 저장 대역에도 false가 전달된다', async () => {
  const h = setup();
  await h.app.bootstrapped;
  h.elements.get('settings-button').dispatch('click');
  assert.equal(h.elements.get('auto-update-ffmpeg').checked, false);
  h.elements.get('settings-form').dispatch('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.saves[0].autoUpdateFfmpeg, false);
  h.app.dispose();
});

test('최초 설치는 크기 안내를 렌더한 뒤 두 프레임을 거쳐 ACK 크기로 받는다', async () => {
  const pending = deferred(); const h = setup({ initialTools: state(1, tool('missing', { needsInstall: true, candidateId: 'first', downloadBytes: 193970776 })), download: request => { hFrameStatus = h.elements.get('ffmpeg-status').textContent; return pending.promise; } });
  let hFrameStatus = '';
  await h.app.bootstrapped; await new Promise(resolve => setImmediate(resolve));
  assert.match(h.elements.get('ffmpeg-status').textContent, /185\.0 MiB/);
  assert.equal(hFrameStatus, h.elements.get('ffmpeg-status').textContent);
  assert.deepEqual(h.calls.downloads[0], { toolId: 'ffmpeg', candidateId: 'first', acknowledgedBytes: 193970776 });
  pending.resolve({ ok: true, value: state(2, tool('installed', { revision: 2 })) });
  h.app.dispose();
});

test('candidate revision 변경은 이전 ACK 대상을 폐기하고 같은 후보 반복 ACK를 막는다', async () => {
  const firstFrame = deferred(); let frames = 0;
  const h = setup();
  h.document.defaultView.requestAnimationFrame = fn => { frames++; if (frames === 1) firstFrame.promise.then(fn); else queueMicrotask(fn); };
  await h.app.bootstrapped;
  h.push(state(2, tool('missing', { needsInstall: true, candidateId: 'old', downloadBytes: 1000 })));
  h.push(state(3, tool('missing', { needsInstall: true, candidateId: 'new', downloadBytes: 2000 })));
  firstFrame.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.downloads, [{ toolId: 'ffmpeg', candidateId: 'new', acknowledgedBytes: 2000 }]);
  h.push(state(4, tool('missing', { needsInstall: true, candidateId: 'new', downloadBytes: 2000 })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.downloads.length, 1);
  h.app.dispose();
});

test('수동 확인은 받지 않고 버튼 다운로드와 진행률 및 대기 상태를 렌더한다', async () => {
  const h = setup({ download: async () => ({ ok: true, value: state(4, tool('downloaded-pending', { revision: 4, percent: 100, downloadedBytes: 50, downloadBytes: 50 })) }) });
  await h.app.bootstrapped;
  h.elements.get('ffmpeg-check-button').dispatch('click'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.checks, ['ffmpeg']); assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.elements.get('ffmpeg-download-button').hidden, false);
  h.elements.get('ffmpeg-download-button').dispatch('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.downloads[0].acknowledgedBytes, 193970776);
  assert.match(h.elements.get('ffmpeg-status').textContent, /대기열이 비면 적용합니다/);
  h.app.dispose();
});

test('bootstrap보다 먼저 온 push를 보존하고 dispose 뒤 응답과 push를 무시한다', async () => {
  const boot = deferred(); const h = setup({ bootstrap: boot.promise });
  h.push(state(5, tool('available', { revision: 5, candidateId: 'pushed', downloadBytes: 1000 })));
  boot.resolve({ ok: true, value: { settings: {}, items: [], revision: 0 } }); await h.app.bootstrapped;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.elements.get('ffmpeg-status').textContent, /설치\/갱신/);
  h.app.dispose(); h.push(state(6, tool('error', { revision: 6, error: { code: 'NETWORK', message: 'raw' } })));
  assert.doesNotMatch(h.elements.get('ffmpeg-status').textContent, /raw/);
});

test('큐 원시 오류 문자열은 노출하지 않고 metadata 경고가 있어도 편집을 성공시킨다', async () => {
  const h = setup({ metadata: async ({ requestId }) => ({ ok: true, value: { requestId, video: { title: 'Sample', url: 'https://source.invalid/video', durationSec: 30 }, warnings: [{ code: 'METADATA_WARNING', message: 'metadata warning' }] } }) }); await h.app.bootstrapped;
  h.queue({ revision: 1, items: [{ id: 'bad', status: 'failed', error: 'secret raw stderr', snapshot: { format: 'mp4', timeline: { startSec: 0, endSec: 1 }, video: { title: 'Bad' } }, createdAt: 1 }] });
  assert.doesNotMatch(h.elements.get('queue-list').children[0]?.title || '', /secret raw stderr/);
  await h.app.edit({ url: 'https://source.invalid/video' });
  assert.equal(h.app.getState().video.title, 'Sample');
  assert.doesNotMatch(h.elements.get('app-error').textContent, /metadata warning|secret raw stderr/);
  h.app.dispose();
});
