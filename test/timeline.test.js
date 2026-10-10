'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimeline, xToTime, timeToX, zoomAt } from '../lib/timeline.js';

test('maps viewport x and time using the zoomed timeline', () => {
  const state = { startSec: 0, endSec: 1000, zoom: 2, scrollSec: 100, playheadSec: 0 };
  assert.equal(xToTime(100, 1000, state, 1000), 150);
  assert.equal(timeToX(150, 1000, state, 1000), 100);
});

test('zoomAt preserves the time under the anchor', () => {
  const state = { startSec: 0, endSec: 1000, zoom: 2, scrollSec: 100, playheadSec: 0 };
  assert.equal(zoomAt(state, 4, 200, 1000, 1000).scrollSec, 150);
});

test('normalizeTimeline clamps scroll to the zoomed duration', () => {
  const result = normalizeTimeline({ startSec: 0, endSec: 1000, zoom: 4, scrollSec: 999, playheadSec: 0 }, 1000);
  assert.equal(result.scrollSec, 750);
});

test('normalizeTimeline enforces the minimum selection gap', () => {
  const result = normalizeTimeline({ startSec: 100, endSec: 100, zoom: 1, scrollSec: 0, playheadSec: 100 }, 1000);
  assert.equal(result.startSec, 100);
  assert.equal(result.endSec, 100.05);
});

test('rejects nonpositive duration and width', () => {
  const state = { startSec: 0, endSec: 1, zoom: 1, scrollSec: 0, playheadSec: 0 };
  assert.throws(() => normalizeTimeline(state, 0), RangeError);
  assert.throws(() => xToTime(0, 0, state, 1), RangeError);
  assert.throws(() => timeToX(0, 0, state, 1), RangeError);
  assert.throws(() => zoomAt(state, 2, 0, 0, 1), RangeError);
});

test('normalization does not mutate its input', () => {
  const state = { startSec: 100, endSec: 100, zoom: 4, scrollSec: 999, playheadSec: 100 };
  const original = { ...state };
  normalizeTimeline(state, 1000);
  assert.deepEqual(state, original);
});
