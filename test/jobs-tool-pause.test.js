import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobs } from '../lib/jobs.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const waitingJob = (status = 'waiting') => ({
  id: jobId, attempt: 1, status, phase: 'queued', progress: 0, etaSec: null,
  outputPath: null, error: null, startedAt: null, finishedAt: null,
  fileName: 'clip', snapshot: { video: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', title: 'video', durationSec: 10 }, timeline: { startSec: 1, endSec: 5, zoom: 1, scrollSec: 0, playheadSec: 1 }, cutMode: 'accurate', format: 'mkv' },
  execution: { outputDir: 'C:\\output', outputLayout: 'flat-v1' },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
});

function harness({ startPaused = false, status = 'waiting' } = {}) {
  const document = { schemaVersion: 1, revision: 0, settings: { outputDir: 'C:\\output', format: 'mkv' }, items: [waitingJob(status)] };
  const saves = [];
  const starts = [];
  let uuidCalls = 0;
  const store = {
    async load() { return { document: structuredClone(document) }; },
    async save(value) { saves.push(structuredClone(value)); Object.assign(document, structuredClone(value)); },
    async flush() { this.flushed = true; }
  };
  const runner = {
    start(item) {
      starts.push(structuredClone(item));
      return { done: new Promise(() => {}), cancel() {} };
    }
  };
  const jobs = createJobs({ store, runner, startPaused, uuid: () => { uuidCalls++; return '22222222-2222-4222-8222-222222222222'; } });
  return { jobs, store, saves, starts, get uuidCalls() { return uuidCalls; }, document };
}

test('startPaused init preserves waiting item without starting runner', async () => {
  const h = harness({ startPaused: true });
  await h.jobs.init();
  assert.equal(h.jobs.list()[0].status, 'waiting');
  assert.equal(h.starts.length, 0);
  assert.equal(h.uuidCalls, 0);
  assert.equal(h.saves.at(-1).schemaVersion, 1);
});

test('default startPaused false keeps automatic resume behavior', async () => {
  const h = harness();
  await h.jobs.init();
  assert.equal(h.starts.length, 1);
  assert.equal(h.jobs.list()[0].status, 'running');
  assert.equal(h.uuidCalls, 1);
});

test('pause rejects add and retry with TOOL_NOT_READY', async () => {
  const h = harness({ startPaused: true, status: 'cancelled' });
  await h.jobs.init();
  await assert.rejects(h.jobs.add(waitingJob().snapshot, { outputDir: 'C:\\output' }), error => error.code === 'TOOL_NOT_READY');
  await assert.rejects(h.jobs.retry(jobId), error => error.code === 'TOOL_NOT_READY');
  assert.equal(h.jobs.list()[0].status, 'cancelled');
  assert.equal(h.starts.length, 0);
  assert.equal(h.uuidCalls, 0);
});

test('cancel while paused persists cancelled state and does not pump next item', async () => {
  const h = harness({ startPaused: true });
  await h.jobs.init();
  const result = await h.jobs.cancel(jobId);
  assert.equal(result.status, 'cancelled');
  assert.equal(h.saves.at(-1).items[0].status, 'cancelled');
  assert.equal(h.jobs.list()[0].status, 'cancelled');
  assert.equal(h.starts.length, 0);
});

test('resume starts restored queue once and repeated calls are safe', async () => {
  const h = harness({ startPaused: true });
  await h.jobs.init();
  await Promise.all([h.jobs.resume(), h.jobs.resume(), h.jobs.resume()]);
  assert.equal(h.starts.length, 1);
  assert.equal(h.jobs.list()[0].status, 'running');
  assert.equal(h.uuidCalls, 1);
});

test('shutdown while paused saves waiting queue and flushes store without pumping', async () => {
  const h = harness({ startPaused: true });
  await h.jobs.init();
  await h.jobs.shutdown();
  assert.equal(h.saves.at(-1).schemaVersion, 1);
  assert.equal(h.saves.at(-1).items[0].status, 'waiting');
  assert.equal(h.jobs.list()[0].status, 'waiting');
  assert.equal(h.store.flushed, true);
  assert.equal(h.starts.length, 0);
  assert.equal(h.uuidCalls, 0);
});
