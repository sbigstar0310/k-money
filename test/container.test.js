/**
 * container.gs — 유저 시트 안에 복사되는 유일한 파일.
 *
 * **여기 있는 것은 우리가 고칠 수 없다.** 사본을 뜬 사람의 시트 안으로
 * 복사되고 그걸로 끝이다. 그래서 이 파일에 대한 테스트는 두 가지를 본다.
 *
 *   1. 로직이 새어 들어오지 않았는가 — 들어오면 영영 못 고친다
 *   2. 라이브러리와의 계약이 지켜지는가 — 메뉴 이름·버전·스코프
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const scan = require('./scan');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'appsscript', 'container.gs'), 'utf8');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'appsscript', 'appsscript.json'), 'utf8'));

const SCANNED = scan(SRC);
const CODE = SCANNED.code;

function loadContainer(stubs) {
  const ctx = vm.createContext(Object.assign({ Logger: { log() {} } }, stubs));
  vm.runInContext(SRC, ctx);
  return ctx;
}

/** 라이브러리가 정상 연결된 상태를 흉내 낸다. */
function fakeLib(over) {
  const app = Object.assign({
    process() { return { ok: true, step: 'done', message: 'ok' }; },
    menuSpec: () => [{ label: '① 처음 설정하기', handler: 'menu_setup' }],
    versionText: () => '시트 스크립트: 0.1.1\n집계 라이브러리: 0.1.1',
  }, over);
  return { getApp: () => app, KMApp: app };
}

// ── 로직이 새어 들어오지 않았는가 ─────────────────────────────────

test('컨테이너에 파이프라인 로직이 없다', () => {
  // ⚠️ 여기 들어온 것은 이미 설치한 사람에게 **영영 전달되지 않는다.**
  //    Gmail 검색·집계·Drive 저장은 전부 라이브러리(app.gs) 몫이다.
  const FORBIDDEN = [
    [/GmailApp\.search/, 'Gmail 검색'],
    [/getAttachments/, '첨부 고르기'],
    [/openById/, '시트 변환'],
    [/KM\.aggregate|KM\.parse/, '집계 호출'],
    [/unzipEncrypted/, '압축 해제'],
    [/createFile|setContent/, 'Drive 쓰기'],
  ];
  FORBIDDEN.forEach(([re, what]) => {
    assert.doesNotMatch(CODE, re, what + ' 이 컨테이너에 있다 — 고칠 수 없는 곳이다');
  });
});

test('컨테이너가 충분히 작다', () => {
  // 커지고 있다면 로직이 새고 있다는 신호다. 숫자 자체보다 방향이 중요하다.
  const lines = CODE.split('\n').filter((l) => l.trim()).length;
  assert.ok(lines < 140, '실질 코드가 ' + lines + '줄이다. 라이브러리로 밀어라');
});

// ── 인터넷에 나가지 않는다 ────────────────────────────────────────

/** 실제로 유저 계정에서 도는 파일들. 개발용(probe·verify·template)은 뺀다. */
const DEPLOYED = ['container.gs', 'app.gs', 'core.gs', 'zipcrypto.gs', 'library-api.gs'];

test('배포되는 모든 .gs 가 존재한다', () => {
  DEPLOYED.forEach((f) => {
    assert.ok(fs.existsSync(path.join(ROOT, 'appsscript', f)), f + ' 이 없다');
  });
});

test('배포되는 어떤 .gs 에도 외부 통신이 없다', () => {
  // ⚠️ 컨테이너만 보면 안 된다. **라이브러리는 호출 스크립트의 스코프로 돈다.**
  //    core.gs 는 빌드 산물이라 눈으로 훑을 일이 없어서 제일 늦게 발견된다.
  DEPLOYED.forEach((f) => {
    const { code } = scan(fs.readFileSync(path.join(ROOT, 'appsscript', f), 'utf8'));
    assert.doesNotMatch(code, /UrlFetchApp/, f + ' 에서 UrlFetchApp 호출이 나왔다');
  });
});

test('매니페스트에 외부 통신 스코프가 없다', () => {
  assert.ok(
    (MANIFEST.oauthScopes || []).indexOf('https://www.googleapis.com/auth/script.external_request') === -1,
    '코드가 안 쓰는 스코프를 요구하면 동의 화면만 무서워지고 얻는 게 없다');
});

// ── 라이브러리 찾기 ───────────────────────────────────────────────

test('resolveLib_ — getApp() 함수 경로로 찾는다', () => {
  // var 전역이 라이브러리 밖에서 보이는지 문서로 확실하지 않다. 함수는 확실하다.
  const lib = fakeLib();
  delete lib.KMApp;
  assert.match(loadContainer({ kmoneylib: lib }).resolveLib_().via, /kmoneylib/);
});

test('resolveLib_ — 식별자를 바꿔도 모양으로 찾는다', () => {
  assert.match(loadContainer({ 내라이브러리: fakeLib() }).resolveLib_().via, /모양으로 찾음/);
});

test('resolveLib_ — 껍데기만 있는 객체를 라이브러리로 착각하지 않는다', () => {
  // 전역을 훑기 때문에 아무 객체나 걸릴 수 있다. process 가 있어야 우리 것이다.
  const ctx = loadContainer({ kmoneylib: { getApp: () => ({}) }, 딴것: { KMApp: {} } });
  assert.equal(ctx.resolveLib_().via, '못 찾음');
});

test('resolveLib_ — getApp() 이 던져도 죽지 않는다', () => {
  const ctx = loadContainer({ kmoneylib: { getApp() { throw new Error('공유 해제됨'); } } });
  assert.equal(ctx.resolveLib_().via, '못 찾음');
});

test('app_() — 못 찾으면 유저가 할 일을 말한다', () => {
  const ctx = loadContainer({});
  assert.throws(() => ctx.app_(), (e) => {
    assert.match(e.message, /라이브러리/);
    assert.match(e.message, /kmoneylib/);
    // 사본을 새로 만들면 비밀번호와 트리거가 안 따라온다.
    assert.doesNotMatch(e.message, /사본/);
    return true;
  });
});

// ── 메뉴 ──────────────────────────────────────────────────────────

test('onOpen — 라이브러리가 없어도 메뉴는 뜬다', () => {
  // 메뉴가 없으면 유저는 무엇이 잘못됐는지 물어볼 창구조차 없다.
  // 실제로 사본 직후 메뉴가 안 보여서 막힌 적이 있다.
  let built = null;
  const menu = {
    addItem(label, handler) { built = { label, handler }; return this; },
    addSeparator() { return this; },
    addToUi() {},
  };
  const ctx = loadContainer({
    SpreadsheetApp: { getUi: () => ({ createMenu: () => menu }) },
  });
  ctx.onOpen();
  assert.ok(built, '라이브러리가 없으면 메뉴를 통째로 포기하고 있다');
  assert.match(built.label, /문제/);
  assert.match(SRC, new RegExp('function\\s+' + built.handler + '\\s*\\('));
});

test('onOpen — 정상이면 라이브러리가 준 목록대로 만든다', () => {
  const items = [];
  const menu = {
    addItem(label, handler) { items.push(handler); return this; },
    addSeparator() { items.push('---'); return this; },
    addToUi() {},
  };
  const ctx = loadContainer({
    SpreadsheetApp: { getUi: () => ({ createMenu: () => menu }) },
    kmoneylib: fakeLib({
      menuSpec: () => [
        { label: 'A', handler: 'menu_setup' },
        { separator: true },
        { label: 'B', handler: 'menu_status' },
      ],
    }),
  });
  ctx.onOpen();
  assert.deepEqual(items, ['menu_setup', '---', 'menu_status']);
});

test('트리거와 메뉴가 이름으로 참조하는 함수가 전부 있다', () => {
  // 이미 설치된 유저의 트리거가 'runDaily' 를 문자열로 가리키고 있다.
  // 이름을 바꾸면 그 사람들의 자동 실행이 조용히 멈춘다.
  ['onOpen', 'runDaily', 'menu_setup', 'menu_runNow', 'menu_setPassword',
    'menu_status', 'menu_version'].forEach((fn) => {
    assert.match(CODE, new RegExp('function\\s+' + fn + '\\s*\\('), fn + ' 이 없다');
  });
  // 문자열은 CODE 에서 지워지므로 원문에서 본다.
  assert.match(SRC, /newTrigger\(\s*'runDaily'\s*\)/, '트리거 핸들러 이름이 바뀌었다');
});

test('withUi_ — 메뉴에서 난 예외를 날 것으로 보여주지 않는다', () => {
  let shown = null;
  const ui = { alert(t, m) { shown = { t, m }; }, ButtonSet: { OK: 'OK' } };
  const ctx = loadContainer({
    PropertiesService: { getScriptProperties: () => ({}) },
    LockService: { getScriptLock: () => ({}) },
    GmailApp: {}, DriveApp: {}, Drive: {},
    SpreadsheetApp: { getActiveSpreadsheet: () => null, getUi: () => ui },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  });
  ctx.withUi_(function () { throw new TypeError('x is not a function'); });
  assert.ok(shown, '조용히 삼켰다');
  assert.match(shown.m, /시트 스크립트/, '버전을 같이 보여줘야 신고를 받을 수 있다');
});

// ── env — 경계를 넘는 것을 전부 담았는가 ──────────────────────────

test('env_ 가 컨텍스트 의존 서비스를 전부 담는다', () => {
  // ⚠️ 하나라도 빠뜨리고 라이브러리에서 직접 부르면 **라이브러리 프로젝트의
  //    것**이 잡힌다. 유저 비밀번호도 유저 시간대도 거기 없다.
  const ctx = loadContainer({
    PropertiesService: { getScriptProperties: () => 'PROPS' },
    LockService: { getScriptLock: () => 'LOCK' },
    GmailApp: 'GMAIL', DriveApp: 'DRIVE', Drive: 'DRIVEAPI',
    SpreadsheetApp: { getActiveSpreadsheet: () => 'SS', getUi: () => 'UI' },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  });
  const env = ctx.env_();
  assert.equal(env.props, 'PROPS');
  assert.equal(env.lock, 'LOCK');
  assert.equal(env.gmail, 'GMAIL');
  assert.equal(env.drive, 'DRIVE');
  assert.equal(env.driveApi, 'DRIVEAPI');
  assert.equal(env.tz, 'Asia/Seoul');
  assert.equal(env.containerVersion, ctx.CONTAINER_VERSION);
});

test('env_ — 시트가 없어도(독립 스크립트) 죽지 않는다', () => {
  const ctx = loadContainer({
    PropertiesService: { getScriptProperties: () => ({}) },
    LockService: { getScriptLock: () => ({}) },
    GmailApp: {}, DriveApp: {}, Drive: {},
    SpreadsheetApp: {
      getActiveSpreadsheet() { throw new Error('no sheet'); },
      getUi() { throw new Error('no ui'); },
    },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  });
  const env = ctx.env_();
  assert.equal(env.ss, null);
  assert.equal(env.ui, null);
});

// ── 버전 표기 ─────────────────────────────────────────────────────

test('VERSION · package.json · CONTAINER_VERSION · README 가 같다', () => {
  const fileVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const pkg = require(path.join(ROOT, 'package.json')).version;
  const containerVersion = /var CONTAINER_VERSION = '([^']+)'/.exec(SRC)[1];

  assert.match(fileVersion, /^\d+\.\d+\.\d+$/, 'VERSION 은 v 접두사 없는 semver 여야 한다');
  assert.equal(pkg, fileVersion);
  assert.equal(containerVersion, fileVersion, 'container.gs 의 버전을 같이 올려야 한다');

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const shown = /현재 버전 \*\*([\d.]+)\*\*/.exec(readme);
  assert.ok(shown, 'README 에 현재 버전 표기가 없다');
  assert.equal(shown[1], fileVersion, 'README 의 버전이 뒤처졌다');
});

// ── 유저에게 하는 안내가 실제로 존재하는가 ────────────────────────

test('CHANGELOG 에 현재 버전 항목이 있고 올릴지 여부를 밝힌다', () => {
  // 유저에게 "바뀐 것들을 보고 올릴지 정하세요" 라고 안내한다.
  // 여기가 비어 있으면 그 안내가 통째로 헛돈다.
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const head = log.indexOf('## ' + version);
  assert.notEqual(head, -1, 'CHANGELOG 에 ' + version + ' 항목이 없다');

  const section = log.slice(head, log.indexOf('\n## ', head + 1));
  assert.match(section, /🔴|🟡|⚪/, '올려야 하는지 아닌지를 안 밝혔다');
  // 라이브러리 배포 번호(정수)도 적어야 유저가 드롭다운에서 고를 수 있다.
  assert.match(section, /라이브러리 버전 `\d+`/, '라이브러리 배포 번호가 없다');
});

test('문서가 가리키는 상대 링크가 실제로 있다', () => {
  // 깨진 링크는 "관리 안 되는 저장소" 신호다. 내용보다 먼저 읽힌다.
  const docs = ['README.md', 'CHANGELOG.md', 'SECURITY.md',
    'docs/install.md', 'docs/deploy.md'];
  const missing = [];
  docs.forEach((rel) => {
    const dir = path.dirname(path.join(ROOT, rel));
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    [...text.matchAll(/\]\(([^)#:]+\.md)(#[^)]*)?\)/g)].forEach((m) => {
      if (!fs.existsSync(path.resolve(dir, m[1]))) missing.push(rel + ' → ' + m[1]);
    });
  });
  assert.deepEqual(missing, []);
});

test('샘플 산출물이 실제 스키마와 같고 커넥터 한도 안에 든다', () => {
  // 설치 전에 "뭘 넘기게 되는지" 보여주는 유일한 파일이다.
  // 스키마가 바뀌었는데 여기가 옛날 모양이면 그 안내가 거짓이 된다.
  const sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'docs', 'sample-latest.json'), 'utf8'));
  const KM = require('./helpers').loadCore();
  assert.equal(sample.schema, KM.aggregate.SCHEMA, '샘플이 옛 스키마다 — 다시 만들어라');
  assert.ok(JSON.stringify(sample).length < 40000, '커넥터가 못 읽을 만큼 크다');
  // 실데이터를 실수로 커밋하는 걸 막는다.
  assert.equal(sample.sourceMessageId, 'sample');
});

// ── 매니페스트가 코드와 맞는가 ────────────────────────────────────

/**
 * 코드가 어떤 서비스를 쓰면 어떤 스코프가 필요한가.
 *
 * PropertiesService · LockService · Session.getScriptTimeZone · Utilities 는
 * 스코프가 필요 없어서 여기 없다. ui.alert/prompt/createMenu 도 필요 없다 —
 * 다만 **HtmlService 다이얼로그로 바꾸면 script.container.ui 가 필요해진다.**
 * 비밀번호가 평문으로 보이는 걸 고치려다 그걸 건드리기 쉬우니 적어 둔다.
 */
const NEED = [
  // 컨테이너는 서비스를 직접 부르고(GmailApp), 라이브러리는 env 를 통해
  // 부른다(env.gmail). **둘 다 같은 스코프를 쓴다** — 한쪽만 보면 스코프가
  // 남아 있는지 빠졌는지 판단이 뒤집힌다.
  [/GmailApp\b|\bgmail\.(search|get)/, 'https://www.googleapis.com/auth/gmail.readonly'],
  [/DriveApp\b|Drive\.Files\b|\bdrive(Api)?\.(Files|getFile|getFolder|createFolder)/,
    'https://www.googleapis.com/auth/drive'],
  [/SpreadsheetApp\b|\bsheets\.openById/, 'https://www.googleapis.com/auth/spreadsheets'],
  [/ScriptApp\b/, 'https://www.googleapis.com/auth/script.scriptapp'],
  [/UrlFetchApp\b/, 'https://www.googleapis.com/auth/script.external_request'],
];

/** 스코프는 컨테이너가 요청하지만, 쓰는 건 라이브러리도 마찬가지다. */
const ALL_CODE = DEPLOYED
  .map((f) => scan(fs.readFileSync(path.join(ROOT, 'appsscript', f), 'utf8')).code)
  .join('\n');

test('매니페스트 스코프가 코드가 실제로 쓰는 것을 덮는다', () => {
  // oauthScopes 를 **적는 순간 Apps Script 의 자동 추론이 꺼진다.** 하나
  // 빠뜨리면 그 API 만 조용히 던지고 나머지는 멀쩡히 돌아서 늦게 안다.
  // 실제로 spreadsheets.currentonly 를 적어놓고 openById 를 불러서
  // 매일 돌던 파이프라인을 깰 뻔했다.
  const have = MANIFEST.oauthScopes || [];
  NEED.forEach(([pattern, scope]) => {
    if (pattern.test(ALL_CODE)) {
      assert.ok(have.indexOf(scope) !== -1, pattern + ' 을 쓰는데 ' + scope + ' 이 없다');
    }
  });
});

test('매니페스트에 코드가 안 쓰는 스코프가 없다', () => {
  const used = NEED.filter(([p]) => p.test(ALL_CODE)).map(([, s]) => s);
  (MANIFEST.oauthScopes || []).forEach((s) => {
    assert.ok(used.indexOf(s) !== -1, s + ' 을 요구하는데 코드에서 안 쓴다');
  });
});

test('openById 를 쓰면서 currentonly 로 좁히지 않는다', () => {
  // spreadsheets.currentonly 는 바인딩된 시트 하나만 준다. 우리는 변환한
  // 임시 시트를 openById 로 연다 — currentonly 로는 거기서 던진다.
  if (/openById/.test(ALL_CODE)) {
    assert.ok((MANIFEST.oauthScopes || [])
      .indexOf('https://www.googleapis.com/auth/spreadsheets.currentonly') === -1,
    'openById 를 쓰는 코드에 currentonly 를 걸면 매일 실행이 깨진다');
  }
});

test('install.md 스코프 표가 매니페스트와 정확히 같다', () => {
  // 유저에게 "정확히 말씀드릴게요" 라고 해놓은 표다. 어긋나면 그 문장이 거짓말이 된다.
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8');
  const head = md.indexOf('| 스코프 | 실제로 할 수 있는 것 |');
  assert.notEqual(head, -1, 'install.md 에서 스코프 표를 못 찾았다');
  const table = md.slice(head, md.indexOf('\n\n', head));
  const rows = [...table.matchAll(/^\| `([a-z._]+)` \|/gm)].map((m) => m[1]);
  const short = (MANIFEST.oauthScopes || []).map((s) => s.replace(/^.*\/auth\//, ''));
  assert.deepEqual(rows, short);
});

test('install.md 의 비상 복구 안내가 배포 파일을 다 부른다', () => {
  // "프로젝트가 멈추면" 을 위한 유일한 안내다. 한 파일이라도 빠지면
  // 유저는 절반만 붙여넣고 중간에서 멈춘다. 실제로 zipcrypto.gs 가 빠져 있었다.
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8');
  const head = md.indexOf('되살리려면');
  assert.notEqual(head, -1, 'install.md 에서 복구 안내를 못 찾았다');
  const para = md.slice(head, head + 400);
  DEPLOYED.filter((f) => f !== 'container.gs').forEach((f) => {
    assert.ok(para.indexOf(f) !== -1, f + ' 이 복구 안내에 없다');
  });
});

test('매니페스트가 라이브러리를 고정 버전으로 참조한다', () => {
  const libs = (MANIFEST.dependencies || {}).libraries || [];
  assert.equal(libs.length, 1);
  assert.equal(libs[0].developmentMode, false, 'HEAD 로 두면 유저가 우리 미완성 코드를 쓴다');
  assert.match(String(libs[0].version), /^\d+$/, '라이브러리 버전은 정수다');
});

// ── 템플릿 ────────────────────────────────────────────────────────

test('템플릿의 상태 줄이 상수가 가리키는 행에 있다', () => {
  // rows 배열에 한 줄만 끼워 넣으면 이후가 전부 밀린다. 그런데 **오류가 안 난다** —
  // 상태는 계속 B10 에 찍히고, 유저 화면의 '지금 상태' 자리는 첫 문구 그대로
  // 남는다. 조용히 틀리는 종류라 사람이 눈으로 잡기 어렵다.
  const tpl = fs.readFileSync(path.join(ROOT, 'appsscript', 'template.gs'), 'utf8');
  const block = /var rows = \[([\s\S]*?)\n  \];/.exec(tpl);
  assert.ok(block, 'template.gs 의 rows 배열을 못 찾았다');
  const rows = block[1].split('\n').filter((l) => l.trim().startsWith('['));

  const rowOf = (name) => Number(/[A-Z]+(\d+)/.exec(
    new RegExp(name + " = '([A-Z]+\\d+)'").exec(tpl)[1])[1]);

  const statusRow = rowOf('TEMPLATE_STATUS_CELL');
  assert.match(rows[statusRow - 2], /지금 상태/,
    'B' + statusRow + ' 위가 "지금 상태" 가 아니다 — rows 에 줄이 끼었다');
  assert.equal(rowOf('TEMPLATE_CHECKED_CELL'), statusRow + 1);
});
