import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.js';

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ytcut-store-'));
}

test('missing file loads as null without warning', async () => {
  const directory = await temporaryDirectory();
  const result = await createStore(path.join(directory, 'state.json')).load();
  assert.deepEqual(result, { document: null, warning: null });
});

test('saves and loads a UTF-8 document', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'state.json');
  const store = createStore(file);
  const document = { schemaVersion: 1, revision: 0, settings: { title: '안녕하세요 🌏' }, items: [] };
  await store.save(document);
  assert.deepEqual((await store.load()).document, document);
  assert.match(await fs.readFile(file, 'utf8'), /안녕하세요 🌏/);
});

test('concurrent saves serialize and capture input immediately', async () => {
  const directory = await temporaryDirectory();
  const store = createStore(path.join(directory, 'state.json'));
  const first = { schemaVersion: 1, revision: 1, settings: { value: 'first' }, items: [] };
  const second = { schemaVersion: 1, revision: 2, settings: { value: 'second' }, items: [] };
  const saveFirst = store.save(first);
  const saveSecond = store.save(second);
  second.settings.value = 'changed after call';
  await Promise.all([saveFirst, saveSecond]);
  assert.equal((await store.load()).document.revision, 2);
  assert.equal((await store.load()).document.settings.value, 'second');
});

test('corrupt file is preserved and reported', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, '{broken', 'utf8');
  const result = await createStore(file).load();
  assert.equal(result.document, null);
  assert.equal(result.warning.code, 'CORRUPT');
  const names = await fs.readdir(directory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^state\.json\.corrupt-.*\.json$/);
  assert.equal(await fs.readFile(path.join(directory, names[0]), 'utf8'), '{broken');
});

test('future schema blocks saves and filesystem save errors reject', async () => {
  const directory = await temporaryDirectory();
  const futureFile = path.join(directory, 'future.json');
  const future = '{"schemaVersion":2,"revision":8,"settings":{},"items":[]}';
  await fs.writeFile(futureFile, future, 'utf8');
  const store = createStore(futureFile);
  const result = await store.load();
  assert.equal(result.document, null);
  assert.equal(result.warning.code, 'UNSUPPORTED_SCHEMA');
  await assert.rejects(store.save({ schemaVersion: 1, revision: 9, settings: {}, items: [] }), /blocked/);
  assert.equal(await fs.readFile(futureFile, 'utf8'), future);

  const directoryTarget = path.join(directory, 'is-directory');
  await fs.mkdir(directoryTarget);
  const failingStore = createStore(directoryTarget);
  const attempted = failingStore.save({ schemaVersion: 1, revision: 1, settings: {}, items: [] });
  await assert.rejects(attempted);
  await assert.rejects(failingStore.flush());
  assert.deepEqual(await fs.readdir(directoryTarget), []);
});
