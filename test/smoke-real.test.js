/**
 * 실데이터 스모크 체크.
 *
 * fixtures/real.json 은 개인 금융 정보라 커밋하지 않는다(.gitignore).
 * 없으면 조용히 건너뛴다 — 다른 사람도 `npm test` 를 돌릴 수 있어야 한다.
 *
 * 픽스처 만들기:
 *     uv run python scripts/dump-rows.py <내보낸.xlsx> fixtures/real.json
 *
 * 여기서 확인하는 건 '값이 얼마인가'가 아니라 **파이프라인이 실제 모양의
 * 데이터에서 끝까지 도는가**, 그리고 합성 테스트가 못 잡는 규모 문제
 * (산출물 크기, 컬럼 수, 인코딩)가 없는가다.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./lib/helpers');

const FIXTURE = path.join(H.ROOT, 'fixtures', 'real.json');
const available = fs.existsSync(FIXTURE);
const opts = { skip: available ? false : 'fixtures/real.json 없음 — dump-rows.py 로 생성' };

const KM = H.loadCore();

test('실데이터가 끝까지 돈다', opts, () => {
  const sheets = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const ex = KM.parse.extract(sheets);
  const f = KM.aggregate.build(ex);

  assert.ok(ex.txns.length > 0, '거래가 하나도 안 읽혔다');
  assert.ok(f.period && f.period.days > 0);
  assert.ok(f.balance && f.balance.netWorth !== 0, '잔고 시트를 못 읽었다');

  // 회계 항등식: 이체를 뺀 흐름은 스스로 일관돼야 한다
  assert.strictEqual(f.flow.net, f.flow.income - f.flow.expense);

  // 합계는 계산이어야 한다 — 수식 셀을 읽었다면 0 이나 NaN 이 나온다
  assert.ok(Number.isFinite(f.balance.netWorth) && f.balance.netWorth > 0);

  // 잘라낸 목록의 나머지를 밝히지 않으면 LLM 이 검산했을 때 안 맞는다
  const cats = f.categories.items.reduce((s, c) => s + c.amount, 0) + (f.categories.otherTotal || 0);
  assert.strictEqual(cats, f.flow.expense, '카테고리 합 + 나머지 = 지출');
  const accs = f.balance.accounts.reduce((s, a) => s + a.amount, 0) + (f.balance.otherAccountsTotal || 0);
  assert.strictEqual(accs - f.balance.totalDebt, f.balance.netWorth, '계좌 합 + 나머지 − 부채 = 순자산');
});

test('실데이터 산출물이 커지지 않는다', opts, () => {
  // ⚠️ **드라이브에 실제로 쓰이는 모양 그대로, 실제 단위로 잰다.**
  //
  //    두 번 어긋났다. 처음엔 압축본을 쟀는데 persist 는
  //    `JSON.stringify(facts, null, 2)` 를 쓴다 (1.73배). 고치고 나서도
  //    `.length` 를 그대로 뒀는데 그건 **UTF-16 코드유닛**이다 — 한국어라
  //    바이트는 1.14배다. 17,569 자가 드라이브에서는 **20,042 bytes** 다.
  //    "2,400 여유 있네" 하고 필드를 더 넣게 되는 종류의 거짓말이다.
  //
  //    '19KB 를 넘으면 커넥터가 빈 문자열로 읽는다' 는 옛 기록은 **틀렸다**
  //    (DECISIONS §4 — 갓 만든 파일이 잠시 비어 보인 것이었다). 그러니
  //    이 문턱은 절벽이 아니라 **증가 감지기**다. 목록 절단이 풀리거나
  //    0채움에 상한이 없어지면 여기가 먼저 빨개진다 (실제로 그렇게 잡혔다).
  //    지금 실측 20,042 에서 10% 를 여유로 둔다.
  const sheets = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const facts = KM.aggregate.build(KM.parse.extract(sheets));
  const bytes = Buffer.byteLength(JSON.stringify(facts, null, 2), 'utf8');
  assert.ok(bytes < 22000, '산출물 ' + bytes + ' bytes — 무엇이 늘었는지 보라');
});

test('실데이터에서 이체 분해가 총량을 보존한다', opts, () => {
  const sheets = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const ex = KM.parse.extract(sheets);
  const tb = KM.analyze.transferBalance(ex.txns, ex.snapshot.owner);

  const raw = ex.txns
    .filter((t) => t.kind === 'transfer')
    .reduce((s, t) => s + t.amount, 0);
  assert.strictEqual(tb.selfNet + tb.externalNet, raw, '본인/타인으로 가르면서 돈이 새면 안 된다');
  assert.strictEqual(tb.externalIn + tb.externalOut, tb.externalNet);
});
