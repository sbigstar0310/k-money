/**
 * 소스를 훑어 **주석과 문자열을 지운 코드**와 **문자열 목록**을 돌려준다.
 *
 * ━━ 이 파일이 조용히 틀리면 나머지 안전장치가 전부 무력해진다 ━━━━
 *
 * 여기 결과 위에 이런 단언들이 서 있다.
 *
 *   · 배포되는 어떤 .gs 에도 UrlFetchApp 이 없다
 *   · 고칠 수 없는 컨테이너에 파이프라인 로직이 없다
 *   · 매니페스트 스코프가 코드와 정확히 맞는다
 *
 * 전부 **"없다"** 를 주장한다. 그래서 스캐너가 코드를 과하게 지우면
 * 단언은 조용히 통과한다 — 위양성이 아니라 **위음성**이고, 그게 최악이다.
 *
 * ━━ 세 번 뚫렸다 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   1차  replace(/\/\/.*$/gm, '')
 *        'a//b' 같은 문자열이 있으면 그 줄 뒷부분이 통째로 사라진다.
 *
 *   2차  "주석으로 시작하는 줄만 버리기"
 *        `/* ok *​/ UrlFetchApp.fetch(...)` 한 줄이면 줄 전체가 주석 취급.
 *
 *   3차  정규식 리터럴을 앞 **한 글자**로 판별
 *        `return /\s*'$/.test(s)` 를 나눗셈으로 읽고, 그 안의 따옴표에
 *        걸려 문자열 모드로 들어가 **파일 나머지를 전부 삼켰다.**
 *        app.gs 의 safeCell 이 정확히 그 모양이라, 거기 아포스트로피
 *        하나만 더 있었으면 안전장치 셋이 동시에 죽어 있었을 것이다.
 *
 * 그래서 지금은 앞 **토큰**으로 판별하고(키워드 포함), 리터럴이 안 닫히면
 * **던진다.** 스캔이 미심쩍으면 통과시키느니 시끄럽게 죽는 게 낫다.
 */

'use strict';

/** 이 뒤의 '/' 는 나눗셈이 아니라 정규식이다. */
const REGEX_AFTER_KEYWORD =
  /\b(return|typeof|instanceof|case|in|of|new|delete|void|throw|do|else|yield|await)$/;

/** 이 문자 뒤의 '/' 도 정규식이다 (값이 올 자리). */
const REGEX_AFTER_PUNCT = /[(,=:[!&|?{};+\-*%~^<>]$/;

module.exports = function scan(src) {
  let code = '';
  const strings = [];
  let i = 0;
  let token = '';   // 직전 토큰. 한 글자가 아니라 토큰이어야 한다

  const push = (c) => {
    code += c;
    // 식별자·키워드는 이어 붙이고, 그 외 문자는 토큰을 새로 시작한다
    if (/[A-Za-z0-9_$]/.test(c)) token += c;
    else if (!/\s/.test(c)) token = c;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // 줄 주석
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // 블록 주석
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= src.length) {
        throw new Error('scan: 닫히지 않은 블록 주석 (' + start + ') — 결과를 믿을 수 없다');
      }
      i += 2;
      code += ' ';
      token = '';
      continue;
    }

    // 정규식 리터럴
    if (c === '/' && (!token || REGEX_AFTER_PUNCT.test(token) || REGEX_AFTER_KEYWORD.test(token))) {
      const start = i;
      i++;
      let closed = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') {                       // 문자 클래스 안의 '/' 는 끝이 아니다
          i++;
          while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
            i += src[i] === '\\' ? 2 : 1;
          }
          i++;
          continue;
        }
        if (src[i] === '/') { closed = true; i++; break; }
        i++;
      }
      if (!closed) {
        throw new Error('scan: 닫히지 않은 정규식 (' + start + ') — 결과를 믿을 수 없다');
      }
      while (i < src.length && /[gimsuy]/.test(src[i])) i++;   // 플래그
      code += ' ';
      token = ')';   // 값이 나온 뒤다 — 다음 '/' 는 나눗셈
      continue;
    }

    // 문자열 / 템플릿 리터럴
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      let buf = '';
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\') { buf += src.substr(i, 2); i += 2; continue; }
        if (src[i] === quote) { closed = true; i++; break; }
        // 템플릿이 아닌 문자열은 줄을 못 넘는다. 넘었다면 우리가 잘못 읽은 것이다.
        if (src[i] === '\n' && quote !== '`') break;
        buf += src[i];
        i++;
      }
      if (!closed) {
        throw new Error('scan: 닫히지 않은 문자열 (' + start + ') — 결과를 믿을 수 없다');
      }
      strings.push(buf);
      code += ' ';
      token = ')';
      continue;
    }

    push(c);
    i++;
  }

  return { code, strings };
};
