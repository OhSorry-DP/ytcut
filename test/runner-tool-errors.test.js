import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRunner } from '../lib/runner.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

function metadataRunner(stderr, code = 1) {
  const child = fakeChild();
  const runner = createRunner({ spawnImpl: () => {
    process.nextTick(() => {
      child.stderr.end(stderr);
      child.emit('close', code);
    });
    return child;
  }});
  return runner;
}

const sourceUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('metadata bot 응답은 안전한 BOT_CHECK으로 분류한다', async () => {
  await assert.rejects(metadataRunner('Please confirm you are not a bot').metadata(sourceUrl), error => {
    assert.equal(error.code, 'BOT_CHECK');
    assert.equal(error.message.includes('confirm you are not a bot'), false);
    return true;
  });
});

test('metadata 일반 오류는 민감한 stderr를 노출하지 않는다', async () => {
  const runner = metadataRunner('fatal internal failure https://private.invalid/path');
  await assert.rejects(runner.metadata(sourceUrl), error => {
    assert.equal(error.code, 'TOOL_FAILED');
    assert.equal(error.message.includes('private.invalid'), false);
    return true;
  });
});

test('metadata 403과 429는 지정된 오류 코드로 분류한다', async () => {
  for (const [stderr, code] of [['HTTP Error 403: Forbidden', 'ACCESS_DENIED'], ['HTTP Error 429: Too Many Requests', 'RATE_LIMITED']]) {
    await assert.rejects(metadataRunner(stderr).metadata(sourceUrl), error => error.code === code);
  }
});

test('metadata 취소, spawn 실패, timeout을 처리한다', async t => {
  const controller = new AbortController();
  const child = fakeChild();
  const runner = createRunner({ spawnImpl: () => child });
  const pending = runner.metadata(sourceUrl, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORTED');

  await assert.rejects(createRunner({ spawnImpl: () => { const error = new Error('spawn'); error.code = 'ENOENT'; throw error; } })
    .metadata(sourceUrl), error => error.code === 'ENOENT');

  await t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = createRunner({ spawnImpl: () => fakeChild() }).metadata(sourceUrl);
  await t.mock.timers.tick(45000);
  await assert.rejects(timed, error => error.code === 'TIMEOUT');
});

test('진행률 stderr는 오류 본문으로 분류하지 않는다', async () => {
  await assert.rejects(metadataRunner('[download] 42.0% of 10.00MiB at 1.00MiB/s').metadata(sourceUrl), error => {
    assert.equal(error.code, 'TOOL_FAILED');
    assert.equal(error.message.includes('42.0%'), false);
    return true;
  });
});

test('exit 0의 JS 경고는 성공 결과에 warning으로 남는다', async () => {
  const child = fakeChild();
  const runner = createRunner({ spawnImpl: () => {
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({ id: 'id', title: 'title', duration: 12, formats: [] }));
      child.stderr.end('No supported JavaScript runtime could be found');
      child.emit('close', 0);
    });
    return child;
  }});
  const result = await runner.metadata(sourceUrl);
  assert.equal(result.videoId, 'id');
  assert.equal(result.warnings[0].code, 'JS_RUNTIME_MISSING');
});
