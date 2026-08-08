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
  var LIMITS = { parties: 8, spikes: 5, recurring: 12, categories: 12, merchants: 12, accounts: 15, matrixCategories: 8 };

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

      categories: capped(A.byCategory(txns), LIMITS.categories, 'category', 'amount'),
      merchants: capped(A.byMerchant(txns), LIMITS.merchants, 'merchant', 'amount'),
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

  /** 목록을 자르되 **잘라낸 총액을 반드시 밝힌다.** */
  function capped(list, limit, keyField, amountField) {
    var head = list.slice(0, limit);
    var rest = list.slice(limit);
    var out = { items: head };
    if (rest.length) {
      out.otherCount = rest.length;
      out.otherTotal = M.sum(rest, function (x) { return x[amountField]; });
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
    var rest = all.slice(LIMITS.accounts);
    var out = {
      netWorth: M.netWorth(snap),
      totalDebt: M.totalDebt(snap),
      buckets: buckets,
      accounts: head.map(function (h) {
        return { bucket: h.bucket, name: h.name, amount: h.amount };
      }),
    };
    if (rest.length) {
      out.otherAccountsCount = rest.length;
      out.otherAccountsTotal = M.sum(rest, function (h) { return h.amount; });
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

if (typeof module !== 'undefined') module.exports = KM.aggregate;
