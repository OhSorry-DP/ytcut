import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createPreviewStream } from '../lib/preview-stream.js';

const videoId = 'abcdefghijk';
const formats = [{ protocol: 'https', url: 'https://r.googlevideo.com/video',
  vcodec: 'avc1.64001f', acodec: 'mp4a.40.2', height: 360 }];
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls++; return true; };
  return child;
}
function response() {
  const res = new PassThrough();
  res.statuses = [];
  res.writeHead = status => { res.statuses.push(status); return res; };
  return res;
}
function request() {
  const req = new EventEmitter();
  req.method = 'GET'; req.complete = true; req.aborted = false;
  return req;
}
function fakeProxy({ urls }) {
  const inputUrls = urls.map((_, index) => `http://127.0.0.1:1234/0123456789abcdef0123456789abcdef/${index}`);
  return { inputUrls, close() {}, onFailure() { return () => {}; } };
}
function preview(options = {}) {
  const service = createPreviewStream({ randomBytesImpl: () => Buffer.from('0123456789abcdef'.repeat(2), 'hex'),
    rangeProxyFactory: async input => fakeProxy(input), ...options });
  service.cacheFormats(videoId, formats);
  return service;
}

test('active ffmpeg close를 기다린 뒤 callback을 실행한다', async () => {
  const child = fakeChild();
  const service = preview({ spawnImpl: () => child, platform: 'linux' });
  const { path } = await service.prepare(videoId);
  service.serve(request(), response(), path.split('/')[2].replace('.mp4', ''));
  await tick();
  const callbackStarted = deferred();
  let callbackDone = false;
  const barrier = service.withToolsSuspended(async () => { callbackStarted.resolve(); callbackDone = true; });
  await tick();
  assert.equal(callbackDone, false);
  assert.equal(child.killCalls, 1);
  child.emit('close', 0);
  await callbackStarted.promise;
  await barrier;
  assert.equal(callbackDone, true);
});

test('URL resolver close를 기다리고 resolver 작업을 끝낸다', async () => {
  const child = fakeChild();
  let spawnCalls = 0;
  const service = createPreviewStream({ getYtdlpPath: async () => 'resolver', spawnImpl: () => { spawnCalls++; return child; }, platform: 'linux' });
  const preparing = service.prepare(videoId);
  const preparingRejected = assert.rejects(preparing, { code: 'PREVIEW_UNAVAILABLE' });
  await tick();
  assert.equal(spawnCalls, 1);
  let callbackDone = false;
  const barrier = service.withToolsSuspended(async () => { callbackDone = true; });
  await tick();
  assert.equal(callbackDone, false);
  child.emit('close', 1);
  await preparingRejected;
  await barrier;
  assert.equal(callbackDone, true);
});

test('getFfmpegPath 대기 중 장벽이 시작되면 늦은 spawn을 막는다', async () => {
  const path = deferred();
  let spawnCalls = 0;
  const service = preview({ getFfmpegPath: () => path.promise, spawnImpl: () => { spawnCalls++; return fakeChild(); } });
  const prepared = await service.prepare(videoId);
  service.serve(request(), response(), prepared.path.split('/')[2].replace('.mp4', ''));
  await tick();
  let callbackDone = false;
  const barrier = service.withToolsSuspended(async () => { callbackDone = true; });
  await barrier;
  path.resolve('new-ffmpeg');
  await tick();
  assert.equal(callbackDone, true);
  assert.equal(spawnCalls, 0);
});

test('proxy 생성 대기와 response cleanup 경합에서 늦은 proxy를 닫는다', async () => {
  const opening = deferred();
  let spawnCalls = 0, closeCalls = 0;
  const service = preview({
    rangeProxyFactory: () => opening.promise,
    spawnImpl: () => { spawnCalls++; return fakeChild(); },
  });
  const prepared = await service.prepare(videoId);
  const req = request(), res = response();
  service.serve(req, res, prepared.path.split('/')[2].replace('.mp4', ''));
  await tick();
  res.emit('close');
  opening.resolve({ inputUrls: ['http://127.0.0.1:1234/0123456789abcdef0123456789abcdef/0'], close() { closeCalls++; }, onFailure() { return () => {}; } });
  await tick();
  assert.equal(closeCalls, 1);
  assert.equal(spawnCalls, 0);
  await service.withToolsSuspended(async () => {});
});

test('5000ms 종료 실패는 REPLACE_BUSY로 반환하고 다음 장벽을 해제한다', async () => {
  const child = fakeChild();
  const timers = [];
  const service = preview({ spawnImpl: () => child, platform: 'linux', now: () => 100,
    setTimeoutImpl: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeoutImpl: () => {} });
  const prepared = await service.prepare(videoId);
  service.serve(request(), response(), prepared.path.split('/')[2].replace('.mp4', ''));
  await tick();
  const blocked = service.withToolsSuspended(async () => {});
  await tick();
  assert.equal(timers.at(-1).ms, 5000);
  timers.at(-1).callback();
  await assert.rejects(blocked, { code: 'REPLACE_BUSY' });
  assert.equal(child.killCalls, 1);
  child.emit('close', 0);
  await service.withToolsSuspended(async () => {});
});

test('callback 예외 뒤 새 prepare와 serve를 재사용할 수 있다', async () => {
  const children = [];
  const service = preview({ spawnImpl: () => { const child = fakeChild(); children.push(child); return child; }, platform: 'linux' });
  await assert.rejects(service.withToolsSuspended(async () => { throw new Error('callback failed'); }), /callback failed/);
  service.cacheFormats(videoId, formats);
  const prepared = await service.prepare(videoId);
  const res = response();
  service.serve(request(), res, prepared.path.split('/')[2].replace('.mp4', ''));
  await tick();
  assert.equal(children.length, 1);
  assert.equal(res.statuses.length, 0);
  service.stop();
  children[0].emit('close', 0);
  service.close();
});
