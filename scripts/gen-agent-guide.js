/**
 * 개발 도구 — docs/AGENT.md.txt 를 app.gs 의 AGENT_GUIDE 배열로 옮겨 적는다.
 *
 *     node scripts/gen-agent-guide.js
 *
 * ━━ 왜 필요한가 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 같은 글이 두 곳에 있다. 하나는 유저 드라이브로 나가는 안내문이고
 * (app.gs 안의 문자열 배열), 하나는 저장소에서 읽고 리뷰하는 사본이다.
 * 테스트가 **글자 하나까지 같은지** 강제하는데, 손으로 맞추면 200줄짜리
 * 배열에서 따옴표 하나 어긋나는 순간 빨간불이고 어디가 다른지도 안 보인다.
 *
 * 그래서 **docs/AGENT.md.txt 가 원본**이고 배열은 여기서 찍어낸다.
 * 안내문을 고칠 때는 .txt 만 고치고 이걸 돌리면 된다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'docs', 'AGENT.md.txt');
const DEST = path.join(root, 'appsscript', 'app.gs');

const BEGIN = '  var AGENT_GUIDE = [\n';
const END = "  ].join('\\n') + '\\n';";

const text = fs.readFileSync(SRC, 'utf8');
if (!text.endsWith('\n')) {
  throw new Error('docs/AGENT.md.txt 가 개행으로 안 끝난다 — join 결과와 어긋난다');
}

// 마지막 개행은 join 뒤에 붙이므로 배열에 넣지 않는다.
// ⚠️ CRLF 로 저장되면 모든 원소 끝에 \r 이 박혀 드라이브로 나간다. 그런데
//    등가성 테스트는 **양쪽 다 \r 이라 통과한다** — 조용히 새는 종류다.
const lines = text.slice(0, -1).split('\n').map((l) => l.replace(/\r$/, ''));
const body = lines
  .map((l) => '      ' + JSON.stringify(l).replace(/'/g, "\\u0027") + ',')
  // Apps Script 소스는 작은따옴표를 쓰지만, JSON.stringify 가 주는 큰따옴표
  // 문자열이 이스케이프까지 정확하다. 섞어 쓰지 말고 그대로 둔다.
  .join('\n');

const gs = fs.readFileSync(DEST, 'utf8');
const from = gs.indexOf(BEGIN);
const to = gs.indexOf(END, from);
if (from === -1 || to === -1) {
  throw new Error('app.gs 에서 AGENT_GUIDE 블록을 못 찾았다');
}

// ⚠️ **엉뚱한 끝을 잡으면 조용히 코드를 삼킨다.** indexOf 는 "그다음 첫
//    END" 를 잡을 뿐이라, 누가 배열 종결부를 손으로 바꾸거나 비슷한 배열이
//    하나 더 생기면 그 사이가 통째로 지워지는데 **아무 에러도 안 난다.**
//    지금 지우려는 구간이 정말 문자열 배열뿐인지 확인한다.
const doomed = gs.slice(from + BEGIN.length, to);
if (/^\s*(function|var|if|for|return)\b/m.test(doomed)) {
  throw new Error('AGENT_GUIDE 끝을 잘못 잡았다 — 지우려는 구간에 코드가 있다');
}

const next = gs.slice(0, from + BEGIN.length) + body + '\n' + gs.slice(to);
fs.writeFileSync(DEST, next);
console.log('✅ AGENT_GUIDE ← docs/AGENT.md.txt (' + lines.length + '줄, ' + text.length + '자)');
