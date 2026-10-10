import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, formatTime } from '../lib/time.js';

test('parseTime converts supported time formats', () => {
  assert.equal(parseTime('90.125'), 90.125);
  assert.equal(parseTime('01:02:03.004'), 3723.004);
});

test('parseTime rejects invalid values', () => {
  assert.throws(() => parseTime('1:60'), RangeError);
  assert.throws(() => parseTime('-1'), RangeError);
  assert.throws(() => parseTime(''), RangeError);
});

test('formatTime rounds to milliseconds and carries into the next minute', () => {
  assert.equal(formatTime(59.9996), '00:01:00.000');
});

test('formatTime supports hours above 99', () => {
  assert.equal(formatTime(360000), '100:00:00.000');
});
