import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyToolError,
  classifyToolWarning,
  safeToolError,
} from '../lib/tool-errors.js';

test('봇 확인 신호가 로그인 신호보다 우선한다', () => {
  const result = classifyToolError({ stderr: 'Sign in required: confirm you are not a bot' });

  assert.equal(result.code, 'BOT_CHECK');
  assert.equal(result.message, classifyToolError({ code: 'BOT_CHECK' }).message);
});

test('비공개, 구체적인 삭제, 지역 제한 신호를 분류한다', () => {
  assert.equal(classifyToolError({ stderr: 'Private video' }).code, 'PRIVATE_CONTENT');
  assert.equal(classifyToolError({ stderr: 'Video has been removed' }).code, 'REMOVED_CONTENT');
  assert.equal(classifyToolError({ stderr: 'The uploader has not made this video available in your country' }).code, 'REGION_RESTRICTED');
  assert.equal(classifyToolError({ stderr: 'Video unavailable' }).code, 'SOURCE_UNAVAILABLE');
});

test('403과 429를 제한적으로 분류하고 update context에서도 403 원인을 단정하지 않는다', () => {
  const forbidden = 'HTTP Error 403: Forbidden';

  assert.equal(classifyToolError({ stderr: forbidden }).code, 'ACCESS_DENIED');
  assert.equal(classifyToolError({ stderr: forbidden, context: 'update' }).code, 'ACCESS_DENIED');
  assert.equal(classifyToolError({ stderr: forbidden, context: 'source' }).code, 'ACCESS_DENIED');
  assert.equal(classifyToolError({ stderr: 'HTTP Error 429: Too Many Requests', context: 'update' }).code, 'RATE_LIMITED');
});

test('네트워크, JS, 쿠키 신호와 미확인 오류를 구분한다', () => {
  assert.equal(classifyToolError({ stderr: 'ETIMEDOUT while connecting' }).code, 'NETWORK');
  assert.equal(classifyToolError({ stderr: 'No supported JavaScript runtime' }).code, 'JS_RUNTIME_MISSING');
  assert.equal(classifyToolWarning('JS challenge failed').code, 'JS_CHALLENGE_FAILED');
  assert.equal(classifyToolError({ stderr: 'Failed to decrypt cookie data' }).code, 'COOKIE_UNAVAILABLE');
  assert.equal(classifyToolError({ stderr: 'unrecognized diagnostic' }).code, 'TOOL_FAILED');
});

test('취소와 출력 오류 코드는 원문보다 우선해 보존된다', () => {
  assert.equal(classifyToolError({ code: 'cancelled', stderr: 'unexpected failure' }).code, 'CANCELLED');
  assert.equal(safeToolError({ code: 'OUTPUT_INVALID', message: 'unexpected failure' }).code, 'OUTPUT_INVALID');
});

test('ANSI를 정규화하고 URL, 쿠키, 프록시 비밀을 반환하지 않는다', () => {
  const ansi = classifyToolError({ stderr: '\u001b[31mconfirm you are not a bot\u001b[0m' });
  assert.equal(ansi.code, 'BOT_CHECK');

  const secrets = [
    'fetch failed at https://example.invalid/path?token=secret-value',
    'Cookie: session-secret',
    'proxy=http://user:password@proxy.invalid:8080',
  ];
  for (const stderr of secrets) {
    const result = safeToolError({ message: stderr });
    const returned = JSON.stringify(result);
    assert.equal(result.code, 'TOOL_FAILED');
    assert.ok(!returned.includes(stderr));
    assert.ok(!returned.includes('secret-value'));
    assert.ok(!returned.includes('session-secret'));
    assert.ok(!returned.includes('password'));
    assert.ok(!returned.includes('proxy.invalid'));
  }
});
