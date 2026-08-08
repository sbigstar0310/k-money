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

    // 유저가 대화로 쌓은 것. **계산하지 않고 그대로 실어 나른다** —
    // 목표를 숫자로 바꾸는 건 LLM 일이고, 우리는 세션 사이를 잇는 역할만 한다.
    var profile = KM.profile.normalize(opts.profile);
    if (profile.goals.length || Object.keys(profile.assumptions).length) {
      out.profile = { goals: profile.goals, assumptions: profile.assumptions };
    }

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
    if (out.pace && out.pace.observedMonths < MIN_MONTHS) {
      out.pace.monthlyOmitted = 'shortObservation';
      delete out.pace.monthly;
      delete out.pace.monthlyExSpikes;
      delete out.pace.monthlyIfExternalIsOwn;
      delete out.flow.avgMonthlyExpense;
      if (out.cash) delete out.cash.monthsOfExpense;
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
      items: shown.map(function (r) {
        return {
          label: r.label, months: r.months,
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
    truncation: 'otherTotal·otherAccountsTotal·external.other 는 목록에서 잘려나간 나머지다. 합계를 검산할 때 같이 더해라.',
    recurring: 'recurring 은 금액이 일정한 모든 지출을 잡는다 — 월세·식비도 들어간다. items 의 label 을 보고 구독과 생활비를 구분해라.',
    // ⚠️ 여기에 금액을 적지 마라. goalTable(5천만·1억·2억)을 '우리가 고른
    //    상수라 판단이지 집계가 아니다' 라며 지웠는데, 같은 숫자가 산문으로
    //    돌아와 있었다. 문장으로 적으면 안 걸린다는 게 함정이다.
    goals: '목표 금액은 유저가 정한다. 우리가 예시 금액을 먼저 던지지 않는다. profile 이 있으면 유저가 예전에 말한 목표다. 없으면 이번 대화에서만 유효하다 — 드라이브의 profile.json 은 유저가 직접 올려야 하고, 네가 쓸 수는 없다.',
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
