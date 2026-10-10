'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFileName, defaultFileStem, validateSnapshot, transition, recoverItems } from '../lib/queue-state.js';

const snapshot = (format = 'mkv') => ({
  video: { url: 'https://example.test/video', videoId: 'video-1', title: 'Title', durationSec: 120 },
  timeline: { startSec: 10, endSec: 30, zoom: 1, scrollSec: 0, playheadSec: 10 },
  cutMode: 'keep',
  format,
});

const item = (overrides = {}) => ({
  id: 'job-1', status: 'waiting', attempt: 1, progress: 0,
  snapshot: snapshot(), execution: { preset: 'default' },
  ...overrides,
});

test('start returns a new running item and leaves the original unchanged', () => {
  const original = item();
  const started = transition(original, { type: 'start', attempt: 1 }, '2026-10-09T00:00:00.000Z');
  assert.notEqual(started, original);
  assert.equal(started.status, 'running');
  assert.equal(started.startedAt, '2026-10-09T00:00:00.000Z');
  assert.equal(original.status, 'waiting');
  assert.equal(original.startedAt, undefined);
});

test('complete marks a running item completed at 100 percent', () => {
  const running = item({ status: 'running' });
  const completed = transition(running, { type: 'complete', attempt: 1, outputPath: 'out.mkv' }, 'done');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress, 100);
  assert.equal(completed.outputPath, 'out.mkv');
});

test('late completion after cancellation is ignored', () => {
  const cancelled = item({ status: 'cancelled' });
  assert.equal(transition(cancelled, { type: 'complete', attempt: 1 }, 'late'), cancelled);
});

test('retrying a failed item increments attempt and clears progress and execution results', () => {
  const before = item({ status: 'failed', attempt: 2, progress: 45, error: 'oops', outputPath: 'old.mkv', startedAt: 'start', failedAt: 'fail' });
  const retried = transition(before, { type: 'retry', attempt: 2 }, 'retry-time');
  assert.equal(retried.status, 'waiting');
  assert.equal(retried.attempt, 3);
  assert.equal(retried.progress, 0);
  assert.equal(retried.error, undefined);
  assert.equal(retried.outputPath, undefined);
  assert.equal(retried.startedAt, undefined);
  assert.equal(retried.failedAt, undefined);
  assert.equal(retried.snapshot, before.snapshot);
  assert.equal(retried.execution, before.execution);
});

test('stale attempts are ignored and completed items cannot retry', () => {
  const current = item({ status: 'running', attempt: 3 });
  assert.equal(transition(current, { type: 'fail', attempt: 2, error: 'stale' }, 'now'), current);
  assert.throws(() => transition(item({ status: 'completed' }), { type: 'retry', attempt: 1 }, 'now'), RangeError);
});

test('recovery and snapshot validation preserve the declared status and format rules', () => {
  const running = item({ status: 'running' });
  const waiting = item();
  const recovered = recoverItems([running, waiting], 'recovered');
  assert.equal(recovered[0].status, 'failed');
  assert.equal(recovered[0].error.code, 'INTERRUPTED');
  assert.equal(recovered[0].failedAt, 'recovered');
  assert.equal(recovered[1], waiting);

  assert.equal(validateSnapshot(snapshot('mkv')), undefined);
  assert.equal(validateSnapshot(snapshot('mp4')), undefined);
  const invalidRange = snapshot();
  invalidRange.timeline.endSec = 121;
  assert.throws(() => validateSnapshot(invalidRange), RangeError);
  const missingFormat = snapshot();
  delete missingFormat.format;
  assert.throws(() => validateSnapshot(missingFormat), RangeError);
  assert.throws(() => validateSnapshot(snapshot('avi')), RangeError);
});

test('file names are trimmed and normalized without changing internal spaces', () => {
  assert.equal(normalizeFileName('  여행 1  '), '여행 1');
  assert.equal(normalizeFileName(undefined), '');
  assert.equal(normalizeFileName(''), '');
});

test('default title stems replace Windows-invalid characters and reserved names', () => {
  assert.deepEqual(['A:B?', 'CON.txt', '...', '   ', undefined].map(defaultFileStem),
    ['A_B_', '_CON.txt', 'clip', 'clip', 'clip']);
  assert.equal(defaultFileStem('영상.mp4'), '영상.mp4');
});

test('strict file names reject traversal, reserved names, extensions, and separators', () => {
  for (const value of ['../x', 'a..b', 'CON.txt', 'COM¹', 'a.mp4', 'x/y']) {
    assert.throws(() => normalizeFileName(value), RangeError, value);
  }
});

test('strict file names reject nonstrings and control characters', () => {
  for (const value of [null, 3, 'a\u0001b', 'a\u007fb']) {
    assert.throws(() => normalizeFileName(value), RangeError);
  }
});

test('file name limits count UTF-16 units and title truncation preserves surrogate pairs', () => {
  assert.equal(normalizeFileName('가'.repeat(120)), '가'.repeat(120));
  assert.throws(() => normalizeFileName('가'.repeat(121)), RangeError);
  assert.equal(defaultFileStem('가'.repeat(121)).length, 120);
  assert.equal(defaultFileStem(`${'a'.repeat(119)}😀`).length, 119);
  assert.equal(defaultFileStem('name. '), 'name');
});

test('retry clears transient output fields and recovery validates path and layout metadata', () => {
  const before = item({ status: 'failed', fileName: '여행', outputFileName: 'old', missingOutputPath: 'C:\\old.mkv' });
  const retried = transition(before, { type: 'retry', attempt: 1 }, 'retry-time');
  assert.equal(retried.fileName, '여행');
  assert.equal(retried.outputFileName, undefined);
  assert.equal(retried.missingOutputPath, undefined);
  assert.throws(() => recoverItems([item({ missingOutputPath: 'relative.mkv' })], 'now'), RangeError);
  assert.throws(() => recoverItems([item({ execution: { outputLayout: 'unknown' } })], 'now'), RangeError);
  assert.equal(recoverItems([item({ fileName: 'trip', missingOutputPath: 'C:\\trip.mkv' })], 'now')[0].fileName, 'trip');
});
