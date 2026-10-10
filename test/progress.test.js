import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineDecoder, parseProgressLine } from '../lib/progress.js';

test('parses ffmpeg time, speed and end while ignoring invalid and unrelated values', () => {
  assert.deepEqual(parseProgressLine('out_time_us=1500000'), { kind: 'ffmpeg-time', seconds: 1.5 });
  assert.deepEqual(parseProgressLine('out_time_us=0'), { kind: 'ffmpeg-time', seconds: 0 });
  assert.deepEqual(parseProgressLine('speed=0.343x'), { kind: 'ffmpeg-speed', factor: 0.343 });
  assert.deepEqual(parseProgressLine('progress=end'), { kind: 'ffmpeg-end' });
  for (const line of ['out_time_us=N/A', 'out_time_us=NaN', 'out_time_us=-1', 'out_time_us=Infinity',
    'speed=N/A', 'speed=-1x', 'frame=10', 'fps=20', 'bitrate=3', 'total_size=40',
    'out_time_ms=1500000', 'out_time=00:00:01.500000', 'dup_frames=0', 'drop_frames=0',
    'stream_0_0_q=1', 'progress=continue']) assert.equal(parseProgressLine(line), null, line);
});

test('decodes UTF-8 split at byte boundaries without changing the source line', () => {
  const source = 'ytcut-progress:{"status":"한글"}';
  const bytes = Buffer.from(source);
  const lines = [];
  const decoder = createLineDecoder((line) => lines.push(line));
  for (const byte of bytes) decoder.write(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(lines, [source]);
});

test('assembles CRLF lines and flushes a final unterminated line at EOF', () => {
  const lines = [];
  const decoder = createLineDecoder((line) => lines.push(line));
  decoder.write('one\r');
  decoder.write('\ntwo\r\n\nthree');
  decoder.end();
  assert.deepEqual(lines, ['one', 'two', 'three']);
});

test('computes download percent using total_bytes first and estimate as fallback', () => {
  assert.equal(parseProgressLine('ytcut-progress:{"downloaded_bytes":25,"total_bytes":100}').percent, 25);
  const fallback = parseProgressLine('ytcut-progress:{"downloaded_bytes":25,"total_bytes_estimate":200}');
  assert.equal(fallback.percent, 12.5);
  assert.equal(fallback.totalBytes, 200);
});

test('malformed, unknown, negative, and non-finite numeric data are harmless', () => {
  assert.equal(parseProgressLine('ytcut-progress:{bad'), null);
  assert.equal(parseProgressLine('other:{}'), null);
  const result = parseProgressLine('ytcut-progress:{"downloaded_bytes":-1,"total_bytes":-2,"speed":-3,"eta":-4}');
  assert.deepEqual(result, {
    kind: 'progress', percent: null, downloadedBytes: null, totalBytes: null,
    speedBps: null, etaSec: null, status: null,
  });
});

test('recovers after an oversized line and parses output and postprocess records', () => {
  const lines = [];
  const decoder = createLineDecoder((line) => lines.push(line));
  decoder.write('x'.repeat(1024 * 1024 + 1) + '\n');
  decoder.write('ytcut-output:"/tmp/한글.mp4"\nytcut-postprocess:{"status":"done"}');
  decoder.end();
  assert.deepEqual(lines.map(parseProgressLine), [
    { kind: 'output', path: '/tmp/한글.mp4' },
    { kind: 'postprocess', percent: null, downloadedBytes: null, totalBytes: null, speedBps: null, etaSec: null, status: 'done' },
  ]);
});
