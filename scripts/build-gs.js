/**
 * 개발 도구 — core/ 를 Apps Script 용 단일 파일로 묶는다.
 *
 *     node scripts/build-gs.js
 *     → appsscript/core.gs
 *
 * ━━ 왜 묶는가 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Apps Script 는 프로젝트 안 파일들의 **전역 코드 실행 순서를 보장하지 않는다.**
 * core 모듈은 로드 시점에 `var M = KM.model` 로 참조를 잡으므로, layout 이
 * model 보다 먼저 돌면 M 이 영원히 undefined 가 된다. 그러고도 프로그램은
 * 죽지 않고 이상한 값을 낸다 — 우리가 가장 피하려는 종류의 고장이다.
 *
 * 한 파일 안에서는 위에서 아래로 도는 것이 보장되므로, 의존 순서대로
 * 이어붙이면 그냥 사라지는 문제다. 덤으로 유저가 붙여넣을 파일도 줄어든다.
 *
 * node 로 검증할 때는 원본 core/*.js 를 그대로 쓴다. 내용이 같으니
 * 여기서 맞으면 거기서도 맞는다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORDER = require('../core/order'); // 의존 순서 — 한 곳에서만 정한다
const root = path.join(__dirname, '..');
const VERSION = require(path.join(root, 'package.json')).version;
const dest = path.join(root, 'appsscript', 'core.gs');

const header = `/**
 * ⚠️ 자동 생성 파일 — 직접 고치지 마라.
 *
 *   생성: node scripts/build-gs.js
 *   원본: core/${ORDER.join('.js, core/')}.js
 *
 * 고칠 일이 있으면 core/ 를 고치고 다시 생성하라. 여기서 고치면
 * 다음 생성 때 조용히 덮어써진다.
 *
 * 이 파일은 node 로 검증한 것과 **같은 코드**다. 포팅이 없으므로
 * 로컬에서 맞은 계산은 여기서도 맞는다.
 */

`;

// 버전을 코드에 박아 둔다. 유저가 쓰는 버전과 최신 버전을 비교하려면
// 돌고 있는 코드가 자기 버전을 알아야 한다.
const versionDecl = `var KM = (globalThis.KM = globalThis.KM || {});\nKM.VERSION = '${VERSION}';\n`;

const parts = ORDER.map(function (name) {
  const file = path.join(root, 'core', name + '.js');
  const src = fs.readFileSync(file, 'utf8')
    // node 전용 내보내기는 Apps Script 에서 의미가 없다 (module 이 없다).
    .replace(/\nif \(typeof module !== 'undefined'\) module\.exports = [^\n]*\n/g, '\n');
  return '// ' + '═'.repeat(68) + '\n// core/' + name + '.js\n// ' + '═'.repeat(68) + '\n\n' + src.trim() + '\n';
});

const bundle = header + versionDecl + '\n' + parts.join('\n\n');

// 테스트가 '커밋된 core.gs 가 지금 core/ 에서 나온 것인가' 를 이걸로 검사한다.
// 예전에는 두 파일이 어긋나도 테스트가 전부 통과했다 — 그리고 실제로 도는 건
// 커밋된 쪽이다.
module.exports = { ORDER: ORDER, dest: dest, build: function () { return bundle; } };

if (require.main === module) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bundle, 'utf8');
  const bytes = fs.statSync(dest).size;
  console.log('→ appsscript/core.gs  v' + VERSION + '  (' + bytes.toLocaleString() + ' bytes, ' + ORDER.length + '개 모듈)');
}
