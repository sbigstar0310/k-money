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

const os = require('os');

const ROOT = path.join(__dirname, '..');
const build = require('../scripts/build-deploy');
const record = require('../scripts/record-deploy');
const deploy = require('../scripts/deploy');

/**
 * ⚠️ **테스트는 진짜 `build/` 에 쓰지 않는다.**
 *
 * 처음엔 그렇게 했는데, `throws` 를 기대하는 테스트가 복사까지 해 놓고
 * 매니페스트 쓰기 직전에 죽어서 **`npm test` 는 초록인데 `build/` 가 반쯤
 * 남았다.** 그 상태로 배포하면 `deploy.js` 는 디스크를 그냥 읽으므로
 * 라이브러리 쪽은 완비돼 보여서 **조용히 성공한다.**
 * 더 나쁜 건 `build('99')` 가 남긴 가짜 버전 번호가 그대로 배포되는 것이다.
 */
function tmpOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kmoney-build-'));
}

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
  const dir = tmpOut();
  const out = build.build(null, dir);
  ['library', 'template'].forEach((target) => {
    const got = fs.readdirSync(path.join(dir, target)).sort();
    const want = out.files[target].slice().sort();
    // 스냅샷은 대조용이라 목록 밖이다.
    assert.deepEqual(got.filter((f) => f !== build.LIBRARY_MANIFEST_SNAPSHOT), want,
      target + ' 에 목록에 없는 파일이 있거나 빠졌다');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('빌드가 라이브러리 번호를 템플릿 매니페스트에 주입한다', () => {
  const dir = tmpOut();
  const out = build.build('99', dir);
  assert.equal(out.libVersion, '99');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'template', 'appsscript.json'), 'utf8'));
  assert.equal(m.dependencies.libraries[0].version, '99');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('배포 번호가 정수가 아니면 빌드가 죽는다', () => {
  // deploymentId 는 'AKfycb…' 문자열이고 versionNumber 는 정수다.
  // 둘을 헷갈리면 유저 드롭다운에 없는 값이 매니페스트에 박힌다.
  const dir = tmpOut();
  assert.throws(() => build.build('AKfycbxyz', dir), /정수가 아니다/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('스탬프가 없으면 배포 전에 죽는다', () => {
  // build/ 가 지금 커밋에서 나온 것인지 보는 유일한 장치다. 스탬프를 맨
  // 마지막에 쓰므로, 빌드가 중간에 죽으면 스탬프가 없어서 여기서 걸린다.
  const dir = tmpOut();
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true });
  assert.throws(() => build.assertFresh('library', dir), /\.built\.json 이 없다/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('다시 빌드해도 배포 기록이 살아남는다 (같은 커밋일 때)', () => {
  // ⚠️ 이게 파이프라인을 못 끝내게 하던 버그다. 7절이 --lib-version 으로
  //    다시 빌드하는데 rmrf 가 5절의 기록을 지워서, --template 이 "어느 번호를
  //    기대하는지 모른다" 로 죽었다. 그 자리는 **라이브러리 버전이 이미 영구
  //    생성된 뒤**라 되돌릴 수 없다.
  const dir = tmpOut();
  build.build(null, dir);
  fs.writeFileSync(path.join(dir, '.deployed.json'),
    JSON.stringify({ libVersion: 14, deploymentId: 'AKfycbx', gitHead: build.gitHead() }));

  const out = build.build('14', dir);
  assert.equal(out.carriedDeploy, '14', '다시 빌드하면서 배포 기록이 사라졌다');
  assert.ok(fs.existsSync(path.join(dir, '.deployed.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('커밋이 다르면 배포 기록을 버린다', () => {
  // 다른 커밋에서 배포한 번호를 이번 템플릿에 박으면 유저가 엉뚱한
  // 라이브러리를 받는다. 없는 것보다 낡은 게 나쁘다.
  const dir = tmpOut();
  build.build(null, dir);
  fs.writeFileSync(path.join(dir, '.deployed.json'),
    JSON.stringify({ libVersion: 14, gitHead: 'deadbeef' }));

  const out = build.build('14', dir);
  assert.equal(out.carriedDeploy, null, '다른 커밋의 배포 기록이 살아남았다');
  assert.ok(!fs.existsSync(path.join(dir, '.deployed.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AI 드라이브 커넥터 범위가 SECURITY.md 에 적혀 있다', () => {
  // ⚠️ 이 사실은 한때 install.md 에만 있었고, 안내를 줄이면서 **저장소에서
  //    통째로 사라졌었다.** 설치 안내는 방법 1 을 (권장) 이라 하고 README 는
  //    "나만 볼 수 있습니다" 라고 하는데, 그 둘을 상쇄하던 유일한 문장이었다.
  //
  //    install.md 에 다시 넣지 않는 것은 의도다 — 설치 화면에서 겁을 주지
  //    않기로 했다. 대신 위험을 모아 두는 자리에 둔다. 다만 **어느 문서에도
  //    없는 상태로는 돌아가지 않는다.** 그게 이 테스트가 있는 이유다.
  const md = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(md, /돈동생.{0,3}폴더 밖|폴더뿐 아니라/,
    'SECURITY.md 에서 AI 드라이브 커넥터 범위 설명이 사라졌다');
  assert.match(md, /방법 2/, '대안(파일 직접 올리기)을 가리키지 않는다');
});

test('appsscript/ 의 모든 .gs 가 어디로 갈지 정해져 있다', () => {
  // ⚠️ 화이트리스트의 반대 방향 실패다. 새 .gs 를 추가하고 TARGETS 에 넣는
  //    걸 잊으면 로컬 테스트는 전부 통과하고 **배포된 라이브러리에서만**
  //    ReferenceError 가 난다. 그때는 유저 손에서 터진다.
  const onDisk = fs.readdirSync(path.join(ROOT, 'appsscript'))
    .filter((f) => f.endsWith('.gs')).sort();
  const routed = build.TARGETS.library.files
    .concat(build.TARGETS.template.files)
    .concat(['template.gs'])  // 개발자 1회용. 어디에도 안 나간다
    .sort();
  assert.deepEqual(onDisk, routed,
    'appsscript/ 의 .gs 중 배포 목록에 없는 것이 있다 — 어디로 보낼지 정해라');
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

test('배포 스크립트가 자격증명을 로그에 넣지 않는다', () => {
  // 이 스크립트들의 출력은 터미널만이 아니라 에이전트 트랜스크립트에도
  // 남는다. 즉 사실상 영구 기록이다. 지금은 깨끗한데, 6개월 뒤 디버깅하다
  // 한 줄 추가되는 걸 막는다.
  ['deploy.js', 'deploy-login.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    const bad = src.split('\n')
      .filter((l) => /console\.(log|error)/.test(l))
      .filter((l) => /clientSecret|refreshToken|refresh_token|access_token/.test(l));
    assert.deepEqual(bad, [], f + ' 가 자격증명을 출력한다');
  });
});

test('템플릿 스코프가 정확히 넷이고 늘지 않는다', () => {
  // ⚠️ 스코프 증가가 이 프로젝트 최대 리스크다. 예전엔 이걸 "에이전트가
  //    install.md 표와 대조하기" 로 뒀는데, 확실한 검사를 불확실한 검사로
  //    덮는 것이었다. 늘어나면 npm run check 가 빨갛게 죽는 게 맞다.
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript', 'appsscript.json'), 'utf8'));
  assert.deepEqual(m.oauthScopes, [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.scriptapp',
  ], '스코프가 바뀌었다 — 늘렸다면 SECURITY.md·install.md·이 테스트를 같이 고쳐라');
});

test('배포되는 코드에 데이터를 밖으로 여는 통로가 없다', () => {
  // SECURITY.md 가 유저에게 약속한 것이 이것이다. UrlFetchApp 만 막으면
  // 부족하다 — spreadsheets 권한으로 =IMPORTDATA 를 써 넣으면 구글 서버가
  // 대신 요청을 보내고, drive 권한으로 공유 설정을 열 수 있다.
  const banned = ['UrlFetchApp', 'IMPORTDATA', 'IMPORTXML', 'IMPORTRANGE',
    'setSharing', 'addEditor', 'eval('];

  // ⚠️ 주석은 뺀다. `app.gs` 의 `safeCell()` 은 `' =IMPORTDATA(...)'` 가 수식으로
  //    읽히는 걸 **막는** 코드이고, 주석이 그걸 설명한다. 그걸 위반으로 세면
  //    방어 코드를 문서화한 대가로 테스트가 빨개진다 — 그러면 다음 사람은
  //    주석을 지운다. 경보가 나쁜 행동을 부르면 안 된다.
  const stripComments = function (s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  };

  build.TARGETS.library.files.concat(build.TARGETS.template.files).forEach((f) => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'appsscript', f), 'utf8'));
    banned.forEach((b) => {
      assert.ok(src.indexOf(b) === -1, f + ' 의 코드에 ' + b + ' 가 있다');
    });
  });
});

test('라이브러리 매니페스트 스냅샷이 저장소에 있다', () => {
  // 없으면 deploy.js 의 원격 매니페스트 대조가 **통째로 꺼진다.**
  // 꺼진 줄 모르고 도는 게 최악이라, 있는 걸 테스트가 지킨다.
  const p = path.join(ROOT, 'appsscript', build.LIBRARY_MANIFEST_SNAPSHOT);
  assert.ok(fs.existsSync(p), build.LIBRARY_MANIFEST_SNAPSHOT + ' 이 없다 — --snapshot-manifest');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  // 라이브러리는 호출 스크립트의 스코프로 돈다. 자기 스코프를 들고 있으면
  // 유저 동의 화면이 늘어날 수 있으므로 없어야 한다.
  assert.ok(!m.oauthScopes, '라이브러리 매니페스트에 oauthScopes 가 생겼다');
});

// ─── 배포되는 코드에 실측 금액이 섞이지 않게 ──────────────────────────

/**
 * 나가는 코드에 **개발자 본인 데이터의 원 단위 금액**이 남지 않게 한다.
 *
 * ⚠️ 이건 배포 직전 눈으로 훑어서 두 번 놓친 검사다. 처음엔 '실측' 이라는
 *    **낱말**로 찾아서 숫자만 있는 세 곳을 놓쳤고, 그다음엔 정규식에 `원`
 *    **접미사**를 요구해서 `"...순액이 8,917,889" 를 만든다` 를 놓쳤다.
 *    두 번 다 "무엇을 찾을지" 가 아니라 "어떻게 생겼는지" 를 잘못 잡은 것이다.
 *    그래서 사람의 성실성이 아니라 **숫자 모양**에 건다.
 *
 * 라이브러리 버전은 지우는 API 가 없다. 한 번 나가면 그 파일이 영원히
 * 유저 드롭다운에 남는다 — 되돌릴 수 없는 자리라 검사를 판단에 안 맡긴다.
 *
 * 새 숫자를 넣어야 하면 **왜 개인 데이터가 아닌지 여기 적고** 통과시킨다.
 * 목록에 이름을 적는 부담이 곧 브레이크다.
 */
const ALLOWED_NUMERALS = {
  // 부호 규약을 설명하는 교과서 예시 (core/model.js)
  '100,000': '수입 +100,000 예시',
  '25,000': '지출 −25,000 / 환불 +25,000 예시',
  // "700만 받고 700만 보내면 순액 0" 가정형에서 나오는 합 (core/analyze.js)
  '1,400': '가정형 예시의 총액',
  // 익명화하며 만원대로 뭉갠 값들
  '1,000': '−1,000만원대 / +1,000만원대',
  '1,200': '부채 예시 1,200만원',
  // 금융 데이터가 아니라 산출물·테스트 파일의 크기
  '12,831': '긴 공백을 채웠을 때의 산출물 bytes',
  '121,210': 'ZipCrypto 이식을 검증한 테스트 zip 의 bytes',
  '30.436875': '평균 월 길이 (365.25 / 12)',
};

test('배포되는 코드에 실측 금액이 남아 있지 않다', () => {
  // 쉼표로 세 자리씩 끊긴 수, 그리고 소수점 아래가 긴 수.
  // 실측 금액은 이 둘 중 하나의 모양으로 온다.
  const SHAPES = /[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+\.[0-9]{4,}/g;

  const targets = [];
  for (const dir of ['core', 'appsscript']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (/\.(js|gs)$/.test(name)) targets.push(path.join(dir, name));
    }
  }
  assert.ok(targets.length > 5, '검사 대상을 못 찾았다 — 경로가 바뀌었나');

  const hits = [];
  for (const rel of targets) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    src.forEach((line, i) => {
      for (const m of line.match(SHAPES) || []) {
        if (ALLOWED_NUMERALS[m]) continue;
        hits.push(rel + ':' + (i + 1) + '  ' + m + '   ' + line.trim().slice(0, 72));
      }
    });
  }

  assert.deepEqual(hits, [],
    '배포되는 코드에 실측으로 보이는 숫자가 있다. 개인 데이터가 아니라면 ' +
    'ALLOWED_NUMERALS 에 이유와 함께 적어라:\n' + hits.join('\n'));
});
