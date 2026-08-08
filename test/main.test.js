/**
 * main.gs — Apps Script 결선 코드의 순수 부분을 검증한다.
 *
 * main.gs 는 오래 테스트가 없었고, 실제로 그래서 여러 개가 새어 나갔다.
 * Gmail·Drive·Sheet 를 건드리는 부분은 여기서 못 돌리지만, **판단을 하는
 * 부분**과 **매니페스트가 코드와 맞는지**는 돌릴 수 있다. 판단이 틀리면
 * 유저는 멀쩡한 걸 고치러 가고, 매니페스트가 어긋나면 아무도 못 쓴다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'appsscript', 'main.gs'), 'utf8');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'appsscript', 'appsscript.json'), 'utf8'));

/**
 * main.gs 를 격리된 컨텍스트에서 평가한다.
 * stubs 로 Apps Script 전역을 흉내 낸다. 안 준 건 없는 것이다.
 */
function loadMain(stubs) {
  const ctx = vm.createContext(Object.assign({ Logger: { log() {} } }, stubs));
  vm.runInContext(SRC, ctx);
  return ctx;
}

/** 라이브러리가 정상 연결된 상태. */
function lib(version) {
  return { kmoneylib: { buildFacts() {}, version: () => version, schema: () => 'facts@2' } };
}

// ── 인터넷에 나가지 않는다 ─────────────────────────────────────────
//
// 이건 편의 기능이 아니라 **이 프로젝트가 유저에게 하는 약속**이다.
// Gmail 전체 읽기 권한으로 도는 스크립트라, "밖으로 나갈 길이 없다" 를
// 코드가 아니라 권한 목록만 보고 확인할 수 있어야 한다.

/**
 * `name` 이 **주석 밖에서** 나오는 줄들.
 *
 * 주석을 정규식으로 걷어내는 방법을 먼저 썼다가 물렸다. `'a//b'` 같은
 * 문자열이 있으면 그 줄의 뒷부분이 통째로 잘려서, 거기 있는 진짜 호출이
 * **사라진 채로 통과한다.** 보안 단언에서 과다 제거는 위음성이라 최악이다.
 * 그래서 원문을 줄 단위로 보고, 주석으로 시작하는 줄만 뺀다.
 */
function codeLines(src, name) {
  return src.split('\n')
    .filter((l) => l.indexOf(name) !== -1)
    .map((l) => l.trim())
    .filter((l) => !/^(\/\/|\*|\/\*)/.test(l));
}

/**
 * 주석 줄을 걷어낸 main.gs. 줄 단위라 문자열 안의 `//` 에 물리지 않는다.
 * (블록 주석 본문은 `*` 로 시작하므로 같이 걸린다.)
 */
const CODE = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/** 실제로 유저 계정에서 도는 파일들. 개발용(probe·verify·template)은 뺀다. */
const DEPLOYED = ['main.gs', 'core.gs', 'zipcrypto.gs', 'library-api.gs'];

test('배포되는 어떤 .gs 에도 외부 통신이 없다', () => {
  // ⚠️ main.gs 만 보면 안 된다. **라이브러리는 호출 스크립트의 스코프로 돈다.**
  //    core.gs 는 빌드 산물이라 눈으로 훑을 일이 없어서, 실수로 들어와도
  //    제일 늦게 발견된다.
  DEPLOYED.forEach((f) => {
    const p = path.join(ROOT, 'appsscript', f);
    if (!fs.existsSync(p)) return;
    const hits = codeLines(fs.readFileSync(p, 'utf8'), 'UrlFetchApp');
    assert.deepEqual(hits, [], f + ' 에서 UrlFetchApp: ' + hits.join(' | '));
  });
});

test('배포되는 모든 .gs 가 존재한다', () => {
  // 위 테스트가 없는 파일을 조용히 건너뛰므로, 여기서 목록을 붙잡아 둔다.
  DEPLOYED.forEach((f) => {
    assert.ok(fs.existsSync(path.join(ROOT, 'appsscript', f)), f + ' 이 없다');
  });
});

test('매니페스트에 외부 통신 스코프가 없다', () => {
  const have = MANIFEST.oauthScopes || [];
  assert.ok(
    have.indexOf('https://www.googleapis.com/auth/script.external_request') === -1,
    '코드가 안 쓰는 스코프를 요구하면 동의 화면만 무서워지고 얻는 게 없다');
});

// ── 버전 표시 ──────────────────────────────────────────────────────

test('versionText_ — 두 버전을 따로 보여준다', () => {
  // 라이브러리는 유저가 드롭다운으로 갈아끼울 수 있고, main.gs 는 시트 안에
  // 복사돼 있어 못 바꾼다. 하나로 합쳐 보여주면 옛 main.gs 로 도는 걸 감춘다.
  const ctx = loadMain(lib('0.1.1'));
  const t = ctx.versionText_();
  assert.match(t, /시트 스크립트: 0\.1\.1/);
  assert.match(t, /집계 라이브러리: 0\.1\.1/);
});

test('versionText_ — 라이브러리를 못 찾아도 죽지 않는다', () => {
  const t = loadMain({}).versionText_();
  assert.match(t, /시트 스크립트:/);
  assert.match(t, /못 찾았습니다/);
});

test('versionText_ — version() 이 던져도 예외가 새어 나가지 않는다', () => {
  // 라이브러리 공유가 풀리거나 core.gs 없이 library-api.gs 만 올라간 상태.
  // 컨텍스트를 넘는 호출이라 감싸지 않으면 그대로 날 것으로 뜬다 —
  // 그게 "업데이트 확인에서 오류 발생" 의 정체였다.
  const ctx = loadMain({
    kmoneylib: { buildFacts() {}, version() { throw new Error('보이지 않는 라이브러리'); } },
  });
  assert.match(ctx.versionText_(), /못 찾았습니다/);
});

test('버전 안내가 설정을 날리라고 하지 않는다', () => {
  // 사본을 새로 만들면 스크립트 속성(비밀번호)과 트리거가 **따라오지 않는다.**
  // 편의 기능 하나 때문에 설정을 날리라고 하는 건 조언이 아니다.
  const i = SRC.indexOf('function menu_version');
  // indexOf 가 -1 이면 slice(-1) 은 파일의 마지막 한 글자다. 그러면 아래
  // 단언이 무조건 통과한다 — 함수 이름을 바꾸는 순간 보호가 증발한다.
  assert.notEqual(i, -1, 'menu_version 이 사라졌다 — 이 테스트가 헛돌고 있다');
  assert.doesNotMatch(SRC.slice(i), /사본|다시 복사|새로 만드/);
});

// ── 데이터가 멈춘 걸 알아채는가 ────────────────────────────────────
//
// 이 도구가 조용히 죽는 방식이 정확히 이거다. 유저가 뱅샐 내보내기를 그만두면
// 트리거는 매일 성공하고 시트에는 초록 체크와 오늘 날짜가 찍힌다.

/** 오늘로부터 n일 전 'YYYY-MM-DD'. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function propsStub(map) {
  return { getProperty: (k) => (k in map ? map[k] : null), setProperty(k, v) { map[k] = v; } };
}

test('freshnessLine_ — 데이터를 한 번도 못 받았으면 그렇게 말한다', () => {
  const ctx = loadMain({});
  const line = ctx.freshnessLine_(ctx.dataAge_(propsStub({})));
  assert.match(line, /아직 받은 데이터가 없어요/);
});

test('freshnessLine_ — 오래되면 경고하고 며칠인지 센다', () => {
  const ctx = loadMain({});
  const props = propsStub({ LAST_INGEST_DATE: daysAgo(40) });
  const line = ctx.freshnessLine_(ctx.dataAge_(props));
  assert.match(line, /⚠️/);
  assert.match(line, /40일 전/);
  assert.match(line, /다시 내보내/);
});

test('freshnessLine_ — 최근이면 경고하지 않는다', () => {
  const ctx = loadMain({});
  const line = ctx.freshnessLine_(ctx.dataAge_(propsStub({ LAST_INGEST_DATE: daysAgo(2) })));
  assert.doesNotMatch(line, /⚠️/);
  assert.match(line, /2일 전/);
});

test('dataAge_ — 깨진 값에 NaN 을 내보내지 않는다', () => {
  const ctx = loadMain({});
  assert.equal(ctx.dataAge_(propsStub({ LAST_INGEST_DATE: '언젠가' })).days, null);
});

test('process_ 성공 경로가 마지막 수신일을 기록한다', () => {
  // 이걸 안 적으면 신선도를 계산할 근거가 없다.
  assert.match(SRC, /props\.setProperty\(PROP\.lastIngest, stamp\)/);
});

// ── 시트에 쓰는 값 ─────────────────────────────────────────────────

test('safeCell_ — 수식으로 읽힐 수 있는 값을 막는다', () => {
  const ctx = loadMain({});
  // spreadsheets 권한이 있으니 =IMPORTDATA 같은 수식은 구글 서버가 대신
  // 요청을 보내는 통로가 된다. 우리 문자열은 안전하지만 여기서 한 번 막는다.
  assert.equal(ctx.safeCell_('=IMPORTDATA("http://x")'), "'=IMPORTDATA(\"http://x\")");
  assert.equal(ctx.safeCell_('+1'), "'+1");
  assert.equal(ctx.safeCell_('@x'), "'@x");
  assert.equal(ctx.safeCell_('✅ 정상'), '✅ 정상');
});

test('상태 칸이 템플릿과 main.gs 에서 같은 곳을 가리킨다', () => {
  // template.gs 는 고쳐서 다시 배포할 수 있지만 main.gs 는 유저 시트 안의
  // 사본이라 못 고친다. 한쪽만 옮기면 기존 설치는 **오류 없이** 엉뚱한 칸에
  // 쓰게 되고, 유저 화면은 영원히 첫 문구 그대로 남는다.
  const tpl = fs.readFileSync(path.join(ROOT, 'appsscript', 'template.gs'), 'utf8');
  const cell = (src, name) => new RegExp(name + " = '([A-Z]+\\d+)'").exec(src);
  const status = cell(tpl, 'TEMPLATE_STATUS_CELL');
  const checked = cell(tpl, 'TEMPLATE_CHECKED_CELL');
  assert.ok(status && checked, 'template.gs 의 상태 칸 상수를 못 찾았다');
  assert.match(CODE, new RegExp("getRange\\('" + status[1] + "'\\)"),
    'main.gs 가 ' + status[1] + ' 에 안 쓴다');
  assert.match(CODE, new RegExp("getRange\\('" + checked[1] + "'\\)"),
    'main.gs 가 ' + checked[1] + ' 에 안 쓴다');
});

test('상태를 이름으로 찾은 시트에 쓴다', () => {
  // getSheets()[0] 만 쓰면 유저가 시트를 하나 추가하는 순간 남의 시트에 쓴다.
  assert.match(CODE, /getSheetByName\(STATUS_SHEET\)/);
});

// ── 비밀번호 힌트 ──────────────────────────────────────────────────

test('hint_ — 별 개수가 자릿수와 맞는다', () => {
  // 문서에 첫 글자·끝 글자·**자릿수**를 보여준다고 약속했다. 유저는 별을
  // 세어서 비밀번호를 떠올리므로, 하나 어긋나면 틀린 길이로 입력한다.
  const { hint_ } = loadMain({});
  ['abcd', '0930', 'a1b2c3d4', '가나다라마'].forEach((pw) => {
    assert.equal(hint_(pw).length, pw.length, pw + ' 의 힌트 길이');
  });
  assert.equal(hint_('abcd'), 'a**d');
});

test('hint_ — 짧은 비밀번호는 답을 흘리지 않는다', () => {
  const { hint_ } = loadMain({});
  ['a', 'ab'].forEach((pw) => {
    assert.doesNotMatch(hint_(pw), new RegExp(pw), pw + ' 가 힌트에 그대로 보인다');
  });
});

// ── 유저에게 보이는 문자열 ─────────────────────────────────────────

test('유저에게 보이는 문자열에 마크다운을 쓰지 않는다', () => {
  // ui.alert 는 평문만 렌더한다. **강조** 는 별표가 그대로 보인다.
  // 주석은 CODE 에서 이미 빠졌으므로 남은 건 진짜 문자열이다.
  const literals = [...CODE.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  const bad = literals.filter((l) => l.indexOf('**') !== -1);
  assert.deepEqual(bad, [], '별표가 그대로 보인다: ' + bad.join(' | '));
});

// ── 잠금 ───────────────────────────────────────────────────────────

test('사람이 누르는 실행도 잠금을 잡는다', () => {
  // 아침 트리거와 겹치면 임시 시트가 둘, latest.json 쓰기가 둘이 되고
  // pruneFacts_ 가 서로가 쓰는 걸 지운다.
  const i = CODE.indexOf('function menu_runNow');
  assert.notEqual(i, -1);
  const body = CODE.slice(i, i + 1400);
  assert.match(body, /LockService\.getScriptLock/);
  assert.match(body, /releaseLock/);
  assert.match(body, /catch/, '라이브러리를 못 찾으면 날 것의 TypeError 가 뜬다');
});

// ── 라이브러리 탐색 ────────────────────────────────────────────────

test('resolveApi_ — 식별자를 바꿔도 모양으로 찾는다', () => {
  const ctx = loadMain({ 내라이브러리: { buildFacts() {}, version: () => '0.1.0' } });
  assert.match(ctx.resolveApi_().via, /모양으로 찾음/);
});

test('resolveApi_ — 아무것도 없으면 못 찾았다고 한다', () => {
  assert.equal(loadMain({}).resolveApi_().via, '못 찾음');
});

// ── 버전 표기가 세 군데에서 일치하는가 ──────────────────────────────

test('VERSION · package.json · MAIN_VERSION 이 같다', () => {
  // 어긋나면 유저에게 보여주는 버전이 거짓말이 된다.
  const fileVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const pkg = require(path.join(ROOT, 'package.json')).version;
  const mainVersion = /var MAIN_VERSION = '([^']+)'/.exec(SRC)[1];

  assert.match(fileVersion, /^\d+\.\d+\.\d+$/, 'VERSION 은 v 접두사 없는 semver 여야 한다');
  assert.equal(pkg, fileVersion);
  assert.equal(mainVersion, fileVersion, 'main.gs 의 MAIN_VERSION 을 같이 올려야 한다');

  // README 상단에도 적혀 있다. 유저에게 "최신은 저장소에서" 라고 안내하므로
  // 저장소가 옛 번호를 들고 있으면 그 안내가 헛돈다.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const shown = /현재 버전 \*\*([\d.]+)\*\*/.exec(readme);
  assert.ok(shown, 'README 에 현재 버전 표기가 없다');
  assert.equal(shown[1], fileVersion, 'README 의 버전이 뒤처졌다');
});

// ── 매니페스트가 코드와 맞는가 ─────────────────────────────────────

/**
 * 코드가 어떤 서비스를 쓰면 어떤 스코프가 필요한가.
 *
 * PropertiesService · LockService · Session.getScriptTimeZone · Utilities 는
 * 스코프가 필요 없어서 여기 없다. ui.alert/prompt/createMenu 도 필요 없다 —
 * 다만 **HtmlService 다이얼로그로 바꾸면 script.container.ui 가 필요해진다.**
 * 비밀번호가 평문으로 보이는 걸 고치려다 그걸 건드리기 쉬우니 적어 둔다.
 */
const NEED = [
  [/GmailApp\./, 'https://www.googleapis.com/auth/gmail.readonly'],
  [/DriveApp\.|Drive\.Files\./, 'https://www.googleapis.com/auth/drive'],
  [/SpreadsheetApp\./, 'https://www.googleapis.com/auth/spreadsheets'],
  [/ScriptApp\.newTrigger|ScriptApp\.getProjectTriggers/, 'https://www.googleapis.com/auth/script.scriptapp'],
  [/UrlFetchApp\./, 'https://www.googleapis.com/auth/script.external_request'],
];

test('매니페스트 스코프가 코드가 실제로 쓰는 것을 덮는다', () => {
  // oauthScopes 를 **적는 순간 Apps Script 의 자동 추론이 꺼진다.** 하나
  // 빠뜨리면 그 API 만 조용히 던지고 나머지는 멀쩡히 돌아서 늦게 안다.
  // 실제로 spreadsheets.currentonly 를 적어놓고 openById 를 불러서
  // 매일 돌던 파이프라인을 깰 뻔했다.
  const have = MANIFEST.oauthScopes || [];
  NEED.forEach(([pattern, scope]) => {
    if (pattern.test(CODE)) {
      assert.ok(have.indexOf(scope) !== -1,
        'main.gs 가 ' + pattern + ' 을 쓰는데 매니페스트에 ' + scope + ' 이 없다');
    }
  });
});

test('매니페스트에 코드가 안 쓰는 스코프가 없다', () => {
  // 한 방향만 보면 코드에서 지운 기능의 스코프가 남는다. 실제로
  // script.external_request 가 그렇게 남아 동의 화면만 무서워질 뻔했다.
  const used = NEED.filter(([p]) => p.test(CODE)).map(([, s]) => s);
  (MANIFEST.oauthScopes || []).forEach((s) => {
    assert.ok(used.indexOf(s) !== -1, s + ' 을 요구하는데 코드에서 안 쓴다');
  });
});

test('install.md 스코프 표가 매니페스트와 정확히 같다', () => {
  // 유저에게 "정확히 말씀드릴게요" 라고 해놓은 표다. 어긋나면 그 문장이 거짓말이 된다.
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8');
  const rows = [...md.matchAll(/^\| `([a-z._]+)` \|/gm)].map((m) => m[1]);
  const short = (MANIFEST.oauthScopes || []).map((s) => s.replace(/^.*\/auth\//, ''));
  assert.deepEqual(rows, short);
});

test('openById 를 쓰면서 currentonly 로 좁히지 않는다', () => {
  // spreadsheets.currentonly 는 바인딩된 시트 하나만 준다. 우리는 변환한
  // 임시 시트를 openById 로 연다 — currentonly 로는 거기서 던진다.
  const have = MANIFEST.oauthScopes || [];
  if (/SpreadsheetApp\.openById/.test(CODE)) {
    assert.ok(have.indexOf('https://www.googleapis.com/auth/spreadsheets.currentonly') === -1,
      'openById 를 쓰는 코드에 currentonly 를 걸면 매일 실행이 깨진다');
  }
});

test('매니페스트가 라이브러리를 고정 버전으로 참조한다', () => {
  const libs = (MANIFEST.dependencies || {}).libraries || [];
  assert.equal(libs.length, 1);
  assert.equal(libs[0].developmentMode, false, 'HEAD 로 두면 유저가 우리 미완성 코드를 쓴다');
  assert.match(String(libs[0].version), /^\d+$/, '라이브러리 버전은 정수다');
});

// ── 메뉴가 실제 함수를 가리키는가 ──────────────────────────────────

test('메뉴 항목이 전부 존재하는 함수를 가리킨다', () => {
  // addItem 의 두 번째 인자는 문자열이라 오타가 나도 로드 시점에 안 걸린다.
  // 유저가 눌러야 비로소 "스크립트 함수를 찾을 수 없습니다" 가 뜬다.
  const handlers = [...SRC.matchAll(/\.addItem\('[^']*',\s*'([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(handlers.length >= 5, '메뉴 항목을 못 읽었다');
  handlers.forEach((fn) => {
    assert.match(SRC, new RegExp('function\\s+' + fn + '\\s*\\('), fn + ' 이 없다');
  });
});
