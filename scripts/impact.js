#!/usr/bin/env node
/**
 * 이번 릴리스가 **유저에게 무엇을 바꾸는가** 를 증거로 낸다.
 *
 *     node scripts/impact.js            # 사람이 읽는 형태
 *     node scripts/impact.js --json     # 릴리스 절차가 읽는 형태
 *     node scripts/impact.js --base v0.4.2
 *
 * ━━ 왜 필요한가 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * CHANGELOG 의 🔴/🟡/⚪ 는 유저가 **올릴지 말지를 정하는 근거**다.
 * ⚪ 로 잘못 매기면 계산이 틀린 버전을 쓰는 사람이 안 올린다.
 * 그런데 지금 테스트는 등급이 **있는지**만 보지 **맞는지**는 못 본다.
 *
 * 그래서 감으로 매기지 않는다. `docs/sample-latest.json` 은 **진짜 파이프라인을
 * 통과한 산출물**이고 CI 가 최신임을 강제한다. 직전 태그의 것과 비교하면
 * "유저가 보는 숫자가 실제로 바뀌었는가" 가 **측정**된다.
 *
 * 이 프로젝트가 이미 쓰는 원칙과 같다 — 순회로 알 수 있는 걸 선택에 맡기지 않는다.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAMPLE = 'docs/sample-latest.json';

/*
 * 배포되는 것들. 여기가 안 바뀌면 유저 쪽에서 도는 코드는 그대로다.
 *
 * ⚠️ 목록을 여기 또 적지 않는다. 이중화하면 `build-deploy.js` 에 파일을
 *    추가하고 여기를 안 고쳐도 **테스트가 전부 초록이고 등급만 낮아진다** —
 *    새 파일만 바뀐 릴리스가 "배포되는 파일이 하나도 안 바뀌었다 → ⚪" 로 나간다.
 */
const TARGETS = require('./build-deploy').TARGETS;
const LIBRARY = TARGETS.library.files.map(function (f) { return 'appsscript/' + f; });
const TEMPLATE = TARGETS.template.files.concat([TARGETS.template.manifest])
  .map(function (f) { return 'appsscript/' + f; });

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function lastTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0']);
  } catch (e) {
    return null;
  }
}

function fileAt(ref, rel) {
  try {
    return execFileSync('git', ['show', ref + ':' + rel], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    return null;
  }
}

/** 중첩 객체를 `a.b[0].c` → 값 로 편다. 경로별로 비교하려고. */
function flatten(node, prefix, out) {
  out = out || {};
  prefix = prefix || '';
  if (node === null || typeof node !== 'object') {
    out[prefix] = node;
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach(function (v, i) { flatten(v, prefix + '[' + i + ']', out); });
    return out;
  }
  Object.keys(node).forEach(function (k) {
    flatten(node[k], prefix ? prefix + '.' + k : k, out);
  });
  return out;
}

/**
 * 샘플이 **만들어진 날**에 따라 저절로 바뀌는 자리. 신호가 아니라 잡음이다.
 *
 * 이걸 안 걸러내면 아무것도 안 고친 날에도 🔴 가 뜨고, **매번 뜨는 경보는
 * 곧 안 보는 경보가 된다.** 등급을 측정으로 바꾸려는 시도 자체가 죽는다.
 */
/*
 * ⚠️ **좁게 잡아라.** 처음엔 `/^period\./` 로 뭉뚱그렸는데, 그건
 *    `period.days` 까지 삼킨다. 이 저장소 최악의 버그(라이브러리 경계에서
 *    `instanceof Date` 가 안 넘어가 **84개월짜리 산출물**이 나온 것)의 관측
 *    지표가 정확히 그 값이었다 — `366일 → 175일`. 그 사고가 오늘 다시 나면
 *    필터가 조용히 지운다. 잡음 필터는 신호를 삼키는 순간 가치가 음수가 된다.
 *
 *    `source` 는 지금 문자열이라 `/^source\./` 가 아무것도 안 잡는다. 죽은
 *    규칙은 다음 사람이 그 필드를 객체로 바꾸는 순간 조용히 발효되므로 뺐다.
 */
const NOISE = [/^generatedFor$/, /^generatedAt$/, /^receivedOn$/, /^sourceMessageId$/,
  /^period\.(from|to)$/];

/**
 * 유저가 보는 **숫자**가 아니라 AI 에게 주는 **설명문**인 자리.
 *
 * 여기가 바뀌면 AI 가 답하는 방식이 달라지는 것이지 계산이 틀린 게 아니다.
 * 무게가 다르므로 따로 센다.
 */
const PROSE = [/^hints\./, /^title$/, /^aboutThisFolder/, /^schema$/];

function classify(p) {
  if (NOISE.some(function (r) { return r.test(p); })) return 'noise';
  if (PROSE.some(function (r) { return r.test(p); })) return 'prose';
  return 'number';
}

/**
 * 샘플 산출물의 차이를 **종류별로** 가른다.
 *
 * 값이 바뀐 것과 키가 는 것은 무게가 다르다. 값이 바뀌면 **어제 본 숫자가
 * 오늘 다르다**는 뜻이고, 키가 늘면 없던 게 생긴 것이다.
 * 그리고 숫자가 바뀐 것과 안내문이 바뀐 것도 무게가 다르다.
 */
function diffSample(before, after) {
  if (before === null) return { unavailable: true };
  const a = flatten(JSON.parse(before));
  const b = flatten(JSON.parse(after));

  const added = [];
  const removed = [];
  const changed = [];
  const prose = [];

  Object.keys(b).forEach(function (k) {
    const kind = classify(k);
    if (kind === 'noise') return;
    if (!(k in a)) { added.push(k); return; }
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) return;
    if (kind === 'prose') prose.push(k);
    else changed.push({ path: k, from: a[k], to: b[k] });
  });
  Object.keys(a).forEach(function (k) {
    if (classify(k) !== 'noise' && !(k in b)) removed.push(k);
  });

  return { unavailable: false, added: added, removed: removed, changed: changed, prose: prose };
}

function collect(base) {
  const files = base ? git(['diff', '--name-only', base + '..HEAD']).split('\n').filter(Boolean) : [];
  const touched = function (list) { return list.filter(function (f) { return files.indexOf(f) !== -1; }); };

  const sample = diffSample(base ? fileAt(base, SAMPLE) : null,
    fs.readFileSync(path.join(ROOT, SAMPLE), 'utf8'));

  return {
    base: base,
    files: files,
    library: touched(LIBRARY),
    template: touched(TEMPLATE),
    agentGuide: files.indexOf('docs/AGENT.md.txt') !== -1,
    sample: sample,
  };
}

/**
 * 증거에서 등급 **후보**를 뽑는다. 결론이 아니라 하한선이다.
 *
 * 여기서 나온 것보다 **낮게** 매기려면 근거를 대야 한다. 높게 매기는 건 자유다 —
 * 틀렸을 때 유저가 치르는 값이 한쪽으로만 크기 때문이다. ⚪ 로 잘못 매기면
 * 계산이 틀린 버전을 쓰는 사람이 안 올린다. 🔴 로 잘못 매기면 한 번 더 누른다.
 */
function suggest(ev) {
  const why = [];
  let grade = '⚪';

  if (ev.sample.unavailable) {
    why.push('직전 태그의 샘플을 못 읽었다 — 비교 없이는 ⚪ 라고 말할 수 없다');
    grade = '🟡';
  } else {
    if (ev.sample.changed.length) {
      why.push('산출물의 값이 ' + ev.sample.changed.length + '곳 바뀌었다 ' +
        '(유저가 어제 본 숫자가 오늘 다르다)');
      grade = '🔴';
    }
    if (ev.sample.removed.length) {
      why.push('산출물에서 필드 ' + ev.sample.removed.length + '개가 사라졌다 ' +
        '(AI 가 찾던 값이 없어진다)');
      grade = '🔴';
    }
    if (ev.sample.added.length && grade === '⚪') {
      why.push('산출물에 필드 ' + ev.sample.added.length + '개가 늘었다');
      grade = '🟡';
    }
    if (ev.sample.prose.length && grade === '⚪') {
      why.push('AI 에게 주는 안내문이 ' + ev.sample.prose.length + '곳 바뀌었다 ' +
        '(숫자가 아니라 답하는 방식이 달라진다)');
      grade = '🟡';
    }
  }

  if (ev.agentGuide && grade === '⚪') {
    why.push('AGENT.md 가 바뀌었다 — AI 가 답하는 방식이 달라진다');
    grade = '🟡';
  }
  if (ev.library.length && grade === '⚪') {
    // ⚠️ 예전엔 사유만 붙이고 등급은 ⚪ 로 뒀다. 그런데 이 문장은 사람과
    //    점검 에이전트를 **정확히 안심시키는 방향으로** 틀린다 — 샘플이
    //    낡았을 때도 똑같이 나오기 때문이다. 배포되는 코드가 바뀌었으면
    //    최소한 "올릴 이유가 있다" 는 말은 해야 한다.
    why.push('라이브러리 코드가 바뀌었는데 산출물 차이가 안 보인다 — ' +
      '내부 변경이거나, 샘플이 낡았거나 둘 중 하나다');
    grade = '🟡';
  }
  if (!ev.library.length && !ev.template.length && grade === '⚪') {
    why.push('배포되는 파일이 하나도 안 바뀌었다 — 올릴 이유가 없다');
  }

  return { grade: grade, why: why };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--base');
  if (i !== -1 && (!argv[i + 1] || argv[i + 1].startsWith('--'))) {
    // 값 없는 --base 로 조용히 "비교 없음" 모드로 내려앉지 않는다.
    throw new Error('--base 뒤에 기준(태그·커밋)이 없다');
  }
  const base = i !== -1 ? argv[i + 1] : lastTag();

  // ⚠️ 기준이 HEAD 면 "바뀐 게 없다 → ⚪ → 올릴 이유가 없다" 가 나온다.
  //    SKILL 이 태그를 최종 커밋에 다니, 재실행하면 태그가 HEAD 를 가리켜
  //    이 상태에 쉽게 빠진다. 확신에 찬 틀린 문장이라 특히 나쁘다.
  if (base && git(['rev-parse', base + '^{commit}']) === git(['rev-parse', 'HEAD'])) {
    throw new Error('기준(' + base + ')이 HEAD 와 같다 — 비교할 게 없다. --base 로 직전 릴리스를 지정해라.');
  }

  const ev = collect(base);
  const s = suggest(ev);
  const result = Object.assign({ suggested: s.grade, reasons: s.why }, ev);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('기준: ' + (base || '(태그 없음)'));
  console.log('바뀐 파일 ' + ev.files.length + '개' +
    (ev.library.length ? ' · 라이브러리: ' + ev.library.map(function (f) { return path.basename(f); }).join(' ') : '') +
    (ev.template.length ? ' · 템플릿: ' + ev.template.map(function (f) { return path.basename(f); }).join(' ') : ''));
  if (!ev.sample.unavailable) {
    console.log('산출물: 숫자 ' + ev.sample.changed.length + '곳 변경 · ' +
      ev.sample.added.length + '개 추가 · ' + ev.sample.removed.length + '개 삭제 · ' +
      '안내문 ' + ev.sample.prose.length + '곳');
    ev.sample.changed.slice(0, 5).forEach(function (c) {
      console.log('  ' + c.path + ': ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to));
    });
    if (ev.sample.changed.length > 5) console.log('  … 외 ' + (ev.sample.changed.length - 5) + '곳');
  }
  console.log('');
  console.log('등급 하한: ' + s.grade);
  s.why.forEach(function (w) { console.log('  · ' + w); });
}

module.exports = { flatten: flatten, diffSample: diffSample, suggest: suggest, collect: collect };

if (require.main === module) main();
