const MESSAGES = Object.freeze({
  BOT_CHECK: '원본 사이트에서 사람 확인을 요구합니다. 사이트의 정상 화면에서 안내를 확인하세요. 앱의 자동 재시도는 하지 않습니다.',
  LOGIN_REQUIRED: '로그인이 필요한 콘텐츠입니다. 본인의 접근 권한을 확인하고 필요하면 설정에서 쿠키를 직접 선택하세요.',
  ACCESS_DENIED: '접근이 거부되었습니다(403). 주소와 접근 권한을 확인하세요. 도구 업데이트로 해결되는지는 보장되지 않습니다.',
  RATE_LIMITED: '요청이 너무 많아 제한되었습니다(429). 요청을 중지하고 잠시 후 직접 다시 시도하세요.',
  PRIVATE_CONTENT: '비공개 콘텐츠입니다. 본인 계정의 접근 권한을 확인하세요.',
  REMOVED_CONTENT: '삭제되었거나 제공이 중단된 콘텐츠입니다. 원본 사이트에서 상태를 확인하세요.',
  REGION_RESTRICTED: '현재 지역에서 제공되지 않는 콘텐츠입니다. 원본 사이트의 제공 정책을 확인하세요.',
  NETWORK: '네트워크 연결을 확인한 뒤 다시 시도하세요.',
  JS_RUNTIME_MISSING: 'JS 실행 환경이 없거나 처리가 실패했습니다. 도구 버전과 선택한 런타임을 확인하세요.',
  JS_CHALLENGE_FAILED: 'JS 실행 환경이 없거나 처리가 실패했습니다. 도구 버전과 선택한 런타임을 확인하세요.',
  COOKIE_UNAVAILABLE: '브라우저 쿠키를 읽지 못했습니다. 브라우저 상태나 지정한 쿠키 파일을 확인하세요.',
  SOURCE_UNAVAILABLE: '콘텐츠 정보를 가져오지 못했습니다. 주소와 도구 상태를 확인하세요.',
  TOOL_FAILED: '콘텐츠 정보를 가져오지 못했습니다. 주소와 도구 상태를 확인하세요.',
  CANCELLED: '작업이 취소되었습니다.',
  OUTPUT_INVALID: '출력 파일을 확인하지 못했습니다. 저장 위치와 출력 상태를 확인하세요.',
});

export const CLASSIFIED_CODES = Object.freeze(Object.keys(MESSAGES));
const FIXED_CODES = new Set(['CANCELLED', 'OUTPUT_INVALID']);

// 제안된 패턴이며 라이브 stderr 형식은 검증되지 않았다. 일치하지 않으면 안전한 일반 오류로 처리한다.
function normalize(value) {
  return String(value ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .toLowerCase();
}

function hasSensitiveText(value) {
  const text = String(value ?? '');
  return /https?:\/\/|(?:^|\s)(?:[a-z]:\\|\\\\|\/)(?:[^\s]+)/i.test(text)
    || /(?:cookie|authorization|token|password|secret)\s*[:=]/i.test(text)
    || /(?:^|[?&])(?:cookie|token|auth|key)=/i.test(text);
}

function result(code) {
  return { code, message: MESSAGES[code] };
}

export function classifyToolError({ code, stderr, context } = {}) {
  const incoming = String(code ?? '').toUpperCase();
  if (FIXED_CODES.has(incoming)) return result(incoming);
  const raw = String(stderr ?? '');
  const text = normalize(raw);

  // 오류 원문은 메시지에 복사하지 않는다. 기존 안전 코드도 민감한 원문이 동반되면 일반 오류로 축소한다.
  if (hasSensitiveText(raw)) return result('TOOL_FAILED');
  if (CLASSIFIED_CODES.includes(incoming)) return result(incoming);

  if (/confirm.*not a bot|captcha challenge/.test(text)) return result('BOT_CHECK');
  if (/private video/.test(text)) return result('PRIVATE_CONTENT');
  if (/video has been removed|video has been deleted/.test(text)) return result('REMOVED_CONTENT');
  if (/not made this video available in your country/.test(text)) return result('REGION_RESTRICTED');
  if (/sign in|login required|authentication required/.test(text)) return result('LOGIN_REQUIRED');
  if (/http error 429|too many requests/.test(text)) return result('RATE_LIMITED');
  if (/http error 403|http status 403/.test(text)) {
    // update API 403은 봇 신호가 아니다. 모든 context에서 접근 거부로만 분류한다.
    return result(context === 'update' || context === 'source' ? 'ACCESS_DENIED' : 'ACCESS_DENIED');
  }
  if (/enotfound|eai_again|etimedout|timed out|connection reset/.test(text)) return result('NETWORK');
  if (/no supported javascript runtime/.test(text)) return result('JS_RUNTIME_MISSING');
  if (/js challenge.*failed/.test(text)) return result('JS_CHALLENGE_FAILED');
  if (/failed to decrypt|cookie database.*locked/.test(text)) return result('COOKIE_UNAVAILABLE');
  if (/video unavailable/.test(text)) return result('SOURCE_UNAVAILABLE');
  return result('TOOL_FAILED');
}

export function safeToolError(error) {
  if (error && typeof error === 'object') {
    return classifyToolError({ code: error.code, stderr: error.message, context: error.context });
  }
  return result('TOOL_FAILED');
}

// 성공 결과의 경고도 안전한 코드와 고정 문구만 외부에 전달한다.
export function classifyToolWarning(warning) {
  const text = normalize(typeof warning === 'string' ? warning : warning?.message);
  if (/no supported javascript runtime/.test(text)) return result('JS_RUNTIME_MISSING');
  if (/js challenge.*failed/.test(text)) return result('JS_CHALLENGE_FAILED');
  return result('TOOL_FAILED');
}
