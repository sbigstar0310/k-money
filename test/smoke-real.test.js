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

test('실데이터 산출물이 커넥터 한도 안에 든다', opts, () => {
  const sheets = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const size = JSON.stringify(KM.aggregate.build(KM.parse.extract(sheets))).length;
  assert.ok(size < 12000, '산출물 ' + size + ' bytes — 19KB 절벽에 접근');
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
