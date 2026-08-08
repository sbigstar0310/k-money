/**
 * scan.js — **안전장치를 떠받치는 파일이라 자기 테스트가 있어야 한다.**
 *
 * 여기 결과 위에 "UrlFetchApp 이 없다" · "컨테이너에 로직이 없다" ·
 * "스코프가 코드와 맞는다" 가 서 있다. 전부 **없음**을 주장하므로,
 * 스캐너가 과하게 지우면 단언이 조용히 통과한다.
 *
 * 실제로 세 번 뚫렸고, 세 번째는 `return /\s*'$/.test(s)` 한 줄 —
 * app.gs 의 safeCell 이 바로 그 모양이었다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const scan = require('./lib/scan');

test('주석은 지우고 코드는 남긴다', () => {
  const { code } = scan('var a = 1; // 주석\n/* 블록 */ var b = 2;');
  assert.match(code, /var a = 1;/);
  assert.match(code, /var b = 2;/);
  assert.doesNotMatch(code, /주석|블록/);
});

test("문자열 안의 '//' 가 그 줄 뒤를 삼키지 않는다", () => {
  // 1차 시도가 여기서 뚫렸다.
  const { code } = scan("var u = 'a//b'; UrlFetchApp.fetch(u);");
  assert.match(code, /UrlFetchApp/);
});

test('한 줄에 섞인 블록 주석이 코드를 가리지 않는다', () => {
  // 2차 시도가 여기서 뚫렸다.
  const { code } = scan('/* ok */ UrlFetchApp.fetch("http://x");');
  assert.match(code, /UrlFetchApp/);
});

test('return 뒤의 정규식을 나눗셈으로 읽지 않는다', () => {
  // 3차 시도가 여기서 뚫렸다. 정규식 안의 아포스트로피에 걸려
  // 문자열 모드로 들어가면서 **파일 나머지를 통째로 삼켰다.**
  const src = [
    "function safeCell(s) { return /^\\s*[=+\\-@]/.test(s) ? \"'\" + s : s; }",
    'function evil() { UrlFetchApp.fetch("http://x"); }',
  ].join('\n');
  const { code } = scan(src);
  assert.match(code, /UrlFetchApp/, '정규식 뒤의 코드가 사라졌다');
});

test('실제 app.gs 의 safeCell 모양에서도 뒤가 살아 있다', () => {
  const src = [
    "  function safeCell(s) {",
    "    var t = String(s);",
    "    return /^\\s*[=+\\-@]/.test(t) ? \"'\" + t : t;",
    "  }",
    "  function after() { UrlFetchApp.fetch('x'); }",
  ].join('\n');
  assert.match(scan(src).code, /UrlFetchApp/);
});

test('키워드 뒤 정규식 — typeof · case · in · throw', () => {
  ['return', 'typeof', 'case', 'in', 'throw', 'new', 'of', 'void'].forEach((kw) => {
    const { code } = scan(`x = ${kw} /a'b/.source; UrlFetchApp.fetch();`);
    assert.match(code, /UrlFetchApp/, kw + ' 뒤에서 뚫렸다');
  });
});

test('나눗셈을 정규식으로 착각하지 않는다', () => {
  // 반대 방향 실패. a / b / c 를 정규식으로 읽으면 그 사이가 사라진다.
  const { code } = scan('var r = total / months / 2; GmailApp.search(q);');
  assert.match(code, /GmailApp/);
  assert.match(code, /total/);
  assert.match(code, /months/);
});

test('문자 클래스 안의 슬래시가 정규식을 끝내지 않는다', () => {
  const { code } = scan('var re = /[/]/; UrlFetchApp.fetch();');
  assert.match(code, /UrlFetchApp/);
});

test('문자열 목록을 돌려준다', () => {
  const { strings } = scan(`var a = 'hello'; var b = "world"; var c = \`tpl\`;`);
  assert.deepEqual(strings, ['hello', 'world', 'tpl']);
});

test('이스케이프된 따옴표에서 문자열이 안 끝난다', () => {
  const { strings } = scan("var a = 'it\\'s'; var b = 'next';");
  assert.deepEqual(strings, ["it\\'s", 'next']);
});

test('닫히지 않은 문자열은 통과시키지 않고 던진다', () => {
  // 조용히 잘라서 돌려주면 그 뒤의 UrlFetchApp 이 안 보인다.
  // 미심쩍으면 통과시키느니 시끄럽게 죽는 게 낫다.
  assert.throws(() => scan("var a = 'no end;\nUrlFetchApp.fetch();"), /닫히지 않은 문자열/);
});

test('닫히지 않은 블록 주석도 던진다', () => {
  assert.throws(() => scan('/* 안 닫힘\nUrlFetchApp.fetch();'), /닫히지 않은 블록 주석/);
});

test('닫히지 않은 정규식도 던진다', () => {
  assert.throws(() => scan('var r = /abc\nUrlFetchApp.fetch();'), /닫히지 않은 정규식/);
});

test('배포되는 실제 파일을 전부 스캔해도 던지지 않는다', () => {
  // 위 세 개가 던지게 만들었으니, 진짜 소스에서 오탐이 나면 안 된다.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'appsscript');
  fs.readdirSync(dir).filter((n) => n.endsWith('.gs')).forEach((n) => {
    const src = fs.readFileSync(path.join(dir, n), 'utf8');
    const { code } = scan(src);
    assert.ok(code.length > src.length * 0.2,
      n + ' 에서 코드의 80% 이상이 사라졌다 — 스캐너가 잘못 읽고 있다');
  });
});
