/**
 * 소스를 훑어 **주석과 문자열을 지운 코드**와 **문자열 목록**을 돌려준다.
 *
 * 정규식으로 두 번 시도했다가 두 번 다 뚫렸다.
 *
 *   1차 `replace(/\/\/.*$/gm, '')` — `'a//b'` 같은 문자열이 있으면 그 줄의
 *      **뒷부분이 통째로 사라진다.** 거기 진짜 호출이 있어도 안 보인다.
 *   2차 "주석으로 시작하는 줄만 버리기" — `/* ok *​/ UrlFetchApp.fetch(...)`
 *      한 줄이면 **줄 전체가 주석 취급**되어 그냥 통과한다.
 *
 * 보안 단언에서 과하게 지우는 건 위음성이라 최악이다. 그래서 대충 하지 않고
 * 상태를 들고 한 글자씩 읽는다. 정규식 리터럴은 앞 토큰으로 구분한다 —
 * 나눗셈과 헷갈리면 그 뒤가 통째로 밀리기 때문이다.
 */

'use strict';

module.exports = function scan(src) {
  let code = '';
  const strings = [];
  let i = 0, buf = null, quote = null, prev = '';

  while (i < src.length) {
    const c = src[i], next = src[i + 1];

    if (quote) {
      if (c === '\\') { buf += src.substr(i, 2); i += 2; continue; }
      if (c === quote) { strings.push(buf); buf = null; quote = null; code += ' '; i++; continue; }
      buf += c; i++; continue;
    }

    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; code += ' '; continue;
    }

    // 정규식 리터럴. 값이 올 자리의 '/' 만 정규식이다.
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^]$/.test(prev.trim() || '=')) {
      i++;
      while (i < src.length && src[i] !== '/') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
        i++;
      }
      i++; code += ' '; continue;
    }

    if (c === '"' || c === "'" || c === '`') { quote = c; buf = ''; i++; continue; }

    code += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return { code, strings };
};
