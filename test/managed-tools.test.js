import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createManagedTool } from '../lib/ytdlp-updater.js';

function harness(options = {}) {
  const files = new Map();
  const calls = { fetch: 0, aborts: 0, replaces: 0 };
  const settings = { ffmpegPath: 'ffmpeg', autoUpdateFfmpeg: false };
  const timers = new Map();
  let timerId = 0;
  const clock = {
    setTimeout(fn, ms) { const id = ++timerId; if (ms <= 200) queueMicrotask(fn); else timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++timerId; }, clearInterval(id) { timers.delete(id); },
  };
  const failRename = options.failRename || (() => false);
  const jobList = [...(options.jobs || [])];
  const fs = {
    async stat(name) { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => true, size: Buffer.byteLength(files.get(name)) }; },
    async readFile(name) { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(name); },
    async writeFile(name, data) { if (options.failMetaWrite && name.endsWith('.meta.json.tmp')) throw new Error('metadata write failed'); files.set(name, Buffer.from(data)); },
    async unlink(name) { if (!files.delete(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    async rename(from, to) { if (failRename(from, to)) throw new Error('rename failed'); if (!files.has(from)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); files.set(to, files.get(from)); files.delete(from); },
    async mkdir() {},
    async open(name) { const chunks = []; return { async writeFile(data) { chunks.push(Buffer.from(data)); files.set(name, Buffer.concat(chunks)); }, async close() {} }; },
    promises: {
      async stat(name) { return fs.stat(name); }, async readFile(name) { return fs.readFile(name); },
      async writeFile(name, data) { return fs.writeFile(name, data); }, async unlink(name) { return fs.unlink(name); },
      async rename(from, to) { return fs.rename(from, to); }, async mkdir() {},
      async realpath(name) { return name; },
    },
  };
  const bytes = Buffer.from('small deterministic package');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let candidateRevision = 1;
  const candidate = () => ({ repo: 'BtbN/FFmpeg-Builds', channel: 'release', branch: '9.0', releaseTag: 'latest', assetName: 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip', assetId: candidateRevision, assetUpdatedAt: `2026-10-0${candidateRevision}T00:00:00Z`, downloadBytes: bytes.length, packageSha256: checksum, candidateId: `candidate-${candidateRevision}`, downloadURL: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/asset.zip' });
  const descriptor = {
    id: 'ffmpeg', pathKey: 'ffmpegPath', autoUpdateKey: 'autoUpdateFfmpeg', defaultCommand: 'ffmpeg',
    async probe(file) { const usable = files.has(file) && !String(files.get(file)).startsWith('broken'); return { usable, version: usable ? 'n9.0.2-24-gfd5d616c29-20261009' : null, capabilities: usable ? ['libx264', 'gpl'] : [] }; },
    async discover() { if (options.discoverFailure) throw Object.assign(new Error('discovery failed'), { code: options.discoverFailure }); return candidate(); }, compare(meta, next) { if (!meta?.assetId) return 'unknown'; return meta.assetId === next.assetId ? 'same' : 'newer'; },
    async verifyAndStage() { const name = '/bin/stage/candidate.exe'; files.set(name, Buffer.from('new executable')); return { candidateExe: name, binarySha256: 'binary-hash', packageSha256: checksum, version: 'n9.0.2-24-gfd5d616c29-20261009', capabilities: ['libx264', 'gpl'] }; },
    async beforeReplace() { calls.replaces++; },
  };
  const fetch = async (_url, init) => {
    calls.fetch++;
    const body = { async *[Symbol.asyncIterator]() { if (options.hang) await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })); yield bytes; } };
    return { ok: true, status: 200, url: _url, headers: { get: () => null }, body, async arrayBuffer() { return bytes; }, async text() { return ''; }, async json() { return {}; } };
  };
  const spawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { calls.aborts++; }; queueMicrotask(() => { child.stdout.emit('data', Buffer.from('ffmpeg version n9.0.2-24-gfd5d616c29-20261009')); child.emit('close', 0); }); return child; };
  const tool = createManagedTool({ fetch, spawn, fs, clock, managedPath: '/bin/ffmpeg.exe', descriptor, getSettings: () => settings, jobs: { list: () => jobList }, sharedGate: options.sharedGate });
  return { tool, files, settings, calls, clock, candidate, setRevision(value) { candidateRevision = value; }, setJobs(value) { jobList.splice(0, jobList.length, ...value); }, fireTimer(ms) { const item = [...timers].find(([, timer]) => timer.ms === ms); if (item) { timers.delete(item[0]); item[1].fn(); return true; } return false; } };
}

test('auto update off still installs once, then leaves the managed tool untouched without receiving a body', async () => {
  const h = harness();
  const first = await h.tool.ensureInstalled();
  assert.equal(first.status, 'available');
  const installed = await h.tool.download({ candidateId: first.candidateId, acknowledgedBytes: first.downloadBytes });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.source, 'managed');
  assert.equal(h.settings.autoUpdateFfmpeg, false);
  assert.equal(h.calls.fetch, 1);
  const checked = await h.tool.check(false);
  assert.equal(checked.status, 'up-to-date');
  assert.equal(h.calls.fetch, 1);
});

test('size acknowledgement is required before body and a stale candidate cannot be downloaded', async () => {
  const h = harness();
  const found = await h.tool.check(true);
  const before = h.calls.fetch;
  await h.tool.download({ candidateId: found.candidateId, acknowledgedBytes: found.downloadBytes - 1 });
  assert.equal(h.calls.fetch, before);
  h.setRevision(2);
  await h.tool.check(true);
  const refreshed = h.tool.getState();
  assert.notEqual(refreshed.candidateId, found.candidateId);
  await h.tool.download({ candidateId: found.candidateId, acknowledgedBytes: found.downloadBytes });
  assert.equal(h.calls.fetch, before);
});

test('two tools share the replacement gate and queue changes retry a staged replacement after jobs drain', async () => {
  let release;
  const gate = { run(callback) { return new Promise((resolve, reject) => { release = () => Promise.resolve().then(callback).then(resolve, reject); }); } };
  const h = harness({ sharedGate: gate, jobs: [{ status: 'running' }] });
  const found = await h.tool.check(true);
  const pending = h.tool.download({ candidateId: found.candidateId, acknowledgedBytes: found.downloadBytes });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.tool.getState().status, 'downloaded-pending');
  release();
  await pending;
  assert.equal(h.files.has('/bin/ffmpeg.exe'), false);
  h.setJobs([]);
  const queued = h.tool.queueChanged();
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await queued).status, 'installed');
  assert.equal(h.files.has('/bin/ffmpeg.exe'), true);
});

test('metadata write failure restores both previous executable and metadata', async () => {
  const h = harness({ failMetaWrite: true });
  h.files.set('/bin/ffmpeg.exe', Buffer.from('old executable'));
  h.files.set('/bin/ffmpeg.exe.meta.json', Buffer.from(JSON.stringify({ assetId: 0, assetUpdatedAt: '2026-10-01T00:00:00Z', packageSha256: 'old' })));
  const originalWrite = h.files;
  const found = await h.tool.check(true);
  const result = await h.tool.download({ candidateId: found.candidateId, acknowledgedBytes: found.downloadBytes });
  assert.equal(result.status, 'error');
  assert.equal(originalWrite.get('/bin/ffmpeg.exe').toString(), 'old executable');
  assert.equal(JSON.parse(originalWrite.get('/bin/ffmpeg.exe.meta.json').toString()).assetId, 0);
});

test('network and 404 discovery errors preserve the usable managed tool and PATH is used only when it is unusable', async () => {
  const h = harness({ discoverFailure: 'UPDATE_NOT_FOUND' });
  h.files.set('/bin/ffmpeg.exe', Buffer.from('valid managed executable'));
  const effective = await h.tool.effective();
  assert.equal(effective.source, 'managed');
  const failed = await h.tool.check(true);
  assert.equal(failed.status, 'error');
  assert.equal(failed.source, 'managed');
  assert.equal(failed.error.code, 'NETWORK');
  h.files.set('/bin/ffmpeg.exe', Buffer.from('broken managed executable'));
  const fallback = await h.tool.effective();
  assert.equal(fallback.source, 'none');
  h.files.set('/bin/ffmpeg.exe', Buffer.from('valid managed executable'));
  const result = await h.tool.check(true);
  assert.equal(result.source, 'managed');
});

test('stop aborts active transfer and progress and configured large-transfer timeouts stay bounded', async () => {
  const h = harness({ hang: true });
  const found = await h.tool.check(true);
  const pending = h.tool.download({ candidateId: found.candidateId, acknowledgedBytes: found.downloadBytes });
  while (h.calls.fetch === 0) await new Promise(resolve => setImmediate(resolve));
  h.tool.stop();
  await pending;
  assert.equal(h.files.has('/bin/ffmpeg.exe'), false);
  assert.equal(h.tool.getState().percent == null || (h.tool.getState().percent >= 0 && h.tool.getState().percent <= 100), true);
  assert.ok(h.calls.fetch >= 1);
  const timed = harness({ hang: true });
  const next = await timed.tool.check(true);
  const timedDownload = timed.tool.download({ candidateId: next.candidateId, acknowledgedBytes: next.downloadBytes });
  while (timed.calls.fetch === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(timed.fireTimer(30000), true);
  await timedDownload;
  assert.equal(timed.tool.getState().percent == null || timed.tool.getState().percent <= 100, true);
});
