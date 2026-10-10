import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createJobs, outputFolder } from '../lib/jobs.js';
import { recoverItems, transition } from '../lib/queue-state.js';
import { createStore } from '../lib/store.js';

const id = '12345678-1234-4234-8234-123456789abc';
const snapshot = { format: 'mp4', cutMode: 'accurate', video: { url: 'https://example.test', videoId: 'video', title: 'Video', durationSec: 10 }, timeline: { startSec: 0, endSec: 5, zoom: 1, scrollSec: 0, playheadSec: 0 } };
const row = (status, extra = {}) => ({ id, status, attempt: 1, snapshot, execution: { outputDir: path.resolve('outputs') }, outputPath: path.resolve('outputs', id, 'attempt-1', 'clip.mp4'), ...extra });
async function fixture(initial, actions = {}) {
  const writes = [], changes = [], trashed = [], opened = [];
  let finish;
  const jobs = createJobs({
    store: { load: async () => ({ document: { schemaVersion: 1, revision: 0, settings: {}, items: initial } }), save: async document => writes.push(structuredClone(document)) },
    runner: { start: () => ({ done: new Promise(resolve => { finish = resolve; }), cancel: () => {} }) },
    onChange: payload => changes.push(payload),
    fileActions: {
      confirmDelete: async () => true,
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      stat: async () => ({ isFile: () => true }),
      trashItem: async target => trashed.push(target),
      openPath: async target => { opened.push(target); return ''; },
      ...actions,
    },
  });
  await jobs.init();
  const shutdown = jobs.shutdown;
  jobs.shutdown = () => { finish?.({}); return shutdown(); };
  return { jobs, writes, changes, trashed, opened };
}

test('remove persists waiting/completed/failed removal and rejects running without touching files', async () => {
  const f = await fixture([row('waiting', { id: 'active' }), ...['waiting', 'completed', 'failed'].map((status, i) => row(status, { id: `target-${i}` }))]);
  const revision = f.jobs.revision;
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.jobs.remove(`target-${i}`), { removed: true });
  assert.equal(f.jobs.revision, revision + 3);
  assert.deepEqual(f.writes.at(-1).items.map(item => item.id), ['active']);
  assert.deepEqual(f.changes.at(-1).items, f.jobs.list());
  await assert.rejects(f.jobs.remove('active'), { code: 'NOT_REMOVABLE' });
  await f.jobs.cancel('active');
  await assert.rejects(f.jobs.remove('active'), { code: 'NOT_REMOVABLE' });
  assert.deepEqual(f.trashed, []);
  await f.jobs.shutdown();
});

test('delete validates UUID and direct-child paths and trashes only the entire job directory', async () => {
  for (const badId of ['plain-id', '../escape', `${id}/../escape`, `..\\${id}`, `C:\\${id}`]) {
    const f = await fixture([row('completed', { id: badId })]);
    await assert.rejects(f.jobs.deleteFile(badId), { code: 'INVALID_OUTPUT_PATH' });
    assert.deepEqual(f.trashed, []);
  }
  assert.throws(() => outputFolder(row('failed', { execution: { outputDir: '../outside' } })), { code: 'INVALID_OUTPUT_PATH' });
  const escapingPaths = { ...path, join: () => path.resolve('outside', id) };
  assert.throws(() => outputFolder(row('failed'), escapingPaths), { code: 'INVALID_OUTPUT_PATH' });
  for (const status of ['completed', 'failed', 'cancelled']) {
    const f = await fixture([row(status, { attempt: 3, outputPath: path.resolve('elsewhere.mp4') })]);
    const revision = f.jobs.revision;
    assert.deepEqual(await f.jobs.deleteFile(id), { deleted: true });
    assert.deepEqual(f.trashed, [path.join(path.resolve('outputs'), id)]);
    assert.equal(f.jobs.revision, revision + 1);
    assert.equal(f.jobs.list().length, 1);
    assert.equal(f.writes.at(-1).items[0].fileDeleted, true);
    assert.equal(f.changes.at(-1).items[0].outputPath, null);
  }
});

test('delete cancellation, missing directories, unsafe directories and active jobs are handled', async () => {
  const cancelled = await fixture([row('completed')], { confirmDelete: async () => false });
  const revision = cancelled.jobs.revision;
  assert.deepEqual(await cancelled.jobs.deleteFile(id), { deleted: false });
  assert.equal(cancelled.jobs.revision, revision);
  assert.deepEqual(cancelled.trashed, []);
  const missing = await fixture([row('failed')], { lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.deepEqual(await missing.jobs.deleteFile(id), { deleted: true });
  assert.deepEqual(missing.trashed, []);
  assert.equal(missing.jobs.list()[0].fileDeleted, true);
  const unsafe = await fixture([row('failed')], { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }) });
  await assert.rejects(unsafe.jobs.deleteFile(id), { code: 'INVALID_OUTPUT_PATH' });
  assert.deepEqual(unsafe.trashed, []);
  const active = await fixture([row('waiting'), row('waiting', { id: 'waiting' })]);
  for (const target of [id, 'waiting']) await assert.rejects(active.jobs.deleteFile(target), { code: 'NOT_DELETABLE' });
  await active.jobs.cancel(id);
  await assert.rejects(active.jobs.deleteFile(id), { code: 'NOT_DELETABLE' });
  await active.jobs.shutdown();
  const failure = await fixture([row('completed')], { trashItem: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  await assert.rejects(failure.jobs.deleteFile(id), { code: 'EACCES' });
  assert.equal(failure.jobs.list()[0].fileDeleted, undefined);
});

test('flat completed deletion trashes only a validated root file and preserves legacy folder deletion', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-flat-delete-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'output');
  await fs.mkdir(root);
  const target = path.join(root, 'travel.mp4');
  await fs.writeFile(target, 'video');
  const realFileActions = { lstat: targetPath => fs.lstat(targetPath) };
  const flatRow = (outputPath = target) => row('completed', {
    execution: { outputDir: root, outputLayout: 'flat-v1' }, outputPath,
    outputFileName: 'travel.mp4',
  });
  const deleted = await fixture([flatRow()], realFileActions);
  assert.deepEqual(await deleted.jobs.deleteFile(id), { deleted: true });
  assert.deepEqual(deleted.trashed, [target]);
  assert.equal(deleted.jobs.list()[0].missingOutputPath, target);
  assert.equal(deleted.jobs.list()[0].outputPath, null);

  const unsafePaths = [root, path.join(directory, 'outside.mp4'), path.join(root, 'nested', 'clip.mp4'), path.join(root, 'wrong.mkv')];
  for (const unsafePath of unsafePaths) {
    const unsafe = await fixture([flatRow(unsafePath)], realFileActions);
    await assert.rejects(unsafe.jobs.deleteFile(id), { code: 'INVALID_OUTPUT_PATH' });
    assert.deepEqual(unsafe.trashed, []);
    await unsafe.jobs.shutdown();
  }

  const symlink = path.join(root, 'link.mp4');
  const linked = await fixture([flatRow(symlink)], {
    ...realFileActions,
    lstat: async targetPath => targetPath === symlink
      ? { isFile: () => false, isSymbolicLink: () => true }
      : fs.lstat(targetPath),
  });
  await assert.rejects(linked.jobs.deleteFile(id), { code: 'INVALID_OUTPUT_PATH' });
  assert.deepEqual(linked.trashed, []);

  const missing = await fixture([flatRow(path.join(root, 'missing.mp4'))], realFileActions);
  assert.deepEqual(await missing.jobs.deleteFile(id), { deleted: true });
  assert.deepEqual(missing.trashed, []);
  assert.equal(missing.jobs.list()[0].missingOutputPath, path.join(root, 'missing.mp4'));

  const cancelled = await fixture([flatRow()], { ...realFileActions, confirmDelete: async () => false });
  const revision = cancelled.jobs.revision;
  assert.deepEqual(await cancelled.jobs.deleteFile(id), { deleted: false });
  assert.equal(cancelled.jobs.revision, revision);
  assert.equal(cancelled.jobs.list()[0].outputPath, target);
  assert.equal(cancelled.jobs.list()[0].fileDeleted ?? false, false);

  const legacy = await fixture([row('completed')]);
  assert.deepEqual(await legacy.jobs.deleteFile(id), { deleted: true });
  assert.deepEqual(legacy.trashed, [path.join(path.resolve('outputs'), id)]);
  for (const f of [deleted, linked, missing, cancelled, legacy]) await f.jobs.shutdown();
});

test('openFile opens only an existing completed file and reports shell errors', async () => {
  const f = await fixture([row('completed')]);
  assert.deepEqual(await f.jobs.openFile(id), { opened: true });
  assert.deepEqual(f.opened, [row('completed').outputPath]);
  await f.jobs.deleteFile(id);
  await assert.rejects(f.jobs.openFile(id), { code: 'NO_OUTPUT_FILE' });
  await assert.rejects(f.jobs.openFile('unknown'), { code: 'NO_OUTPUT_FILE' });
  for (const item of [row('failed'), row('completed', { outputPath: null })]) {
    const other = await fixture([item]);
    await assert.rejects(other.jobs.openFile(id), { code: 'NO_OUTPUT_FILE' });
    assert.deepEqual(other.opened, []);
  }
  const missing = await fixture([row('completed')], { stat: async () => { throw new Error('missing'); } });
  await assert.rejects(missing.jobs.openFile(id), { code: 'NO_OUTPUT_FILE' });
  const failed = await fixture([row('completed')], { openPath: async () => 'cannot open' });
  await assert.rejects(failed.jobs.openFile(id), { code: 'OPEN_OUTPUT_FAILED' });
});

test('fileDeleted survives real store reload and recovery; legacy documents still load', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-actions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'state.json'));
  await store.save({ schemaVersion: 1, revision: 4, settings: {}, items: [row('completed', { fileDeleted: true, outputPath: null }), row('failed', { id: 'legacy' })] });
  const jobs = createJobs({ store, runner: { start() { throw new Error('unexpected start'); } } });
  await jobs.init();
  assert.equal(jobs.list()[0].fileDeleted, true);
  assert.equal(jobs.list()[1].fileDeleted ?? false, false);
  await jobs.shutdown();
  const loaded = await store.load();
  assert.equal(loaded.warning, null);
  assert.equal(loaded.document.items[0].fileDeleted, true);
  assert.equal(Object.hasOwn(loaded.document.items[1], 'fileDeleted'), false);
  assert.equal(recoverItems([row('running', { fileDeleted: true })], 'now')[0].fileDeleted, true);
  assert.throws(() => recoverItems([row('failed', { fileDeleted: 'yes' })], 'now'), /boolean/);
  assert.equal(transition(row('failed', { fileDeleted: true }), { type: 'retry', attempt: 1 }, 'now').fileDeleted, false);
});

test('retry resets fileDeleted in persisted state and runner input', async () => {
  const f = await fixture([row('failed', { fileDeleted: true, outputPath: null })]);
  await f.jobs.retry(id);
  assert.equal(f.jobs.list()[0].fileDeleted, false);
  assert.equal(f.writes.at(-1).items[0].fileDeleted, false);
  assert.equal(f.jobs.list()[0].attempt, 2);
  await f.jobs.shutdown();
});

test('completed rename preserves snapshots for flat and legacy files and enforces state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-rename-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const flat of [true, false]) {
    const parent = flat ? directory : path.join(directory, id, 'attempt-1');
    await fs.mkdir(parent, { recursive: true });
    const oldPath = path.join(parent, 'clip.mp4');
    await fs.writeFile(oldPath, 'video');
    const f = await fixture([row('completed', { fileName: 'clip', outputPath: oldPath, execution: { outputDir: directory, ...(flat ? { outputLayout: 'flat-v1' } : {}) } })], { lstat: fs.lstat });
    const before = f.jobs.list()[0];
    await f.jobs.rename(id, 'new');
    assert.deepEqual(f.jobs.list()[0].snapshot, before.snapshot);
    assert.deepEqual(f.jobs.list()[0].execution, before.execution);
    assert.equal(await fs.readFile(path.join(parent, 'new.mp4'), 'utf8'), 'video');
    assert.equal(Object.hasOwn(f.writes.at(-1).items[0], 'renameAllowed'), false);
    await assert.rejects(f.jobs.rename('unknown', 'new'), { code: 'INVALID_QUEUE_ID' });
    await f.jobs.deleteFile(id);
    await assert.rejects(f.jobs.rename(id, 'other'), { code: 'NO_OUTPUT_FILE' });
  }
  const f = await fixture([row('waiting'), ...['waiting', 'failed', 'cancelled'].map(status => row(status, { id: status }))]);
  await assert.rejects(f.jobs.rename(id, 'new'), { code: 'NOT_RENAMABLE' });
  await f.jobs.cancel(id);
  await assert.rejects(f.jobs.rename(id, 'new'), { code: 'NOT_RENAMABLE' });
  for (const status of ['waiting', 'failed', 'cancelled']) assert.equal((await f.jobs.rename(status, 'new')).value.fileName, 'new');
  await f.jobs.shutdown();
});

test('rename conflict, no-op, case-only and OS errors preserve application state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-conflict-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oldPath = path.join(directory, 'clip.mp4');
  await fs.writeFile(oldPath, 'source');
  await fs.writeFile(path.join(directory, 'TAKEN.mp4'), 'target');
  const initial = () => [row('completed', { fileName: 'clip', outputPath: oldPath, execution: { outputDir: directory, outputLayout: 'flat-v1' } })];
  const f = await fixture(initial(), { lstat: fs.lstat });
  await assert.rejects(f.jobs.rename(id, 'taken'), { code: 'OUTPUT_NAME_CONFLICT' });
  assert.equal(await fs.readFile(path.join(directory, 'TAKEN.mp4'), 'utf8'), 'target');
  const revision = f.jobs.revision;
  await f.jobs.rename(id, 'clip');
  assert.equal(f.jobs.revision, revision);
  await f.jobs.rename(id, 'CLIP');
  assert.equal(f.jobs.list()[0].outputFileName, 'CLIP.mp4');
  await fs.rename(path.join(directory, 'CLIP.mp4'), oldPath);
  for (const code of ['EPERM', 'EBUSY', 'ENOENT']) {
    const other = await fixture(initial(), { lstat: fs.lstat, rename: async () => { throw Object.assign(new Error('denied'), { code }); } });
    const before = other.jobs.list()[0];
    await assert.rejects(other.jobs.rename(id, 'other'), error => error.code === 'OUTPUT_RENAME_FAILED' && error.message.includes(code));
    assert.deepEqual(other.jobs.list()[0], before);
  }
});

test('rename save failures attempt exactly one rollback and publish only failure with old state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-rollback-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const rollbackFails of [false, true]) {
    const oldPath = path.join(directory, `old-${rollbackFails}.mp4`), newPath = path.join(directory, 'new.mp4');
    await fs.writeFile(oldPath, 'video');
    let failSave = false, calls = 0;
    const events = [];
    const jobs = createJobs({
      store: { load: async () => ({ document: { schemaVersion: 1, revision: 0, settings: {}, items: [row('completed', { fileName: 'old', outputPath: oldPath, execution: { outputDir: directory, outputLayout: 'flat-v1' } })] } }), save: async () => { if (failSave) throw Object.assign(new Error('save broke'), { code: 'EIO' }); } },
      runner: {}, onChange: (payload, error) => events.push({ payload, error }),
      fileActions: { rename: async (from, to) => { calls++; if (calls === 2 && rollbackFails) throw Object.assign(new Error('rollback broke'), { code: 'EBUSY' }); await fs.rename(from, to); } },
    });
    await jobs.init();
    const revision = jobs.revision;
    events.length = 0; failSave = true;
    await assert.rejects(jobs.rename(id, 'new'), error => {
      assert.equal(error.code, rollbackFails ? 'RENAME_ROLLBACK_FAILED' : 'PERSIST_FAILED');
      assert.match(error.message, /save broke/);
      if (rollbackFails) for (const value of ['rollback broke', oldPath, newPath, 'may remain']) assert.ok(error.message.includes(value));
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(jobs.revision, revision);
    assert.equal(jobs.list()[0].outputPath, oldPath);
    assert.equal(jobs.list()[0].fileName, 'old');
    assert.equal(events.filter(event => !event.error).length, 0);
    assert.equal(events[0].payload.items[0].outputPath, oldPath);
    assert.equal(await fs.readFile(rollbackFails ? newPath : oldPath, 'utf8'), 'video');
    if (rollbackFails) await fs.unlink(newPath);
  }
});

test('scan persists external deletion and restoration across startup and reload without unnecessary saves', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-scan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'clip.mp4');
  const store = createStore(path.join(directory, 'state.json'));
  await store.save({ schemaVersion: 1, revision: 0, settings: {}, items: [row('completed', { outputPath: target, fileName: 'clip' })] });
  const jobs = createJobs({ store, runner: {} });
  await jobs.init();
  assert.equal(jobs.list()[0].missingOutputPath, target);
  assert.equal(jobs.list()[0].fileDeleted, true);
  await assert.rejects(jobs.openFile(id), { code: 'NO_OUTPUT_FILE' });
  assert.deepEqual(await jobs.resolveOpenOutput(id), { kind: 'folder', path: row('completed').execution.outputDir });
  const revision = jobs.revision;
  await jobs.refreshCompletedFiles();
  assert.equal(jobs.revision, revision);
  await fs.writeFile(target, 'returned');
  const reloaded = createJobs({ store, runner: {} });
  await reloaded.init();
  assert.equal(reloaded.list()[0].outputPath, target);
  assert.equal(reloaded.list()[0].fileDeleted, false);
  assert.equal(Object.hasOwn(reloaded.list()[0], 'missingOutputPath'), false);
  await fs.unlink(target);
  await assert.rejects(reloaded.openFile(id), { code: 'NO_OUTPUT_FILE' });
  assert.equal(reloaded.list()[0].missingOutputPath, target);
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
    const f = await fixture([row('completed')], { lstat: async () => { throw Object.assign(new Error(code), { code }); } });
    const writes = f.writes.length, changes = f.changes.length;
    await f.jobs.refreshCompletedFiles();
    assert.equal(f.writes.length, writes);
    assert.equal(f.changes.length, changes);
    assert.equal(f.jobs.list()[0].outputPath, row('completed').outputPath);
  }
});

test('scan ignores concurrent requests, batches eight reads and discards removed or changed output rows', async () => {
  let scanning = false, live = 0, peak = 0, reads = 0;
  const releases = [];
  const scanId = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const f = await fixture(Array.from({ length: 18 }, (_, index) => row('completed', { id: scanId(index), outputPath: path.resolve('outputs', scanId(index), 'attempt-1', 'clip.mp4') })), {
    lstat: async target => {
      if (!scanning || !String(target).endsWith('clip.mp4')) return { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false };
      reads++; live++; peak = Math.max(peak, live);
      await new Promise(resolve => releases.push(resolve));
      live--;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  scanning = true;
  const operation = f.jobs.refreshCompletedFiles();
  await f.jobs.refreshCompletedFiles();
  assert.equal(reads, 8);
  await f.jobs.remove(scanId(0));
  await f.jobs.deleteFile(scanId(1));
  // deleteFile changes outputPath while the scan holds its captured path.
  for (let batch = 0; batch < 3; batch++) {
    releases.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  await operation;
  assert.equal(reads, 18);
  assert.equal(peak, 8);
  assert.equal(f.jobs.list().length, 17);
  assert.equal(f.jobs.list().find(item => item.id === scanId(1)).missingOutputPath, undefined);
  assert.equal(f.jobs.list().find(item => item.id === scanId(2)).fileDeleted, true);
});
