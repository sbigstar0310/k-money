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

if (typeof module !== 'undefined') module.exports = KM.model;
