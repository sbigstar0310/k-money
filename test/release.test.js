'use strict';

/**
 * 배포 파이프라인 회귀 테스트.
 *
 * 여기서 지키려는 건 하나다 — **조용히 잘못되는 길을 막는 것.**
 * 배포는 실패하면 눈에 띄지만, 잘못 성공하면 유저가 오류 없이 옛 코드로 돈다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const build = require('../scripts/build-deploy');
const record = require('../scripts/record-deploy');
const deploy = require('../scripts/deploy');

// ─── build-deploy ────────────────────────────────────────────────────

test('배포 대상 목록이 화이트리스트다 — 목록에 없으면 안 나간다', () => {
  // updateContent 는 요청에 없는 원격 파일을 **전부 지운다.** 무시 목록으로
  // 거르면 거르기에 실패하는 순간 원격이 사라진다. 그래서 명시 목록만 쓴다.
  assert.deepEqual(build.TARGETS.library.files,
    ['core.gs', 'zipcrypto.gs', 'app.gs', 'library-api.gs']);
  assert.deepEqual(build.TARGETS.template.files, ['container.gs']);
  assert.equal(build.TARGETS.template.manifest, 'appsscript.json');
});

test('core.gs 가 app.gs 보다 먼저 나간다', () => {
  // Apps Script 는 파일 순서대로 최상위 코드를 돌린다. app.gs 가 먼저 오면
  // core 참조가 undefined 로 잡히고, 죽지 않고 이상한 값을 낸다.
  const f = build.TARGETS.library.files;
  assert.ok(f.indexOf('core.gs') < f.indexOf('app.gs'), 'core.gs 가 app.gs 뒤에 있다');
  assert.ok(f.indexOf('core.gs') < f.indexOf('library-api.gs'));
});

test('template.gs 는 어디에도 안 들어간다', () => {
  // 개발자가 템플릿 시트를 꾸밀 때 한 번 쓰는 도구다. 유저에게도
  // 라이브러리에도 갈 이유가 없는데, 같은 디렉터리에 있어서 섞이기 쉽다.
  const all = build.TARGETS.library.files.concat(build.TARGETS.template.files);
  assert.ok(all.indexOf('template.gs') === -1, 'template.gs 가 배포 목록에 있다');
  assert.ok(fs.existsSync(path.join(ROOT, 'appsscript', 'template.gs')),
    'template.gs 가 사라졌다면 이 테스트의 전제가 바뀐 것이다');
});

test('라이브러리에는 매니페스트를 만들어 넣지 않는다', () => {
  // 라이브러리 프로젝트의 매니페스트는 저장소에 없고 편집기에만 있다.
  // 여기서 지어내면 무엇이 켜져 있는지 틀린 채로 다음 배포부터 굳는다.
  // deploy.js 가 원격에서 읽어 그대로 되쓴다.
  assert.equal(build.TARGETS.library.manifest, null);
});

test('빌드가 두 디렉터리를 만들고 목록대로만 담는다', () => {
  const out = build.build(null);
  ['library', 'template'].forEach((target) => {
    const dir = path.join(build.OUT, target);
    const got = fs.readdirSync(dir).sort();
    const want = out.files[target].slice().sort();
    // 스냅샷은 대조용이라 목록 밖이다.
    assert.deepEqual(got.filter((f) => f !== build.LIBRARY_MANIFEST_SNAPSHOT), want,
      target + ' 에 목록에 없는 파일이 있거나 빠졌다');
  });
});

test('빌드가 라이브러리 번호를 템플릿 매니페스트에 주입한다', () => {
  const out = build.build('99');
  assert.equal(out.libVersion, '99');
  const m = JSON.parse(fs.readFileSync(path.join(build.OUT, 'template', 'appsscript.json'), 'utf8'));
  assert.equal(m.dependencies.libraries[0].version, '99');
  build.build(null); // 원상 복구
});

test('배포 번호가 정수가 아니면 빌드가 죽는다', () => {
  // deploymentId 는 'AKfycb…' 문자열이고 versionNumber 는 정수다.
  // 둘을 헷갈리면 유저 드롭다운에 없는 값이 매니페스트에 박힌다.
  assert.throws(() => build.build('AKfycbxyz'), /정수가 아니다/);
});

// ─── record-deploy ───────────────────────────────────────────────────

test("CHANGELOG 의 '대기' 만 번호로 바뀐다", () => {
  const src = '## 0.9.9 — 2026-01-01 · 라이브러리 버전 대기\n\n본문\n';
  const out = record.recordChangelog(src, '0.9.9', 13);
  assert.match(out.text, /라이브러리 버전 `13`/);
  assert.equal(out.changed, true);
});

test('CHANGELOG 에 이미 다른 번호가 있으면 덮지 않고 죽는다', () => {
  // 두 번 배포했는데 첫 번째 번호가 남아 있으면 유저가 옛 코드를 고른다.
  const src = '## 0.9.9 — 2026-01-01 · 라이브러리 버전 `11`\n';
  assert.throws(() => record.recordChangelog(src, '0.9.9', 13), /이미 다른 번호/);
  const same = record.recordChangelog(src, '0.9.9', 11);
  assert.equal(same.changed, false, '같은 번호면 조용히 넘어간다');
});

test('이력표 마커 사이가 표가 아니면 죽는다', () => {
  // gen-agent-guide.js 가 겪은 함정과 같다 — 끝을 잘못 잡으면 그 사이가
  // 통째로 지워지는데 아무 에러도 안 난다.
  const bad = record.BEGIN + '\nfunction oops() {}\n' + record.END;
  assert.throws(() => record.recordHistory(bad, '0.9.9', 13, ''), /표가 아니다/);
});

test('이력표에 같은 번호를 두 번 적지 않는다', () => {
  const src = record.BEGIN + '\n| 라이브러리 버전 | 코드 버전 | 비고 |\n|---|---|---|\n' +
    '| 13 | 0.4.3 | 기존 |\n' + record.END;
  const out = record.recordHistory(src, '0.4.3', 13, '새로');
  assert.equal(out.changed, false);
});

test('이력표에 행이 붙고 마커가 남는다', () => {
  const src = record.BEGIN + '\n| 라이브러리 버전 | 코드 버전 | 비고 |\n|---|---|---|\n' +
    '| 13 | 0.4.3 | 기존 |\n' + record.END;
  const out = record.recordHistory(src, '0.5.0', 14, '새 줄');
  assert.match(out.text, /\| 14 \| 0\.5\.0 \| 새 줄 \|/);
  assert.ok(out.text.indexOf(record.BEGIN) !== -1 && out.text.indexOf(record.END) !== -1);
});

test('매니페스트 갱신이 형식을 안 건드린다', () => {
  // JSON 을 다시 찍으면 저장소 파일 형식이 통째로 바뀌어 diff 가 안 읽힌다.
  const src = fs.readFileSync(path.join(ROOT, 'appsscript', 'appsscript.json'), 'utf8');
  const out = record.recordManifest(src, 999);
  assert.match(out.text, /"version": "999"/);
  assert.equal(out.text.split('\n').length, src.split('\n').length, '줄 수가 바뀌었다');
});

test('실제 문서에 이력표 마커가 살아 있다', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'deploy.md'), 'utf8');
  assert.ok(md.indexOf(record.BEGIN) !== -1, 'docs/deploy.md 에 BEGIN 마커가 없다');
  assert.ok(md.indexOf(record.END) !== -1, 'docs/deploy.md 에 END 마커가 없다');
});

// ─── deploy (네트워크 없이 검증 가능한 부분) ──────────────────────────

test('파일 이름이 Apps Script API 표현으로 바뀐다', () => {
  assert.deepEqual(deploy.toApiFile('core.gs', 'x'), { name: 'core', type: 'SERVER_JS', source: 'x' });
  assert.deepEqual(deploy.toApiFile('appsscript.json', '{}'), { name: 'appsscript', type: 'JSON', source: '{}' });
  assert.throws(() => deploy.toApiFile('notes.txt', ''), /올릴 수 없는/);
});

test('되읽기 대조가 매니페스트는 파싱해서, 코드는 바이트로 본다', () => {
  // JSON 은 들여쓰기가 달라져도 내용이 같으면 통과해야 한다. 아니면 매번
  // 틀렸다고 나와서 **경보가 무의미해진다.**
  const sent = [{ name: 'appsscript', type: 'JSON', source: '{"a":1,"b":2}' }];
  const got = [{ name: 'appsscript', type: 'JSON', source: '{\n  "a": 1,\n  "b": 2\n}' }];
  assert.deepEqual(deploy.diffFiles(sent, got), []);

  const codeSent = [{ name: 'core', type: 'SERVER_JS', source: 'var a=1;' }];
  const codeGot = [{ name: 'core', type: 'SERVER_JS', source: 'var a = 1;' }];
  assert.equal(deploy.diffFiles(codeSent, codeGot).length, 1, '코드가 다른데 통과했다');
});

test('되읽기 대조가 빠진 파일과 남은 파일을 둘 다 잡는다', () => {
  const sent = [{ name: 'core', type: 'SERVER_JS', source: 'x' }];
  assert.match(deploy.diffFiles(sent, [])[0], /원격에 없다/);

  const got = [{ name: 'core', type: 'SERVER_JS', source: 'x' },
    { name: 'stale', type: 'SERVER_JS', source: 'y' }];
  assert.match(deploy.diffFiles(sent, got)[0], /원격에만 있다/);
});

// ─── impact — 등급을 감이 아니라 측정으로 ────────────────────────────

const impact = require('../scripts/impact');

test('생성 날짜는 잡음으로 걸러진다', () => {
  // 아무것도 안 고친 날에도 날짜는 바뀐다. 이걸 신호로 세면 매번 🔴 가 뜨고,
  // **매번 뜨는 경보는 곧 안 보는 경보가 된다.**
  const a = JSON.stringify({ generatedFor: '2026-06-30', flow: { income: 100 } });
  const b = JSON.stringify({ generatedFor: '2026-06-28', flow: { income: 100 } });
  const d = impact.diffSample(a, b);
  assert.deepEqual(d.changed, [], '날짜 변경이 숫자 변경으로 잡혔다');
});

test('안내문 변경과 숫자 변경을 가른다', () => {
  // hints 가 바뀌면 AI 가 답하는 방식이 달라지는 것이지 계산이 틀린 게 아니다.
  const a = JSON.stringify({ hints: { goals: '옛말' }, flow: { income: 100 } });
  const b = JSON.stringify({ hints: { goals: '새말' }, flow: { income: 100 } });
  const d = impact.diffSample(a, b);
  assert.equal(d.prose.length, 1);
  assert.equal(d.changed.length, 0);
});

test('숫자가 바뀌면 등급 하한이 🔴 이다', () => {
  const a = JSON.stringify({ flow: { income: 100 } });
  const b = JSON.stringify({ flow: { income: 200 } });
  const s = impact.suggest({ sample: impact.diffSample(a, b), library: [], template: [], agentGuide: false });
  assert.equal(s.grade, '🔴');
});

test('필드가 사라져도 🔴 이다', () => {
  // AI 가 찾던 값이 없어지면 "없는 키는 만들어내지 마세요" 를 지키는 AI 는
  // 답을 못 하고, 안 지키는 AI 는 지어낸다. 둘 다 나쁘다.
  const a = JSON.stringify({ flow: { income: 100 }, pace: { monthly: 5 } });
  const b = JSON.stringify({ flow: { income: 100 } });
  const s = impact.suggest({ sample: impact.diffSample(a, b), library: [], template: [], agentGuide: false });
  assert.equal(s.grade, '🔴');
});

test('배포 파일이 안 바뀌면 ⚪ 이고 그 이유를 말한다', () => {
  const same = JSON.stringify({ flow: { income: 100 } });
  const s = impact.suggest({
    sample: impact.diffSample(same, same), library: [], template: [], agentGuide: false });
  assert.equal(s.grade, '⚪');
  assert.match(s.why.join(' '), /올릴 이유가 없다/);
});

test('비교 대상이 없으면 ⚪ 라고 말하지 않는다', () => {
  // 직전 태그의 샘플을 못 읽었는데 ⚪ 라고 하면, 근거 없이 "안 올려도 된다" 는
  // 말을 유저에게 하는 것이다. 모르면 모른다고 해야 한다.
  const s = impact.suggest({ sample: { unavailable: true }, library: [], template: [], agentGuide: false });
  assert.notEqual(s.grade, '⚪');
});

test('AGENT.md 만 바뀌어도 🟡 이다', () => {
  const same = JSON.stringify({ flow: { income: 100 } });
  const s = impact.suggest({
    sample: impact.diffSample(same, same), library: ['appsscript/app.gs'],
    template: [], agentGuide: true });
  assert.equal(s.grade, '🟡');
});

test('자격증명 경로가 저장소 밖이다', () => {
  // 이 토큰은 유저 메일함을 읽는 코드를 배포할 수 있다. 저장소에 두면
  // 커밋 한 번으로 새어 나간다.
  assert.ok(deploy.CONFIG.indexOf(ROOT) !== 0, '자격증명이 저장소 안을 가리킨다');
});
