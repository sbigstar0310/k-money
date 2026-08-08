/**
 * 개발 도구 — core/ 를 로컬에서 돌려 산출물을 만든다.
 *
 *     node scripts/run-local.js fixtures/real.json [이전산출물.json]
 *
 * Apps Script 에서 돌 코드와 **같은 파일**을 쓴다. 여기서 맞으면 거기서도 맞다.
 * 다른 건 행을 어디서 얻느냐뿐이다 — 여기선 픽스처, 거기선 getValues().
 */

'use strict';

const fs = require('fs');
const path = require('path');

// core 는 globalThis.KM 에 스스로를 붙인다. 의존 순서대로 읽어들인다.
['model', 'layout', 'analyze', 'parse', 'aggregate'].forEach(function (m) {
  require(path.join(__dirname, '..', 'core', m + '.js'));
});
const KM = globalThis.KM;

const [fixturePath, previousPath] = process.argv.slice(2);
if (!fixturePath) {
  console.error('사용법: node scripts/run-local.js <픽스처.json> [이전산출물.json]');
  process.exit(2);
}

const sheets = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const extract = KM.parse.extract(sheets);
const facts = KM.aggregate.build(extract);

if (previousPath) {
  facts.delta = KM.aggregate.delta(facts, JSON.parse(fs.readFileSync(previousPath, 'utf8')));
}

const json = JSON.stringify(facts, null, 2);
const compact = JSON.stringify(facts);

console.log(json);
console.error('');
console.error('── 크기 ' + '─'.repeat(50));
console.error('  거래         ' + extract.txns.length + '건 (비원화 제외 ' + extract.foreign.length + '건)');
console.error('  보기 좋은 형태 ' + json.length.toLocaleString() + ' bytes');
console.error('  압축 형태     ' + compact.length.toLocaleString() + ' bytes  ' +
  (compact.length < 12000 ? '✅ 12KB 이내' : '⚠️ 12KB 초과 — 커넥터 19KB 절벽에 접근'));
