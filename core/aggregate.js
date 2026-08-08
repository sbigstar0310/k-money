/**
 * 산출물 조립 — Drive 에 올라가고 LLM 이 읽을 JSON.
 *
 * ━━ 이 파일이 곧 프롬프트다 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 우리는 프롬프트를 소유하지 않는다. 유저의 Claude·ChatGPT·Gemini 가 Drive 를
 * 읽고, 시스템 프롬프트도 모델도 우리 것이 아니다. 그래서 **파일 자체가
 * 우리가 가진 유일한 표면**이고, 두 가지를 여기서 해결해야 한다.
 *
 *   (1) LLM 이 계산하게 두지 않는다 → 필요한 파생값을 전부 미리 넣는다.
 *   (2) 못 믿을 값은 넣지 않는다   → null 이 아니라 **키 자체를 없앤다.**
 *                                    없는 숫자는 인용될 수 없다.
 *
 * ━━ 커넥터에 대해 실측으로 확인한 것 ━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. JSON 은 **읽힌다.** 한때 "빈 문자열로 나온다" 고 기록해 뒀는데 틀렸다.
 *    갓 만든 파일은 커넥터가 아직 처리하지 못해 잠시 비어 보일 뿐이고,
 *    몇 분 뒤에는 정상적으로 읽힌다. 크기와도 MIME 과도 무관했다.
 *
 * 2. 다만 마크다운 특수문자가 이스케이프된다. 실측으로 확인된 대상:
 *      [ ] < > ! \ # * _ ~ `
 *    안전한 것: { } ( ) : ; , . ? / | + = % & @ $ " ' -
 *    → JSON 의 뼈대({ } " : ,)는 멀쩡하고 배열 괄호만 \[ \] 가 된다.
 *      엄격한 파서는 깨지지만 LLM 이 읽는 데는 지장이 없다.
 *    → 식별자에 밑줄을 쓰지 않는 이유가 이것이다 (snake_case → camelCase).
 *
 * 3. 그래도 거래 원본은 넣지 않고 목록마다 상한을 둔다. 토큰과 가독성 문제다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.aggregate = (function () {
  'use strict';

  var M = KM.model;
  var A = KM.analyze;

  var SCHEMA = 'k-money/facts@1';
  var LIMITS = { parties: 8, spikes: 5, recurring: 10, categories: 12 };

  // 이 아래면 분류 오류로 보지 않는다. 수입이 아니라 **지출** 기준인 것이
  // 중요하다 — 지금 문제가 '수입이 덜 잡힌다' 인데 그 수입으로 문턱을 잡으면
  // 결함이 자기 탐지 문턱을 같이 낮추는 순환이 된다.
  function materialFloor(flow) {
    return Math.max(Math.round(flow.expense * 0.05), 200000);
  }

  function build(extract, opts) {
    opts = opts || {};
    var txns = extract.txns;
    var snap = extract.snapshot;

    var flow = A.totals(txns);
    var monthly = A.monthlyTotals(txns);
    var avgExpense = A.avgMonthlyExpense(txns);
    var tb = A.transferBalance(txns, snap ? snap.owner : null);
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
        avgMonthlyExpense: avgExpense,
        monthly: monthly,
      },

      // 이체는 '내 계좌 간 이동'이라 순액이 0이어야 정상이다.
      transfers: {
        self: {
          net: tb.selfNet,
          count: tb.selfCount,
          matchedByMaskedName: tb.selfMatchedByMask,
        },
        external: {
          net: tb.externalNet,
          gross: tb.externalGross,
          in: tb.externalIn,
          out: tb.externalOut,
          count: tb.externalCount,
          topInflows: tb.inflows.slice(0, LIMITS.parties),
          topOutflows: tb.outflows.slice(0, LIMITS.parties),
          truncated: {
            inflows: Math.max(0, tb.inflows.length - LIMITS.parties),
            outflows: Math.max(0, tb.outflows.length - LIMITS.parties),
          },
        },
      },

      categories: { expense: A.byCategory(txns).slice(0, LIMITS.categories) },
      refunds: A.refunds(txns),
      recurring: recurringBlock(txns),
      spikes: A.spikes(txns).filter(function (s) { return s.excess >= material; })
                            .slice(0, LIMITS.spikes),
    };

    if (snap) {
      out.balance = balanceBlock(snap);
      out.cash = cashBlock(snap, avgExpense);
      out.investments = investmentBlock(snap);
    }

    out.dataQuality = quality(tb, flow, extract, material);

    // (2) 못 믿을 값은 키를 만들지 않는다.
    var unclassified = Math.abs(tb.externalGross);
    if (flow.income > 0 && unclassified < flow.income * 0.05) {
      out.flow.savingsRate = Math.round((flow.net / flow.income) * 1000) / 1000;
    } else {
      out.flow.savingsRateOmitted = {
        reason: 'unclassifiedTransfers',
        unclassifiedGross: unclassified,
        recordedIncome: flow.income,
      };
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

  function recurringBlock(txns) {
    var items = A.recurring(txns);
    var active = items.filter(function (r) { return r.active; });
    return {
      // 살아 있는 항목만 1년치를 전망한다. 끝난 구독까지 ×12 하면
      // 존재하지 않는 돈이 생긴다 (실측: 보고액의 66%가 허수였다).
      activeMonthlyTotal: M.sum(active, function (r) { return r.monthlyMedian; }),
      activeProjectedAnnual: M.sum(active, function (r) { return r.projectedAnnual; }),
      observedTotal: M.sum(items, function (r) { return r.observedTotal; }),
      activeCount: active.length,
      inactiveCount: items.length - active.length,
      items: items.slice(0, LIMITS.recurring),
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
    return {
      netWorth: M.netWorth(snap),
      totalAssets: M.totalAssets(snap),
      totalDebt: M.totalDebt(snap),
      buckets: buckets,
      accounts: M.assets(snap)
        .slice()
        .sort(function (a, b) { return b.amount - a.amount; })
        .slice(0, 15)
        .map(function (h) {
          return { bucket: h.bucket, group: h.group, name: h.name, amount: h.amount };
        }),
    };
  }

  function cashBlock(snap, avgExpense) {
    var total = M.bucketTotal(snap, M.Bucket.CASH);
    var buffer = avgExpense * 3;
    return {
      total: total,
      monthsOfExpense: avgExpense > 0 ? Math.round((total / avgExpense) * 10) / 10 : null,
      emergencyBuffer3m: buffer,
      aboveBuffer: total - buffer,
    };
  }

  /**
   * 투자.
   *
   * ⚠️ 두 시트가 다르다. '투자성 자산'(재무현황)에는 CMA 처럼 원금 정보가
   *    없는 계좌가 들어 있고, '투자현황'에는 없다. 한쪽 합계에 다른 쪽 이름을
   *    붙이면 실측 130,385원이 조용히 증발한다.
   *    → 수익률은 **원금이 있는 것만으로** 계산하고, 나머지는 따로 밝힌다.
   */
  function investmentBlock(snap) {
    var priced = snap.investments.filter(function (i) { return i.principal > 0; });
    var principal = M.sum(priced, function (i) { return i.principal; });
    var value = M.sum(priced, function (i) { return i.value; });
    var bucket = M.bucketTotal(snap, M.Bucket.INVESTMENT);
    var listedUnpriced = M.sum(
      snap.investments.filter(function (i) { return i.principal <= 0; }),
      function (i) { return i.value; }
    );

    return {
      bucketTotal: bucket,
      withCostBasis: {
        principal: principal,
        value: value,
        pnl: value - principal,
        roi: principal > 0 ? Math.round(((value - principal) / principal) * 1000) / 1000 : null,
        count: priced.length,
      },
      withoutCostBasis: {
        value: bucket - value,
        note: 'CMA·예수금 등 원금 정보가 없어 수익률 계산에서 제외된 금액',
        listedCount: snap.investments.length - priced.length,
      },
      holdings: priced
        .map(function (i) {
          return {
            name: i.name, broker: i.broker,
            principal: i.principal, value: i.value,
            pnl: i.value - i.principal,
            roi: Math.round(M.roi(i) * 1000) / 1000,
          };
        })
        .sort(function (a, b) { return a.roi - b.roi; }),
    };
  }

  function quality(tb, flow, extract, material) {
    var flags = [];
    if (Math.abs(tb.externalGross) >= material) {
      flags.push({
        code: 'unclassifiedExternalTransfers',
        amountNet: tb.externalNet,
        amountGross: tb.externalGross,
        // 순액이 0이어도 총액은 클 수 있다. 700만 받고 700만 보내면
        // 순액 0이지만 1,400만원이 수입에도 지출에도 안 잡힌 상태다.
        note: '이체로 분류됐지만 본인 계좌가 아닌 곳과 오간 금액',
      });
    }
    if (Math.abs(tb.selfNet) >= material) {
      flags.push({
        code: 'selfTransferImbalance',
        amount: tb.selfNet,
        note: '본인 계좌 간 이체 순액. 0이어야 정상이며 어긋나면 미연동 계좌가 있다',
      });
    }
    if (tb.selfMatchedByMask > 0) {
      flags.push({
        code: 'ownerMatchedByMaskedName',
        count: tb.selfMatchedByMask,
        note: '가려진 이름으로 본인 판정된 건. 동명이인이면 본인/타인 구분이 뒤집힌다',
      });
    }
    if (extract.foreign && extract.foreign.length) {
      flags.push({
        code: 'foreignCurrencyExcluded',
        count: extract.foreign.length,
        note: '원화가 아닌 거래는 합계에서 제외했다',
      });
    }
    if (!extract.snapshot) {
      flags.push({ code: 'noBalanceSheet', note: '자산 현황이 없어 잔고 지표를 낼 수 없다' });
    }
    return { material: material, flags: flags };
  }

  /** 필드의 뜻만 적는다. 결론은 적지 않는다 — 그건 읽는 쪽 몫이다. */
  var HINTS = {
    signs: '금액은 내 지갑 기준이다. 들어오면 +, 나가면 −. expense 합계는 이미 부호를 뒤집고 환불을 차감한 순액이다.',
    transfers: '이체는 수입에도 지출에도 포함되지 않는다. 본인 계좌 간 이동이므로 self.net 은 0에 가까워야 한다.',
    numbers: '이 파일의 숫자는 계산이 끝난 값이다. 다시 계산하지 말고, 여기 없는 수치는 만들지 마라.',
    scope: '이 도구는 사실·계산·비교까지만 한다. 상품 추천이나 매매 판단은 하지 않는다.',
    currency: 'KRW. 원 단위 정수.',
  };

  /**
   * 이전 산출물과의 차이. **대화 한 세션은 이걸 알 수 없다** —
   * 히스토리를 가진 우리만 낼 수 있는 값이라 굳이 계산해 싣는다.
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
      previous.recurring.items.forEach(function (r) { was[r.key] = true; });
      d.newRecurring = current.recurring.items
        .filter(function (r) { return r.active && !was[r.key]; })
        .map(function (r) { return { label: r.label, monthlyMedian: r.monthlyMedian }; });
    }
    return d;
  }

  return { build: build, delta: delta, SCHEMA: SCHEMA, LIMITS: LIMITS };
})();

if (typeof module !== 'undefined') module.exports = KM.aggregate;
