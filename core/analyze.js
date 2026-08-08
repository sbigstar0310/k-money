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

if (typeof module !== 'undefined') module.exports = KM.analyze;
