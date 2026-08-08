/**
 * ⚠️ 자동 생성 파일 — 직접 고치지 마라.
 *
 *   생성: node scripts/build-gs.js
 *   원본: core/model.js, core/layout.js, core/analyze.js, core/parse.js, core/aggregate.js
 *
 * 고칠 일이 있으면 core/ 를 고치고 다시 생성하라. 여기서 고치면
 * 다음 생성 때 조용히 덮어써진다.
 *
 * 이 파일은 node 로 검증한 것과 **같은 코드**다. 포팅이 없으므로
 * 로컬에서 맞은 계산은 여기서도 맞는다.
 */

var KM = (globalThis.KM = globalThis.KM || {});
KM.VERSION = '0.4.0';

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
  // 표시 문구를 고치는 순간 와이어 계약이 깨진다. 화면에 뭐라고 쓸지는 LLM 몫이다.
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
    // 뱅샐이 적요에 존칭을 붙이는 경우가 있다. '홍길동님' 은 길이가 하나 길어
    // 본인 판정에서 빠지고, 그러면 본인 이체가 남과의 이체로 잡혀
    // pace 에 없는 돈으로 더해진다. 접미사만 떼고 원본도 함께 본다.
    // '홍길동님전자' 처럼 뒤에 더 붙은 건 떼도 길이가 안 맞아 여전히 걸러진다.
    // ⚠️ **원본을 전부 먼저 본 뒤에 접미사를 뗀 것을 본다.** 섞어 넣으면
    //    '홍*동님 홍길동' 에서 가려진 쪽이 먼저 걸려 masked 가 켜지고,
    //    '동명이인일 수 있다' 플래그가 헛되이 선다.
    var candidates = tokens.slice();
    for (var t = 0; t < tokens.length; t++) {
      var stripped = tokens[t].replace(/(님|씨)$/, '');
      if (stripped !== tokens[t] && stripped) candidates.push(stripped);
    }
    for (var i = 0; i < candidates.length; i++) {
      var tok = candidates[i];
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


  return {
    Kind: Kind, Bucket: Bucket, BASE_CURRENCY: BASE_CURRENCY,
    outflow: outflow, inflow: inflow, isRefund: isRefund, month: month,
    itemKey: itemKey, matchOwner: matchOwner,
    assets: assets, debts: debts, totalAssets: totalAssets, totalDebt: totalDebt,
    netWorth: netWorth, inBucket: inBucket, bucketTotal: bucketTotal,
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

    var seen = Object.keys(acc).sort();
    if (!seen.length) return [];

    // ⚠️ **중간의 빈 달을 만들어 넣는다.** 예전엔 거래가 하나도 없는 달이
    //    목록에서 통째로 사라졌다. 그러면 "3월에 얼마 썼어?" 에 답할 수가
    //    없고, 월 배열을 눈으로 훑는 소비자는 2월 다음이 4월인 걸 못 본다.
    //    같은 데이터를 보는 spikes 는 이미 0채움을 하고 있어서, **한 산출물
    //    안에서 3월의 존재 여부가 두 갈래**였다.
    //
    //    양끝은 늘리지 않는다. 관측이 시작되기 전과 끝난 뒤는 '안 썼다' 가
    //    아니라 '모른다' 다.
    // ⚠️ **긴 공백은 채우지 않는다.** 2019년에 쓰다 그만두고 2026년에
    //    다시 시작한 사람은 채우면 92행이 되고 산출물이 커넥터 한도를
    //    넘는다 (실측 12,831 bytes, 그중 78행이 채운 것). 한두 달 빈
    //    것과 몇 년 쉰 것은 다른 얘기다.
    var out = [];
    for (var k = 0; k < seen.length; k++) {
      var cur = seen[k];
      if (k > 0) {
        var gap = monthRange(seen[k - 1], cur);
        gap = gap.slice(1, gap.length - 1);   // 양끝은 실제 달
        if (gap.length <= MAX_GAP_FILL) {
          for (var g = 0; g < gap.length; g++) {
            // 진짜 0 과 구분한다. 소비자가 "이 달은 왜 0이지" 를 물을 수 있어야 한다.
            out.push({ month: gap[g], income: 0, expense: 0, net: 0, noTransactions: true });
          }
        }
      }
      var r = acc[cur];
      r.net = r.income - r.expense;
      out.push(r);
    }
    return out;
  }

  /** 이보다 긴 공백은 채우는 대신 flow.gaps 로 알린다. */
  var MAX_GAP_FILL = 2;

  /** 채우지 않고 건너뛴 구간. 소비자가 '없는 달' 을 눈치채야 한다. */
  function monthGaps(rows) {
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var span = monthRange(rows[i - 1].month, rows[i].month);
      if (span.length > 2) {
        out.push({ from: span[1], to: span[span.length - 2], months: span.length - 2 });
      }
    }
    return out;
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
   * ⚠️ **달 개수로 나누지 않는다.** 뱅샐이 끊어 주는 구간은 **양끝 달이 잘려
   *    있다** (실측 366일 = 13개 달에 걸침). 366일을 13으로 나누면
   *    실제(12.02개월)보다 8% 작아진다. 실측에서 이 오차가 비상금 기준선을
   *    377,649원 낮췄고, 그만큼 유휴현금을 부풀렸다.
   *    → 실제 경과 일수를 평균 월 길이로 나눈다.
   */
  function avgMonthlyExpense(txns) {
    var rows = monthlyTotals(txns);
    if (!rows.length) return 0;
    var spent = M.sum(rows, function (r) { return r.expense; });
    return Math.round(spent / observedMonths(txns));
  }

  /**
   * 실제 관측 개월. **이 규칙이 두 군데에 복사돼 있었다** — avgMonthlyExpense 와
   * pace 가 각자 계산했고, 한쪽에서 `span < 1` 보정을 지워도 아무 테스트도
   * 깨지지 않았다. 둘이 어긋나면 같은 문서 안의 두 숫자가 다른 분모를 쓴다.
   *
   * 이체만 있는 날은 세지 않는다 — 흐름을 관측한 기간이 아니다.
   */
  function observedMonths(txns) {
    var days = [];
    for (var i = 0; i < txns.length; i++) {
      if (txns[i].kind !== M.Kind.TRANSFER) days.push(txns[i].day);
    }
    if (!days.length) return 1;
    days.sort();
    var span = dayDiff(days[0], days[days.length - 1]) / DAYS_PER_MONTH;
    return span < 1 ? 1 : span; // 한 달 미만은 한 달로 본다 (과대평가 방지)
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
        if (!party[t.desc]) party[t.desc] = { party: t.desc, net: 0, gross: 0, count: 0 };
        party[t.desc].net += t.amount;
        // ⚠️ 총액도 센다. 순액만으로 줄을 세우면 **받은 만큼 보낸 상대가
        //    양쪽 목록에서 다 사라진다.** 700만 받고 700만 보낸 사람은
        //    net === 0 이라 inflows(>0) 에도 outflows(<0) 에도 안 들어가서,
        //    1,400만원이 오간 상대의 이름이 아무 데도 안 남았다.
        //    그 상황을 드러내려고 만든 코드에서 정작 이름이 사라졌다.
        party[t.desc].gross += Math.abs(t.amount);
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
      // net === 0 인 상대는 inflows 쪽에 둔다. 어느 쪽도 아니면 사라지는데,
      // 사라지는 게 하필 '많이 오갔는데 순액이 0인' — 제일 알려야 할 상대다.
      // 같은 순액이면 총액이 큰 쪽을 앞에 둔다.
      inflows: list.filter(function (p) { return p.net >= 0; })
                   .sort(function (a, b) { return (b.net - a.net) || (b.gross - a.gross); }),
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
   *    돈**이었다. 두 달 전 시작한 구독과 이미 해지한 구독이 모두 연간치로
   *    부풀려졌다. → **전망을 아예 내지 않는다.** 실제로 나간 돈
   *    (observedTotal)과 '아직 살아 있나'(active) 만 낸다. ×12 는 LLM 이
   *    한다 — 우리가 하면 죽은 구독까지 연간치로 세게 된다.
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
    // ⚠️ **채운 달은 세지 않는다.** 0채움이 들어온 뒤로 rows.length 는 늘
    //    전체 개월과 같아져서 이 가드가 죽어 있었다. 실측: 관측 3개월짜리에
    //    급증이 잡혀 baseline 0 · ratio null 이 나갔다.
    var realMonths = 0;
    for (var rm = 0; rm < rows.length; rm++) if (!rows[rm].noTransactions) realMonths++;
    if (realMonths < minMonths) return [];
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
  function pace(txns, owner, reportedSpikes) {
    var t = totals(txns);
    var tb = transferBalance(txns, owner);
    var rows = monthlyTotals(txns);
    if (!rows.length) return null;

    var months = observedMonths(txns);
    var net = t.income - t.expense + tb.externalNet;

    // ⚠️ **밖에서 보고한 급증만 되돌린다.**
    //    예전에는 여기서 spikes(txns) 를 다시, 필터도 상한도 없이 불렀다.
    //    그러면 monthlyExSpikes 와 spikes 배열이 서로 다른 집합을 가리켜서,
    //    두 숫자의 차이가 보이는 급증 합계와 안 맞는다. 소비자(LLM)는
    //    검산을 못 하고, 못 한다는 사실조차 모른다.
    var visible = reportedSpikes || [];
    var spikeExcess = visible.reduce(function (s, x) { return s + x.excess; }, 0);

    return {
      monthly: Math.round(net / months),
      // 급증을 일회성으로 보면 부호가 뒤집힐 수 있다 (실측 −20만 → +6만).
      // 어느 쪽인지는 데이터가 못 정한다. 그래서 둘 다 싣는다.
      monthlyExSpikes: spikeExcess > 0 ? Math.round((net + spikeExcess) / months) : null,
      // 남과 오간 이체를 통째로 '내 계좌였다' 로 보면 얼마인가.
      // 이체가 미분류일 때 위쪽 값 대신 내보낸다 — 한쪽 끝이 아니라 폭을 준다.
      monthlyExcludingExternal: Math.round((t.income - t.expense) / months),
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
    observedMonths: observedMonths, monthGaps: monthGaps,
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

  // ⚠️ **이름은 통용되는 AGENT.md 를 그대로 둔다.** 한때 '돈동생-AI안내.md'
  //    로 바꾸려 했다 — 파일명에 유저 어휘가 없어 커넥터 검색에 안 걸린다는
  //    이유였는데, **실측해 보니 틀렸다.**
  //
  //        title contains '돈동생'     → AGENT.md 안 나옴
  //        fullText contains '돈동생'  → AGENT.md **나옴**
  //
  //    커넥터는 내용도 검색한다. 안내문 첫 줄에 '돈동생 · 가계부 · 기억' 이
  //    들어 있으면 이름이 영어여도 찾힌다. 그러니 이름을 바꿔 얻을 게 없고,
  //    통용 규약을 버리는 값과 이미 깔린 파일을 옮기는 값만 남는다.
  //    app.gs 의 CFG.agentName 과 **같아야 한다** (테스트가 강제한다).
  var AGENT_FILE = 'AGENT.md';
  var LIMITS = { parties: 8, spikes: 5, recurring: 12, categories: 12, merchants: 12, accounts: 15, debts: 10, matrixCategories: 8 };

  // 이 아래면 보고하지 않는다. **지출** 기준인 것이 중요하다 — 지금 문제가
  // '수입이 덜 잡힌다' 인데 그 수입으로 문턱을 잡으면 결함이 자기 탐지 문턱을
  // 같이 낮추는 순환이 된다.
  // 이보다 짧으면 월 단위로 환산하지 않는다. 며칠치를 월로 늘리면 그 오차가
  // 그대로 '비상금 35개월치' 같은 문장이 된다.
  var MIN_MONTHS = 2;

  /**
   * 급증을 문턱으로 거르고 상한을 씌우되, **가려진 만큼을 함께 돌려준다.**
   * 그냥 자르면 pace.monthlyExSpikes 와의 차이를 아무도 검산할 수 없다.
   */
  function cutSpikes(all, material) {
    var material_ = all.filter(function (s) { return s.excess >= material; });
    var shown = material_.slice(0, LIMITS.spikes);
    var hidden = material_.slice(LIMITS.spikes);
    return {
      shown: shown,
      hiddenCount: hidden.length,
      hiddenExcess: M.sum(hidden, function (s) { return s.excess; }),
    };
  }

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

    // ⚠️ 급증은 **한 번만** 계산해서 보고와 pace 가 같은 것을 본다.
    //    따로 계산하면 monthlyExSpikes 와 spikes 배열이 어긋나고,
    //    그 차이는 소비자가 검산할 방법이 없다.
    var spikeCut = cutSpikes(A.spikes(txns), material);
    var reportedSpikes = spikeCut.shown;

    var out = {
      // ⚠️ 사람이 읽는 제목. **분기하지 마라** — 이 값으로 조건을 걸면
      //    문구를 고치는 순간 계약이 깨진다 (그래서 Kind 같은 건 ASCII 다).
      //    여기 한국어를 넣는 이유는 하나뿐이다: 커넥터가 **내용으로**
      //    검색할 때 걸리게 하려고. 유저는 "돈동생" 이나 "가계" 라고 말하지
      //    "facts@2" 라고 말하지 않는다.
      title: title(txns),

      // ⚠️ **최상위 두 번째 자리를 쓰는 이유가 있다.** 예전에 이 지시는
      //    `hints.goals` 안에 있었다 — 최상위 20개 중 마지막 키의, 힌트
      //    10개 중 8번째. 17KB 파일의 맨 끝이다. **실측에서 AI 가 거기까지
      //    안 갔다.**
      //
      //    그리고 그 문장은 "알게 된 것은 메모리/ 에 있다" 였다. **읽을 곳을
      //    가리키는 말이라, 폴더를 열어 비어 있으면 지시가 이행 완료된다.**
      //    실제로 그렇게 끝났다 — AI 는 안내문을 끝내 열지 않았고, 자기가
      //    쓸 수 있다는 것도 몰랐다.
      //
      //    그래서 여기서는 **쓰기가 주절**이다. 읽기는 그다음이다.
      readFirst:
        '대화에서 사용자에 대해 새로 알게 된 것이 있으면 답을 마치기 전에 ' +
        '같은 폴더의 메모리/ 에 마크다운으로 적어라. 그 폴더는 사용자의 ' +
        '파일이고 사용자가 기억해 달라고 만든 자리다. ' +
        '적는 법과 규칙은 같은 폴더의 ' + AGENT_FILE + ' 에 있다 — 먼저 읽어라.',

      schema: SCHEMA,
      source: extract.source,
      // ⚠️ **데이터의 마지막 날이다.** 예전에는 메일을 받은 날(asOf)을 썼다.
      //    뱅샐이 어제까지만 담아 보내면 그 둘이 다르고, delta.since 가
      //    그걸 물려받아 "언제부터의 변화인지" 가 하루씩 어긋났다.
      //    메일 받은 날은 별도 필드로 남긴다.
      // ⚠️ **흐름 창의 끝**이다. period.to 는 이체까지 포함해서, 1년 전
      //    이체 하나가 있으면 "2026-07-20 까지 정리했어요 (50일치)" 인데
      //    실제 수입·지출은 이틀치인 상황이 나온다.
      generatedFor: (function () {
        var p = period(txns) || {};
        return p.flowTo || p.to || opts.asOf
          || (monthly.length ? monthly[monthly.length - 1].month : null);
      })(),
      period: period(txns),

      flow: {
        income: flow.income,
        expense: flow.expense,
        net: flow.net,
        avgMonthlyExpense: A.avgMonthlyExpense(txns),
        monthly: monthly,
      },

      // 이 파일에서 가장 틀리기 쉬운 값. analyze.pace 주석 참조.
      // 아래에서 신뢰할 수 없으면 monthly 를 걷어낸다.
      pace: A.pace(txns, owner, reportedSpikes),

      // 이체는 '내 계좌 간 이동'이라 self.net 은 0에 가까워야 정상이다.
      transfers: transferBlock(tb),

      categories: capped(A.byCategory(txns), LIMITS.categories, 'amount', flow.expense),
      merchants: capped(A.byMerchant(txns), LIMITS.merchants, 'amount', flow.expense),
      categoryMonthly: matrix(txns, monthly),
      refunds: A.refunds(txns),
      recurring: recurringBlock(txns),
      spikes: reportedSpikes,
    };
    if (spikeCut.hiddenCount) {
      out.spikesOther = { count: spikeCut.hiddenCount, excess: spikeCut.hiddenExcess };
    }

    if (snap) {
      out.balance = balanceBlock(snap);
      out.cash = cashBlock(snap, out.flow.avgMonthlyExpense);
      out.investments = investmentBlock(snap);
      // ⚠️ 이름이 값을 배신하면 안 된다. 이건 스냅샷의 나이가 아니라
      //    **계정 주인의 나이**다. snapshotAge 라고 적어 놨더니 27 이
      //    '27일 전 데이터' 로 읽힐 자리에 있었다.
      if (snap.age) out.ownerAge = snap.age;
    }

    // 개인화는 여기 없다. 유저에 대해 알게 된 것은 드라이브의 `메모리/` 폴더에
    // 마크다운으로 쌓이고, AI 가 직접 읽는다.
    //
    // ⚠️ **facts 에 싣지 않는 이유** — 우리가 그 값으로 계산을 안 한다.
    //    예전에는 profile.json 을 읽어 그대로 실어 날랐는데, 실어 나르기만 할
    //    거면 스키마를 강요할 이유가 없었다. 스키마는 "부모님 용돈 매달 30만원",
    //    "커피값에 민감함" 같은 걸 담지 못하고 유저를 좁히기만 한다.
    //    목표를 숫자로 바꾸는 것도, 모순을 정리하는 것도 AI 일이다.

    // 채우지 않고 건너뛴 구간. 안 밝히면 소비자가 2월 다음이 9월인 걸 못 본다.
    var gaps = A.monthGaps(monthly);
    if (gaps.length) out.flow.gaps = gaps;

    out.dataQuality = quality(tb, extract, material, out.pace);

    // 못 믿을 값은 키를 만들지 않는다. null 이면 인용되고, 없으면 인용될 수 없다.
    //
    // ⚠️ 이유를 하나로 못 박으면 안 된다. 거래가 0건인 시트에도
    //    'unclassifiedTransfers' 를 적고 있었다 — 이체가 한 건도 없는데.
    //    LLM 은 그걸 그대로 유저에게 옮긴다.
    var transfersMurky = Math.abs(tb.externalGross) >= flow.income * 0.05;
    if (flow.income > 0 && !transfersMurky) {
      out.flow.savingsRate = Math.round((flow.net / flow.income) * 1000) / 1000;
    } else {
      out.flow.savingsRateOmitted = flow.income > 0 ? 'unclassifiedTransfers' : 'noIncome';
    }

    // ⚠️ **pace 도 같은 문턱으로 막는다.**
    //
    //    pace.monthly 는 externalNet 을 더해서 만든다 — savingsRate 를 못 믿게
    //    만든 바로 그 값이다. 한쪽만 숨기고 다른 쪽을 그냥 내보내면, 더 위험한
    //    쪽을 내보내는 셈이다. pace 는 이 도구가 존재하는 이유인 숫자고
    //    hints 가 "직접 다시 유도하지 마라" 고까지 적어 뒀다.
    //
    //    실측 시나리오: 카카오뱅크 세이프박스로 매달 100만원을 옮기면 적요가
    //    상품명이라 본인 계좌로 안 잡힌다. 실제 여유는 월 150만인데
    //    pace.monthly 가 51만으로 나왔다. 3배 차이다.
    // pace 는 흐름이 한 건도 없으면 null 이다 (이체만 있는 시트).
    if (out.pace && transfersMurky) {
      out.pace.monthlyOmitted = 'unclassifiedTransfers';
      out.pace.monthlyIfExternalIsOwn = out.pace.monthlyExcludingExternal;
      delete out.pace.monthly;
      delete out.pace.monthlyExSpikes;
    }
    if (out.pace) delete out.pace.monthlyExcludingExternal;

    // ⚠️ **관측이 짧으면 월 단위 값을 내보내지 않는다.**
    //
    //    설치 첫날 며칠치만 들어오면 pace.monthly 가 월 292만, 비상금이
    //    35.5개월치로 나온다. 플래그도 없다. 그 숫자를 보고 안심하는 게
    //    이 도구가 할 수 있는 최악의 일이다.
    // 흐름이 한 건도 없으면 월평균은 0이 아니라 '없음' 이다.
    if (out.period && out.period.flowOmitted) delete out.flow.avgMonthlyExpense;

    if (out.pace && out.pace.observedMonths < MIN_MONTHS) {
      out.pace.monthlyOmitted = 'shortObservation';
      delete out.pace.monthly;
      delete out.pace.monthlyExSpikes;
      delete out.pace.monthlyIfExternalIsOwn;
      delete out.flow.avgMonthlyExpense;
      if (out.cash) delete out.cash.monthsOfExpense;
    }

    if (opts.asOf && opts.asOf !== out.generatedFor) {
      out.receivedOn = opts.asOf;   // 메일을 받은 날. 데이터의 마지막 날과 다르다
    }

    out.hints = HINTS;
    return out;
  }

  function title(txns) {
    var p = period(txns);
    if (!p) return '돈동생 가계 요약';
    // 흐름 창을 쓴다 — 이체만 오간 구간까지 제목에 넣으면 실제보다 길어 보인다.
    return '돈동생 가계 요약 · ' + (p.flowFrom || p.from) + ' ~ ' + (p.flowTo || p.to);
  }

  /**
   * ⚠️ **창이 두 개다.** period 는 이체를 포함한 **모든** 거래를 걸치고,
   *    pace·avgMonthlyExpense 는 **이체를 뺀** 거래만 걸친다. 둘이 크게
   *    다를 수 있는데 (이체 한 건이 1년 앞에 있으면 390일 vs 1개월),
   *    라벨이 없어서 소비자가 어느 쪽인지 알 수 없었다.
   *    hints 는 "여기 있는 숫자로 비율을 계산해 써라" 고 권하고 있고.
   */
  function period(txns) {
    if (!txns.length) return null;
    var days = txns.map(function (t) { return t.day; }).sort();
    var from = days[0], to = days[days.length - 1];
    var out = { from: from, to: to, days: A.dayDiff(from, to) };

    var flowDays = txns.filter(function (t) { return t.kind !== M.Kind.TRANSFER; })
                       .map(function (t) { return t.day; }).sort();
    if (flowDays.length) {
      var f = flowDays[0], t2 = flowDays[flowDays.length - 1];
      // 같으면 굳이 싣지 않는다 — 대부분의 경우 같고, 늘 실으면 소음이다.
      if (f !== from || t2 !== to) {
        out.flowFrom = f;
        out.flowTo = t2;
        out.flowDays = A.dayDiff(f, t2);
        out.flowNote = '수입·지출 지표(pace·avgMonthlyExpense·monthly)는 이 창을 쓴다. ' +
          'period 의 from·to 는 이체까지 포함한 전체 범위다';
      }
    } else {
      // ⚠️ 창이 100% 어긋난 경우인데 여기만 라벨이 없었다. 소비자는
      //    "366일 관측, 월평균 지출 0" 을 읽고 '안 쓰는 사람' 으로 결론낸다.
      out.flowOmitted = 'noNonTransferTransactions';
      out.flowNote = '이체 말고는 거래가 없다. period 의 날짜는 이체만의 범위다';
    }
    return out;
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

    // ⚠️ daysObserved 를 `to` 의 일(日)로 쓰면 안 된다. 그 달 1일부터
    //    관측했다는 가정이 깔려 있어서, 3월 15일 하루치 데이터가
    //    'daysObserved: 15' 가 됐다. 연환산하면 15배 과소평가된다.
    //    첫 달도 잘려 있는데 그쪽엔 아예 값이 없었다.
    var firstRow = rows[0], lastRow = rows[rows.length - 1];
    if (from.slice(8) !== '01') {
      firstRow.partial = true;
      firstRow.daysObserved = daysInWindow(firstRow.month, from, to);
    }
    if (Number(to.slice(8)) < lastDay) {
      lastRow.partial = true;
      lastRow.daysObserved = daysInWindow(lastRow.month, from, to);
    }
    return rows;
  }

  /** 그 달에서 실제로 관측된 날 수. 달의 시작·끝과 관측 창의 교집합이다. */
  function daysInWindow(month, from, to) {
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    var last = new Date(y, m, 0).getDate();
    var start = month + '-01', end = month + '-' + (last < 10 ? '0' : '') + last;
    if (from > start) start = from;
    if (to < end) end = to;
    return A.dayDiff(start, end); // dayDiff 는 양끝을 포함한다
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
      // ⚠️ **otherCount 는 내지 않는다.** otherTotal 은 '전체에서 빠진 만큼'
      //    이고, 목록은 만드는 쪽에서 이미 걸러진 뒤다 (byMerchant 는 순액이
      //    0 이하인 가맹점을 뺀다). 그래서 list.length − limit 은 otherTotal 이
      //    가리키는 모집단과 다르다. 두 값을 나눠 '평균' 을 내면 틀린다.
      //    셀 수 없으면 세지 않는다. 금액만 정확히 준다.
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

    // ⚠️ **살아 있는 것을 먼저 보여준다.** 금액순으로만 자르면 비싼 해지
    //    구독들이 상한을 다 먹고, 지금 나가는 돈이 하나도 안 보일 수 있다.
    //    실측 재현: 해지한 12개가 목록을 채우고 살아 있는 6개가 통째로 밀렸다.
    //    hints 는 "label 을 보고 구분하라" 고 하는데, 볼 label 이 없었다.
    var ordered = active.concat(items.filter(function (r) { return !r.active; }));
    var shown = ordered.slice(0, LIMITS.recurring);

    var block = {
      // active 로 거르는 것이 함정이다 (끝난 구독까지 세면 실측 66%가 허수였다).
      // 그래서 이 합계만 우리가 낸다. 연환산은 ×12 라 LLM 이 한다.
      activeMonthlyTotal: M.sum(active, function (r) { return r.monthlyMedian; }),
      activeCount: active.length,
      inactiveCount: items.length - active.length,
      // ⚠️ label 이 실려야 한다. 금액이 일정하면 월세도 식비도 여기 잡히는데,
      //    총액만 주면 "고정지출 전액 끊으면 15년 빨라져" 같은 답이 나온다
      //    (실측 재현: 진짜 구독만이면 11개월. 179개월 차이).
      // ⚠️ **잘리지 않은 활성 키 전체.** delta 가 '새로 생겼나' 를 판정할 때
      //    쓴다. items 는 상한이 걸려 있어서, 그걸로 비교하면 경계를 넘어
      //    들어온 항목이 없던 구독으로 보고된다.
      activeKeys: active.map(function (r) { return r.key; }),
      items: shown.map(function (r) {
        return {
          key: r.key, label: r.label, months: r.months,
          firstMonth: r.firstMonth, lastMonth: r.lastMonth,
          monthlyMedian: r.monthlyMedian, observedTotal: r.observedTotal,
          active: r.active,
        };
      }),
    };

    // ⚠️ **잘라낸 만큼을 밝힌다.** 안 밝히면 activeMonthlyTotal 과 items 의
    //    합이 안 맞는데 소비자는 그 사실을 모른다. 샘플에서도 월 75,100원이
    //    설명 없이 사라져 있었다.
    var hiddenActive = active.filter(function (r) { return shown.indexOf(r) === -1; });
    if (hiddenActive.length) {
      block.otherActiveCount = hiddenActive.length;
      block.otherActiveTotal = M.sum(hiddenActive, function (r) { return r.monthlyMedian; });
    }
    return block;
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
      // accounts 는 상한이 걸려 있어 더해도 총자산이 안 나온다. 직접 준다.
      totalAssets: total,
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
    // ⚠️ 두 시트가 같은 집합을 담는다고 가정하면 안 된다. 연금저축펀드가
    //    재무현황에서는 '연금 자산' 으로, 투자현황에서는 종목으로 잡히면
    //    bucketTotal 이 0인데 holdings 는 차 있고, 뺄셈이 **음수**가 된다.
    //    "제외해야 하는 금액" 이라는 설명이 붙은 채로 음수가 나가면 안 된다.
    var unpriced = bucket - value;
    var out = {
      bucketTotal: bucket,
      unpricedValue: unpriced > 0 ? unpriced : 0,
      unpricedNote: 'CMA·예수금 등 원금 정보가 없어 수익률 계산에서 제외해야 하는 금액',
      holdings: priced.map(function (i) {
        return { name: i.name, broker: i.broker, principal: i.principal, value: i.value };
      }).sort(function (a, b) {
        return (a.value - a.principal) / a.principal - (b.value - b.principal) / b.principal;
      }),
    };
    if (unpriced < 0) {
      out.sheetMismatch = -unpriced;
      out.sheetMismatchNote = '투자현황의 평가액이 재무현황의 투자성 자산보다 크다. ' +
        '두 시트가 같은 계좌를 다르게 분류한 것으로 보인다';
    }
    return out;
  }

  function quality(tb, extract, material, paceInfo) {
    var flags = [];
    if (paceInfo && paceInfo.observedMonths < MIN_MONTHS) {
      flags.push({
        code: 'shortObservation',
        observedMonths: paceInfo.observedMonths,
        note: '관측 기간이 짧아 월 단위 값(pace.monthly·avgMonthlyExpense·' +
              'cash.monthsOfExpense)을 내지 않았다. 한 달치가 더 쌓이면 나온다',
      });
    }
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
    // ⚠️ 거래 타입이 낯설면 던지면서(parse.js) 자산 그룹이 낯설면 조용히
    //    other 에 넣고 있었다. 같은 종류의 '모름' 인데 처리가 반대다.
    //    파킹통장·청약 같은 게 cash/savings 에서 빠지면 비상금이 과소평가된다.
    //    실제로 샘플의 청년희망적금(자산의 55%)이 other 에 들어가 있었다.
    if (extract.snapshot) {
      var unknown = {};
      extract.snapshot.holdings.forEach(function (h) {
        if (h.bucket === M.Bucket.OTHER && h.group) unknown[h.group] = true;
      });
      var names = Object.keys(unknown);
      if (names.length) {
        flags.push({
          code: 'unknownAssetGroups', groups: names,
          note: '분류표에 없는 자산 그룹이라 other 로 넣었다. cash·savings 지표에서 빠져 있다',
        });
      }
    }
    return { material: material, materialNote: '지출의 5%. 이 미만은 보고하지 않았다', flags: flags };
  }

  /** 필드의 뜻과 계산 규약만 적는다. 결론은 적지 않는다. */
  var HINTS = {
    signs: '금액은 내 지갑 기준이다. 들어오면 +, 나가면 −. expense 합계는 이미 부호를 뒤집고 환불을 차감한 순액이다.',
    transfers: '이체는 수입에도 지출에도 포함되지 않는다. 본인 계좌 간 이동이므로 self.net 은 0에 가까워야 한다.',
    pace: 'pace.monthly = (수입 − 지출 + 남과 오간 이체 순액) ÷ 관측개월. 본인 계좌 간 이체 순액은 더하지 않는다 — 새로 생긴 돈이 아니다. 이 값을 직접 다시 유도하지 마라.',
    derived: '합계·차액·비율·연환산은 여기 있는 숫자로 계산해 써라. 다만 pace 와 avgMonthlyExpense 는 이미 보정된 값이니 그대로 쓴다.',
    period: 'period.from·to 는 이체까지 포함한 전체 범위다. flowFrom·flowTo·flowDays 가 있으면 수입·지출 지표는 그 좁은 창을 쓴 것이다 — 지출을 period.days 로 나누지 마라. flow.gaps 는 거래가 아예 없어 건너뛴 구간이다.',
    truncation: 'otherTotal·otherAccountsTotal·external.other 는 목록에서 잘려나간 나머지다. 합계를 검산할 때 같이 더해라.',
    recurring: 'recurring 은 금액이 일정한 모든 지출을 잡는다 — 월세·식비도 들어간다. items 의 label 을 보고 구독과 생활비를 구분해라.',
    // ⚠️ 여기에 금액을 적지 마라. goalTable(5천만·1억·2억)을 '우리가 고른
    //    상수라 판단이지 집계가 아니다' 라며 지웠는데, 같은 숫자가 산문으로
    //    돌아와 있었다. 문장으로 적으면 안 걸린다는 게 함정이다.
    goals: '목표 금액은 유저가 정한다. 우리가 예시 금액을 먼저 던지지 않는다. 유저가 목표를 말하면 메모리/ 에 적어라 (readFirst 참고).',
    scope: '이 도구는 사실·계산·비교까지만 한다. 상품 추천이나 매매 판단은 하지 않는다.',
    currency: 'KRW. 원 단위 정수.',
  };

  /**
   * 이전 산출물과의 차이. 대화 한 세션은 지난 스냅샷을 볼 수 없고,
   * **뱅샐 내보내기는 최소 1년치다** (유저가 더 길게 고를 수도 있다).
   * 어느 쪽이든 **내보낸 창 밖은 우리가 안 쌓으면 영구히 사라진다** —
   * 유저가 그 창보다 오래 쉬면 그 사이가 통째로 빈다.
   */
  function delta(current, previous) {
    if (!previous) return null;
    var d = { since: previous.generatedFor };
    if (current.balance && previous.balance) {
      d.netWorth = current.balance.netWorth - previous.balance.netWorth;
    }
    if (current.cash && previous.cash) d.cash = current.cash.total - previous.cash.total;
    // 한쪽이라도 shortObservation 으로 빠졌으면 뺄셈이 NaN 이고 JSON 에서 null 이 된다.
    if (typeof (current.flow || {}).avgMonthlyExpense === 'number' &&
        typeof (previous.flow || {}).avgMonthlyExpense === 'number') {
      d.avgMonthlyExpense = current.flow.avgMonthlyExpense - previous.flow.avgMonthlyExpense;
    }
    // ⚠️ **잘린 목록으로 '새로 생겼나' 를 판정하면 안 된다.** 예전에는
    //    previous.recurring.items(상한 12개로 이미 잘린 것)를 '예전에 있던 것'
    //    으로 썼다. 그래서 경계를 넘어 들어온 항목이 **없던 구독이 생긴 것**
    //    으로 보고됐다. delta 는 내보낸 창 밖을 보존하는 유일한 수단이라,
    //    여기서 나온 거짓은 유저가 검증할 방법이 없다.
    //
    //    그래서 잘리지 않은 **활성 키 전체**(activeKeys)를 따로 싣고 그걸로
    //    비교한다. label 이 아니라 키로 보는 이유는, 설명이 같은 서로 다른
    //    항목이 label 만으로는 한 덩어리가 되기 때문이다.
    if (current.recurring && previous.recurring) {
      var prevKeys = previous.recurring.activeKeys;
      if (prevKeys) {
        var was = {};
        prevKeys.forEach(function (k) { was[k] = true; });
        d.newRecurring = (current.recurring.activeKeys || [])
          .filter(function (k) { return !was[k]; })
          .map(function (k) {
            var hit = null;
            current.recurring.items.forEach(function (r) { if (r.key === k) hit = r; });
            if (hit) return { key: k, label: hit.label, monthlyMedian: hit.monthlyMedian };
            // ⚠️ 상한 밖이라 items 에 없다. **새로 생긴 싼 구독이 정확히
            //    이 경우다.** label 없이 내보내면 같은 배열 안에서 모양이
            //    갈리고, hints 는 "label 을 보고 구분하라" 고 한다.
            //    키는 '대분류|소분류|설명' 이라 마지막 조각이 label 이다.
            var parts = String(k).split('|');
            return { key: k, label: parts[parts.length - 1] || k,
                     monthlyMedianOmitted: 'truncated' };
          });
      } else {
        // 예전 스냅샷이 activeKeys 를 안 갖고 있다 (0.4.x 이전). 지어내지 않는다.
        d.newRecurringOmitted = 'previousSnapshotTooOld';
      }
    }
    return d;
  }

  return { build: build, delta: delta, SCHEMA: SCHEMA, LIMITS: LIMITS };
})();
