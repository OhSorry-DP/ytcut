'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRunner } from '../lib/runner.js';
import { buildMetadataArgs, buildDownloadArgs } from '../lib/yt-args.js';
import { selectPreviewStreams } from '../lib/preview-stream.js';
const URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const TEMP_ROOT = process.cwd();
const JOB_ID = '12345678-1234-4234-8234-123456789abc';
function harness(platform = 'linux') {
  const calls = [];
  const runner = createRunner({ platform, now: () => 123, spawnImpl: (exe, args, opts) => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 42;
    c.kill = () => { c.killed = true; };
    calls.push({ exe, args, opts, c }); return c;
  } });
  return { runner, calls };
}
const item = (format = 'mkv', cutMode = 'fast', outputDir = TEMP_ROOT) => ({
  id: 'job', attempt: 2, status: 'running',
  snapshot: { video: { url: URL, videoId: 'abcdefghijk', title: '한글', durationSec: 12 },
    timeline: { startSec: 2, endSec: 8, zoom: 1, scrollSec: 0, playheadSec: 2 }, format, cutMode },
  execution: { outputDir, ytDlpPath: 'custom-yt-dlp', ffmpegPath: 'custom-ffmpeg' },
});
const mark = file => 'ytcut-output:' + JSON.stringify(file);
async function flatFixture(dir, id = JOB_ID) {
  const value = item('mp4', 'fast', dir);
  value.id = id; value.attempt = 1; value.fileName = 'result'; value.execution.outputLayout = 'flat-v1';
  const root = path.resolve(dir, id, 'attempt-1');
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'clip.mp4');
  await fs.writeFile(source, 'verified clip');
  return { value, source, jobDir: path.dirname(root) };
}
function publishFixture(fixture, onUpdate) {
  const { runner, calls } = harness();
  const job = runner.start(fixture.value, onUpdate);
  calls[0].c.stdout.write(mark(fixture.source)); calls[0].c.emit('close', 0);
  return job;
}
test('flat direct link leaves only the final file and preserves its inode and content', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-link-'));
  try {
    const fixture = await flatFixture(dir), original = await fs.lstat(fixture.source);
    const link = fs.link.bind(fs); let links = 0;
    t.mock.method(fs, 'link', async (from, to) => { assert.equal(from, fixture.source); links++; await link(from, to); });
    t.mock.method(fs, 'copyFile', async () => { assert.fail('하드링크 성공 시 복사하지 않아야 한다'); });
    const result = await publishFixture(fixture).done;
    assert.equal(result.outputFileName, 'result.mp4'); assert.equal(links, 1);
    assert.deepEqual(await fs.readdir(dir), ['result.mp4']);
    await assert.rejects(fs.lstat(fixture.jobDir), { code: 'ENOENT' });
    assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'verified clip');
    const final = await fs.lstat(result.outputPath);
    assert.equal(final.dev, original.dev); assert.equal(final.ino, original.ino);
    assert.equal(final.birthtimeMs, original.birthtimeMs);
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('flat unsupported links fall back to exclusive copy with identical content', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-fallback-'));
  try {
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL']) {
      const fixture = await flatFixture(dir), original = await fs.lstat(fixture.source);
      const copy = fs.copyFile.bind(fs); let copies = 0;
      t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code }); });
      t.mock.method(fs, 'copyFile', async (from, to, flags) => {
        assert.equal(from, fixture.source); assert.equal(flags, constants.COPYFILE_EXCL); copies++;
        await copy(from, to, flags);
      });
      const result = await publishFixture(fixture).done;
      assert.equal(copies, 1); assert.equal(result.outputFileName, 'result.mp4');
      assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'verified clip');
      assert.notEqual((await fs.lstat(result.outputPath)).ino, original.ino);
      assert.deepEqual(await fs.readdir(dir), ['result.mp4']);
      t.mock.restoreAll(); await fs.unlink(result.outputPath);
    }
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('flat link and copy EEXIST races advance to (2) and preserve existing content', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-race-'));
  try {
    for (const mode of ['link', 'copy']) {
      const fixture = await flatFixture(dir), link = fs.link.bind(fs), copy = fs.copyFile.bind(fs);
      let attempts = 0;
      const race = async (from, to, flags) => {
        if (++attempts === 1) {
          await fs.writeFile(to, 'existing');
          throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
        }
        return mode === 'link' ? link(from, to) : copy(from, to, flags);
      };
      if (mode === 'link') t.mock.method(fs, 'link', race);
      else {
        t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); });
        t.mock.method(fs, 'copyFile', race);
      }
      const result = await publishFixture(fixture).done;
      assert.equal(attempts, 2); assert.equal(result.outputFileName, 'result (2).mp4');
      assert.equal(await fs.readFile(path.join(dir, 'result.mp4'), 'utf8'), 'existing');
      assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'verified clip');
      t.mock.restoreAll(); await fs.unlink(result.outputPath); await fs.unlink(path.join(dir, 'result.mp4'));
    }
    const fixture = await flatFixture(dir);
    await fs.writeFile(path.join(dir, 'RESULT.mp4'), 'case collision');
    const result = await publishFixture(fixture).done;
    assert.equal(result.outputFileName, 'result (2).mp4');
    assert.equal(await fs.readFile(path.join(dir, 'RESULT.mp4'), 'utf8'), 'case collision');
    assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'verified clip');
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('flat cleanup refuses non UUID, outside, root and symbolic link directories', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-cleanup-guard-'));
  try {
    const output = path.join(dir, 'output'); await fs.mkdir(output);
    for (const id of ['job', '../' + JOB_ID, '.', JOB_ID]) {
      if (id === JOB_ID) {
        const target = path.join(dir, 'target'); await fs.mkdir(target);
        await fs.symlink(target, path.join(output, JOB_ID), process.platform === 'win32' ? 'junction' : 'dir');
      }
      const fixture = await flatFixture(output, id);
      let removals = 0;
      t.mock.method(fs, 'rm', async () => { removals++; assert.fail('검증 실패 경로를 삭제하면 안 된다'); });
      const result = await publishFixture(fixture).done;
      assert.equal(removals, 0); assert.equal(result.outputFileName, 'result.mp4');
      assert.equal(await fs.readFile(fixture.source, 'utf8'), 'verified clip');
      assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'verified clip');
      t.mock.restoreAll(); await fs.unlink(result.outputPath);
    }
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('flat cleanup failure still reports completion and retains the published file', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-cleanup-failure-'));
  try {
    const fixture = await flatFixture(dir); let removals = 0; const updates = [];
    t.mock.method(fs, 'rm', async (target, options) => {
      assert.equal(target, fixture.jobDir); assert.deepEqual(options, { recursive: true, force: true }); removals++;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const result = await publishFixture(fixture, u => updates.push(u)).done;
    assert.equal(removals, 1); assert.equal(result.outputFileName, 'result.mp4');
    assert.equal(updates.filter(u => u.phase === 'completed').length, 1);
    assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'verified clip');
    assert.equal(await fs.readFile(fixture.source, 'utf8'), 'verified clip');
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('flat cancellation rolls back only owned link or copy and preserves replacements', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-rollback-'));
  try {
    for (const mode of ['link', 'copy']) for (const replace of [false, true]) {
      const fixture = await flatFixture(dir); let job; const updates = [];
      if (mode === 'copy') t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); });
      const original = fs[mode === 'link' ? 'link' : 'copyFile'].bind(fs);
      t.mock.method(fs, mode === 'link' ? 'link' : 'copyFile', async (...args) => {
        await original(...args); job.cancel();
        if (replace) {
          // 복사 대상의 소유권을 확인한 뒤 롤백 시점에 외부 파일로 교체한다.
          const lstat = fs.lstat.bind(fs); let observations = 0;
          t.mock.method(fs, 'lstat', async target => {
            if (target === args[1] && ++observations === (mode === 'copy' ? 2 : 1)) {
              await fs.unlink(target); await fs.writeFile(target, 'external');
            }
            return lstat(target);
          });
        }
      });
      job = publishFixture(fixture, u => updates.push(u));
      await assert.rejects(job.done, { code: 'CANCELLED' });
      assert.equal(updates.filter(u => u.progress === 100).length, 0);
      assert.equal(await fs.readFile(fixture.source, 'utf8'), 'verified clip');
      const candidate = path.join(dir, 'result.mp4');
      if (replace) assert.equal(await fs.readFile(candidate, 'utf8'), 'external');
      else await assert.rejects(fs.lstat(candidate), { code: 'ENOENT' });
      t.mock.restoreAll(); if (replace) await fs.unlink(candidate);
    }
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('metadataWithStreams preserves selectable formats while metadata remains Video-only', async () => {
  const sourceFormats = [360, 480, 720].flatMap((height, index) => [
    { protocol: 'https', vcodec: 'avc1.4d', acodec: 'none', height, tbr: 900 + index, url: `https://v.googlevideo.com/video${height}`, extra: 'discard' },
    { protocol: 'https', vcodec: 'none', acodec: 'mp4a.40', abr: 128 + index, url: `https://a.googlevideo.com/audio${height}` },
  ]);
  const video = { url: URL, videoId: 'abcdefghijk', title: 'title', durationSec: 12 };
  for (const [cap, expected] of [[undefined, 480], [360, 360], [480, 480], [720, 720]]) {
    const { runner, calls } = harness();
    const pending = runner.metadataWithStreams(URL, cap === undefined ? {} : { previewResolution: cap });
    calls[0].c.stdout.write(JSON.stringify({ id: 'abcdefghijk', title: 'title', duration: 12, formats: sourceFormats }));
    calls[0].c.emit('close', 0);
    const result = await pending;
    assert.deepEqual(Object.keys(result).sort(), ['formats', 'streams', 'video']);
    assert.deepEqual(result.video, video);
    assert.deepEqual(result.streams, {
      video: `https://v.googlevideo.com/video${expected}`,
      audio: 'https://a.googlevideo.com/audio720',
    });
    assert.deepEqual(result.formats, sourceFormats.map(({ extra, ...format }) => format));
    assert.notEqual(result.formats, sourceFormats);
    assert.equal(selectPreviewStreams(result.formats, expected).video, result.streams.video);
    assert.equal(calls.length, 1); assert.ok(calls[0].args.includes('-J')); assert.equal(calls[0].args.includes('-g'), false);
  }
  const { runner, calls } = harness();
  const pending = runner.metadata(URL);
  calls[0].c.stdout.write(JSON.stringify({ id: 'abcdefghijk', title: 'title', duration: 12, formats: sourceFormats }));
  calls[0].c.emit('close', 0);
  assert.deepEqual(await pending, video);
  assert.equal(calls.length, 1); assert.equal(calls[0].args.includes('-g'), false);
});
test('metadataWithStreams treats unavailable preview formats as non-fatal', async () => {
  const fixtures = [
    [undefined, null], [null, null], ['not-an-array', null], [[], []],
    [[{ protocol: 'https', vcodec: 'vp9', acodec: 'none', height: 480, url: 'https://v.googlevideo.com/v' }],
      [{ protocol: 'https', vcodec: 'vp9', acodec: 'none', height: 480, url: 'https://v.googlevideo.com/v' }]],
    [[{ protocol: 'https', vcodec: 'avc1', acodec: 'none', height: 720, url: 'https://v.googlevideo.com/v' }],
      [{ protocol: 'https', vcodec: 'avc1', acodec: 'none', height: 720, url: 'https://v.googlevideo.com/v' }]],
  ];
  for (const [input, expectedFormats] of fixtures) {
    const { runner, calls } = harness(); const pending = runner.metadataWithStreams(URL);
    const metadata = { id: 'abcdefghijk', title: 'title', duration: 12 };
    if (input !== undefined) metadata.formats = input;
    calls[0].c.stdout.write(JSON.stringify(metadata)); calls[0].c.emit('close', 0);
    const result = await pending;
    assert.deepEqual(result.video, { url: URL, videoId: 'abcdefghijk', title: 'title', durationSec: 12 });
    assert.equal(result.streams, null); assert.deepEqual(result.formats, expectedFormats);
    assert.equal(calls.length, 1); assert.equal(calls[0].args.includes('-g'), false);
  }
});
test('flat publication preserves literal names, title fallback and existing collision files', async () => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-flat-'));
  try {
    const root = path.join(dir, 'job', 'attempt-2');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'clip.mp4'), 'new');
    await fs.writeFile(path.join(dir, '여행.mp4'), 'old');
    await fs.writeFile(path.join(dir, '여행 (2).mp4'), 'old2');
    for (const [name, expected] of [['100% 완료', '100% 완료.mp4'], ['', '여행_봄_.mp4'], ['여행', '여행 (3).mp4']]) {
      const value = item('mp4', 'fast', dir);
      value.execution.outputLayout = 'flat-v1'; value.fileName = name;
      value.snapshot.video.title = '여행:봄?';
      const { runner, calls } = harness(); const updates = [];
      const job = runner.start(value, u => updates.push(u));
      calls[0].c.stdout.write(mark(path.join(root, 'clip.mp4'))); calls[0].c.emit('close', 0);
      assert.deepEqual(await job.done, { outputPath: path.join(await fs.realpath(dir), expected), outputFileName: expected });
      assert.equal(await fs.readFile(path.join(dir, expected), 'utf8'), 'new');
      assert.equal(updates.filter(u => u.progress === 100).length, 1);
    }
    assert.equal(await fs.readFile(path.join(dir, '여행.mp4'), 'utf8'), 'old');
    assert.equal(await fs.readFile(path.join(dir, '여행 (2).mp4'), 'utf8'), 'old2');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('flat publication cancellation during copy preserves existing files and reports no completion', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-copy-'));
  try {
    const root = path.join(dir, 'job', 'attempt-2'); await fs.mkdir(root, { recursive: true });
    const source = path.join(root, 'clip.mp4'); await fs.writeFile(source, 'new');
    await fs.writeFile(path.join(dir, '여행.mp4'), 'old');
    const copy = fs.copyFile.bind(fs); let job;
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); });
    t.mock.method(fs, 'copyFile', async (...args) => { await copy(...args); job.cancel(); });
    const { runner, calls } = harness(); const updates = []; const value = item('mp4', 'fast', dir);
    value.execution.outputLayout = 'flat-v1'; value.fileName = '여행';
    job = runner.start(value, u => updates.push(u));
    calls[0].c.stdout.write(mark(source)); calls[0].c.emit('close', 0);
    await assert.rejects(job.done, { code: 'CANCELLED' });
    assert.equal(updates.filter(u => u.progress === 100).length, 0);
    assert.equal(await fs.readFile(path.join(dir, '여행.mp4'), 'utf8'), 'old');
    await assert.rejects(fs.lstat(path.join(dir, '여행 (2).mp4')), { code: 'ENOENT' });
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('flat publication maps permission, path length and exhausted names to explicit codes', async t => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-errors-'));
  try {
    const root = path.join(dir, 'job', 'attempt-2'); await fs.mkdir(root, { recursive: true });
    const source = path.join(root, 'clip.mp4'); await fs.writeFile(source, 'new');
    for (const [code, linkCode] of [
      ['OUTPUT_PUBLISH_FAILED', 'EACCES'], ['OUTPUT_PUBLISH_FAILED', 'EPERM'],
      ['OUTPUT_PATH_TOO_LONG'], ['OUTPUT_NAME_EXHAUSTED'],
    ]) {
      if (code === 'OUTPUT_PUBLISH_FAILED') {
        t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('permission denied'), { code: linkCode }); });
        if (linkCode === 'EPERM') t.mock.method(fs, 'copyFile', async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
      }
      if (code === 'OUTPUT_PATH_TOO_LONG') {
        const realpath = fs.realpath.bind(fs);
        t.mock.method(fs, 'realpath', async p => p === dir ? path.join(dir, 'x'.repeat(220)) : realpath(p));
      }
      if (code === 'OUTPUT_NAME_EXHAUSTED') t.mock.method(fs, 'readdir', async () => Array.from({ length: 9999 }, (_, i) => `여행${i ? ` (${i + 1})` : ''}.mp4`));
      const value = item('mp4', 'fast', dir); value.execution.outputLayout = 'flat-v1'; value.fileName = '여행';
      const { runner, calls } = harness(); const job = runner.start(value);
      calls[0].c.stdout.write(mark(source)); calls[0].c.emit('close', 0);
      await assert.rejects(job.done, { code }); t.mock.restoreAll();
    }
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('flat publication blocks outside sources and symlink directory escapes', async () => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-escape-'));
  try {
    const root = path.join(dir, 'job', 'attempt-2'); await fs.mkdir(root, { recursive: true });
    const outside = path.join(dir, 'outside'); await fs.mkdir(outside);
    const source = path.join(outside, 'clip.mp4'); await fs.writeFile(source, 'outside');
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const marker of [source, path.join(root, 'escape', 'clip.mp4')]) {
      const value = item('mp4', 'fast', dir); value.execution.outputLayout = 'flat-v1'; value.fileName = 'result';
      const { runner, calls } = harness(); const job = runner.start(value);
      calls[0].c.stdout.write(mark(marker)); calls[0].c.emit('close', 0);
      await assert.rejects(job.done, { code: 'OUTPUT_OUTSIDE_ATTEMPT' });
    }
    await assert.rejects(fs.stat(path.join(dir, 'result.mp4')), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('flat suffix truncation preserves surrogate pairs and cancellation preserves an external replacement', async t => {
  // 긴 작업 경로에서도 120자 파일명과 240자 경로 제한을 함께 검증한다.
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'o'));
  try {
    const root = path.join(dir, 'job', 'attempt-2'); await fs.mkdir(root, { recursive: true });
    const source = path.join(root, 'clip.mp4'); await fs.writeFile(source, 'new');
    const stem = 'a'.repeat(115) + '😀' + 'xyz';
    await fs.writeFile(path.join(dir, stem + '.mp4'), 'old');
    const value = item('mp4', 'fast', dir); value.execution.outputLayout = 'flat-v1'; value.fileName = stem;
    const { runner, calls } = harness(); const job = runner.start(value);
    calls[0].c.stdout.write(mark(source)); calls[0].c.emit('close', 0);
    assert.equal((await job.done).outputFileName, 'a'.repeat(115) + ' (2).mp4');
    const link = fs.link.bind(fs); let cancelledJob;
    t.mock.method(fs, 'link', async (from, to) => {
      await link(from, to); await fs.unlink(to); await fs.writeFile(to, 'external'); cancelledJob.cancel();
    });
    value.fileName = 'replacement'; const second = harness(); cancelledJob = second.runner.start(value);
    second.calls[0].c.stdout.write(mark(source)); second.calls[0].c.emit('close', 0);
    await assert.rejects(cancelledJob.done, { code: 'CANCELLED' });
    assert.equal(await fs.readFile(path.join(dir, 'replacement.mp4'), 'utf8'), 'external');
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('ffmpeg stderr maps time and ETA, caps at 99 and completes only after file validation', async () => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-progress-'));
  assert.equal(path.dirname(dir), path.resolve(TEMP_ROOT));
  try {
    const root = path.join(dir, 'job', 'attempt-2');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'clip.mkv'), 'data');
    const { runner, calls } = harness(), updates = [];
    const job = runner.start(item('mkv', 'fast', dir), value => updates.push(value));
    const c = calls[0].c;
    c.stderr.write('frame=1\nout_time_us=N/A\nspeed=N/A\nout_time_us=1000000\nspeed=0.5x\nprogress=continue\n');
    assert.equal(updates.at(-1).progress, 16.7);
    assert.equal(updates.at(-1).etaSec, 10);
    const count = updates.length;
    c.stderr.write('out_time_us=1000000\nspeed=0.5x\n');
    assert.equal(updates.length, count);
    c.stderr.write('out_time_us=9000000\n');
    assert.equal(updates.at(-1).progress, 99);
    assert.equal(updates.at(-1).etaSec, 0);
    c.stderr.write('progress=end\n');
    assert.equal(updates.at(-1).phase, 'processing');
    c.stdout.write('ytcut-progress:{"status":"finished","downloaded_bytes":100,"total_bytes":100}\nytcut-postprocess:{"status":"started"}\n');
    assert.equal(updates.at(-1).phase, 'processing');
    assert.ok(updates.every(value => value.progress < 100));
    c.stdout.write(mark(path.join(root, 'clip.mkv')) + '\n');
    c.emit('close', 0); await job.done;
    assert.equal(updates.at(-1).progress, 100);
    assert.equal(updates.at(-1).etaSec, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('postprocess started switches to processing and failed output never reports 100', async () => {
  const { runner, calls } = harness(), updates = [];
  const job = runner.start(item(), value => updates.push(value));
  calls[0].c.stdout.write('ytcut-postprocess:{"status":"started"}\n');
  assert.equal(updates.at(-1).phase, 'processing');
  assert.equal(updates.at(-1).progress, 99);
  calls[0].c.emit('close', 0);
  await assert.rejects(job.done, { code: 'OUTPUT_MISSING' });
  assert.ok(updates.every(value => value.progress < 100));
});

test('ffmpeg progress noise cannot overwrite stderr error tail', async () => {
  const { runner, calls } = harness();
  const job = runner.start(item());
  calls[0].c.stderr.write('ERROR: media unavailable\nWARNING: retry exhausted\n');
  calls[0].c.stderr.write(('frame=10\nfps=1\nbitrate=N/A\ntotal_size=2\nout_time_us=N/A\nout_time_ms=1\nout_time=00:00:01\nspeed=N/A\ndup_frames=0\ndrop_frames=0\nstream_0_0_q=1\nprogress=continue\n').repeat(1000));
  calls[0].c.emit('close', 1);
  await assert.rejects(job.done, error => {
    assert.equal(error.message, '콘텐츠 정보를 가져오지 못했습니다. 주소와 도구 상태를 확인하세요.');
    return error.code === 'DOWNLOAD_FAILED';
  });
});
test('metadata delegates argv, returns Video and validates JSON, duration and exit', async () => {
  for (const [payload, exit, error] of [
    [{ id: 'abcdefghijk', title: '한글', duration: 12 }, 0, null],
    [{ id: 'abcdefghijk', title: '한글', duration: 0 }, 0, 'INVALID_DURATION'],
    [{ duration: 12, is_upcoming: true }, 0, 'INVALID_DURATION'],
    [{ duration: 12 }, 0, 'INVALID_METADATA'],
    ['{', 0, 'INVALID_METADATA'],
    [{ duration: 12 }, 1, 'METADATA_FAILED'],
  ]) {
    const { runner, calls } = harness(); const p = runner.metadata(URL, { ytDlpPath: 'custom' });
    const { c, args, opts, exe } = calls[0];
    assert.deepEqual(args, buildMetadataArgs(URL)); assert.equal(exe, 'custom');
    assert.deepEqual(opts, { shell: false, windowsHide: true });
    const b = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const split = Math.max(1, b.indexOf(Buffer.from('한')) + 1);
    c.stdout.write(b.subarray(0, split)); c.stdout.write(b.subarray(split)); c.emit('close', exit);
    if (error) await assert.rejects(p, { code: error });
    else assert.deepEqual(await p, { url: URL, videoId: 'abcdefghijk', title: '한글', durationSec: 12 });
  }
});
test('download delegates all four format/mode combinations with canonical QueueItem', async () => {
  for (const format of ['mkv', 'mp4']) for (const cutMode of ['accurate', 'fast']) {
    const { runner, calls } = harness(); const value = item(format, cutMode); const job = runner.start(value);
    const { args, opts, exe, c } = calls[0];
    assert.deepEqual(args, buildDownloadArgs(value));
    assert.equal(exe, value.execution.ytDlpPath); assert.deepEqual(opts, { shell: false, windowsHide: true });
    assert.equal(args[args.indexOf('--download-sections') + 1], '*2.000-8.000');
    assert.equal(args[args.indexOf('-P') + 1], path.join(value.execution.outputDir, 'job', 'attempt-2'));
    assert.equal(args.includes('--force-keyframes-at-cuts'), cutMode === 'accurate');
    c.emit('close', 1); await assert.rejects(job.done, { code: 'DOWNLOAD_FAILED' });
  }
});
test('shared decoder/parser handles both streams, CRLF, split UTF-8 and final line', async () => {
  const { runner, calls } = harness(); const updates = [];
  const job = runner.start(item(), u => { updates.push(u); if (u.kind === 'postprocess') throw new Error('consumer'); });
  const c = calls[0].c;
  c.stdout.write('ytcut-progress:{"downloaded_bytes":4');
  c.stdout.write('2,"total_bytes":100,"speed":12,"eta":3}\r'); c.stdout.write('\ninvalid\n');
  const bytes = Buffer.from('ytcut-postprocess:{"status":"한글"}'); const split = bytes.indexOf(Buffer.from('한')) + 1;
  c.stderr.write(bytes.subarray(0, split)); c.stderr.write(bytes.subarray(split));
  c.emit('close', 1); await assert.rejects(job.done, { code: 'DOWNLOAD_FAILED' });
  assert.equal(updates.length, 3);
  assert.deepEqual(updates[1], { kind: 'progress', percent: 42, downloadedBytes: 42, totalBytes: 100,
    speedBps: 12, etaSec: 3, status: null, phase: 'downloading', progress: 42, timestamp: 123 });
  assert.equal(updates[2].status, '한글'); assert.equal(updates[2].phase, 'processing');
});
test('success requires after_move, exit zero, confined existing file and matching format', async () => {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, 'runner-'));
  // Verify the absolute cleanup target remains under the intended temp parent.
  assert.equal(path.dirname(dir), path.resolve(TEMP_ROOT));
  try {
    const root = path.join(dir, 'job', 'attempt-2'); await fs.mkdir(root, { recursive: true });
    for (const format of ['mkv', 'mp4']) await fs.writeFile(path.join(root, 'clip.' + format), 'data');
    const outside = path.join(dir, 'outside.mkv'); await fs.writeFile(outside, 'data');
    await fs.mkdir(path.join(root, 'folder.mkv'));
    for (const [format, file, exit, error] of [
      ['mkv', null, 0, 'OUTPUT_MISSING'], ['mkv', 'missing.mkv', 0, 'OUTPUT_MISSING'],
      ['mkv', 'folder.mkv', 0, 'OUTPUT_MISSING'], ['mkv', 'clip.mp4', 0, 'OUTPUT_FORMAT_MISMATCH'],
      ['mp4', 'clip.mkv', 0, 'OUTPUT_FORMAT_MISMATCH'], ['mkv', outside, 0, 'OUTPUT_OUTSIDE_ATTEMPT'],
      ['mkv', 'clip.mkv', 1, 'DOWNLOAD_FAILED'], ['mkv', 'clip.mkv', 0, null], ['mp4', 'clip.mp4', 0, null],
    ]) {
      const { runner, calls } = harness(); const job = runner.start(item(format, 'fast', dir));
      if (file) calls[0].c.stdout.write(mark(path.isAbsolute(file) ? file : path.join(root, file)));
      calls[0].c.emit('close', exit); calls[0].c.emit('close', exit);
      if (error) await assert.rejects(job.done, { code: error });
      else assert.equal((await job.done).outputPath, await fs.realpath(path.join(root, file)));
    }
    // Cancellation during asynchronous file validation must defeat success.
    const { runner, calls } = harness(); const job = runner.start(item('mkv', 'fast', dir));
    calls[0].c.stdout.write(mark(path.join(root, 'clip.mkv'))); calls[0].c.emit('close', 0);
    job.cancel(); await assert.rejects(job.done, { code: 'CANCELLED' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('Windows cancellation kills tree once, handles taskkill failure and late events', async () => {
  for (const failure of ['error', 'exit']) {
    const { runner, calls } = harness('win32'); const updates = []; const job = runner.start(item(), u => updates.push(u));
    let count = 0; const result = job.done.catch(e => { count++; return e; });
    job.cancel(); job.cancel(); await Promise.resolve(); assert.equal(count, 0); assert.equal(calls.length, 2);
    assert.equal(calls[1].exe, 'taskkill'); assert.deepEqual(calls[1].args, ['/PID', '42', '/T', '/F']);
    assert.deepEqual(calls[1].opts, { shell: false, windowsHide: true });
    if (failure === 'error') calls[1].c.emit('error', new Error('taskkill failed'));
    else calls[1].c.emit('close', 1);
    assert.equal(calls[0].c.killed, true);
    calls[0].c.stdout.write('ytcut-progress:{"downloaded_bytes":99,"total_bytes":100}\n');
    calls[0].c.emit('close', 0); calls[0].c.emit('error', new Error('late')); calls[0].c.emit('close', 1);
    assert.equal((await result).code, 'CANCELLED'); assert.equal(count, 1); assert.equal(updates.length, 1);
  }
});
test('spawn errors, metadata timeout, abort and output limit settle once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, calls } = harness(); const job = runner.start(item()); let count = 0;
  const p = job.done.catch(e => { count++; return e; });
  calls[0].c.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); calls[0].c.emit('close', 0);
  assert.equal((await p).code, 'ENOENT'); assert.equal(count, 1);
  const m = runner.metadata(URL); const mp = assert.rejects(m, { code: 'TIMEOUT' });
  t.mock.timers.tick(45000); calls[1].c.emit('close', 0); await mp; assert.equal(calls[1].c.killed, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runner.metadata(URL, { signal: controller.signal }), { code: 'ABORTED' }); assert.equal(calls.length, 2);
  const liveAbort = new AbortController(); const aborted = runner.metadata(URL, { signal: liveAbort.signal });
  const ap = assert.rejects(aborted, { code: 'ABORTED' }); liveAbort.abort(); calls[2].c.emit('close', 0); await ap;
  const large = runner.metadata(URL); const lp = assert.rejects(large, { code: 'OUTPUT_LIMIT' });
  calls[3].c.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1)); calls[3].c.emit('close', 0); await lp;
  const throwing = createRunner({ spawnImpl: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  await assert.rejects(throwing.start(item()).done, { code: 'ENOENT' });
  await assert.rejects(throwing.metadata(URL), { code: 'ENOENT' });
});
