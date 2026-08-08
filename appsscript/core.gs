/**
 * ⚠️ 자동 생성 파일 — 직접 고치지 마라.
 *
 *   생성: node scripts/build-gs.js
 *   원본: core/model.js, core/layout.js, core/analyze.js, core/parse.js, core/profile.js, core/aggregate.js
 *
 * 고칠 일이 있으면 core/ 를 고치고 다시 생성하라. 여기서 고치면
 * 다음 생성 때 조용히 덮어써진다.
 *
 * 이 파일은 node 로 검증한 것과 **같은 코드**다. 포팅이 없으므로
 * 로컬에서 맞은 계산은 여기서도 맞는다.
 */

var KM = (globalThis.KM = globalThis.KM || {});
KM.VERSION = '0.1.1';

// ════════════════════════════════════════════════════════════════════
// core/model.js
// ════════════════════════════════════════════════════════════════════

/**
 * 돈동생 도메인 모델 — 어떤 앱에서 왔는지 모르는 계층.
 *
 * 이 파일은 node 와 Apps Script 양쪽에서 그대로 돈다.
 *   node        : require('./core/model.js') 후 globalThis.KM.model
 *   Apps Script : 파일이 전역에 이어붙으므로 KM.model 로 바로 접근
 * 그래서 포팅 단계가 없다. 로컬에서 검증한 파일이 그대로 프로덕션에 올라간다.
 *
 * ━━ 부호 규약 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * amount 는 **내 지갑 기준 현금 방향**이다. 들어오면 +, 나가면 −.
 *
 *   수입   +100,000
 *   지출    −25,000
 *   환불    +25,000   ← kind 는 expense 인 채로 부호만 +
 *   이체    방향 그대로
 *
 * 이건 우리 계약이지 특정 앱의 관습이 아니다. 지출을 양수로 적는 앱을 붙일 때는
 * **어댑터가 뒤집어서** 이 계약을 맞춘다.
 *
 * 부호를 Math.abs 로 뭉개면 환불이 지출에 더해져 오차가 실제 환불액의 두 배가
 * 된다 (실측: 환불 713,863원 → 오차 1,427,726원). 그래서 부호는 절대 뭉개지
 * 않고, 방향이 필요한 곳에서는 outflow/inflow 파생값을 쓴다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.model = (function () {
  'use strict';

  // 값은 ASCII 식별자다. 한국어를 넣으면 안 된다 — 이 값은 산출물 JSON 에
  // 그대로 실려 나가고, 그러면 소비자가 한국어 문자열로 분기하게 된다.
  // 표시 문구를 고치는 순간 와이어 계약이 깨진다. 표시는 LABEL 이 맡는다.
  var Kind = { INCOME: 'income', EXPENSE: 'expense', TRANSFER: 'transfer' };

  var Bucket = {
    CASH: 'cash', // 자유입출금·현금·페이머니 — 즉시 꺼낼 수 있는 돈
    SAVINGS: 'savings', // 예적금·청약
    INVESTMENT: 'investment', // 주식·펀드·CMA
    PROPERTY: 'property',
    INSURANCE: 'insurance',
    PENSION: 'pension',
    OTHER: 'other',
    DEBT: 'debt',
  };

  var LABEL = {
    income: '수입', expense: '지출', transfer: '이체',
    cash: '현금성', savings: '저축성', investment: '투자성', property: '실물',
    insurance: '보험', pension: '연금', other: '기타', debt: '부채',
  };

  var BASE_CURRENCY = 'KRW';

  /** 지출 방향 순액. 환불이면 음수가 되어 합계에서 알아서 차감된다. */
  function outflow(t) {
    return t.kind === Kind.EXPENSE ? -t.amount : 0;
  }

  function inflow(t) {
    return t.kind === Kind.INCOME ? t.amount : 0;
  }

  /** 지출로 분류됐는데 돈이 들어왔다 — 환불·취소. */
  function isRefund(t) {
    return t.kind === Kind.EXPENSE && t.amount > 0;
  }

  function month(t) {
    return t.day.slice(0, 7); // 'YYYY-MM-DD' → 'YYYY-MM'
  }

  /**
   * 반복 항목 식별자. 구독·월세 판정에 쓴다.
   *
   * 구분자는 **반드시 인쇄 가능한 문자**여야 한다. 예전에 NUL(U+0000)을 썼는데
   * 두 가지로 새어 나갔다 — 산출물 JSON 에 NUL 이 그대로 실려 Drive 까지
   * 갔고, 소스 파일이 바이너리로 취급돼 grep 이 매치를 조용히 감췄다.
   * '|' 는 뱅샐 분류명에 쓰이지 않는다 ('카페/간식' 처럼 '/' 만 쓴다).
   */
  function itemKey(t) {
    return t.major + '|' + t.minor + '|' + t.desc;
  }

  // ── 소유자 판정 ────────────────────────────────────────────────
  //
  // 가계부 앱은 이체 상대 이름을 '홍*동' 처럼 가린다. 그래서 글자마다
  // '원래 글자 또는 *' 를 허용해야 하는데, 순진하게 하면 두 가지로 샌다.
  //
  //   '***'    → 모든 글자가 * 라 아무 이름이나 통과한다
  //   '박홍길동' → 부분 문자열이라 남의 이름에 내 이름이 들어가면 통과한다
  //
  // 실측에서 이 오탐 하나가 R1 판정을 547,688원 뒤집었다. 그래서
  //   (1) 공백으로 자른 토큰을 **완전 일치**로만 본다 ('토뱅 홍길동' 는 통과)
  //   (2) 가려지지 않은 글자가 최소 1개는 있어야 한다 ('***' 차단)
  // 그리고 마스킹으로 걸린 건은 masked=true 로 표시해 불확실성을 위로 올린다.

  function matchOwner(desc, owner) {
    if (!owner || !desc) return { self: false, masked: false };
    // 공백으로만 자르면 '토스 홍길동/' 의 '홍길동/' 가 길이 불일치로 빠진다.
    // 실측에서 이 한 건이 본인 이체 494,000원을 타인으로 새게 만들었다.
    // → 한글·영숫자·* 의 연속만 토큰으로 뽑아 구두점을 떨군다.
    var tokens = String(desc).match(/[가-힣A-Za-z0-9*]+/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (tok.length !== owner.length) continue;
      var exact = 0;
      var ok = true;
      for (var j = 0; j < owner.length; j++) {
        if (tok[j] === owner[j]) exact++;
        else if (tok[j] !== '*') { ok = false; break; }
      }
      // 가려지지 않은 글자가 하나도 없으면 아무 이름이나 통과한다
      if (ok && exact > 0) return { self: true, masked: exact < owner.length };
    }
    return { self: false, masked: false };
  }

  // ── 스냅샷 파생값 ──────────────────────────────────────────────
  //
  // 합계는 언제나 계산이다. 출처가 준 합계 셀은 신뢰하지 않는다 —
  // 뱅샐은 총자산·순자산을 수식으로만 내보내서 읽으면 비어 있다.

  function sum(arr, f) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += f(arr[i]);
    return s;
  }

  function assets(snap) {
    return snap.holdings.filter(function (h) { return h.bucket !== Bucket.DEBT; });
  }

  function debts(snap) {
    return snap.holdings.filter(function (h) { return h.bucket === Bucket.DEBT; });
  }

  function totalAssets(snap) {
    return sum(assets(snap), function (h) { return h.amount; });
  }

  function totalDebt(snap) {
    return sum(debts(snap), function (h) { return h.amount; });
  }

  function netWorth(snap) {
    return totalAssets(snap) - totalDebt(snap);
  }

  function inBucket(snap, bucket) {
    return snap.holdings.filter(function (h) { return h.bucket === bucket; });
  }

  function bucketTotal(snap, bucket) {
    return sum(inBucket(snap, bucket), function (h) { return h.amount; });
  }

  /**
   * 종목 수익률. 원금 0이면 계산 불가 — 0 이 아니라 null 이다.
   * 0 을 돌려주면 '본전'으로 읽혀서, 원금 정보가 없는 CMA 계좌가
   * '손익 없음'으로 리포트에 조용히 섞인다.
   */
  function roi(inv) {
    return inv.principal > 0 ? (inv.value - inv.principal) / inv.principal : null;
  }

  return {
    Kind: Kind, Bucket: Bucket, LABEL: LABEL, BASE_CURRENCY: BASE_CURRENCY,
    outflow: outflow, inflow: inflow, isRefund: isRefund, month: month,
    itemKey: itemKey, matchOwner: matchOwner,
    assets: assets, debts: debts, totalAssets: totalAssets, totalDebt: totalDebt,
    netWorth: netWorth, inBucket: inBucket, bucketTotal: bucketTotal, roi: roi,
    sum: sum,
  };
})();


// ════════════════════════════════════════════════════════════════════
// core/layout.js
// ════════════════════════════════════════════════════════════════════

/**
 * 출처별 시트 레이아웃 — **형식이 바뀌면 고칠 곳은 여기 한 파일이다.**
 *
 * parse.js 에는 시트 이름도 컬럼 번호도 없다. 전부 여기 있다.
 * 뱅샐이 컬럼을 바꾸면 새 버전을 만들어 LAYOUTS 에 추가하면 되고,
 * 파싱 로직과 집계는 손대지 않는다.
 *
 * 컬럼 번호는 0부터 센다 (엑셀 A열 = 0).
 * 섹션은 행 번호가 아니라 **헤더 시그니처**로 찾는다 — 뱅샐이 섹션을 하나
 * 추가하면 행 번호는 전부 밀리지만 헤더 문구는 남기 때문이다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.layout = (function () {
  'use strict';

  var B = KM.model.Bucket;
  var K = KM.model.Kind;

  var BANKSALAD_V1 = {
    id: 'banksalad',
    label: '뱅크샐러드',
    version: 'v1',

    ledgerSheet: '가계부 내역',
    ledgerHeader: ['날짜', '시간', '타입', '대분류', '소분류', '내용', '금액', '화폐', '결제수단', '메모'],
    ledgerCols: { day: 0, kind: 2, major: 3, minor: 4, desc: 5, amount: 6, currency: 7, method: 8 },

    statusSheet: '뱅샐현황',
    // [B열 문구, C열 문구] 로 섹션 헤더를 찾는다
    profileHeader: ['이름', '성별'],
    balanceHeader: ['항목', '상품명'],
    investHeader: ['투자상품종류', '금융사'],
    profileCols: { name: 1, age: 3 },
    balanceCols: {
      assetGroup: 1, assetName: 2, assetAmount: 4,
      debtGroup: 5, debtName: 6, debtAmount: 8,
    },
    investCols: { kind: 1, broker: 2, name: 3, principal: 5, value: 6 },
    balanceEnd: '총자산',
    debtEnd: '총부채',
    investEnd: '총계',

    // 출처의 어휘를 우리 어휘로. 다른 앱을 붙일 때도 같은 자리에 자기 표를 둔다.
    kinds: { '수입': K.INCOME, '지출': K.EXPENSE, '이체': K.TRANSFER },
    buckets: {
      '자유입출금 자산': B.CASH,
      '현금 자산': B.CASH,
      '전자금융 자산': B.CASH, // 페이 머니도 즉시 쓸 수 있는 돈이다
      '저축성 자산': B.SAVINGS,
      '투자성 자산': B.INVESTMENT,
      '신탁 자산': B.INVESTMENT,
      '부동산': B.PROPERTY,
      '동산': B.PROPERTY,
      '기타 실물 자산': B.PROPERTY,
      '보험 자산': B.INSURANCE,
      '연금 자산': B.PENSION,
    },
  };

  var LAYOUTS = [BANKSALAD_V1];

  /** 시트 이름만 보고 후보를 고른다. 컬럼 검증은 parse 가 엄격하게 한다. */
  function find(sheetNames) {
    for (var i = 0; i < LAYOUTS.length; i++) {
      if (sheetNames.indexOf(LAYOUTS[i].ledgerSheet) >= 0) return LAYOUTS[i];
    }
    return null;
  }

  return { LAYOUTS: LAYOUTS, BANKSALAD_V1: BANKSALAD_V1, find: find };
})();


// ════════════════════════════════════════════════════════════════════
// core/analyze.js
// ════════════════════════════════════════════════════════════════════

/**
 * 집계 — 산출물이 실어 나를 숫자를 만드는 계층.
 *
 * 여기서 판단은 하지 않는다. "897만원이 문제다" 는 LLM 이 말하고,
 * 우리는 "이체를 본인/타인으로 갈랐더니 타인 쪽 순액이 8,917,889" 를 만든다.
 *
 * ━━ 이 파일의 존재 이유 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 원본 거래 2,456건을 LLM 에 던지면 이체의 비대칭을 못 찾는다.
 * transferBalance.externalNet 을 보여주면 당연히 알아챈다.
 * **무엇을 계산할지 고르는 것**이 우리 몫이고, 해석은 LLM 몫이다.
 *
 * ━━ 여기 있는 함수들은 전부 한 번씩 틀렸었다 ━━━━━━━━━━━━━━━━━
 *
 * 실측 데이터로 검증하면서 잡은 것들. 주석으로 남기는 이유는 되돌아가지
 * 않기 위해서다. 전부 '그럴듯한 값' 이라 눈으로는 안 걸린다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.analyze = (function () {
  'use strict';

  var M = KM.model;
  var DAYS_PER_MONTH = 30.436875; // 그레고리력 평균

  // ── 기본 도구 ──────────────────────────────────────────────────

  function median(nums) {
    if (!nums.length) return 0;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  function monthIndex(ym) {
    return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  }

  function indexToMonth(i) {
    var y = Math.floor(i / 12);
    var m = (i % 12) + 1;
    return y + '-' + (m < 10 ? '0' : '') + m;
  }

  function monthRange(from, to) {
    var out = [];
    for (var i = monthIndex(from); i <= monthIndex(to); i++) out.push(indexToMonth(i));
    return out;
  }

  function dayDiff(from, to) {
    return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  }

  // ── 월별 수지 ──────────────────────────────────────────────────

  /**
   * 월별 수입·지출 순액. 이체는 제외하고 환불은 지출에서 차감한다.
   *
   * ⚠️ **이체만 있는 달은 만들지 않는다.** 예전엔 모든 거래에 대해 월 키를
   *    먼저 만들었는데, 그러면 이체만 오간 달이 '관측된 달' 로 세어져
   *    월평균 지출의 분모를 부풀렸다. 합성 데이터에서 월평균이 4배 과소로
   *    나왔고, 그게 유휴현금 판정을 225만원 틀리게 만들었다.
   */
  function monthlyTotals(txns) {
    var acc = {};
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (t.kind === M.Kind.TRANSFER) continue; // 이체는 월 키조차 만들지 않는다
      var m = M.month(t);
      if (!acc[m]) acc[m] = { month: m, income: 0, expense: 0 };
      acc[m].income += M.inflow(t);
      acc[m].expense += M.outflow(t);
    }
    return Object.keys(acc).sort().map(function (m) {
      var r = acc[m];
      r.net = r.income - r.expense;
      return r;
    });
  }

  function totals(txns) {
    var income = 0, expense = 0;
    for (var i = 0; i < txns.length; i++) {
      income += M.inflow(txns[i]);
      expense += M.outflow(txns[i]);
    }
    return { income: income, expense: expense, net: income - expense };
  }

  /**
   * 월평균 지출.
   *
   * ⚠️ **달 개수로 나누지 않는다.** 뱅샐은 '최근 1년' 을 366일로 끊어 주는데
   *    양끝 달이 잘려 있다. 관측 월이 13개로 세어져 366일을 13으로 나누면
   *    실제(12.02개월)보다 8% 작아진다. 실측에서 이 오차가 비상금 기준선을
   *    377,649원 낮췄고, 그만큼 유휴현금을 부풀렸다.
   *    → 실제 경과 일수를 평균 월 길이로 나눈다.
   */
  function avgMonthlyExpense(txns) {
    var rows = monthlyTotals(txns);
    if (!rows.length) return 0;
    var days = [];
    for (var i = 0; i < txns.length; i++) {
      if (txns[i].kind !== M.Kind.TRANSFER) days.push(txns[i].day);
    }
    days.sort();
    var span = dayDiff(days[0], days[days.length - 1]) / DAYS_PER_MONTH;
    if (span < 1) span = 1; // 한 달 미만은 한 달로 본다 (과대평가 방지)
    var spent = M.sum(rows, function (r) { return r.expense; });
    return Math.round(spent / span);
  }

  // ── 이체 분해 ──────────────────────────────────────────────────

  /**
   * 이체를 '내 계좌끼리' 와 '남과 주고받은 것' 으로 가른다.
   *
   * 내 계좌끼리의 순액은 **0이어야 한다** — 왼손에서 오른손으로 옮긴 돈이니까.
   * 0이 아니면 한쪽 계좌가 연동되지 않아 한 다리만 잡힌 것이다.
   *
   * 남과 주고받은 순액은 **분류되지 않은 현금흐름**이다. 들어왔는데 수입으로
   * 안 세어졌다면 저축률과 목표 도달 시점이 통째로 틀린다.
   *
   * ⚠️ 순액만 보면 안 된다. 남에게 700만 받고 700만 보냈으면 순액은 0이지만
   *    실제로는 1,400만원이 수입에도 지출에도 안 잡힌 상태다. 정산 문화가
   *    활발한 사회 초년생에게 정확히 일어나는 일이라 총액도 같이 낸다.
   */
  function transferBalance(txns, owner) {
    var selfNet = 0, selfCount = 0, maskedCount = 0;
    var extNet = 0, extCount = 0, extIn = 0, extOut = 0;
    var party = {};

    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (t.kind !== M.Kind.TRANSFER) continue;
      var m = M.matchOwner(t.desc, owner);
      if (m.self) {
        selfNet += t.amount;
        selfCount++;
        if (m.masked) maskedCount++;
      } else {
        extNet += t.amount;
        extCount++;
        if (t.amount > 0) extIn += t.amount; else extOut += t.amount;
        if (!party[t.desc]) party[t.desc] = { party: t.desc, net: 0, count: 0 };
        party[t.desc].net += t.amount;
        party[t.desc].count++;
      }
    }

    var list = Object.keys(party).map(function (k) { return party[k]; });
    return {
      selfNet: selfNet,
      selfCount: selfCount,
      // 마스킹된 이름으로 본인 판정된 건수. 동명이인이면 판정이 뒤집힌다.
      selfMatchedByMask: maskedCount,
      externalNet: extNet,
      externalCount: extCount,
      externalIn: extIn,
      externalOut: extOut,
      externalGross: extIn - extOut,
      inflows: list.filter(function (p) { return p.net > 0; })
                   .sort(function (a, b) { return b.net - a.net; }),
      outflows: list.filter(function (p) { return p.net < 0; })
                    .sort(function (a, b) { return a.net - b.net; }),
    };
  }

  // ── 반복 지출 ──────────────────────────────────────────────────

  /**
   * 매달 비슷한 금액으로 빠져나가는 것 — 구독료·월세·보험료.
   *
   * ⚠️ 여기서 두 번 크게 틀렸었다.
   *
   * 1. **연액 = 월평균 × 12** 로 계산했다. 13개월 중 3개월만 나온 항목에도
   *    12를 곱해서, 보고한 연 316만원 중 **209만원(66%)이 존재하지 않는
   *    돈**이었다. 두 달 전 시작한 구독과 이미 해지한 구독이 모두 1년치로
   *    부풀려졌다. → 실제 합계(observedTotal)와 전망치(projectedAnnual)를
   *    분리하고, 전망은 **아직 살아 있는 항목에만** 낸다.
   *
   * 2. 판정을 **(최대−최소)/평균 ≤ 0.15** 로 했다. 두 점만 보는 기준이라
   *    12개월 구독도 가격 인상 한 번이면 탈락했다(실측 3건 미탐). 반대로
   *    미용실 3회 방문(2025-12, 2026-01, 2026-07)은 금액이 같아서 구독으로
   *    채택됐다. → 중앙값 기준 대역 + **발생 밀도**로 바꿨다. 띄엄띄엄이면
   *    반복이 아니다.
   */
  function recurring(txns, opts) {
    opts = opts || {};
    var minMonths = opts.minMonths || 3;
    var band = opts.band || 0.25; // 중앙값 대비 허용 편차
    var minInBand = opts.minInBand || 0.75; // 대역 안에 들어야 하는 달의 비율
    var minDensity = opts.minDensity || 0.7; // 첫 등장~마지막 사이의 발생 밀도
    var activeWithin = opts.activeWithin === undefined ? 1 : opts.activeWithin;

    var rows = monthlyTotals(txns);
    if (!rows.length) return [];
    var lastMonth = rows[rows.length - 1].month;

    var groups = {};
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (t.kind !== M.Kind.EXPENSE) continue;
      var k = M.itemKey(t);
      if (!groups[k]) groups[k] = { key: k, label: t.desc || t.major + '/' + t.minor, per: {} };
      groups[k].per[M.month(t)] = (groups[k].per[M.month(t)] || 0) + M.outflow(t);
    }

    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var months = Object.keys(g.per).filter(function (m) { return g.per[m] > 0; }).sort();
      if (months.length < minMonths) return;

      var amounts = months.map(function (m) { return g.per[m]; });
      var med = median(amounts);
      if (med <= 0) return;

      var inBand = amounts.filter(function (a) {
        return Math.abs(a - med) <= med * band;
      }).length / amounts.length;
      if (inBand < minInBand) return;

      // 띄엄띄엄 발생한 건 반복 지출이 아니라 우연히 금액이 같았던 것이다.
      var span = monthIndex(months[months.length - 1]) - monthIndex(months[0]) + 1;
      var density = months.length / span;
      if (density < minDensity) return;

      var gap = monthIndex(lastMonth) - monthIndex(months[months.length - 1]);
      var active = gap <= activeWithin;

      out.push({
        key: k,
        label: g.label,
        months: months.length,
        firstMonth: months[0],
        lastMonth: months[months.length - 1],
        monthlyMedian: med,
        observedTotal: M.sum(amounts, function (a) { return a; }),
        density: Math.round(density * 100) / 100,
        active: active,
        // 살아 있는 항목만 1년치를 전망한다. 죽은 건 null — 없는 돈이다.
        projectedAnnual: active ? med * 12 : null,
      });
    });

    return out.sort(function (a, b) { return b.monthlyMedian - a.monthlyMedian; });
  }

  // ── 지출 급증 ──────────────────────────────────────────────────

  /**
   * 평소보다 튄 달.
   *
   * 평균이 아니라 **중앙값**을 기준선으로 삼는다. 평균은 튄 달 자신에게
   * 끌려가서 큰 이상치일수록 덜 튀어 보이게 만든다.
   *
   * ⚠️ **지출이 0인 달을 0으로 채운다.** 예전엔 거래가 있는 달만 봤는데,
   *    그러면 안 쓴 달이 통째로 빠져서 기준선이 위로 뜬다(실측 최대 46% 과대).
   *    "평소 안 쓰다가 한 번 크게 썼다" 가 정확히 우리가 찾으려는 모양인데,
   *    그게 가장 안 잡히는 구조였다.
   *
   * ⚠️ 관측이 짧으면 아예 보지 않는다. 다른 달이 3개뿐인 중앙값은 인접한
   *    급증 하나에 통째로 흔들린다.
   */
  function spikes(txns, opts) {
    opts = opts || {};
    var factor = opts.factor || 2.5;
    var floor = opts.floor || 300000;
    var minMonths = opts.minMonths || 6;

    var rows = monthlyTotals(txns);
    if (rows.length < minMonths) return [];
    var allMonths = monthRange(rows[0].month, rows[rows.length - 1].month);
    if (allMonths.length < minMonths) return [];

    var cats = categoryByMonth(txns);

    var out = [];
    Object.keys(cats).forEach(function (cat) {
      var per = cats[cat];
      allMonths.forEach(function (m) {
        var amount = per[m] || 0; // 0채움
        var others = allMonths.filter(function (x) { return x !== m; })
                              .map(function (x) { return per[x] || 0; });
        var base = median(others);
        var excess = amount - base;
        if (excess < floor) return;
        // 기준선이 0 이하면 배수가 의미를 잃는다 (환불이 지출을 넘은 달 등).
        if (base > 0 && amount < base * factor) return;
        out.push({
          category: cat,
          month: m,
          amount: amount,
          baseline: base,
          excess: excess,
          ratio: base > 0 ? Math.round((amount / base) * 10) / 10 : null,
        });
      });
    });

    return out.sort(function (a, b) { return b.excess - a.excess; });
  }

  // ── 카테고리 ───────────────────────────────────────────────────

  function byCategory(txns, kind) {
    kind = kind || M.Kind.EXPENSE;
    var acc = {};
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (t.kind !== kind) continue;
      var v = kind === M.Kind.EXPENSE ? M.outflow(t) : t.amount;
      acc[t.major] = (acc[t.major] || 0) + v;
    }
    return Object.keys(acc)
      .map(function (k) { return { category: k, amount: acc[k] }; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }

  /** 대분류 → { 월: 지출 순액 }. 급증 판정과 월별 추이가 같이 쓴다. */
  function categoryByMonth(txns) {
    var acc = {};
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (t.kind !== M.Kind.EXPENSE) continue;
      if (!acc[t.major]) acc[t.major] = {};
      acc[t.major][M.month(t)] = (acc[t.major][M.month(t)] || 0) + M.outflow(t);
    }
    return acc;
  }

  /**
   * 가맹점별 지출.
   *
   * 카테고리 합계만으로는 "온라인쇼핑 845만원"에서 멈춘다. 무엇을 샀는지는
   * 이 수준까지 내려와야 보이고, 원본 거래 없이는 재구성할 수 없다.
   */
  function byMerchant(txns) {
    var acc = {};
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (t.kind !== M.Kind.EXPENSE || !t.desc) continue;
      if (!acc[t.desc]) acc[t.desc] = { merchant: t.desc, category: t.major, amount: 0, count: 0 };
      acc[t.desc].amount += M.outflow(t);
      acc[t.desc].count++;
    }
    return Object.keys(acc)
      .map(function (k) { return acc[k]; })
      .filter(function (m) { return m.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }

  /**
   * 월 순현금흐름 — **이 파일에서 가장 틀리기 쉬운 값**.
   *
   * 남은 필드로 만들 수 있는 그럴듯한 공식이 여섯 개인데 그중 넷이 부호를
   * 뒤집는다 (실측). 정답은 하나뿐이다:
   *
   *   수입 − 지출 + **남과 오간 이체 순액**
   *
   * 이체를 통째로 빼면 −1,136만원이 나오는데 순자산 1,539만원·부채 0과
   * 앞뒤가 안 맞는다. 통째로 더하면 연동 안 된 내 계좌의 돈을 새 돈으로 센다.
   * **본인 명의 이체 순액은 더하지 않는다** — 순자산을 늘리는 돈이 아니다.
   *
   * 이 한 줄이 우리가 파는 것이다. 산수가 아니라 어떤 식을 쓸지에 대한 판단.
   */
  function pace(txns, owner) {
    var t = totals(txns);
    var tb = transferBalance(txns, owner);
    var rows = monthlyTotals(txns);
    if (!rows.length) return null;

    var days = [];
    for (var i = 0; i < txns.length; i++) {
      if (txns[i].kind !== M.Kind.TRANSFER) days.push(txns[i].day);
    }
    days.sort();
    var months = dayDiff(days[0], days[days.length - 1]) / DAYS_PER_MONTH;
    if (months < 1) months = 1;

    var net = t.income - t.expense + tb.externalNet;
    var spikeExcess = spikes(txns).reduce(function (s, x) { return s + x.excess; }, 0);

    return {
      monthly: Math.round(net / months),
      // 급증을 일회성으로 보면 부호가 뒤집힐 수 있다 (실측 −20만 → +6만).
      // 어느 쪽인지는 데이터가 못 정한다. 그래서 둘 다 싣는다.
      monthlyExSpikes: spikeExcess > 0 ? Math.round((net + spikeExcess) / months) : null,
      observedMonths: Math.round(months * 10) / 10,
    };
  }

  function refunds(txns) {
    var items = txns.filter(M.isRefund);
    return { count: items.length, total: M.sum(items, function (t) { return t.amount; }) };
  }

  return {
    median: median, monthIndex: monthIndex, monthRange: monthRange, dayDiff: dayDiff,
    monthlyTotals: monthlyTotals, totals: totals, avgMonthlyExpense: avgMonthlyExpense,
    transferBalance: transferBalance, recurring: recurring, spikes: spikes,
    byCategory: byCategory, categoryByMonth: categoryByMonth,
    byMerchant: byMerchant, pace: pace, refunds: refunds,
  };
})();


// ════════════════════════════════════════════════════════════════════
// core/parse.js
// ════════════════════════════════════════════════════════════════════

/**
 * 시트 행 → 도메인 객체.
 *
 * 행(rows)은 어댑터가 공급한다. Apps Script 는 SpreadsheetApp 의 getValues(),
 * node 는 테스트 픽스처 JSON. 이 파일은 어디서 왔는지 모른다.
 *
 * ━━ 조용히 틀리느니 시끄럽게 죽는다 ━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 컬럼이 한 칸만 밀려도 금액 자리에서 화폐를 읽는다. 그래도 프로그램은
 * 멀쩡히 돌고 리포트만 틀린다. 그래서 헤더가 다르면 즉시 던진다.
 *
 * ━━ 이 시트에만 있는 함정 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. **합계가 전부 수식이다.** 총자산 =SUM(E40:E71), 순자산 =E72-I72.
 *    뱅샐이 만든 파일은 엑셀을 거친 적이 없어 계산된 값이 없다.
 *    → 합계 셀은 아예 읽지 않는다. 항상 직접 더한다.
 *
 * 2. **그룹명은 그룹의 첫 행에만 적힌다.** ('자유입출금 자산' 아래 계좌 10개)
 *    → 이어받지 않으면 계좌 대부분이 그룹 미상이 된다.
 *
 * 3. **투자성 자산 금액은 실수다** (189044.1941475332). → 원 단위로 반올림.
 *
 * 4. **행 길이가 들쭉날쭉하다.** 메모가 빈 행은 배열이 짧게 온다.
 *    → 직접 인덱싱하지 않고 cell() 로 감싼다.
 *
 * 5. **비원화 거래.** 화폐 컬럼을 읽어놓고 아무도 안 보면 USD 100 이
 *    100원으로 합산된다. → 원화가 아닌 건 따로 모아 집계에서 뺀다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.parse = (function () {
  'use strict';

  var M = KM.model;

  function SchemaMismatch(source, what, expected, actual) {
    var e = new Error(
      '[' + source + '] ' + what + ' 이(가) 예상과 다릅니다.\n' +
      '  예상: ' + JSON.stringify(expected) + '\n' +
      '  실제: ' + JSON.stringify(actual) + '\n' +
      '  → 앱이 내보내기 형식을 바꿨을 수 있습니다. layout.js 에 새 버전을 추가하세요.'
    );
    e.name = 'SchemaMismatch';
    e.detail = { source: source, what: what, expected: expected, actual: actual };
    return e;
  }

  function cell(row, i) {
    return row && i < row.length ? row[i] : null;
  }

  function text(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  /** 셀 → 원 단위 정수. 수식 문자열과 빈 칸은 null. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      var s = v.trim().replace(/,/g, '');
      if (!s || s.charAt(0) === '=') return null; // 수식 — 계산된 값이 없다 (함정 1)
      var n = Number(s);
      return isNaN(n) ? null : Math.round(n);
    }
    if (typeof v === 'number') return Math.round(v); // 실수로 오는 자산이 있다 (함정 3)
    return null;
  }

  /**
   * 날짜처럼 생겼는가.
   *
   * ⚠️ **`instanceof Date` 를 쓰면 안 된다.** 실측에서 이걸로 프로덕션이 깨졌다.
   *
   *    getValues() 가 만든 Date 는 **유저 스크립트 컨텍스트**의 것이고, 이 코드를
   *    라이브러리로 분리하면 **다른 컨텍스트**에서 돈다. instanceof 는 그 경계를
   *    넘지 못해 Date 가 Date 로 인식되지 않는다. 그러면 문자열 분기로 떨어져
   *    "Fri Apr 03 2026 …".slice(0,10) = "Fri Apr 03" 이 날짜가 되고,
   *    month() 가 "Fri Apr" 를 월로 잡아 **84개월짜리 산출물**이 나왔다.
   *    합계는 날짜와 무관해 멀쩡하므로 눈으로는 안 걸린다.
   *
   *    한 프로젝트에 다 넣고 테스트하면 절대 재현되지 않는다. 라이브러리로
   *    나눠야만 드러난다. → **모양으로 판별한다.**
   */
  function isDateLike(v) {
    return !!v && typeof v === 'object' &&
      typeof v.getFullYear === 'function' &&
      typeof v.getMonth === 'function' &&
      typeof v.getDate === 'function';
  }

  /**
   * 날짜 셀 → 'YYYY-MM-DD'.
   * Apps Script 는 Date 객체를, 픽스처 JSON 은 문자열을 준다.
   * UTC 변환을 거치면 하루가 밀 수 있어 로컬 연·월·일을 직접 읽는다.
   */
  function day(v) {
    if (isDateLike(v)) {
      var y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
      return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
    }
    var s = text(v);
    return s ? s.slice(0, 10) : '';
  }

  function findRow(rows, header, what, source) {
    for (var i = 0; i < rows.length; i++) {
      if (text(cell(rows[i], 1)) === header[0] && text(cell(rows[i], 2)) === header[1]) return i;
    }
    throw SchemaMismatch(source, what, header.join(' | ') + ' 헤더 행', '없음');
  }

  // ── 가계부 내역 ────────────────────────────────────────────────

  function ledger(rows, L) {
    if (!rows.length) throw SchemaMismatch(L.id, L.ledgerSheet, '헤더 1행 이상', '빈 시트');

    var header = [];
    for (var h = 0; h < L.ledgerHeader.length; h++) header.push(text(cell(rows[0], h)));
    for (var k = 0; k < L.ledgerHeader.length; k++) {
      if (header[k] !== L.ledgerHeader[k]) {
        throw SchemaMismatch(L.id, "'" + L.ledgerSheet + "' 헤더", L.ledgerHeader, header);
      }
    }

    var C = L.ledgerCols;
    var txns = [], foreign = [], unknown = {};

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var d = day(cell(r, C.day));
      if (!d) continue;

      var rawKind = text(cell(r, C.kind));
      var kind = L.kinds[rawKind];
      if (!kind) { unknown[rawKind] = true; continue; } // 넘겨짚지 않고 모아서 알린다

      var amount = num(cell(r, C.amount));
      if (amount === null) amount = 0;
      var currency = text(cell(r, C.currency)) || M.BASE_CURRENCY;

      var t = {
        day: d, kind: kind,
        major: text(cell(r, C.major)), minor: text(cell(r, C.minor)),
        desc: text(cell(r, C.desc)),
        amount: amount, currency: currency, method: text(cell(r, C.method)),
      };

      // 원화가 아닌 건 원화 합계에 섞지 않는다 (함정 5)
      if (currency !== M.BASE_CURRENCY) foreign.push(t);
      else txns.push(t);
    }

    var unknownKinds = Object.keys(unknown);
    if (unknownKinds.length) {
      throw SchemaMismatch(L.id, '거래 타입', Object.keys(L.kinds), unknownKinds);
    }
    return { txns: txns, foreign: foreign };
  }

  // ── 뱅샐현황 ───────────────────────────────────────────────────

  function profile(rows, L) {
    var r = rows[findRow(rows, L.profileHeader, '고객정보', L.id) + 1];
    var name = text(cell(r, L.profileCols.name));
    if (!name) {
      // 이름이 없으면 '이체 상대가 본인인가' 판정이 불가능하고,
      // 그 판정 위에 데이터 완결성 지표가 서 있다.
      throw SchemaMismatch(L.id, '고객정보의 이름', '계정 주인 이름', '비어 있음');
    }
    return { owner: name, age: num(cell(r, L.profileCols.age)) };
  }

  function balances(rows, L) {
    var C = L.balanceCols;
    var start = findRow(rows, L.balanceHeader, '재무현황', L.id) + 1;
    var holdings = [];
    var assetGroup = '', debtGroup = '';

    for (var i = start; i < rows.length; i++) {
      var r = rows[i];
      var label = text(cell(r, C.assetGroup));
      if (label.indexOf(L.balanceEnd) === 0) break; // 섹션 끝

      if (label) assetGroup = label; // 비어 있으면 위에서 이어받는다 (함정 2)
      var name = text(cell(r, C.assetName));
      var amount = num(cell(r, C.assetAmount));
      if (name && amount !== null) {
        holdings.push({
          bucket: L.buckets[assetGroup] || M.Bucket.OTHER,
          group: assetGroup, name: name, amount: amount,
        });
      }

      var dLabel = text(cell(r, C.debtGroup));
      if (dLabel && dLabel.indexOf(L.debtEnd) !== 0) debtGroup = dLabel;
      var dName = text(cell(r, C.debtName));
      var dAmount = num(cell(r, C.debtAmount));
      if (dName && dAmount !== null) {
        holdings.push({ bucket: M.Bucket.DEBT, group: debtGroup, name: dName, amount: dAmount });
      }
    }

    if (!holdings.length) throw SchemaMismatch(L.id, '재무현황', '자산 1건 이상', '0건');
    return holdings;
  }

  function investments(rows, L) {
    var C = L.investCols;
    var start = findRow(rows, L.investHeader, '투자현황', L.id) + 1;
    var out = [];

    for (var i = start; i < rows.length; i++) {
      var r = rows[i];
      var kind = text(cell(r, C.kind));
      if (kind.indexOf(L.investEnd) === 0) break;
      var name = text(cell(r, C.name));
      var principal = num(cell(r, C.principal));
      var value = num(cell(r, C.value));
      if (!name || principal === null || value === null) continue;
      // 수익률 컬럼은 읽지 않는다 — 원금이 0이면 뱅샐이 0을 넣는데
      // 그건 '본전'이 아니라 '계산 불가'다. model.roi 가 null 로 구분한다.
      out.push({
        kind: kind, broker: text(cell(r, C.broker)), name: name,
        principal: principal, value: value,
      });
    }
    return out;
  }

  /**
   * 전체 파싱. sheets 는 { '시트이름': rows } 형태.
   * 현황 시트는 없어도 된다 (가계부만 내보낸 경우) — 흐름 지표는 그래도 나온다.
   */
  function extract(sheets, L) {
    L = L || KM.layout.find(Object.keys(sheets));
    if (!L) {
      throw SchemaMismatch('unknown', '시트 구성', '알려진 출처의 시트', Object.keys(sheets));
    }

    var led = ledger(sheets[L.ledgerSheet] || [], L);
    var snapshot = null;
    var statusRows = sheets[L.statusSheet];
    if (statusRows && statusRows.length) {
      var p = profile(statusRows, L);
      snapshot = {
        owner: p.owner, age: p.age,
        holdings: balances(statusRows, L),
        investments: investments(statusRows, L),
      };
    }

    return {
      source: L.id + '/' + L.version,
      txns: led.txns,
      foreign: led.foreign,
      snapshot: snapshot,
    };
  }

  return {
    extract: extract, ledger: ledger, profile: profile,
    balances: balances, investments: investments,
    cell: cell, text: text, num: num, day: day, isDateLike: isDateLike,
    SchemaMismatch: SchemaMismatch,
  };
})();


// ════════════════════════════════════════════════════════════════════
// core/profile.js
// ════════════════════════════════════════════════════════════════════

/**
 * 유저 컨텍스트 — 대화로 쌓이는 것.
 *
 * `Drive/k-money/profile.json`. **LLM이 대화 중에 쓴다.** 유저가 JSON을
 * 손으로 고치는 일은 없어야 한다 — 타겟이 사회 초년생이다.
 *
 * ━━ 진술은 관측을 이기지 않는다 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 유저가 "나 월 180 벌어"라고 말해도 그게 기록을 덮어쓰지 않는다.
 *
 *   기록이 믿을 만하다        → 기록을 쓴다
 *   기록이 못 미덥다          → 진술을 쓰되 **출처를 밝힌다**
 *   둘이 크게 다르다          → 둘 다 보여주고 묻는다
 *
 * 이 규칙이 LLM 환각에 대한 방어이기도 하다. 진술값에는 항상 꼬리표가 붙으므로,
 * 잘못 기록된 값이 리포트에 조용히 섞이지 않는다.
 *
 * ━━ 모든 값에 출처와 시점을 남긴다 ━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 연봉이 오르면 갱신해야 하는데, 언제 들은 말인지 모르면 갱신할 시점을 모른다.
 * 그래서 { value, source, at } 꼴을 쓴다. 맨값도 받아주되 정규화한다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.profile = (function () {
  'use strict';

  var SCHEMA = 'k-money/profile@1';

  function defaults() {
    return {
      schema: SCHEMA,
      goals: [],
      assumptions: {},
    };
  }

  /** { value, source, at } 꼴로 통일한다. 맨값이 와도 받아준다. */
  function entry(v, source, at) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && 'value' in v) {
      return { value: v.value, source: v.source || 'unknown', at: v.at || null };
    }
    return { value: v, source: source || 'unknown', at: at || null };
  }

  function valueOf(e, fallback) {
    return e && e.value !== null && e.value !== undefined ? e.value : fallback;
  }

  /**
   * 읽은 JSON을 안전한 모양으로. 깨졌거나 없으면 기본값으로 돌아간다.
   * 여기서 던지면 안 된다 — 프로필이 없다고 리포트 전체가 멈추면 안 되기 때문이다.
   */
  function normalize(raw) {
    var p = defaults();
    if (!raw || typeof raw !== 'object') return p;

    if (Array.isArray(raw.goals)) {
      p.goals = raw.goals
        .filter(function (g) { return g && typeof g.amount === 'number' && g.amount > 0; })
        .map(function (g) {
          return {
            id: String(g.id || g.label || 'goal'),
            label: String(g.label || g.id || '목표'),
            // 목표를 숫자로 바꾸는 건 **우리 일이 아니다.**
            // "전세 구하고 싶어", "20대 남성 상위 10%" 같은 건 바깥 지식과 해석이
            // 필요하고, 그건 LLM 이 잘하고 우리가 못한다. 우리는 숫자를 받아 산수만 한다.
            amount: Math.round(g.amount),
            // 유저가 직접 말한 숫자인지, LLM 이 대신 추정한 숫자인지 구분한다.
            // 추정이면 LLM 이 "1.5억으로 잡았는데 맞나요?" 라고 되물어야 한다.
            estimated: !!g.estimated,
            by: g.by || null, // 'YYYY-MM'. 없어도 된다 — 시점 없는 목표도 목표다
            byIsDefault: !!g.byIsDefault,
            source: g.source || 'unknown',
            at: g.at || null,
          };
        });
    }

    var a = raw.assumptions || {};
    ['monthlyIncome', 'monthlyExpense', 'annualReturn'].forEach(function (k) {
      var e = entry(a[k]);
      if (e && typeof e.value === 'number' && isFinite(e.value)) p.assumptions[k] = e;
    });

    return p;
  }

  /** 유저가 말한 값. 없으면 null. */
  function stated(profile, key) {
    return valueOf(profile.assumptions[key], null);
  }

  return {
    SCHEMA: SCHEMA,
    defaults: defaults, normalize: normalize, entry: entry, valueOf: valueOf,
    stated: stated,
  };
})();


// ════════════════════════════════════════════════════════════════════
// core/aggregate.js
// ════════════════════════════════════════════════════════════════════

/**
 * 산출물 조립 — Drive 에 올라가고 LLM 이 읽을 JSON.
 *
 * ━━ 무엇을 넣고 무엇을 뺄지 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * **우리가 파는 건 산수가 아니라 "어떤 식을 쓸지"다.**
 *
 *   식이 하나뿐이면            → 넣지 않는다. LLM 이 한다
 *   식이 여럿이고 하나만 맞으면 → 넣는다. 우리가 계산한다
 *   원본을 훑어야 나오면        → 넣는다. LLM 이 할 수 없다
 *   상수를 우리가 골랐으면      → 넣지 않는다. 그건 판단이지 집계가 아니다
 *
 * 실측 근거: `pace` 를 빼면 남은 필드로 만들 수 있는 그럴듯한 공식이 여섯 개인데
 * **그중 넷이 부호를 뒤집는다.** 프런티어 모델은 나눗셈을 안 틀린다 — 틀리는 건
 * 식의 선택이다. 그게 이 파일의 존재 이유다.
 *
 * 한때 여기에 goalTable(우리가 5천만·1억·2억을 고름), levers(레버 4종과 10%·20%를
 * 고름), suggestedHorizons(30·35·40세를 고름), 복리 계산이 있었다. 전부 뺐다.
 * 유저 질문 25개를 역산했을 때 **그것들이 필요한 질문이 하나도 없었다.**
 *
 * ━━ 절단은 반드시 밝힌다 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 목록을 자르면서 말을 안 하면, 합계를 검산한 LLM 이 안 맞는 걸 보고
 * 데이터를 못 믿거나 없는 사실을 지어낸다. 실측에서 카테고리 246,450원,
 * 계좌 45,629원, 이체 상대 3,050,875원이 말없이 사라지고 있었다.
 *
 * ━━ 커넥터 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * JSON 은 읽힌다. 갓 만든 파일이 몇 분간 비어 보일 뿐이다(크기·MIME 무관).
 * 다만 마크다운 특수문자가 이스케이프되므로 식별자에 밑줄을 쓰지 않는다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.aggregate = (function () {
  'use strict';

  var M = KM.model;
  var A = KM.analyze;

  var SCHEMA = 'k-money/facts@2';
  var LIMITS = { parties: 8, spikes: 5, recurring: 12, categories: 12, merchants: 12, accounts: 15, debts: 10, matrixCategories: 8 };

  // 이 아래면 보고하지 않는다. **지출** 기준인 것이 중요하다 — 지금 문제가
  // '수입이 덜 잡힌다' 인데 그 수입으로 문턱을 잡으면 결함이 자기 탐지 문턱을
  // 같이 낮추는 순환이 된다.
  function materialFloor(flow) {
    return Math.max(Math.round(flow.expense * 0.05), 200000);
  }

  function build(extract, opts) {
    opts = opts || {};
    var txns = extract.txns;
    var snap = extract.snapshot;
    var owner = snap ? snap.owner : null;

    var flow = A.totals(txns);
    var monthly = withPartialFlags(A.monthlyTotals(txns), txns);
    var tb = A.transferBalance(txns, owner);
    var material = materialFloor(flow);

    var out = {
      schema: SCHEMA,
      source: extract.source,
      generatedFor: opts.asOf || (monthly.length ? monthly[monthly.length - 1].month : null),
      period: period(txns),

      flow: {
        income: flow.income,
        expense: flow.expense,
        net: flow.net,
        avgMonthlyExpense: A.avgMonthlyExpense(txns),
        monthly: monthly,
      },

      // 이 파일에서 가장 틀리기 쉬운 값. analyze.pace 주석 참조.
      pace: A.pace(txns, owner),

      // 이체는 '내 계좌 간 이동'이라 self.net 은 0에 가까워야 정상이다.
      transfers: transferBlock(tb),

      categories: capped(A.byCategory(txns), LIMITS.categories, 'amount', flow.expense),
      merchants: capped(A.byMerchant(txns), LIMITS.merchants, 'amount', flow.expense),
      categoryMonthly: matrix(txns, monthly),
      refunds: A.refunds(txns),
      recurring: recurringBlock(txns),
      spikes: A.spikes(txns).filter(function (s) { return s.excess >= material; })
                            .slice(0, LIMITS.spikes),
    };

    if (snap) {
      out.balance = balanceBlock(snap);
      out.cash = cashBlock(snap, out.flow.avgMonthlyExpense);
      out.investments = investmentBlock(snap);
      if (snap.age) out.snapshotAge = snap.age;
    }

    // 유저가 대화로 쌓은 것. **계산하지 않고 그대로 실어 나른다** —
    // 목표를 숫자로 바꾸는 건 LLM 일이고, 우리는 세션 사이를 잇는 역할만 한다.
    var profile = KM.profile.normalize(opts.profile);
    if (profile.goals.length || Object.keys(profile.assumptions).length) {
      out.profile = { goals: profile.goals, assumptions: profile.assumptions };
    }

    out.dataQuality = quality(tb, extract, material);

    // 못 믿을 값은 키를 만들지 않는다. null 이면 인용되고, 없으면 인용될 수 없다.
    if (flow.income > 0 && Math.abs(tb.externalGross) < flow.income * 0.05) {
      out.flow.savingsRate = Math.round((flow.net / flow.income) * 1000) / 1000;
    } else {
      out.flow.savingsRateOmitted = 'unclassifiedTransfers';
    }

    out.hints = HINTS;
    return out;
  }

  function period(txns) {
    if (!txns.length) return null;
    var days = txns.map(function (t) { return t.day; }).sort();
    var from = days[0], to = days[days.length - 1];
    return { from: from, to: to, days: A.dayDiff(from, to) };
  }

  /**
   * 양끝 달은 대개 잘려 있다. 실측에서 2026-08 이 **8일치 655,250원**인데
   * 표시가 없어 "이번 달 아껴 썼네" 로 읽힐 수 있었다. 한 줄로 막는다.
   */
  function withPartialFlags(rows, txns) {
    if (!rows.length) return rows;
    var days = txns.filter(function (t) { return t.kind !== M.Kind.TRANSFER; })
                   .map(function (t) { return t.day; }).sort();
    var from = days[0], to = days[days.length - 1];
    var lastDay = new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0).getDate();

    if (from.slice(8) !== '01') rows[0].partial = true;
    if (Number(to.slice(8)) < lastDay) {
      rows[rows.length - 1].partial = true;
      rows[rows.length - 1].daysObserved = Number(to.slice(8));
    }
    return rows;
  }

  /**
   * 목록을 자르되 **잘라낸 총액을 반드시 밝힌다.**
   *
   * ⚠️ otherTotal 은 "나머지의 합" 이 아니라 **"전체에서 빠진 만큼"** 이다.
   *    합으로 정의하면 목록 만드는 쪽에 필터가 하나만 끼어도 검산이 깨진다.
   *    실측: byMerchant 가 순액 음수(전액 환불된 가맹점)를 걸러서
   *    merchants 합이 지출을 12,690원 넘었다. 빼기로 정의하면 구조적으로 안 깨진다.
   */
  function capped(list, limit, amountField, total) {
    var head = list.slice(0, limit);
    var shown = M.sum(head, function (x) { return x[amountField]; });
    var out = { items: head };
    if (list.length > limit || shown !== total) {
      out.otherCount = Math.max(0, list.length - limit);
      out.otherTotal = total - shown;
    }
    return out;
  }

  function transferBlock(tb) {
    var inRest = tb.inflows.slice(LIMITS.parties);
    var outRest = tb.outflows.slice(LIMITS.parties);
    var block = {
      self: { net: tb.selfNet, count: tb.selfCount, matchedByMaskedName: tb.selfMatchedByMask },
      external: {
        net: tb.externalNet,
        // 순액이 0이어도 총액은 클 수 있다. 700만 받고 700만 보내면 순액 0이지만
        // 1,400만원이 수입에도 지출에도 안 잡힌 상태다.
        gross: tb.externalGross,
        in: tb.externalIn,
        out: tb.externalOut,
        count: tb.externalCount,
        topInflows: tb.inflows.slice(0, LIMITS.parties),
        topOutflows: tb.outflows.slice(0, LIMITS.parties),
      },
    };
    if (inRest.length || outRest.length) {
      block.external.other = {
        inflowsCount: inRest.length,
        inflowsTotal: M.sum(inRest, function (p) { return p.net; }),
        outflowsCount: outRest.length,
        outflowsTotal: M.sum(outRest, function (p) { return p.net; }),
      };
    }
    return block;
  }

  /**
   * 카테고리 × 월 교차.
   *
   * 이게 없으면 "이번 달 왜 많이 썼어?" 에 답할 수 없다. 카테고리는 연간 합계뿐,
   * 월별은 총액뿐이라 범인을 못 짚는다. 제품이 약속한 문제의 절반이 여기 걸려 있다.
   */
  function matrix(txns, monthly) {
    if (!monthly.length) return null;
    var months = monthly.map(function (r) { return r.month; });
    var per = A.categoryByMonth(txns);
    var top = A.byCategory(txns).slice(0, LIMITS.matrixCategories);
    return {
      months: months,
      rows: top.map(function (c) {
        return {
          category: c.category,
          // 거래가 없는 달은 0이다 — '없음' 이 아니라 '안 썼음' 이다
          amounts: months.map(function (m) { return per[c.category][m] || 0; }),
        };
      }),
    };
  }

  function recurringBlock(txns) {
    var items = A.recurring(txns);
    var active = items.filter(function (r) { return r.active; });
    return {
      // active 로 거르는 것이 함정이다 (끝난 구독까지 세면 실측 66%가 허수였다).
      // 그래서 이 합계만 우리가 낸다. 연환산은 ×12 라 LLM 이 한다.
      activeMonthlyTotal: M.sum(active, function (r) { return r.monthlyMedian; }),
      activeCount: active.length,
      inactiveCount: items.length - active.length,
      // ⚠️ label 이 실려야 한다. 금액이 일정하면 월세도 식비도 여기 잡히는데,
      //    총액만 주면 "고정지출 전액 끊으면 15년 빨라져" 같은 답이 나온다
      //    (실측 재현: 진짜 구독만이면 11개월. 179개월 차이).
      items: items.slice(0, LIMITS.recurring).map(function (r) {
        return {
          label: r.label, months: r.months,
          firstMonth: r.firstMonth, lastMonth: r.lastMonth,
          monthlyMedian: r.monthlyMedian, observedTotal: r.observedTotal,
          active: r.active,
        };
      }),
    };
  }

  function balanceBlock(snap) {
    var buckets = {};
    Object.keys(M.Bucket).forEach(function (k) {
      var b = M.Bucket[k];
      if (b === M.Bucket.DEBT) return;
      var v = M.bucketTotal(snap, b);
      if (v) buckets[b] = v;
    });
    var all = M.assets(snap).slice().sort(function (a, b) { return b.amount - a.amount; });
    var head = all.slice(0, LIMITS.accounts);
    var shown = M.sum(head, function (h) { return h.amount; });
    var total = M.totalAssets(snap);
    var out = {
      netWorth: M.netWorth(snap),
      totalDebt: M.totalDebt(snap),
      buckets: buckets,
      accounts: head.map(function (h) {
        return { bucket: h.bucket, name: h.name, amount: h.amount };
      }),
    };
    if (all.length > LIMITS.accounts || shown !== total) {
      out.otherAccountsCount = Math.max(0, all.length - LIMITS.accounts);
      out.otherAccountsTotal = total - shown; // 합이 아니라 빠진 만큼
    }

    // ── 부채도 **개별로** 내보낸다 ────────────────────────────────
    //
    // 전에는 totalDebt 합계 하나뿐이었다. 그러면 "빚이 1,200만원" 까지만
    // 말할 수 있고 "학자금대출이 얼마, 전세대출이 얼마" 는 못 한다.
    // 사회 초년생에게 학자금·전세대출은 기본값에 가까운데, 그 사람은
    // 자기 상황을 대화에 올릴 수가 없었다.
    //
    // 갚는 순서나 방법은 여기서 정하지 않는다 — 금리·상환조건에 달렸고
    // 그건 우리가 가진 데이터에 없다. **무엇이 얼마인지까지만** 준다.
    var debts = M.debts(snap).slice().sort(function (a, b) { return b.amount - a.amount; });
    if (debts.length) {
      var shownDebts = debts.slice(0, LIMITS.debts);
      out.debts = shownDebts.map(function (h) {
        return { group: h.group, name: h.name, amount: h.amount };
      });
      var shownDebtTotal = M.sum(shownDebts, function (h) { return h.amount; });
      if (debts.length > LIMITS.debts) {
        out.otherDebtsCount = debts.length - LIMITS.debts;
        out.otherDebtsTotal = out.totalDebt - shownDebtTotal;
      }
    }
    return out;
  }

  function cashBlock(snap, avgExpense) {
    // 비상금을 몇 개월치로 볼지는 고용 형태에 따라 다르다. 우리가 고를 값이 아니다.
    // total 과 monthsOfExpense 만 주면 어떤 배수든 LLM 이 계산한다.
    var total = M.bucketTotal(snap, M.Bucket.CASH);
    return {
      total: total,
      monthsOfExpense: avgExpense > 0 ? Math.round((total / avgExpense) * 10) / 10 : null,
    };
  }

  /**
   * 투자.
   *
   * ⚠️ 두 시트가 다르다. '투자성 자산'(재무현황)에는 CMA 처럼 원금 정보가 없는
   *    계좌가 있고 '투자현황'에는 없다. 한쪽 합계에 다른 쪽 이름을 붙이면
   *    실측 130,385원이 조용히 증발한다. **그 분리가 이 블록의 값어치다** —
   *    합계·수익률은 holdings 로 LLM 이 계산한다.
   */
  function investmentBlock(snap) {
    var priced = snap.investments.filter(function (i) { return i.principal > 0; });
    var value = M.sum(priced, function (i) { return i.value; });
    var bucket = M.bucketTotal(snap, M.Bucket.INVESTMENT);
    return {
      bucketTotal: bucket,
      unpricedValue: bucket - value,
      unpricedNote: 'CMA·예수금 등 원금 정보가 없어 수익률 계산에서 제외해야 하는 금액',
      holdings: priced.map(function (i) {
        return { name: i.name, broker: i.broker, principal: i.principal, value: i.value };
      }).sort(function (a, b) {
        return (a.value - a.principal) / a.principal - (b.value - b.principal) / b.principal;
      }),
    };
  }

  function quality(tb, extract, material) {
    var flags = [];
    if (Math.abs(tb.externalGross) >= material) {
      flags.push({
        code: 'unclassifiedExternalTransfers',
        note: '이체로 분류됐지만 본인 계좌가 아닌 곳과 오간 금액. transfers.external 참조',
      });
    }
    if (Math.abs(tb.selfNet) >= material) {
      flags.push({
        code: 'selfTransferImbalance',
        note: '본인 계좌 간 이체 순액이 0이 아니다. 연동 안 된 계좌가 있다',
      });
    }
    if (tb.selfMatchedByMask > 0) {
      flags.push({
        code: 'ownerMatchedByMaskedName',
        note: '가려진 이름으로 본인 판정된 건이 있다. 동명이인이면 본인/타인 구분이 뒤집힌다',
      });
    }
    if (extract.foreign && extract.foreign.length) {
      flags.push({ code: 'foreignCurrencyExcluded', count: extract.foreign.length,
                   note: '원화가 아닌 거래는 합계에서 제외했다' });
    }
    if (!extract.snapshot) {
      flags.push({ code: 'noBalanceSheet', note: '자산 현황이 없어 잔고 지표를 낼 수 없다' });
    }
    return { material: material, materialNote: '지출의 5%. 이 미만은 보고하지 않았다', flags: flags };
  }

  /** 필드의 뜻과 계산 규약만 적는다. 결론은 적지 않는다. */
  var HINTS = {
    signs: '금액은 내 지갑 기준이다. 들어오면 +, 나가면 −. expense 합계는 이미 부호를 뒤집고 환불을 차감한 순액이다.',
    transfers: '이체는 수입에도 지출에도 포함되지 않는다. 본인 계좌 간 이동이므로 self.net 은 0에 가까워야 한다.',
    pace: 'pace.monthly = (수입 − 지출 + 남과 오간 이체 순액) ÷ 관측개월. 본인 계좌 간 이체 순액은 더하지 않는다 — 새로 생긴 돈이 아니다. 이 값을 직접 다시 유도하지 마라.',
    derived: '합계·차액·비율·연환산은 여기 있는 숫자로 계산해 써라. 다만 pace 와 avgMonthlyExpense 는 이미 보정된 값이니 그대로 쓴다.',
    truncation: 'otherTotal·otherAccountsTotal·external.other 는 목록에서 잘려나간 나머지다. 합계를 검산할 때 같이 더해라.',
    recurring: 'recurring 은 금액이 일정한 모든 지출을 잡는다 — 월세·식비도 들어간다. items 의 label 을 보고 구독과 생활비를 구분해라.',
    goals: '유저가 목표를 말하지 않았다면 5천만원·1억 같은 금액을 예시로 먼저 제시해 보라. 목표 금액을 정하는 건 유저와 너의 일이고, 정해지면 profile.goals 에 적어 두면 다음에도 이어진다.',
    scope: '이 도구는 사실·계산·비교까지만 한다. 상품 추천이나 매매 판단은 하지 않는다.',
    currency: 'KRW. 원 단위 정수.',
  };

  /**
   * 이전 산출물과의 차이. 대화 한 세션은 지난 스냅샷을 볼 수 없고,
   * **뱅샐은 최근 1년치만 주므로 우리가 안 쌓으면 영구히 사라진다.**
   */
  function delta(current, previous) {
    if (!previous) return null;
    var d = { since: previous.generatedFor };
    if (current.balance && previous.balance) {
      d.netWorth = current.balance.netWorth - previous.balance.netWorth;
    }
    if (current.cash && previous.cash) d.cash = current.cash.total - previous.cash.total;
    if (current.flow && previous.flow) {
      d.avgMonthlyExpense = current.flow.avgMonthlyExpense - previous.flow.avgMonthlyExpense;
    }
    if (current.recurring && previous.recurring) {
      var was = {};
      previous.recurring.items.forEach(function (r) { was[r.label] = true; });
      d.newRecurring = current.recurring.items
        .filter(function (r) { return r.active && !was[r.label]; })
        .map(function (r) { return { label: r.label, monthlyMedian: r.monthlyMedian }; });
    }
    return d;
  }

  return { build: build, delta: delta, SCHEMA: SCHEMA, LIMITS: LIMITS };
})();
