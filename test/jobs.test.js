import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobs } from '../lib/jobs.js';

const snapshot = format => ({ video: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', title: 'video', durationSec: 10 }, timeline: { startSec: 1, endSec: 5, zoom: 1, scrollSec: 0, playheadSec: 1 }, cutMode: 'accurate', format });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(initial = []) {
  const writes = [], starts = [], changes = [], timers = new Map();
  let sequence = 0, time = 0, fail = false, flushed = 0;
  const clock = {
    now: () => time,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await tick();
      }
      time = end; await tick();
    }
  };
  const store = {
    async load() { return { document: { schemaVersion: 1, revision: 0, settings: {}, items: structuredClone(initial) }, warning: null }; },
    async save(document) { if (fail) throw new Error('disk failure'); writes.push(structuredClone(document.items)); },
    async flush() { flushed++; }
  };
  const runner = { start(item, callbacks) {
    assert.equal(writes.at(-1).find(row => row.id === item.id).status, 'running');
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = { item, callbacks: { onProgress: value => callbacks({ phase: 'downloading', ...value, progress: value.percent }), onDone: async value => { resolve({ outputPath: value?.path }); await tick(); }, onError: async error => { reject(error); await tick(); }, onCancel: async () => { reject({ code: 'CANCELLED' }); await tick(); } }, cancelled: 0, killed: 0 };
    starts.push(entry);
    return { done, cancel() { entry.cancelled++; if (item.status === 'running' && shuttingDown) { entry.killed++; reject({ code: 'CANCELLED' }); } } };
  } };
  let shuttingDown = false;
  const jobs = createJobs({ store, runner, clock, uuid: () => `id-${++sequence}`, onChange: (payload, error) => changes.push({ items: payload.items, error }) });
  const shutdown = jobs.shutdown; jobs.shutdown = () => { shuttingDown = true; return shutdown(); };
  return { jobs, writes, starts, changes, clock, setFail(value) { fail = value; }, get flushed() { return flushed; } };
}

test('add canonicalizes the captured file name and selects flat-v1', async () => {
  const f = fixture(); await f.jobs.init();
  const input = snapshot('mp4'); input.fileName = '  여행  ';
  const item = await f.jobs.add(input);
  assert.equal(item.snapshot.fileName, '여행');
  assert.equal(item.fileName, '여행');
  assert.equal(item.execution.outputLayout, 'flat-v1');
  assert.equal(f.starts[0].item.snapshot.fileName, '여행');
  await f.jobs.shutdown();
});

test('waiting rename updates the requested name without changing the captured snapshot', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'));
  const b = await f.jobs.add(snapshot('mp4'));
  const before = structuredClone(b.snapshot);
  const result = await f.jobs.rename(b.id, '새 이름');
  assert.equal(result.ok, true);
  assert.equal(f.jobs.list().find(row => row.id === b.id).fileName, '새 이름');
  assert.deepEqual(f.jobs.list().find(row => row.id === b.id).snapshot, before);
  assert.equal(f.jobs.list().find(row => row.id === a.id).status, 'running');
  await f.jobs.shutdown();
});

test('running and cancelled active workers cannot be renamed', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'));
  await assert.rejects(f.jobs.rename(a.id, '다른 이름'), error => error.code === 'NOT_RENAMABLE');
  await f.jobs.cancel(a.id);
  await assert.rejects(f.jobs.rename(a.id, '다른 이름'), error => error.code === 'NOT_RENAMABLE');
  await f.starts[0].callbacks.onCancel();
  await f.jobs.shutdown();
});

test('failed jobs can be renamed and retry keeps the requested name and root', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'), { outputDir: 'root' });
  await f.starts[0].callbacks.onError(new Error('failed'));
  await f.jobs.rename(a.id, '재시도');
  await f.jobs.retry(a.id);
  assert.equal(f.starts[1].item.fileName, '재시도');
  assert.equal(f.starts[1].item.execution.outputDir, 'root');
  await f.jobs.shutdown();
});

test('rename save failure preserves name, path and revision and publishes no success', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'));
  await f.starts[0].callbacks.onError(new Error('failed'));
  const before = f.jobs.list()[0], revision = f.jobs.revision, notices = f.changes.length;
  f.setFail(true);
  await assert.rejects(f.jobs.rename(a.id, '새 이름'), /disk failure/);
  assert.equal(f.jobs.list()[0].fileName, before.fileName);
  assert.equal(f.jobs.list()[0].outputPath, before.outputPath);
  assert.equal(f.jobs.revision, revision);
  assert.equal(f.changes.length, notices + 1);
  assert.equal(f.changes.at(-1).items[0].fileName, before.fileName);
  assert.equal(f.changes.at(-1).items[0].outputPath, before.outputPath);
  await f.jobs.shutdown().catch(() => {});
});

test('legacy jobs keep absent output layout and migrate missing format as mkv', async () => {
  const legacy = { id: 'old', attempt: 1, status: 'waiting', snapshot: snapshot('mkv'), execution: { outputDir: 'root' } };
  delete legacy.snapshot.format;
  const f = fixture([legacy]); await f.jobs.init();
  assert.equal(f.jobs.list()[0].snapshot.format, 'mkv');
  assert.equal(Object.hasOwn(f.jobs.list()[0].execution, 'outputLayout'), false);
  await f.jobs.shutdown();
});

test('waiting and running are persisted before spawn; invalid format is rejected', async () => {
  const f = fixture(); await f.jobs.init();
  await assert.rejects(f.jobs.add(snapshot(undefined), { format: 'mp4' }), /snapshot.format/);
  await assert.rejects(f.jobs.add(snapshot('webm')), /snapshot.format/);
  await f.jobs.add(snapshot('mkv'));
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.writes.slice(-2).map(rows => rows[0].status), ['waiting', 'running']);
  await f.jobs.shutdown();
});

test('ETA merges, publishes and persists on existing throttles and resets on retry and completion', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'));
  const count = f.writes.length;
  assert.equal(a.etaSec, null);
  f.starts[0].callbacks.onProgress({ percent: 25, etaSec: 12 });
  await f.clock.advance(250);
  assert.equal(f.jobs.list()[0].etaSec, 12);
  assert.equal(f.changes.at(-1).items[0].etaSec, 12);
  assert.equal(f.writes.length, count);
  f.starts[0].callbacks.onProgress({ percent: 30 });
  await f.clock.advance(750);
  assert.equal(f.writes.at(-1)[0].etaSec, 12);
  assert.equal(f.writes.length, count + 1);
  await f.starts[0].callbacks.onError(new Error('failed'));
  await f.jobs.retry(a.id);
  assert.equal(f.jobs.list()[0].etaSec, null);
  f.starts[1].callbacks.onProgress({ percent: 99, etaSec: 1 });
  await f.starts[1].callbacks.onDone({ path: 'a.mkv' });
  assert.equal(f.jobs.list()[0].progress, 100);
  assert.equal(f.writes.at(-1)[0].etaSec, null);
  await f.jobs.shutdown();
});

test('old documents load with null ETA and interrupted jobs clear saved ETA', async () => {
  const rows = ['completed', 'running'].map((status, i) => ({ id: `old-${i}`, attempt: 1, status,
    snapshot: snapshot('mkv'), execution: {}, progress: i === 0 ? 100 : 20,
    ...(i === 1 ? { etaSec: 40 } : {}) }));
  const f = fixture(rows); await f.jobs.init();
  assert.deepEqual(f.jobs.list().map(row => row.etaSec), [null, null]);
  assert.equal(f.jobs.list()[1].status, 'failed');
  await f.jobs.shutdown();
});

test('A progresses while B waits; UI copies and progress throttles are independent', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'));
  const b = await f.jobs.add(snapshot('mp4'));
  f.jobs.list()[0].snapshot.video.title = 'UI edit';
  const count = f.writes.length, notices = f.changes.length;
  f.starts[0].callbacks.onProgress({ percent: 10 });
  f.starts[0].callbacks.onProgress({ percent: 20, speed: 3 });
  await f.clock.advance(249);
  assert.equal(f.changes.length, notices);
  await f.clock.advance(1);
  assert.equal(f.jobs.list()[0].progress, 20);
  assert.equal(f.writes.length, count);
  assert.equal(f.jobs.list()[0].snapshot.video.title, 'video');
  assert.equal(f.jobs.list().find(row => row.id === b.id).status, 'waiting');
  assert.equal(f.starts.length, 1);
  await f.clock.advance(750);
  assert.equal(f.writes.length, count + 1);
  await f.starts[0].callbacks.onDone({ path: 'a.mkv' });
  assert.equal(f.jobs.list().find(row => row.id === a.id).status, 'completed');
  assert.equal(f.starts[1].item.id, b.id);
  await f.jobs.shutdown();
});

test('cancel holds the slot until termination and ignores late callbacks', async () => {
  const f = fixture(); await f.jobs.init();
  const a = await f.jobs.add(snapshot('mkv'));
  await f.jobs.add(snapshot('mp4'));
  const old = f.starts[0].callbacks;
  await f.jobs.cancel(a.id);
  assert.equal(f.writes.at(-1)[0].status, 'cancelled');
  assert.equal(f.starts[0].cancelled, 1);
  assert.equal(f.starts.length, 1);
  await assert.rejects(f.jobs.retry(a.id), /not ready/);
  await old.onDone({ path: 'late' });
  assert.equal(f.starts.length, 2);
  await old.onError(new Error('late failure'));
  old.onProgress({ percent: 99 });
  await f.clock.advance(1000);
  assert.equal(f.jobs.list()[0].status, 'cancelled');
  assert.equal(f.jobs.list()[0].outputPath, null);
  assert.equal(f.jobs.list()[1].status, 'running');
  await f.jobs.shutdown();
});

test('retry retains id and immutable snapshot format, increments attempt and guards stale callbacks', async () => {
  const f = fixture(); await f.jobs.init();
  const input = snapshot('mkv'), settings = { format: 'mp4', outputDir: 'first', ytDlpPath: 'yt', ffmpegPath: 'ff', extra: 'omit' };
  const added = f.jobs.add(input, settings);
  input.format = 'mp4'; input.timeline.startSec = 99; settings.format = 'mkv'; settings.outputDir = 'changed';
  const a = await added;
  const old = f.starts[0].callbacks;
  await old.onError(new Error('failure'));
  await f.jobs.retry(a.id);
  const item = f.starts[1].item;
  assert.ok(Object.isFrozen(item.snapshot));
  assert.ok(Object.isFrozen(item.snapshot.timeline));
  assert.equal(item.id, a.id); assert.equal(item.attempt, 2);
  assert.equal(item.snapshot.format, 'mkv'); assert.equal(item.snapshot.timeline.startSec, 1);
  assert.deepEqual(item.execution, { outputDir: 'first', ytDlpPath: 'yt', ffmpegPath: 'ff', outputLayout: 'flat-v1' });
  await old.onDone();
  assert.equal(f.jobs.list()[0].status, 'running');
  await f.starts[1].callbacks.onCancel();
  await f.jobs.retry(a.id);
  assert.equal(f.starts[2].item.attempt, 3);
  await f.jobs.shutdown();
});

test('recovery persists INTERRUPTED running jobs and resumes waiting jobs', async () => {
  const initial = ['running', 'waiting'].map((status, i) => ({ id: `saved-${i}`, attempt: 1, status, snapshot: snapshot('mp4'), execution: {} }));
  const f = fixture(initial); await f.jobs.init();
  assert.equal(f.writes[0][0].status, 'failed');
  assert.equal(f.writes[0][0].error.code, 'INTERRUPTED');
  assert.equal(f.writes[0][1].status, 'waiting');
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0].item.id, 'saved-1');
  await f.jobs.add(snapshot('mkv'));
  await f.jobs.shutdown();
  assert.equal(f.starts[0].cancelled, 1);
  assert.equal(f.writes.at(-1)[1].error.code, 'INTERRUPTED');
  assert.equal(f.writes.at(-1)[2].status, 'waiting');
  assert.equal(f.flushed, 1);
});

test('save rejection rejects add, prevents spawning and success notices; shutdown flushes', async () => {
  const f = fixture(); await f.jobs.init();
  const count = f.changes.length;
  f.setFail(true);
  await assert.rejects(f.jobs.add(snapshot('mkv')), /disk failure/);
  assert.equal(f.starts.length, 0);
  assert.equal(f.changes.length, count + 1);
  assert.equal(f.changes.at(-1).error.message, 'disk failure');
  await assert.rejects(f.jobs.add(snapshot('mp4')), /halted/);
  await assert.rejects(f.jobs.shutdown(), /disk failure/);
  assert.equal(f.flushed, 1);
  f.setFail(false);
  await f.jobs.shutdown();
  assert.equal(f.flushed, 2);
  assert.equal(f.writes.at(-1)[0].status, 'waiting');
});
