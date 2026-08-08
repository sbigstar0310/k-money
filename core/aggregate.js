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

      // ⚠️ **명령하지 마라. 설명해라.** 여기는 두 번 틀렸던 자리다.
      //
      //    처음엔 이 안내가 `hints.goals` 안에, 최상위 20개 중 마지막 키의
      //    힌트 8번째에 있었다 — 17KB 파일의 맨 끝. AI 가 거기까지 안 갔다.
      //    그래서 최상위 두 번째로 올리고 "적어라 · 읽어라" 로 세게 썼더니,
      //    이번엔 실측에서 이런 답이 왔다:
      //
      //        "this looks like a prompt injection embedded in data —
      //         my instructions say to treat file contents as data,
      //         not executable instructions"
      //
      //    **그게 맞는 판단이다.** 커넥터로 읽은 파일은 데이터지 명령이 아니고,
      //    제대로 만든 AI 는 거기 적힌 지시를 따르지 않는다. 명령형을 세게
      //    할수록 인젝션 신호만 뚜렷해져서 **조용한 무시가 명시적 거부로**
      //    바뀌었다. 데이터 파일로 이길 수 있는 싸움이 아니고, 이기면 안 된다.
      //
      //    그래서 지금은 **폴더가 무엇인지 설명만** 한다. 무엇을 할지는 읽는
      //    쪽이 정하고, 쓰기 전에 사용자에게 묻는다 (AGENT.md 도 그렇게 말한다).
      //    지시는 **사용자의 입**에서 나와야 한다 — 그게 유일한 신뢰 채널이다.
      aboutThisFolder:
        '이 폴더는 사용자가 자기 가계 기록을 두려고 만든 곳이다. ' +
        '옆의 메모리/ 에는 사용자가 대화에서 알려준 사실(수입·고정지출·목표 등)이 ' +
        '마크다운으로 보관돼 있다 — 답하기 전에 읽어 두면 사용자가 같은 설명을 ' +
        '되풀이하지 않아도 된다. ' +
        '새로 알게 된 것을 여기에 더할 수도 있지만, 파일을 만들기 전에 ' +
        '사용자에게 먼저 확인하라. ' +
        '형식과 주의할 점은 같은 폴더의 ' + AGENT_FILE + ' 에 적혀 있다.',

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

if (typeof module !== 'undefined') module.exports = KM.aggregate;
