import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createUpdater, getLegacyUserDataPath, RELEASE_URL, CHECK_INTERVAL } from '../lib/updater.js';

test('legacy userData stays fixed before ready and supplies state and managed tool paths', () => {
  const appDataPath = path.resolve('profiles', '한글 사용자');
  const expected = path.join(appDataPath, 'YT Cut');
  assert.equal(getLegacyUserDataPath(appDataPath), expected);
  const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const statement = source.match(/^app\.setPath\('userData', getLegacyUserDataPath\(app\.getPath\('appData'\)\)\);$/m);
  assert.ok(statement);
  assert.ok(statement.index < source.indexOf("app.whenReady()"));
  assert.ok(statement.index < source.indexOf("app.getPath('userData')"));
  const calls = [];
  runInNewContext(statement[0], { getLegacyUserDataPath, app: {
    getPath(name) { assert.equal(name, 'appData'); return appDataPath; },
    setPath(name, value) { calls.push([name, value]); },
  } });
  assert.deepEqual(calls, [['userData', expected]]);
  assert.match(source, /mkdir\(app\.getPath\('userData'\)/);
  assert.match(source, /createStore\(path\.join\(app\.getPath\('userData'\), 'state\.json'\)\)/);
  assert.match(source, /managedPath: path\.join\(app\.getPath\('userData'\), 'bin', 'yt-dlp\.exe'\)/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const fake = new EventEmitter();
  let checks = 0, downloads = 0, installs = 0, now = 0, nextId = 0;
  const timers = new Map(), pushes = [], opened = [];
  fake.checkForUpdates = async () => { checks++; fake.emit('update-available', { version: '0.4.0' }); };
  fake.downloadUpdate = async () => { downloads++; fake.emit('update-downloaded', { version: '0.4.0' }); };
  fake.quitAndInstall = () => { installs++; };
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay, interval: false }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
  };
  const updater = createUpdater({ autoUpdater: fake, currentVersion: '0.3.0', isPackaged: true,
    openExternal: async url => opened.push(url), onChange: state => pushes.push(state), clock, ...options });
  const fire = delay => {
    now += delay;
    for (const [id, timer] of [...timers]) if (timer.delay === delay) {
      if (!timer.interval) timers.delete(id);
      timer.fn();
    }
  };
  return { fake, updater, timers, pushes, opened, fire,
    counts: () => ({ checks, downloads, installs }) };
}

test('checking exposes versions and treats the current version as unavailable', async () => {
  const f = fixture();
  await f.updater.check(true);
  assert.deepEqual(f.pushes.map(s => s.status), ['checking', 'available']);
  assert.equal(f.updater.getState().latestVersion, '0.4.0');
  assert.equal(f.updater.getState().currentVersion, '0.3.0');
  f.fake.emit('update-available', { version: '0.3.0' });
  assert.equal(f.updater.getState().status, 'not-available');
  f.fake.emit('update-not-available', { version: '0.3.0' });
  assert.equal(f.updater.getState().status, 'not-available');
  for (const key of ['autoDownload', 'autoInstallOnAppQuit', 'allowPrerelease', 'allowDowngrade']) assert.equal(f.fake[key], false);
  const snapshot = f.updater.getState(); snapshot.status = 'error';
  assert.equal(f.updater.getState().status, 'not-available');
});

test('downloads coalesce progress pushes and complete at 100 percent', async () => {
  const f = fixture(), done = deferred();
  await f.updater.check();
  f.fake.downloadUpdate = () => done.promise;
  const downloading = f.updater.download();
  await Promise.resolve();
  assert.equal(f.updater.getState().status, 'downloading');
  const before = f.pushes.length;
  for (const percent of [10, 20, 30]) f.fake.emit('download-progress', { percent });
  assert.equal(f.pushes.length, before);
  f.fire(250);
  assert.equal(f.pushes.length, before + 1);
  assert.equal(f.pushes.at(-1).percent, 30);
  f.fake.emit('download-progress', { percent: 101 });
  assert.equal(f.updater.getState().percent, 100);
  f.fake.emit('update-downloaded', { version: '0.4.0' });
  done.resolve(); await downloading;
  assert.equal(f.updater.getState().status, 'downloaded');
  assert.equal(f.updater.getState().percent, 100);
  f.fire(250);
  assert.equal(f.pushes.at(-1).status, 'downloaded');
});

test('portable and development downloads only open the fixed release URL', async () => {
  for (const options of [{ portable: true }, { isPackaged: false }]) {
    const f = fixture(options);
    await f.updater.check();
    assert.equal(f.updater.getState().canAutoUpdate, false);
    if (options.isPackaged === false) {
      f.updater.start(); assert.equal(f.timers.size, 0);
      assert.equal(f.updater.getState().status, 'idle');
      assert.equal(f.counts().checks, 0);
    } else assert.equal(f.updater.getState().status, 'available');
    f.fake.emit('update-available', { version: '0.4.0', releaseUrl: 'https://evil.example/token' });
    await f.updater.download();
    assert.deepEqual(f.opened, [RELEASE_URL]);
    assert.equal(RELEASE_URL, 'https://github.com/OhSorry-DP/streamcut/releases/latest');
    assert.ok(f.opened.every(url => url.startsWith('https://github.com/OhSorry-DP/streamcut/releases/')));
    assert.equal(f.counts().downloads, 0);
  }
});

test('checks share one operation and schedule five seconds then six hours', async () => {
  const f = fixture(), pending = deferred();
  let calls = 0;
  f.fake.checkForUpdates = () => { calls++; return pending.promise; };
  f.updater.start(); f.updater.start();
  assert.deepEqual([...f.timers.values()].map(t => t.delay), [5000, CHECK_INTERVAL]);
  f.fire(5000); await Promise.resolve();
  const first = f.updater.check(), second = f.updater.check(true);
  assert.equal(first, second);
  assert.equal(f.updater.getState().manual, true);
  f.fire(CHECK_INTERVAL); await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(); await first;
  f.fire(CHECK_INTERVAL); await Promise.resolve();
  assert.equal(calls, 2);
  await f.updater.check();
  f.updater.stop(); assert.equal(f.timers.size, 0);
});

test('automatic and manual errors retain intent and hide raw error details', async () => {
  const f = fixture();
  f.fake.checkForUpdates = async () => { throw new Error('https://secret.example/token stack'); };
  for (const manual of [false, true]) {
    await f.updater.check(manual);
    const state = f.updater.getState();
    assert.equal(state.status, 'error'); assert.equal(state.manual, manual);
    assert.equal(state.error.code, 'UPDATE_FAILED');
    assert.doesNotMatch(state.error.message, /secret|token|stack|https/);
    assert.match(state.error.message, /업데이트/);
  }
});

test('install cancellation avoids quitting and approval waits for cleanup', async () => {
  let approved = false;
  const cleanup = deferred(), f = fixture({ hasActiveJobs: () => true,
    confirmInstall: async () => approved, prepareInstall: () => cleanup.promise });
  await f.updater.check(); await f.updater.download();
  assert.deepEqual(await f.updater.install(), { cancelled: true });
  assert.equal(f.counts().installs, 0);
  approved = true;
  const install = f.updater.install();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.counts().installs, 0);
  cleanup.resolve();
  assert.deepEqual(await install, { installing: true });
  assert.equal(f.counts().installs, 1);
  const failed = fixture({ prepareInstall: async () => { throw new Error('flush failed'); } });
  await failed.updater.check(); await failed.updater.download();
  assert.deepEqual(await failed.updater.install(), { cancelled: true });
  assert.equal(failed.counts().installs, 0);
});
