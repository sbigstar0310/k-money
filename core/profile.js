/**
 * 유저 컨텍스트 — 대화로 쌓이는 것.
 *
 * `Drive/돈동생/내정보.json`. **유저가 직접 올린다** (드라이브 커넥터는 대개
 * 읽기 전용이라 LLM 이 쓸 수 없다). 유저가 JSON을
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


  return {
    SCHEMA: SCHEMA,
    defaults: defaults, normalize: normalize, entry: entry, valueOf: valueOf,
  };
})();

if (typeof module !== 'undefined') module.exports = KM.profile;
