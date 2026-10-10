import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createYtdlpUpdater, compareVersions, parseSums, resolveEffectivePath, allowedAsset } from '../lib/ytdlp-updater.js';

// GitHub 은 릴리즈 파일을 release-assets.githubusercontent.com 으로 리다이렉트한다(실환경에서 허용 목록 누락으로 실패한 적 있음).
test('asset host allowlist accepts GitHub release hosts only', () => {
  for (const url of ['https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe',
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r',
    'https://objects.githubusercontent.com/x', 'https://a.objects.githubusercontent.com/x']) assert.equal(allowedAsset(url), true, url);
  for (const url of ['http://github.com/x', 'https://evil.com/github.com', 'https://raw.githubusercontent.com/x', 'https://github.com.evil.com/x',
    'https://user:pw@github.com/x', 'https://github.com:8443/x', 'https://release-assets.githubusercontent.com.evil.com/x']) assert.equal(allowedAsset(url), false, url);
});

const managedPath = '/data/bin/yt-dlp.exe';
const latest = '2026.09.01';
const binaryURL = 'https://github.com/yt-dlp/yt-dlp/releases/download/current/yt-dlp.exe';
const sumsURL = 'https://github.com/yt-dlp/yt-dlp/releases/download/current/SHA2-256SUMS';
const missing = () => Object.assign(new Error('Missing'), { code: 'ENOENT' });
function fixture(options = {}) {
  const bytes = Buffer.alloc(options.small ? 1024 : 5 * 1024 * 1024, 7);
  const old = Buffer.from('old executable');
  const files = new Map(options.noManaged ? [] : [[managedPath, old]]);
  const settings = { ytDlpPath: 'yt-dlp', autoUpdateYtDlp: true, ...options.settings };
  const requests = [], commands = [], changes = [], timers = new Map(), delays = [];
  let timerID = 0, active = options.busy || false, renameFailures = options.renameFailures || 0;
  const clock = {
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, { fn, delay }); if ([50, 100, 200].includes(delay)) { delays.push(delay); queueMicrotask(() => { timers.delete(id); fn(); }); } return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++timerID; timers.set(id, { fn, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  const fs = {
    async stat(file) { if (!files.has(file)) throw missing(); return { isFile: () => true }; },
    async mkdir() {},
    async unlink(file) { if (!files.delete(file)) throw missing(); },
    async rename(from, to) {
      if (from.endsWith('.download') && renameFailures-- > 0) throw Object.assign(new Error('Locked'), { code: 'EPERM' });
      if (!files.has(from)) throw missing();
      files.set(to, files.get(from)); files.delete(from);
    },
    async open(file) {
      files.set(file, Buffer.alloc(0));
      return { async writeFile(chunk) { files.set(file, Buffer.concat([files.get(file), chunk])); }, async close() {} };
    },
  };
  const spawn = (command, args, config) => {
    commands.push({ command, args, config });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => {
      const value = command.endsWith('.download') ? (options.wrongVersion ? '2026.08.19' : latest) : options.current === undefined ? '2026.08.19' : options.current;
      if (value === null) child.emit('error', new Error('Unavailable'));
      else { child.stdout.emit('data', `${value}\n`); child.emit('close', 0); }
    });
    return child;
  };
  const fetch = async (url, config) => {
    requests.push(url); assert.equal(config.redirect, 'manual');
    assert.equal(config.headers['User-Agent'], 'streamcut');
    if (options.networkError) throw new Error('Secret URL and stack');
    const headers = { get: name => name === 'location' ? options.redirect : String(bytes.length) };
    if (url === binaryURL && options.redirect) return { status: 302, headers };
    return { ok: true, status: 200, url, headers,
      async json() { return { tag_name: latest, assets: [
        { name: 'yt-dlp.exe', browser_download_url: options.assetURL || binaryURL, size: bytes.length },
        { name: 'SHA2-256SUMS', browser_download_url: sumsURL },
      ] }; },
      async text() { return `${options.badHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}  yt-dlp.exe\n`; },
      body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 1024); yield bytes.subarray(1024); } },
    };
  };
  const updater = createYtdlpUpdater({ fetch, spawn, fs, clock, managedPath, getSettings: () => settings,
    jobs: { list: () => active ? [{ status: 'running' }] : [] }, onChange: value => changes.push(value) });
  return { updater, files, old, bytes, settings, requests, commands, changes, timers, delays,
    emptyQueue() { active = false; return updater.queueChanged(); } };
}

test('numeric versions and exact checksum entry parsing', () => {
  assert.equal(compareVersions('2026.09.01', '2026.08.19'), 1);
  assert.equal(compareVersions('2026.08.19.1000000', '2026.08.19.999999'), 1);
  assert.equal(compareVersions('2026.08.19.9', '2026.08.19.10'), -1);
  assert.equal(compareVersions('2026.08.19', '2026.08.19.0'), 0);
  const hash = 'a'.repeat(64);
  assert.equal(parseSums(`${'b'.repeat(64)}  yt-dlp.exe.zip\n${hash} *yt-dlp.exe\r\n`), hash);
  assert.throws(() => parseSums('invalid'));
});

test('effective path respects managed existence, custom paths and opt out', async () => {
  assert.deepEqual(resolveEffectivePath({ ytDlpPath: 'yt-dlp' }, managedPath, true), { path: managedPath, source: 'managed' });
  assert.deepEqual(resolveEffectivePath({ ytDlpPath: 'yt-dlp' }, managedPath, false), { path: 'yt-dlp', source: 'path' });
  assert.deepEqual(resolveEffectivePath({ ytDlpPath: '/custom/tool.exe' }, managedPath, true), { path: '/custom/tool.exe', source: 'custom' });
  assert.deepEqual(resolveEffectivePath({ ytDlpPath: 'yt-dlp', autoUpdateYtDlp: false }, managedPath, true), { path: 'yt-dlp', source: 'path' });
  const custom = fixture({ settings: { ytDlpPath: '/custom/tool.exe' } });
  assert.equal((await custom.updater.check(true)).status, 'disabled'); assert.equal(custom.requests.length, 0);
  const disabled = fixture({ settings: { autoUpdateYtDlp: false } });
  await disabled.updater.check(); assert.equal(disabled.requests.length, 0);
  assert.equal((await disabled.updater.check(true)).status, 'available'); assert.equal(disabled.requests.length, 1);
});

test('latest or newer PATH version downloads nothing; checks serialize and schedule', async () => {
  for (const current of [latest, '2026.09.01.1234567']) {
    const f = fixture({ noManaged: true, current });
    const first = f.updater.check(true); assert.equal(f.updater.getState().status, 'checking');
    assert.equal(f.updater.check(true), first);
    assert.equal((await first).status, 'up-to-date');
    assert.equal(f.requests.length, 1); assert.equal(f.commands[0].command, 'yt-dlp');
    assert.equal(f.files.size, 0);
    f.updater.start(); assert.deepEqual([...f.timers.values()].map(t => t.delay), [10000, 43200000]);
    f.updater.stop(); assert.equal(f.timers.size, 0);
  }
});

test('download verifies hash and version, replaces with backup and retries locks', async () => {
  for (const renameFailures of [0, 3]) {
    const f = fixture({ renameFailures });
    const state = await f.updater.check(true);
    assert.equal(state.status, 'updated'); assert.equal(state.currentVersion, latest); assert.equal(state.source, 'managed');
    assert.deepEqual(f.files.get(`${managedPath}.bak`), f.old);
    assert.deepEqual(f.files.get(managedPath), f.bytes); assert.equal(f.files.has(`${managedPath}.download`), false);
    assert.equal(f.commands[1].command, `${managedPath}.download`);
    assert.deepEqual(f.commands[1].args, ['--version']); assert.equal(f.commands[1].config.shell, false);
    assert.ok(f.changes.some(value => value.status === 'downloading' && value.percent === 100));
    assert.equal(f.timers.size, 0);
    if (renameFailures) assert.deepEqual(f.delays, [50, 100, 200]);
  }
  const missingTool = fixture({ noManaged: true, current: null });
  assert.equal((await missingTool.updater.check(true)).status, 'updated');
});

test('invalid downloads and rejected hosts are discarded while original survives', async () => {
  for (const options of [{ badHash: true }, { wrongVersion: true }, { small: true }, { renameFailures: 4 },
    { assetURL: 'https://evil.example/yt-dlp.exe' }, { redirect: 'https://evil.example/file' }, { networkError: true }]) {
    const f = fixture(options); const state = await f.updater.check(true);
    assert.equal(state.status, 'error'); assert.equal(state.manual, true);
    assert.deepEqual(f.files.get(managedPath), f.old); assert.equal(f.files.has(`${managedPath}.download`), false);
    assert.ok(!state.error.message.includes('https:')); assert.equal(f.timers.size, 0);
    assert.ok(f.requests.every(url => !url.includes('evil.example')));
  }
  const automatic = fixture({ networkError: true });
  assert.equal((await automatic.updater.check()).manual, false);
  const promoted = fixture({ networkError: true });
  const checking = promoted.updater.check(); promoted.updater.check(true);
  assert.equal((await checking).manual, true);
});

test('active queue defers replacement until change notification finds it empty', async () => {
  const f = fixture({ busy: true });
  assert.equal((await f.updater.check(true)).status, 'downloaded-pending');
  assert.deepEqual(f.files.get(managedPath), f.old);
  assert.equal(f.files.has(`${managedPath}.bak`), false);
  await f.updater.queueChanged(); assert.equal(f.updater.getState().status, 'downloaded-pending');
  await f.emptyQueue(); assert.equal(f.updater.getState().status, 'updated');
  assert.deepEqual(f.files.get(`${managedPath}.bak`), f.old);
  const disabled = fixture({ busy: true });
  await disabled.updater.check(true); disabled.settings.autoUpdateYtDlp = false;
  await disabled.emptyQueue(); assert.equal(disabled.updater.getState().status, 'available');
  assert.deepEqual(disabled.files.get(managedPath), disabled.old);
  const gated = fixture(); const order = []; let release;
  const first = gated.updater.withExecution(async () => { order.push('add'); await new Promise(resolve => { release = resolve; }); });
  const second = gated.updater.withExecution(() => { order.push('retry'); });
  await Promise.resolve(); assert.deepEqual(order, ['add']); release();
  await Promise.all([first, second]); assert.deepEqual(order, ['add', 'retry']);
});
