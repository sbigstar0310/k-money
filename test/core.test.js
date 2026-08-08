/**
 * core 회귀 테스트.
 *
 *     npm test        (= node --test test/)
 *
 * ━━ 이 파일의 성격 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 여기 있는 테스트는 거의 전부 **실제로 한 번 틀렸던 것**이다.
 * 각 테스트 이름 옆의 금액은 실데이터에서 그 버그가 만들었던 오차다.
 * 새 기능을 위한 테스트가 아니라, 아는 함정으로 되돌아가지 않기 위한 것이다.
 *
 * 그래서 문장을 검사하지 않는다. 문장은 LLM 몫이고 우리는 숫자만 책임진다.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

const KM = H.loadCore();
const build = (txns, status) => KM.aggregate.build(KM.parse.extract(H.sheets(txns, status)));
const extract = (txns, status) => KM.parse.extract(H.sheets(txns, status));


// ── 부호 규약 ──────────────────────────────────────────────────────

test('지출은 음수로 들어와 양수 순액이 된다', () => {
  const f = build([H.expense('2025-01-05', 30000)]);
  assert.strictEqual(f.flow.expense, 30000);
});

test('환불은 지출에서 차감된다 — abs() 로 뭉개면 오차가 두 배가 된다 (실측 143만원)', () => {
  const f = build([H.expense('2025-01-05', 100000), H.refund('2025-01-06', 30000)]);
  assert.strictEqual(f.flow.expense, 70000, '100,000 − 30,000 = 70,000');
  assert.strictEqual(f.refunds.count, 1);
  assert.strictEqual(f.refunds.total, 30000);
});

test('이체는 수입에도 지출에도 들어가지 않는다 (실측 912만원)', () => {
  const f = build([
    H.income('2025-01-01', 1000000),
    H.expense('2025-01-05', 200000),
    H.transfer('2025-01-10', -500000, '성대규'),
    H.transfer('2025-01-10', 500000, '성대규'),
  ]);
  assert.strictEqual(f.flow.income, 1000000);
  assert.strictEqual(f.flow.expense, 200000);
});


// ── 이체 분해 ──────────────────────────────────────────────────────

test('본인 계좌 간 이체는 순액이 0이 되어야 한다', () => {
  const f = build([
    H.transfer('2025-01-10', -500000, '토뱅 성대규'),
    H.transfer('2025-01-10', 500000, '성대규'),
  ]);
  assert.strictEqual(f.transfers.self.net, 0);
  assert.strictEqual(f.transfers.external.net, 0);
  assert.strictEqual(f.transfers.self.count, 2);
});

test('순액 0이어도 총액이 크면 미분류가 숨어 있다 — gross 를 따로 낸다', () => {
  // 남에게 700만 받고 700만 보냈다. 순액은 0이지만 1,400만원이 분류되지 않았다.
  const f = build([
    H.transfer('2025-01-10', 7000000, '김철수'),
    H.transfer('2025-01-20', -7000000, '박영희'),
  ]);
  assert.strictEqual(f.transfers.external.net, 0, '순액만 보면 아무 일도 없어 보인다');
  assert.strictEqual(f.transfers.external.gross, 14000000, '실제로는 1,400만원이 미분류');
  const codes = f.dataQuality.flags.map((x) => x.code);
  assert.ok(codes.includes('unclassified_external_transfers'), '순액이 0이어도 플래그가 서야 한다');
});

test('구두점이 붙은 본인 이름도 본인으로 본다 — "토스 성대규/" (실측 494,000원)', () => {
  const f = build([H.transfer('2025-01-10', -444000, '토스 성대규/')]);
  assert.strictEqual(f.transfers.self.net, -444000);
  assert.strictEqual(f.transfers.external.count, 0);
});

test('이름이 통째로 가려진 "***" 는 본인이 아니다 — 아무나 통과한다', () => {
  const f = build([H.transfer('2025-01-10', 500000, '***')]);
  assert.strictEqual(f.transfers.self.count, 0);
  assert.strictEqual(f.transfers.external.net, 500000);
});

test('부분 문자열은 본인이 아니다 — "성대규한국과학기술원" (실측 50,000원 오분류)', () => {
  const f = build([
    H.transfer('2025-01-10', -50000, '성대규한국과학기술원'),
    H.transfer('2025-01-11', -30000, '박성대규'),
  ]);
  assert.strictEqual(f.transfers.self.count, 0, '내 이름이 들어있다고 내 계좌가 아니다');
  assert.strictEqual(f.transfers.external.net, -80000);
});

test('가려진 이름으로 본인 판정된 건은 불확실성으로 표시한다', () => {
  const f = build([H.transfer('2025-01-10', -100000, '성*규')]);
  assert.strictEqual(f.transfers.self.count, 1, '마스킹은 본인일 가능성이 높으니 채택하되');
  assert.strictEqual(f.transfers.self.matchedByMaskedName, 1, '동명이인일 수 있음을 밝힌다');
  const codes = f.dataQuality.flags.map((x) => x.code);
  assert.ok(codes.includes('owner_matched_by_masked_name'));
});


// ── 월평균·관측 기간 ───────────────────────────────────────────────

test('월평균 지출은 달 개수가 아니라 실제 경과일로 나눈다 (실측 37만원 오차)', () => {
  // 2025-01-01 ~ 2025-12-31 = 365일 ≈ 11.99개월. 관측된 '달'은 12개.
  const txns = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.expense('2025-' + mm + '-15', 1000000));
  }
  txns.push(H.expense('2025-01-01', 0));
  txns.push(H.expense('2025-12-31', 0));
  const f = build(txns);
  // 12,000,000 / (365/30.436875) = 1,000,608
  assert.ok(Math.abs(f.flow.avgMonthlyExpense - 1000608) < 2000,
    '실제로는 ' + f.flow.avgMonthlyExpense);
});

test('이체만 있는 달은 관측 개월에 넣지 않는다 (합성에서 유휴현금 225만원 오차)', () => {
  const txns = [
    H.expense('2025-01-15', 1000000),
    H.expense('2025-02-15', 1000000),
    H.expense('2025-03-15', 1000000),
  ];
  // 4~12월은 이체만 오갔다 — 지출 관측은 여전히 3개월이다
  for (let m = 4; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.transfer('2025-' + mm + '-10', 100000, '성대규'));
    txns.push(H.transfer('2025-' + mm + '-11', -100000, '성대규'));
  }
  const f = build(txns);
  assert.strictEqual(f.flow.monthly.length, 3, '이체만 있는 달은 월 행조차 만들지 않는다');
  assert.ok(f.flow.avgMonthlyExpense > 900000,
    '월평균이 ' + f.flow.avgMonthlyExpense + ' — 이체 달이 분모에 섞이면 25만원대로 떨어진다');
});


// ── 반복 지출 ──────────────────────────────────────────────────────

test('띄엄띄엄한 지출은 구독이 아니다 — 미용실 3회 (실측 오탐)', () => {
  // 금액은 같지만 2025-01, 2025-06, 2025-12 — 밀도 3/12
  const f = build([
    H.expense('2025-01-10', 17000, { desc: '미용실', major: '뷰티/미용' }),
    H.expense('2025-06-10', 17000, { desc: '미용실', major: '뷰티/미용' }),
    H.expense('2025-12-10', 17000, { desc: '미용실', major: '뷰티/미용' }),
  ]);
  assert.strictEqual(f.recurring.items.length, 0);
});

test('가격이 올라도 같은 구독으로 본다 — (최대−최소)/평균 기준은 여기서 죽었다', () => {
  const txns = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.expense('2025-' + mm + '-10', m <= 7 ? 5500 : 6600, { desc: '클라우드' }));
  }
  const f = build(txns);
  const item = f.recurring.items.find((r) => r.label === '클라우드');
  assert.ok(item, '12개월 연속 구독이 인상 한 번으로 탈락하면 안 된다');
  assert.strictEqual(item.months, 12);
});

test('끝난 구독은 1년치를 전망하지 않는다 (실측 허수 209만원 = 보고액의 66%)', () => {
  const txns = [];
  // 살아 있는 것: 최근 3개월
  ['2025-10', '2025-11', '2025-12'].forEach((m) => {
    txns.push(H.expense(m + '-10', 20000, { desc: '살아있는구독' }));
  });
  // 죽은 것: 초반 4개월 쓰고 해지
  ['2025-01', '2025-02', '2025-03', '2025-04'].forEach((m) => {
    txns.push(H.expense(m + '-10', 50000, { desc: '해지한구독' }));
  });
  const f = build(txns);

  const alive = f.recurring.items.find((r) => r.label === '살아있는구독');
  const dead = f.recurring.items.find((r) => r.label === '해지한구독');
  assert.strictEqual(alive.active, true);
  assert.strictEqual(alive.projectedAnnual, 240000);
  assert.strictEqual(dead.active, false);
  assert.strictEqual(dead.projectedAnnual, null, '해지한 구독의 1년치는 존재하지 않는 돈이다');

  assert.strictEqual(f.recurring.activeProjectedAnnual, 240000,
    '전망에 죽은 구독이 섞이면 20만 × 12 + 5만 × 12 = 84만이 된다');
  assert.strictEqual(f.recurring.observedTotal, 60000 + 200000, '실제로 나간 돈은 따로 낸다');
});


// ── 지출 급증 ──────────────────────────────────────────────────────

test('지출이 0인 달을 0으로 채워 기준선을 잡는다 (실측 baseline 46% 과대)', () => {
  const txns = [];
  // 12개월 중 2개월만 온라인쇼핑을 했다. 나머지 달은 0이지 '없음'이 아니다.
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.expense('2025-' + mm + '-15', 500000, { major: '식비' }));
  }
  txns.push(H.expense('2025-03-20', 400000, { major: '온라인쇼핑' }));
  txns.push(H.expense('2025-11-20', 3000000, { major: '온라인쇼핑' }));

  const f = build(txns);
  const spike = f.spikes.find((s) => s.category === '온라인쇼핑');
  assert.ok(spike, '평소 안 쓰다가 한 번 크게 쓴 것이 정확히 찾으려는 모양이다');
  assert.strictEqual(spike.baseline, 0, '0채움을 안 하면 기준선이 40만원으로 뜬다');
  assert.strictEqual(spike.month, '2025-11');
});

test('관측이 짧으면 급증 판정을 하지 않는다', () => {
  const f = build([
    H.expense('2025-01-15', 100000),
    H.expense('2025-02-15', 100000),
    H.expense('2025-03-15', 5000000),
  ]);
  assert.strictEqual(f.spikes.length, 0, '다른 달이 2개인 중앙값은 아무것도 말해주지 않는다');
});


// ── 잔고 ───────────────────────────────────────────────────────────

test('합계 셀은 수식이라 읽지 않고 직접 더한다', () => {
  const f = build([H.expense('2025-01-01', 1000)], {
    assets: [
      { group: '자유입출금 자산', name: '통장A', amount: 1000000 },
      { group: '자유입출금 자산', name: '통장B', amount: 500000 },
      { group: '저축성 자산', name: '청약', amount: 2000000 },
    ],
    debts: [{ group: '장기대출', name: '학자금', amount: 300000 }],
  });
  assert.strictEqual(f.balance.totalAssets, 3500000);
  assert.strictEqual(f.balance.totalDebt, 300000);
  assert.strictEqual(f.balance.netWorth, 3200000);
});

test('그룹명은 첫 행에만 있으므로 아래로 이어받는다', () => {
  const f = build([H.expense('2025-01-01', 1000)], {
    assets: [
      { group: '자유입출금 자산', name: 'A', amount: 100 },
      { group: '자유입출금 자산', name: 'B', amount: 200 },
      { group: '자유입출금 자산', name: 'C', amount: 300 },
    ],
  });
  assert.strictEqual(f.balance.buckets.cash, 600, '이어받지 않으면 대부분이 기타로 샌다');
});

test('원금 없는 계좌가 수익률에 섞이면 안 된다 (합성에서 +420% 오보)', () => {
  const f = build([H.expense('2025-01-01', 1000)], {
    assets: [{ group: '투자성 자산', name: 'CMA', amount: 500000 },
             { group: '투자성 자산', name: 'A주식', amount: 20000 }],
    investments: [
      { name: 'CMA', principal: 0, value: 500000 },
      { name: 'A주식', principal: 100000, value: 20000 },
    ],
  });
  assert.strictEqual(f.investments.withCostBasis.principal, 100000);
  assert.strictEqual(f.investments.withCostBasis.value, 20000);
  assert.strictEqual(f.investments.withCostBasis.roi, -0.8, 'CMA 를 섞으면 +420% 가 된다');
  assert.strictEqual(f.investments.withoutCostBasis.value, 500000, '증발시키지 않고 따로 밝힌다');
  assert.strictEqual(f.investments.bucketTotal, 520000);
});

test('투자현황에 없는 투자성 자산도 총액에 남는다 (실측 CMA 130,385원)', () => {
  const f = build([H.expense('2025-01-01', 1000)], {
    assets: [{ group: '투자성 자산', name: '주식A', amount: 80000 },
             { group: '투자성 자산', name: '예수금', amount: 130385 }],
    investments: [{ name: '주식A', principal: 100000, value: 80000 }],
  });
  assert.strictEqual(f.investments.bucketTotal, 210385);
  assert.strictEqual(f.investments.withoutCostBasis.value, 130385);
});


// ── 못 믿을 값은 내보내지 않는다 ───────────────────────────────────

test('미분류 이체가 크면 저축률 키 자체를 만들지 않는다', () => {
  const f = build([
    H.income('2025-01-01', 1000000),
    H.expense('2025-01-05', 300000),
    H.transfer('2025-01-10', 5000000, '누군가'),
  ]);
  assert.strictEqual(f.flow.savingsRate, undefined, 'null 이 아니라 키가 없어야 인용될 수 없다');
  assert.ok(f.flow.savingsRateOmitted);
  assert.strictEqual(f.flow.savingsRateOmitted.reason, 'unclassified_transfers');
});

test('데이터가 깨끗하면 저축률을 낸다', () => {
  const f = build([
    H.income('2025-01-01', 1000000),
    H.expense('2025-01-05', 300000),
  ]);
  assert.strictEqual(f.flow.savingsRate, 0.7);
  assert.strictEqual(f.flow.savingsRateOmitted, undefined);
});

test('문턱은 수입이 아니라 지출 기준이다 — 수입이 틀렸을 때 순환을 피한다', () => {
  // 수입은 10만원만 잡혔고 지출이 2,000만원인 상태 (실데이터가 정확히 이랬다)
  const f = build([
    H.income('2025-01-01', 100000),
    H.expense('2025-01-05', 20000000),
  ]);
  assert.strictEqual(f.dataQuality.material, 1000000,
    '수입 기준이면 20만원까지 내려가 노이즈를 다 잡는다');
});


// ── 파싱 견고성 ────────────────────────────────────────────────────

test('헤더가 다르면 조용히 틀리는 대신 즉시 멈춘다', () => {
  const sheets = H.sheets([H.expense('2025-01-01', 1000)]);
  sheets['가계부 내역'][0][6] = '금액(원)'; // 컬럼명 변경
  assert.throws(() => KM.parse.extract(sheets), /SchemaMismatch|예상과 다릅니다/);
});

test('모르는 거래 타입은 넘겨짚지 않고 멈춘다', () => {
  const sheets = H.sheets([{ day: '2025-01-01', kind: '투자', amount: -1000 }]);
  assert.throws(() => KM.parse.extract(sheets), /거래 타입/);
});

test('원화가 아닌 거래는 원화 합계에 섞지 않는다', () => {
  const ex = extract([
    H.expense('2025-01-01', 10000),
    H.expense('2025-01-02', 100, { currency: 'USD' }),
  ]);
  assert.strictEqual(ex.txns.length, 1);
  assert.strictEqual(ex.foreign.length, 1);
  const f = KM.aggregate.build(ex);
  assert.strictEqual(f.flow.expense, 10000, 'USD 100 이 100원으로 더해지면 안 된다');
  assert.ok(f.dataQuality.flags.some((x) => x.code === 'foreign_currency_excluded'));
});

test('행이 짧아도 죽지 않는다', () => {
  const sheets = H.sheets([H.expense('2025-01-01', 1000)]);
  sheets['가계부 내역'][1] = sheets['가계부 내역'][1].slice(0, 7); // 메모·결제수단 없음
  const ex = KM.parse.extract(sheets);
  assert.strictEqual(ex.txns.length, 1);
  assert.strictEqual(ex.txns[0].method, '');
});

test('날짜는 Date 객체로 와도 문자열로 와도 같게 읽는다', () => {
  const a = KM.parse.day(new Date(2025, 0, 5));
  const b = KM.parse.day('2025-01-05T00:00:00');
  assert.strictEqual(a, '2025-01-05');
  assert.strictEqual(b, '2025-01-05');
});

test('현황 시트가 없어도 흐름 지표는 나온다', () => {
  const f = KM.aggregate.build(KM.parse.extract(H.sheets([H.expense('2025-01-01', 1000)], null)));
  assert.strictEqual(f.flow.expense, 1000);
  assert.strictEqual(f.balance, undefined);
  assert.ok(f.dataQuality.flags.some((x) => x.code === 'no_balance_sheet'));
});

test('거래가 하나도 없어도 죽지 않는다', () => {
  const f = build([]);
  assert.strictEqual(f.period, null);
  assert.strictEqual(f.flow.expense, 0);
});


// ── 델타 ───────────────────────────────────────────────────────────

test('이전 스냅샷이 없으면 델타는 null 이다', () => {
  assert.strictEqual(KM.aggregate.delta(build([H.expense('2025-01-01', 1000)]), null), null);
});

test('델타는 대화 한 세션이 알 수 없는 것만 담는다', () => {
  const prev = build([H.expense('2025-01-01', 1000)], {
    assets: [{ group: '자유입출금 자산', name: 'A', amount: 1000000 }],
  });
  prev.generatedFor = '2025-01';
  const cur = build([H.expense('2025-02-01', 1000)], {
    assets: [{ group: '자유입출금 자산', name: 'A', amount: 1400000 }],
  });
  const d = KM.aggregate.delta(cur, prev);
  assert.strictEqual(d.since, '2025-01');
  assert.strictEqual(d.netWorth, 400000);
  assert.strictEqual(d.cash, 400000);
});


// ── 산출물 계약 ────────────────────────────────────────────────────

test('Apps Script 번들이 core/ 와 같은 결과를 낸다', () => {
  const bundlePath = path.join(H.ROOT, 'appsscript', 'core.gs');
  if (!fs.existsSync(bundlePath)) {
    assert.fail('appsscript/core.gs 가 없다. node scripts/build-gs.js 를 먼저 실행해라.');
  }
  const bundled = H.loadBundle();
  const input = H.sheets([H.income('2025-01-01', 500000), H.expense('2025-01-05', 120000)]);
  assert.deepStrictEqual(
    bundled.aggregate.build(bundled.parse.extract(input)).flow,
    KM.aggregate.build(KM.parse.extract(input)).flow
  );
});

test('enum 값은 ASCII 다 — JSON 소비자가 한국어로 분기하면 안 된다', () => {
  const f = build([H.expense('2025-01-01', 1000)], {
    assets: [{ group: '자유입출금 자산', name: 'A', amount: 100 }],
  });
  assert.ok(Object.keys(f.balance.buckets).every((k) => /^[a-z]+$/.test(k)),
    '실제: ' + Object.keys(f.balance.buckets).join(','));
});

test('산출물에 원본 거래가 실리지 않는다 — 커넥터 19KB 절벽', () => {
  const txns = [];
  for (let i = 0; i < 3000; i++) {
    txns.push(H.expense('2025-' + String((i % 12) + 1).padStart(2, '0') + '-10', 1000 + i,
      { desc: '가맹점' + i }));
  }
  const size = JSON.stringify(build(txns)).length;
  assert.ok(size < 12000, '거래 3,000건인데 산출물이 ' + size + ' bytes');
});
