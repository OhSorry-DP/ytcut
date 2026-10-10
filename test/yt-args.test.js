'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeYouTubeUrl, buildMetadataArgs, buildDownloadArgs } from '../lib/yt-args.js';

const canonicalUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const common = [
  '--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--no-simulate', '--newline', '--progress',
  '--progress-delta', '0.25', '--progress-template', 'download:ytcut-progress:%(progress)j',
  '--progress-template', 'postprocess:ytcut-postprocess:%(progress)j', '--print',
  'after_move:ytcut-output:%(filepath)j',
];

test('normalizes a youtu.be URL and rejects lookalikes, credentials, and unsupported formats', () => {
  assert.equal(normalizeYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), canonicalUrl);
  for (const value of [
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:443/watch?v=dQw4w9WgXcQ',
    'dQw4w9WgXcQ',
    'https://youtube.com/playlist?list=PL1234567890',
  ]) assert.throws(() => normalizeYouTubeUrl(value));

  const base = { id: 'job-1', attempt: 2, execution: { outputDir: 'D:/out', ffmpegPath: 'ffmpeg' }, snapshot: { video: { url: canonicalUrl }, timeline: { startSec: 12.345, endSec: 67.89 }, cutMode: 'accurate' } };
  for (const format of [undefined, 'avi']) {
    assert.throws(() => buildDownloadArgs({ ...base, snapshot: { ...base.snapshot, format } }), RangeError);
  }
});

test('metadata args are exact', () => {
  assert.deepEqual(buildMetadataArgs('http://m.youtube.com/watch?v=dQw4w9WgXcQ'), [
    '--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--skip-download', '-J', '--', canonicalUrl,
  ]);
});

test('mkv accurate and fast download argv are exact', () => {
  const item = { id: 'job-1', attempt: 2, execution: { outputDir: 'D:/out', ffmpegPath: 'C:/ffmpeg' }, snapshot: { format: 'mkv', video: { url: canonicalUrl }, timeline: { startSec: 12.3454, endSec: 67.8904 }, cutMode: 'accurate' } };
  const expectedBase = [...common, '-f', 'bv*+ba/b', '--merge-output-format', 'mkv', '--ffmpeg-location', 'C:/ffmpeg', '--downloader-args', 'ffmpeg:-progress pipe:2 -stats_period 1 -nostats', '--download-sections', '*12.345-67.890'];
  assert.deepEqual(buildDownloadArgs(item), [...expectedBase, '--force-keyframes-at-cuts', '-P', path.join('D:/out', 'job-1', 'attempt-2'), '-o', 'clip.%(ext)s', '--', canonicalUrl]);
  item.snapshot.cutMode = 'fast';
  assert.deepEqual(buildDownloadArgs(item), [...expectedBase, '--no-force-keyframes-at-cuts', '-P', path.join('D:/out', 'job-1', 'attempt-2'), '-o', 'clip.%(ext)s', '--', canonicalUrl]);
});

test('mp4 accurate and fast argv enforce H.264/AAC selection, remux, and no recode', () => {
  const item = { id: 'job-1', attempt: 2, execution: { outputDir: 'D:/out', ffmpegPath: 'C:/ffmpeg' }, snapshot: { format: 'mp4', video: { url: canonicalUrl }, timeline: { startSec: 12.3454, endSec: 67.8904 }, cutMode: 'accurate' } };
  const formatArgs = ['-f', 'bv[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/b[vcodec^=avc1][acodec^=mp4a][ext=mp4]', '-S', 'vcodec:h264,acodec:aac', '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
  const expectedBase = [...common, ...formatArgs, '--ffmpeg-location', 'C:/ffmpeg', '--downloader-args', 'ffmpeg:-progress pipe:2 -stats_period 1 -nostats', '--download-sections', '*12.345-67.890'];
  const accurate = buildDownloadArgs(item);
  assert.deepEqual(accurate, [...expectedBase, '--force-keyframes-at-cuts', '-P', path.join('D:/out', 'job-1', 'attempt-2'), '-o', 'clip.%(ext)s', '--', canonicalUrl]);
  assert.ok(!accurate.includes('--recode-video'));
  item.snapshot.cutMode = 'fast';
  assert.deepEqual(buildDownloadArgs(item), [...expectedBase, '--no-force-keyframes-at-cuts', '-P', path.join('D:/out', 'job-1', 'attempt-2'), '-o', 'clip.%(ext)s', '--', canonicalUrl]);
});

test('download argv keeps the Korean path and URL after -- for both formats', () => {
  for (const format of ['mkv', 'mp4']) {
    const item = { id: 'clip-한글', attempt: 2, execution: { outputDir: 'D:/한글 폴더 & 자료', ytDlpPath: 'yt-dlp', ffmpegPath: 'D:/tools/ffmpeg' }, snapshot: { format, video: { url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', title: '한글', durationSec: 100 }, timeline: { startSec: 1, endSec: 2, zoom: 1, scrollSec: 0, playheadSec: 0 }, cutMode: 'fast' } };
    const args = buildDownloadArgs(item);
    const separator = args.indexOf('--');
    assert.equal(args[separator + 1], canonicalUrl);
    assert.ok(args.includes(path.join('D:/한글 폴더 & 자료', 'clip-한글', 'attempt-2')));
  }
});

test('--ffmpeg-location is omitted for a bare PATH command and kept for a real path', () => {
  const make = ffmpegPath => ({ id: 'job-1', attempt: 1, execution: { outputDir: 'D:/out', ffmpegPath }, snapshot: { format: 'mkv', video: { url: canonicalUrl }, timeline: { startSec: 1, endSec: 2 }, cutMode: 'accurate' } });
  assert.equal(buildDownloadArgs(make('ffmpeg')).includes('--ffmpeg-location'), false);
  const windowsPath = String.raw`C:\tools\ffmpeg.exe`;
  const args = buildDownloadArgs(make(windowsPath));
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], windowsPath);
});
