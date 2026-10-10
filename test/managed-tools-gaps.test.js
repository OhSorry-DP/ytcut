import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createManagedTool, createYtdlpUpdater } from '../lib/ytdlp-updater.js';
import { createFfmpegDescriptor } from '../lib/ffmpeg-tool.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = () => Object.assign(new Error('없음'), { code: 'ENOENT' });
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ descriptor, autoUpdate = true, sharedGate, withToolUse } = {}) {
  const managedPath = descriptor ? '/data/bin/ffmpeg.exe' : '/data/bin/yt-dlp.exe';
  const binaryURL = 'https://github.com/yt-dlp/yt-dlp/releases/download/current/yt-dlp.exe';
  const sumsURL = 'https://github.com/yt-dlp/yt-dlp/releases/download/current/SHA2-256SUMS';
  const bytes = Buffer.alloc(descriptor ? 32 : 5 * 1024 * 1024, 7);
  const old = Buffer.from('이전 실행 파일');
  const files = new Map([[managedPath, old]]), requests = [], commands = [], renames = [], uses = [];
  const settings = { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', autoUpdateYtDlp: autoUpdate, autoUpdateFfmpeg: autoUpdate };
  let busy = false;
  const fs = {
    async stat(file) { if (!files.has(file)) throw missing(); return { isFile: () => true, size: files.get(file).length }; },
    async readFile(file, encoding) { if (!files.has(file)) throw missing(); return encoding ? files.get(file).toString(encoding) : files.get(file); },
    async writeFile(file, value) { files.set(file, Buffer.from(value)); },
    async mkdir() {},
    async unlink(file) { if (!files.delete(file)) throw missing(); },
    async rename(from, to) { if (!files.has(from)) throw missing(); renames.push([from, to]); files.set(to, files.get(from)); files.delete(from); },
    async open(file) { files.set(file, Buffer.alloc(0)); return { async writeFile(chunk) { files.set(file, Buffer.concat([files.get(file), chunk])); }, async close() {} }; },
  };
  const spawn = (command, args) => {
    commands.push([command, args]);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit('data', command.endsWith('.download') ? '2026.10.09\n' : '2026.09.01\n'); child.emit('close', 0); });
    return child;
  };
  const fetch = async url => {
    requests.push(url);
    return { ok: true, status: 200, url, headers: { get: () => null },
      json: async () => ({ tag_name: '2026.10.09', assets: [{ name: 'yt-dlp.exe', size: bytes.length, browser_download_url: binaryURL }, { name: 'SHA2-256SUMS', browser_download_url: sumsURL }] }),
      text: async () => `${hash(bytes)}  yt-dlp.exe\n`,
      body: { async *[Symbol.asyncIterator]() { yield bytes; } },
    };
  };
  const factory = descriptor ? createManagedTool : createYtdlpUpdater;
  const tool = factory({ fetch, spawn, fs, descriptor, managedPath, sharedGate,
    getSettings: () => settings, jobs: { list: () => busy ? [{ status: 'waiting' }] : [] },
    withToolUse: (id, callback) => { uses.push(id); return withToolUse ? withToolUse(id, callback) : callback(); },
  });
  return { tool, fs, spawn, files, settings, requests, commands, renames, uses, bytes, old, managedPath, setBusy(value) { busy = value; } };
}

test('메타 전용 확인은 자동 갱신이 켜져도 수신·교체와 후속 큐 수신을 시작하지 않는다', async () => {
  const f = fixture();
  const first = f.tool.check(true, { downloadAllowed: false });
  assert.equal(f.tool.check(true, { downloadAllowed: false }), first);
  const state = await first;
  assert.equal(state.status, 'available'); assert.equal(state.manual, true); assert.equal(state.canDownload, true);
  await f.tool.queueChanged(); await f.tool.refreshSettings();
  assert.equal(f.requests.length, 1); assert.equal(f.renames.length, 0);
  assert.deepEqual(f.files.get(f.managedPath), f.old);
  assert.equal(f.files.has(`${f.managedPath}.download`), false);
});

test('메타 전용 확인은 이미 받은 보류 후보도 교체하지 않는다', async () => {
  const f = fixture(); f.setBusy(true);
  assert.equal((await f.tool.check(true)).status, 'downloaded-pending');
  f.setBusy(false);
  assert.equal((await f.tool.check(true, { downloadAllowed: false })).status, 'downloaded-pending');
  assert.equal(f.renames.length, 0); assert.equal(f.requests.length, 4);
  await f.tool.queueChanged();
  assert.equal(f.tool.getState().status, 'updated');
});

test('호환 수동 확인의 자동 수신은 유지하고 opt-out 뒤 명시적 수신은 허용한다', async () => {
  const legacy = fixture();
  assert.equal((await legacy.tool.check(true)).status, 'updated');
  assert.ok(legacy.uses.length >= 2);
  const f = fixture({ autoUpdate: false });
  const state = await f.tool.check(true, { downloadAllowed: false });
  await f.tool.download({ candidateId: '다른 후보', acknowledgedBytes: state.downloadBytes });
  assert.equal(f.requests.length, 1);
  await f.tool.download({ candidateId: state.candidateId, acknowledgedBytes: state.downloadBytes });
  assert.equal(f.tool.getState().status, 'updated');
  assert.deepEqual(f.files.get(f.managedPath), f.bytes);
});

test('descriptor의 내부 probe와 검증도 추적하고 진행 중 탐지 종료 뒤 교체한다', async () => {
  const context = new AsyncLocalStorage(), leases = new Set(), order = [];
  let finishProbe, holdProbe = false, f;
  const descriptor = {
    id: 'ffmpeg', pathKey: 'ffmpegPath', autoUpdateKey: 'autoUpdateFfmpeg', defaultCommand: 'ffmpeg',
    async probe(file) {
      order.push(`probe:${file}`);
      if (holdProbe) { holdProbe = false; await new Promise(resolve => { finishProbe = resolve; }); }
      return { usable: true, version: 'n9.0.2', capabilities: ['libx264', 'aac'] };
    },
    async discover() { return { candidateId: 'candidate', downloadBytes: 32, downloadURL: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/package.zip', packageSha256: hash(f.bytes) }; },
    compare: () => 'newer',
    async verifyAndStage(file) {
      order.push('stage');
      const candidateExe = '/data/bin/stage/candidate.exe';
      await f.fs.writeFile(candidateExe, await f.fs.readFile(file));
      return { candidateExe, version: 'n9.0.2', binarySha256: hash(f.bytes), packageSha256: hash(f.bytes) };
    },
  };
  const withToolUse = async (_, callback) => {
    if (context.getStore()) return callback();
    let release;
    const lease = new Promise(resolve => { release = resolve; }); leases.add(lease);
    try { return await callback(); } finally { leases.delete(lease); release(); }
  };
  const sharedGate = async (callback, mode) => {
    assert.equal(mode.replacement, true);
    order.push('barrier'); await Promise.all([...leases]); order.push('replace');
    return context.run(true, callback);
  };
  f = fixture({ descriptor, sharedGate, withToolUse });
  const state = await f.tool.check(true, { downloadAllowed: false });
  holdProbe = true;
  const detecting = f.tool.effective(); await turn();
  const installing = f.tool.download({ candidateId: state.candidateId, acknowledgedBytes: state.downloadBytes });
  await turn();
  assert.ok(order.includes('barrier')); assert.equal(f.renames.length, 0);
  finishProbe(); await Promise.all([detecting, installing]);
  assert.equal(f.tool.getState().status, 'updated', JSON.stringify({ state: f.tool.getState(), order, renames: f.renames }));
  assert.ok(f.uses.length >= 4); assert.ok(order.indexOf('replace') > order.indexOf('barrier'));
  assert.ok(order.slice(order.indexOf('replace')).includes(`probe:${f.managedPath}`));
  assert.equal(f.tool.getState().canDownload, false);
});

test('두 엔진의 교체와 큐 실행은 같은 게이트에서 직렬 처리한다', async () => {
  let tail = Promise.resolve(), release;
  const order = [];
  const gate = (callback, mode) => {
    const next = tail.then(async () => { order.push(mode?.replacement ? 'replace' : 'queue'); return callback(); });
    tail = next.catch(() => {}); return next;
  };
  const first = fixture({ sharedGate: gate }), second = fixture({ sharedGate: gate });
  const queue = first.tool.withExecution(() => new Promise(resolve => { release = resolve; }));
  await turn();
  const a = first.tool.check(true), b = second.tool.check(true);
  await turn(); assert.deepEqual(order, ['queue']); assert.equal(first.renames.length + second.renames.length, 0);
  release(); await Promise.all([queue, a, b]);
  assert.deepEqual(order, ['queue', 'replace', 'replace']);
  assert.equal(first.tool.getState().status, 'updated'); assert.equal(second.tool.getState().status, 'updated');
});

test('실제 9.0 descriptor는 엔진의 제한된 메타 전송을 사용하고 변경 후보 수신을 폐기한다', async () => {
  const f = fixture();
  const zip = Buffer.from('작은 가짜 ZIP');
  const zipName = 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip';
  const apiURL = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest';
  const prefix = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
  let generation = 1, stages = 0;
  const requests = [];
  const fetch = async (url, config) => {
    assert.equal(config.redirect, 'manual'); assert.ok(config.signal);
    requests.push(url);
    const text = url === apiURL ? JSON.stringify({ tag_name: 'latest', assets: [
      { id: generation, name: zipName, size: zip.length, updated_at: '2026-10-09T14:14:00Z', browser_download_url: prefix + zipName },
      { id: 42, name: 'checksums.sha256', updated_at: '2026-10-09T14:14:00Z', browser_download_url: prefix + 'checksums.sha256' },
    ] }) : `${hash(zip)}  ${zipName}\n${'a'.repeat(64)}  ffmpeg-n9.0-latest-win64-lgpl-9.0.zip\n`;
    return { ok: true, status: 200, url, headers: { get: () => null }, body: { async *[Symbol.asyncIterator]() { yield url.endsWith('.zip') ? zip : Buffer.from(text); } } };
  };
  const descriptor = createFfmpegDescriptor({ fetch: () => { throw new Error('엔진 전송을 우회함'); }, spawn: f.spawn, fs: { promises: f.fs }, platform: 'win32', arch: 'x64', stageRoot: process.cwd() });
  descriptor.probe = async () => ({ usable: true, version: 'n9.0.2', capabilities: ['libx264', 'aac'] });
  descriptor.verifyAndStage = async () => { stages++; throw new Error('바뀐 후보를 검증하면 안 됨'); };
  const tool = createManagedTool({ descriptor, fetch, spawn: f.spawn, fs: f.fs, managedPath: '/data/bin/ffmpeg.exe', getSettings: () => f.settings });
  const state = await tool.check(true, { downloadAllowed: false });
  assert.equal(state.status, 'available'); assert.equal(state.downloadBytes, zip.length);
  assert.deepEqual(requests, [apiURL, prefix + 'checksums.sha256']);
  await tool.download({ candidateId: state.candidateId, acknowledgedBytes: zip.length + 1 });
  assert.equal(requests.length, 2);
  generation++;
  await tool.download({ candidateId: state.candidateId, acknowledgedBytes: zip.length });
  assert.equal(tool.getState().error.code, 'VERIFY'); assert.equal(tool.getState().usable, true);
  assert.equal(stages, 0); assert.equal(f.renames.length, 0);
  assert.equal(f.files.has('/data/bin/ffmpeg.exe.download'), false);
});
