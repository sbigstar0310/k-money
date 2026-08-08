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
const H = require('./lib/helpers');

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
    H.transfer('2025-01-10', -500000, '홍길동'),
    H.transfer('2025-01-10', 500000, '홍길동'),
  ]);
  assert.strictEqual(f.flow.income, 1000000);
  assert.strictEqual(f.flow.expense, 200000);
});


// ── 이체 분해 ──────────────────────────────────────────────────────

test('본인 계좌 간 이체는 순액이 0이 되어야 한다', () => {
  const f = build([
    H.transfer('2025-01-10', -500000, '토뱅 홍길동'),
    H.transfer('2025-01-10', 500000, '홍길동'),
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
  assert.ok(codes.includes('unclassifiedExternalTransfers'), '순액이 0이어도 플래그가 서야 한다');
});

test('구두점이 붙은 본인 이름도 본인으로 본다 — "토스 홍길동/" (실측 494,000원)', () => {
  const f = build([H.transfer('2025-01-10', -444000, '토스 홍길동/')]);
  assert.strictEqual(f.transfers.self.net, -444000);
  assert.strictEqual(f.transfers.external.count, 0);
});

test('이름이 통째로 가려진 "***" 는 본인이 아니다 — 아무나 통과한다', () => {
  const f = build([H.transfer('2025-01-10', 500000, '***')]);
  assert.strictEqual(f.transfers.self.count, 0);
  assert.strictEqual(f.transfers.external.net, 500000);
});

test('부분 문자열은 본인이 아니다 — "홍길동한국과학기술원" (실측 50,000원 오분류)', () => {
  const f = build([
    H.transfer('2025-01-10', -50000, '홍길동한국과학기술원'),
    H.transfer('2025-01-11', -30000, '박홍길동'),
  ]);
  assert.strictEqual(f.transfers.self.count, 0, '내 이름이 들어있다고 내 계좌가 아니다');
  assert.strictEqual(f.transfers.external.net, -80000);
});

test('가려진 이름으로 본인 판정된 건은 불확실성으로 표시한다', () => {
  const f = build([H.transfer('2025-01-10', -100000, '홍*동')]);
  assert.strictEqual(f.transfers.self.count, 1, '마스킹은 본인일 가능성이 높으니 채택하되');
  assert.strictEqual(f.transfers.self.matchedByMaskedName, 1, '동명이인일 수 있음을 밝힌다');
  const codes = f.dataQuality.flags.map((x) => x.code);
  assert.ok(codes.includes('ownerMatchedByMaskedName'));
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
    txns.push(H.transfer('2025-' + mm + '-10', 100000, '홍길동'));
    txns.push(H.transfer('2025-' + mm + '-11', -100000, '홍길동'));
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
  assert.strictEqual(dead.active, false);
  // 연환산(×12)은 LLM 이 한다. 우리가 하는 건 '무엇이 아직 살아 있나' 판정뿐이고,
  // 그게 함정이었다 — 끝난 구독까지 세면 실측 66%가 허수였다.
  assert.strictEqual(f.recurring.activeMonthlyTotal, 20000,
    '살아 있는 것만 합산한다. 죽은 구독이 섞이면 70,000 이 된다');
  assert.strictEqual(alive.observedTotal, 60000, '실제로 나간 돈은 따로 낸다');
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
  assert.strictEqual(f.balance.totalDebt, 300000);
  assert.strictEqual(f.balance.netWorth, 3200000, '수식 셀을 읽었다면 0 이나 NaN 이 나온다');
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
  // 수익률은 LLM 이 holdings 로 계산한다. 우리가 하는 건 **원금 있는 것과
  // 없는 것을 가르는 일**이고, 그게 이 블록의 유일한 값어치다.
  assert.strictEqual(f.investments.holdings.length, 1, 'CMA 는 수익률 계산에서 빠져야 한다');
  assert.strictEqual(f.investments.holdings[0].principal, 100000);
  assert.strictEqual(f.investments.unpricedValue, 500000, '증발시키지 않고 따로 밝힌다');
  assert.strictEqual(f.investments.bucketTotal, 520000);
});

test('투자현황에 없는 투자성 자산도 총액에 남는다 (실측 CMA 130,385원)', () => {
  const f = build([H.expense('2025-01-01', 1000)], {
    assets: [{ group: '투자성 자산', name: '주식A', amount: 80000 },
             { group: '투자성 자산', name: '예수금', amount: 130385 }],
    investments: [{ name: '주식A', principal: 100000, value: 80000 }],
  });
  assert.strictEqual(f.investments.bucketTotal, 210385);
  assert.strictEqual(f.investments.unpricedValue, 130385);
});


// ── 못 믿을 값은 내보내지 않는다 ───────────────────────────────────

test('미분류 이체가 크면 저축률 키 자체를 만들지 않는다', () => {
  const f = build([
    H.income('2025-01-01', 1000000),
    H.expense('2025-01-05', 300000),
    H.transfer('2025-01-10', 5000000, '누군가'),
  ]);
  assert.strictEqual(f.flow.savingsRate, undefined, 'null 이 아니라 키가 없어야 인용될 수 없다');
  assert.strictEqual(f.flow.savingsRateOmitted, 'unclassifiedTransfers');
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
  assert.ok(f.dataQuality.flags.some((x) => x.code === 'foreignCurrencyExcluded'));
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
  assert.ok(f.dataQuality.flags.some((x) => x.code === 'noBalanceSheet'));
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


// ── 부채 ───────────────────────────────────────────────────────────

test('부채를 개별로 내보낸다 — 총액만으로는 대화가 안 된다', () => {
  // 사회 초년생에게 학자금·전세대출은 기본값에 가깝다. 총액만 주면
  // "빚 6,200만원" 까지만 말할 수 있고 자기 상황을 올릴 수가 없다.
  const facts = build([H.income('2026-06-01', 2500000)], {
    assets: [{ group: '자유입출금 자산', name: '주거래통장', amount: 3000000 }],
    debts: [
      { group: '신용대출', name: '학자금대출', amount: 12000000 },
      { group: '전세자금대출', name: '전세대출', amount: 50000000 },
    ],
  });
  assert.equal(facts.balance.totalDebt, 62000000);
  assert.equal(facts.balance.netWorth, -59000000, '부채가 순자산에서 빠져야 한다');
  assert.deepEqual(facts.balance.debts.map((d) => d.name), ['전세대출', '학자금대출'],
    '큰 것부터 와야 한다');
  // 자산 목록에 부채가 섞이면 총자산이 부풀어 보인다.
  assert.equal(facts.balance.accounts.filter((a) => a.name.indexOf('대출') !== -1).length, 0);
});

test('부채가 없으면 debts 를 만들지 않는다', () => {
  // 빈 배열을 내보내면 LLM 이 "부채 정보가 있다" 로 읽는다.
  const facts = build([H.income('2026-06-01', 100)],
    { assets: [{ group: '자유입출금 자산', name: '통장', amount: 100 }] });
  assert.equal(facts.balance.debts, undefined);
  assert.equal(facts.balance.totalDebt, 0);
});

test('거래가 없는 달을 0으로 채우되 "모름" 과 구분한다', () => {
  // 예전엔 그 달이 목록에서 통째로 사라져 "3월에 얼마 썼어?" 에 답할 수 없었다.
  // 더 나쁜 건 같은 데이터를 보는 spikes 는 0채움을 하고 있었다는 것 —
  // 한 산출물 안에서 3월의 존재 여부가 두 갈래였다.
  const f = build([
    H.expense('2026-01-10', 500000),
    H.expense('2026-04-10', 500000),
  ]);
  const months = f.flow.monthly.map((r) => r.month);
  assert.deepEqual(months, ['2026-01', '2026-02', '2026-03', '2026-04']);

  const feb = f.flow.monthly[1];
  assert.strictEqual(feb.expense, 0);
  assert.strictEqual(feb.noTransactions, true, '진짜 0 과 구분되어야 한다');
  assert.strictEqual(f.flow.monthly[0].noTransactions, undefined);

  // 카테고리 교차도 같은 달 목록을 써야 한다.
  assert.deepEqual(f.categoryMonthly.months, months);
});

test('양끝은 늘리지 않는다 — 관측 전후는 "안 썼음" 이 아니라 "모름" 이다', () => {
  const f = build([H.expense('2026-03-10', 100000), H.expense('2026-05-10', 100000)]);
  assert.deepEqual(f.flow.monthly.map((r) => r.month),
    ['2026-03', '2026-04', '2026-05']);
});

test('빈 달이 월평균 지출의 분모를 바꾸지 않는다', () => {
  // 분모는 실제 경과일이다. 행 개수가 아니다 — 여기가 흔들리면
  // 0채움이 비상금 기준선을 조용히 낮춘다.
  const a = build([H.expense('2026-01-10', 300000), H.expense('2026-04-10', 300000)]);
  assert.ok(Math.abs(a.flow.avgMonthlyExpense - Math.round(600000 / (91 / 30.436875))) < 2,
    '실제로는 ' + a.flow.avgMonthlyExpense);
});

// ── 이름·기간 라벨 ─────────────────────────────────────────────────

test('존칭이 붙은 본인 이름도 본인으로 본다 — "홍길동님"', () => {
  // 못 잡으면 본인 이체가 남과의 이체로 잡히고, pace 에 없는 돈으로 더해진다.
  const f = build([H.income('2025-01-01', 1000000), H.transfer('2025-01-10', -100000, '홍길동님')]);
  assert.strictEqual(f.transfers.self.count, 1);
  assert.strictEqual(f.transfers.external.count, 0);
});

test('존칭을 떼도 뒤에 더 붙은 건 남이다 — "홍길동님전자"', () => {
  const f = build([H.income('2025-01-01', 1000000), H.transfer('2025-01-10', -100000, '홍길동님전자')]);
  assert.strictEqual(f.transfers.self.count, 0, '접미사를 떼는 게 부분일치가 되면 안 된다');
});

test('흐름 창과 전체 창이 다르면 밝힌다', () => {
  // period 는 이체까지 걸치고, pace·avgMonthlyExpense 는 이체를 뺀 창을 쓴다.
  // 라벨이 없으면 소비자가 지출/period.days 로 12배 틀린 값을 만든다.
  const f = build([
    H.transfer('2025-01-01', -100000, '남'),
    H.expense('2026-01-10', 500000),
    H.income('2026-01-25', 3000000),
  ]);
  assert.strictEqual(f.period.days, 390);
  assert.strictEqual(f.period.flowFrom, '2026-01-10');
  assert.strictEqual(f.period.flowDays, 16);
  assert.match(f.period.flowNote, /pace/);
});

test('두 창이 같으면 굳이 싣지 않는다', () => {
  const f = build([H.expense('2026-01-10', 500000), H.income('2026-01-25', 3000000)]);
  assert.strictEqual(f.period.flowFrom, undefined, '늘 실으면 소음이다');
});

test('generatedFor 는 데이터의 마지막 날이다 — 메일 받은 날이 아니다', () => {
  const KMl = H.loadCore();
  const f = KMl.aggregate.build(
    KMl.parse.extract(H.sheets([H.expense('2026-06-10', 5000)])),
    { asOf: '2026-06-30' });
  assert.strictEqual(f.generatedFor, '2026-06-10', '뱅샐이 어제까지만 담아 보낼 수 있다');
  assert.strictEqual(f.receivedOn, '2026-06-30', '메일 받은 날은 따로 남긴다');
});

// ── 델타 ───────────────────────────────────────────────────────────

test('delta 는 잘린 목록으로 "새 구독" 을 판정하지 않는다', () => {
  // 예전엔 상한(12) 밖에 있던 항목이 안으로 들어오면 없던 구독이 생긴 것으로
  // 보고됐다. delta 는 내보낸 창 밖을 보존하는 유일한 수단이라 검증이 안 된다.
  const KMl = H.loadCore();
  const many = [];
  for (let i = 0; i < 14; i++) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      many.push(H.expense('2025-' + mm + '-10', 10000 + i * 1000, { desc: '구독' + i }));
    }
  }
  const snap = KMl.aggregate.build(KMl.parse.extract(H.sheets(many)));
  assert.ok(snap.recurring.activeKeys.length > snap.recurring.items.length,
    '잘린 목록보다 키가 많아야 이 테스트가 의미 있다');

  // 같은 데이터를 다시 넣으면 새 구독은 하나도 없어야 한다.
  const d = KMl.aggregate.delta(snap, snap);
  assert.deepEqual(d.newRecurring, [], '같은 데이터인데 새 구독이 나왔다');
});

test('delta — 진짜 새 항목은 잡는다', () => {
  const KMl = H.loadCore();
  const base = [];
  for (let m = 1; m <= 12; m++) {
    base.push(H.expense('2025-' + String(m).padStart(2, '0') + '-10', 9900, { desc: '넷플릭스' }));
  }
  const before = KMl.aggregate.build(KMl.parse.extract(H.sheets(base)));
  const after = KMl.aggregate.build(KMl.parse.extract(H.sheets(base.concat(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) =>
      H.expense('2025-' + String(m).padStart(2, '0') + '-11', 14900, { desc: '유튜브' }))))));
  const d = KMl.aggregate.delta(after, before);
  assert.deepEqual(d.newRecurring.map((r) => r.label), ['유튜브']);
});

test('delta — 예전 스냅샷이 낡았으면 지어내지 않는다', () => {
  const KMl = H.loadCore();
  const cur = KMl.aggregate.build(KMl.parse.extract(H.sheets([H.expense('2026-01-10', 1000)])));
  const old = JSON.parse(JSON.stringify(cur));
  delete old.recurring.activeKeys;         // 0.4.x 이전 산출물
  const d = KMl.aggregate.delta(cur, old);
  assert.strictEqual(d.newRecurring, undefined);
  assert.strictEqual(d.newRecurringOmitted, 'previousSnapshotTooOld');
});

// ── 빌드 산물 ──────────────────────────────────────────────────────

test('커밋된 core.gs 가 지금 core/ 에서 나온 것이다', () => {
  // ⚠️ **실제로 유저에게 도는 건 커밋된 core.gs 다.** 예전에는 core/ 를
  //    고치고 빌드를 안 돌려도 테스트가 전부 통과했다 — LIMITS 를 12에서
  //    6으로 바꾸고 확인했더니 133개 전부 초록이었고, 프로덕션은 옛 번들이었다.
  //    npm test 는 누구나 돌리지만 npm run check 는 아무도 기억 못 한다.
  const build = require(path.join(__dirname, '..', 'scripts', 'build-gs.js'));
  const committed = fs.readFileSync(build.dest, 'utf8');
  assert.equal(committed, build.build(),
    'core/ 를 고치고 node scripts/build-gs.js 를 안 돌렸다');
});

// ── 소스 위생 ──────────────────────────────────────────────────────

test('소스에 NUL 바이트가 없다 — 두 번 당한 함정이다', () => {
  // 한 번은 itemKey 구분자로, 한 번은 그 사실을 설명하는 주석에 들어갔다.
  // NUL 은 산출물 JSON 까지 실려 나가고, 소스를 바이너리로 만들어
  // grep 이 매치를 조용히 감춘다. 눈으로는 공백과 구분되지 않는다.
  const dirs = ['core', 'appsscript', 'test', 'scripts'];
  const offenders = [];
  dirs.forEach((d) => {
    const dir = path.join(H.ROOT, d);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir)
      .filter((n) => /\.(js|gs|py)$/.test(n))
      .forEach((n) => {
        const buf = fs.readFileSync(path.join(dir, n));
        if (buf.includes(0)) offenders.push(d + '/' + n);
      });
  });
  assert.deepStrictEqual(offenders, []);
});


// ── 경계 원칙 회귀 ─────────────────────────────────────────────────
//
// 2026-08-08 적대적 검토에서 나온 것들. "우리가 파는 건 산수가 아니라
// 어떤 식을 쓸지에 대한 판단" 이라는 원칙이 코드에서 지켜지는지 본다.

test('pace 는 남과 오간 이체만 더한다 — 여섯 공식 중 하나만 맞다', () => {
  // 실측: pace 를 지우면 LLM 이 만들 수 있는 공식 6개 중 4개가 부호를 뒤집었다.
  // 12개월로 편다 — 짧은 관측이면 pace.monthly 를 아예 안 내보내기 때문이다.
  // 12개월로 편다 — 짧으면 pace.monthly 를 안 내보낸다.
  // 남과 오간 이체는 수입의 5% 아래로 둔다 — 그보다 크면 pace 자체를 막는다.
  const txns = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.income('2025-' + mm + '-01', 3000000));
    txns.push(H.expense('2025-' + mm + '-15', 1000000));
    txns.push(H.transfer('2025-' + mm + '-10', 100000, '회사'));     // 남 → 더한다
    txns.push(H.transfer('2025-' + mm + '-20', 400000, '홍길동'));   // 본인 → 안 더한다
  }
  const f = build(txns, { assets: [{ group: '자유입출금 자산', name: '통장', amount: 5000000 }] });

  // 달마다 (3,000,000 − 1,000,000 + 100,000) = +2,100,000
  const total = f.pace.monthly * f.pace.observedMonths;
  assert.ok(Math.abs(total - 25200000) < 250000, '실제로는 ' + total);
  const perMonth = total / 12;
  assert.ok(Math.abs(perMonth - 1900000) > 100000, '이체를 통째로 빼면 190만이 된다');
  assert.ok(Math.abs(perMonth - 2500000) > 100000, '본인 이체까지 더하면 250만이 된다');
});

test('관측이 짧으면 월 단위 값을 아예 내보내지 않는다', () => {
  // 설치 첫날 며칠치만 들어오면 pace 가 월 292만, 비상금이 35개월치로 나왔다.
  // 플래그도 없었다. 그 숫자를 보고 안심하는 게 이 도구의 최악이다.
  const f = build([
    H.income('2026-03-15', 3000000),
    H.expense('2026-03-15', 80000),
  ], { assets: [{ group: '자유입출금 자산', name: '통장', amount: 2840000 }] });

  assert.strictEqual(f.pace.monthly, undefined, '며칠치를 월로 늘리면 안 된다');
  assert.strictEqual(f.pace.monthlyOmitted, 'shortObservation');
  assert.strictEqual(f.flow.avgMonthlyExpense, undefined);
  assert.strictEqual(f.cash.monthsOfExpense, undefined, '비상금 35개월치가 여기서 나왔다');
  assert.ok(f.dataQuality.flags.some((x) => x.code === 'shortObservation'),
    '조용히 빼면 안 된다. 왜 없는지 말해야 한다');
  // 재료는 남는다 — 판단은 LLM 이 한다.
  assert.ok(f.flow.expense > 0 && f.cash.total > 0);
});

test('미분류 이체가 크면 pace 도 savingsRate 처럼 막는다', () => {
  // 카카오뱅크 세이프박스로 매달 100만원을 옮기면 적요가 상품명이라
  // 본인 계좌로 안 잡힌다. 실제 여유는 월 150만인데 51만으로 나왔었다.
  const txns = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.income('2025-' + mm + '-25', 3000000));
    txns.push(H.expense('2025-' + mm + '-10', 1500000));
    txns.push(H.transfer('2025-' + mm + '-26', -1000000, '카카오뱅크세이프박스'));
  }
  const f = build(txns);

  assert.strictEqual(f.pace.monthly, undefined,
    'savingsRate 는 숨기면서 같은 값으로 만든 pace 를 내보내면 앞뒤가 안 맞는다');
  assert.strictEqual(f.pace.monthlyOmitted, 'unclassifiedTransfers');
  assert.strictEqual(f.flow.savingsRateOmitted, 'unclassifiedTransfers');
  // 한쪽 끝이 아니라 폭을 준다 — '전부 내 계좌였다면' 쪽 값.
  assert.ok(f.pace.monthlyIfExternalIsOwn > 1400000,
    '실제로는 ' + f.pace.monthlyIfExternalIsOwn);
});

test('수입이 없으면 그 이유를 이체 탓으로 돌리지 않는다', () => {
  // 거래가 0건인데 'unclassifiedTransfers' 라고 적고 있었다. 이체가 한 건도 없는데.
  const f = build([H.expense('2025-01-01', 1000)]);
  assert.strictEqual(f.flow.savingsRateOmitted, 'noIncome');
});

test('잘라낸 목록의 나머지를 밝힌다 — 안 밝히면 검산이 안 맞는다', () => {
  const txns = [];
  for (let i = 0; i < 20; i++) {
    txns.push(H.expense('2025-0' + ((i % 9) + 1) + '-10', 10000 * (i + 1),
      { major: '분류' + i, desc: '가맹점' + i }));
  }
  const f = build(txns);
  const shown = f.categories.items.reduce((s, c) => s + c.amount, 0);
  assert.ok(f.categories.otherTotal > 0, '20개 중 12개만 실었으면 나머지를 밝혀야 한다');
  assert.strictEqual(shown + f.categories.otherTotal, f.flow.expense);
});

test('양끝의 잘린 달을 표시한다 — 8일치를 한 달로 읽으면 안 된다', () => {
  const f = build([
    H.expense('2025-01-15', 500000),
    H.expense('2025-03-08', 100000),
  ]);
  assert.strictEqual(f.flow.monthly[0].partial, true, '1월 15일 시작이면 1월은 잘린 달이다');
  const last = f.flow.monthly[f.flow.monthly.length - 1];
  assert.strictEqual(last.partial, true);
  assert.strictEqual(last.daysObserved, 8, '3월은 8일치뿐이다');
});

test('daysObserved 는 관측한 날 수다 — 마지막 거래일의 일(日)이 아니다', () => {
  // 3월 15일 하루치가 'daysObserved: 15' 였다. 그 달 1일부터 봤다는
  // 가정이 깔려 있었다. 연환산하면 15배 과소평가된다.
  const f = build([H.income('2026-03-15', 3000000), H.expense('2026-03-15', 80000)]);
  assert.strictEqual(f.flow.monthly[0].daysObserved, 1);
});

test('잘린 첫 달에도 daysObserved 를 준다', () => {
  // 마지막 달만 주고 첫 달은 partial 표시만 했다. 비대칭이라 소비자가
  // 첫 달을 온전한 달로 읽는다.
  const f = build([H.expense('2025-01-15', 500000), H.expense('2025-03-08', 100000)]);
  const rows = f.flow.monthly;
  assert.strictEqual(rows[0].daysObserved, 17, '1/15~1/31');
  assert.strictEqual(rows[rows.length - 1].daysObserved, 8, '3/01~3/08');
  // 사이의 2월은 거래가 없어 0으로 채워진 달이다. 잘린 게 아니다.
  assert.strictEqual(rows[1].noTransactions, true);
  assert.strictEqual(rows[1].partial, undefined);
});

test('순액 0인 이체 상대가 목록에서 사라지지 않는다', () => {
  // 700만 받고 700만 보낸 상대는 net === 0 이라 inflows(>0) 에도
  // outflows(<0) 에도 안 들어갔다. 1,400만원이 오간 사람의 이름이
  // 아무 데도 안 남았다 — 그걸 드러내려고 만든 코드에서.
  const f = build([
    H.income('2025-01-01', 10000000),
    H.transfer('2025-01-10', 7000000, '김철수'),
    H.transfer('2025-01-20', -7000000, '김철수'),
  ]);
  const named = f.transfers.external.topInflows.concat(f.transfers.external.topOutflows)
    .map((p) => p.party);
  assert.ok(named.includes('김철수'), '이름이 사라졌다: ' + JSON.stringify(named));
  assert.strictEqual(f.transfers.external.gross, 14000000);
});

test('구독 목록은 살아 있는 것부터 보여주고 잘라낸 만큼을 밝힌다', () => {
  // 해지한 비싼 구독들이 상한을 다 먹으면 지금 나가는 돈이 하나도 안 보인다.
  // hints 는 'label 을 보고 구분하라' 고 하는데 볼 label 이 없었다.
  const txns = [];
  for (let i = 0; i < 14; i++) {
    // 비싼 해지 구독: 1~5월만
    for (let m = 1; m <= 5; m++) {
      txns.push(H.expense('2025-0' + m + '-10', 500000 + i, { desc: '해지' + i }));
    }
  }
  for (let i = 0; i < 6; i++) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      txns.push(H.expense('2025-' + mm + '-11', 50000 + i, { desc: '살아있음' + i }));
    }
  }
  const f = build(txns);
  const shownActive = f.recurring.items.filter((r) => r.active);
  assert.ok(shownActive.length >= 6, '살아 있는 게 하나도 안 보인다');
  const sum = shownActive.reduce((a, r) => a + r.monthlyMedian, 0)
    + (f.recurring.otherActiveTotal || 0);
  assert.strictEqual(sum, f.recurring.activeMonthlyTotal, '합계와 목록이 안 맞는다');
});

test('보이는 급증만으로 monthlyExSpikes 를 만든다', () => {
  // 급증을 밖에서는 걸러 5개만 내보내면서 pace 는 안 거른 전체를 썼다.
  // 두 숫자의 차이가 보이는 급증 합계와 안 맞는데 검산할 방법이 없다.
  const txns = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push(H.income('2025-' + mm + '-01', 5000000));
    for (let c = 0; c < 10; c++) {
      txns.push(H.expense('2025-' + mm + '-10', 100000, { major: '분류' + c }));
    }
  }
  for (let c = 0; c < 10; c++) {
    txns.push(H.expense('2025-06-20', 2500000, { major: '분류' + c }));
  }
  const f = build(txns);
  const visible = f.spikes.reduce((a, s) => a + s.excess, 0);
  const implied = (f.pace.monthlyExSpikes - f.pace.monthly) * f.pace.observedMonths;
  assert.ok(Math.abs(implied - visible) < visible * 0.02,
    '보이는 급증 ' + visible + ' 인데 pace 차이는 ' + Math.round(implied));
  if (f.spikesOther) assert.ok(f.spikesOther.count > 0, '잘라냈으면 밝혀야 한다');
});

test('카테고리×월 교차에서 안 쓴 달은 0으로 채운다', () => {
  const txns = [];
  for (let m = 1; m <= 6; m++) {
    txns.push(H.expense('2025-0' + m + '-10', 300000, { major: '식비' }));
  }
  txns.push(H.expense('2025-03-20', 900000, { major: '온라인쇼핑' }));

  const f = build(txns);
  const row = f.categoryMonthly.rows.find((r) => r.category === '온라인쇼핑');
  assert.strictEqual(row.amounts.length, f.categoryMonthly.months.length);
  assert.strictEqual(row.amounts[2], 900000);
  assert.strictEqual(row.amounts[0], 0, "안 쓴 달은 '없음' 이 아니라 0 이다");
});

test('우리가 고른 상수로 결론을 내지 않는다 — 삭제된 것들이 돌아오지 않게', () => {
  const f = build([H.expense('2025-01-01', 1000), H.expense('2025-06-01', 1000)], {
    assets: [{ group: '자유입출금 자산', name: '통장', amount: 5000000 }],
  });
  // 전부 "우리가 임의로 고른 값" 이라 뺐다. 재료는 남아 있고 배수는 LLM 이 정한다.
  assert.strictEqual(f.goal, undefined, 'goalTable·levers·suggestedHorizons');
  assert.strictEqual(f.cash.emergencyBuffer3m, undefined, '비상금 몇 개월인지는 우리가 못 정한다');
  assert.strictEqual(f.cash.aboveBuffer, undefined);
  assert.ok(f.cash.total > 0, '재료는 남긴다');
});

test('고정지출에 무엇이 들었는지 밝힌다 — 총액만 주면 월세도 끊으라는 말이 된다', () => {
  const txns = [];
  for (let m = 1; m <= 6; m++) {
    txns.push(H.expense('2025-0' + m + '-01', 500000, { desc: '월세' }));
    txns.push(H.expense('2025-0' + m + '-10', 9900, { desc: '스트리밍' }));
  }
  const f = build(txns);
  const labels = f.recurring.items.map((r) => r.label);
  assert.ok(labels.includes('월세') && labels.includes('스트리밍'),
    '실측: label 이 없으면 "고정지출 전액 끊으면 15년 빨라져" 가 나온다 (실제 11개월)');
});

test('otherTotal 은 나머지의 합이 아니라 빠진 만큼이다', () => {
  // 전액 환불된 가맹점은 순액이 음수라 목록에서 빠진다. 그걸 "나머지의 합"으로
  // 세면 검산이 안 맞는다 (실측 12,690원 초과). "전체 − 실린 것"으로 정의한다.
  const txns = [H.expense('2025-01-01', 100000, { desc: 'A' }),
                H.expense('2025-01-02', 50000, { desc: '전액환불' }),
                H.refund('2025-01-03', 50000, { desc: '전액환불' })];
  const f = build(txns);
  const shown = f.merchants.items.reduce((s, m) => s + m.amount, 0);
  assert.strictEqual(shown + (f.merchants.otherTotal || 0), f.flow.expense);
});

test('다른 컨텍스트의 Date 도 날짜로 읽는다 — 라이브러리 경계에서 깨졌던 것', () => {
  // Apps Script 라이브러리로 분리하면 getValues() 의 Date 는 다른 컨텍스트의
  // 객체라 instanceof Date 가 false 가 된다. 그러면 문자열 분기로 떨어져
  // "Fri Apr 03" 이 날짜가 되고 84개월짜리 산출물이 나온다.
  // vm 으로 다른 realm 의 진짜 Date 를 만들어 재현한다.
  const vm = require('node:vm');
  const foreign = vm.runInNewContext('new Date(2026, 3, 3)');

  assert.strictEqual(foreign instanceof Date, false, '전제: 경계를 넘으면 instanceof 가 깨진다');
  assert.strictEqual(KM.parse.isDateLike(foreign), true);
  assert.strictEqual(KM.parse.day(foreign), '2026-04-03');

  // 파이프라인 전체에서도 통해야 한다
  const sheets = H.sheets([H.expense('2025-01-15', 30000)]);
  sheets['가계부 내역'][1][0] = vm.runInNewContext('new Date(2025, 0, 15)');
  const f = KM.aggregate.build(KM.parse.extract(sheets));
  assert.strictEqual(f.period.from, '2025-01-15');
  assert.strictEqual(f.flow.monthly[0].month, '2025-01', '"Thu Jan" 이 월이 되면 안 된다');
});
