/**
 * 돈동생 — 유저 시트 안에 복사되는 유일한 파일.
 *
 * ━━ 이 파일은 고칠 수 없다고 생각하고 써라 ━━━━━━━━━━━━━━━━━━━
 *
 * 사본을 뜨는 순간 이 코드가 유저 시트 안으로 복사되고, 그 뒤로 **우리가
 * 고쳐도 닿지 않는다.** 라이브러리는 버전 드롭다운으로 갈아끼워지지만
 * 이 파일은 아니다. 여기 버그를 하나 넣으면 그 사람은 영영 그걸 안고 산다.
 *
 * 그래서 **판단을 여기 두지 않는다.** 남는 것은 세 종류뿐이다.
 *
 *   1. Apps Script 가 **이름으로** 찾아야 하는 것
 *      onOpen(단순 트리거) · runDaily(트리거 핸들러) · menu_*(메뉴 대상)
 *      전부 위임 한 줄이다.
 *
 *   2. **컨테이너 컨텍스트에서만 옳은 것** — env_() 가 모아 넘긴다
 *      스크립트 속성 · 시간대 · 이 시트 · UI · 트리거.
 *      라이브러리에서 그냥 부르면 라이브러리 프로젝트의 것이 잡힌다.
 *
 *   3. 라이브러리를 못 찾았을 때의 안내
 *      그것만은 라이브러리 없이 말할 수 있어야 한다.
 *
 * 나머지 로직은 전부 라이브러리의 app.gs 에 있다.
 *
 * ━━ 유저는 이 파일을 열 일이 없다 (읽을 수는 있다) ━━━━━━━━━━━━
 *
 * 조작은 전부 시트 메뉴 '💰 돈동생' 에서 한다. 다만 문서에서 "Gmail 을 읽는
 * 도구니 직접 확인해 보라" 고 안내하므로, **읽으러 오는 사람은 있다.**
 * 그 사람이 처음 여는 파일이 이것이다.
 *
 * ━━ 비밀번호 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 코드에도 시트 셀에도 쓰지 않는다. 스크립트 속성에만 둔다.
 * 코드에 쓰면 편집 이력에 남고, 시트에 쓰면 공유하는 순간 같이 나간다.
 */

/**
 * 이 파일의 버전. **라이브러리 버전과 다른 값이다.**
 * VERSION 파일과 같아야 한다 — test/container.test.js 가 강제한다.
 */
var CONTAINER_VERSION = '0.4.0';

/**
 * 라이브러리를 어디서 찾을지.
 *
 * 실질적인 보장은 **매니페스트가 `userSymbol` 을 고정**하고 그게 사본에
 * 따라온다는 것이다. 아래 전역 훑기는 그 위에 덧댄 보험이고, Apps Script
 * 전역이 라이브러리 심볼을 열거 가능한 속성으로 노출하는지는 실환경에서
 * 확인하지 않았다. 안 되더라도 잃는 건 없지만, 믿고 설계하지는 마라.
 */
var LIB_CANDIDATES = ['kmoneylib', 'kmoney', 'KMoney'];

/**
 * 후보에서 KMApp 을 꺼낸다.
 * `var` 전역이 라이브러리 밖에서 보이는지가 문서로 확실하지 않아
 * **함수 경로(getApp)를 먼저** 본다. 함수는 확실히 노출된다.
 */
function appOf_(c) {
  if (!c) return null;
  try {
    if (typeof c.getApp === 'function') {
      var a = c.getApp();
      if (a && typeof a.process === 'function') return a;
    }
  } catch (e) {
    // 접근만으로 던지는 전역이 있다.
  }
  return c.KMApp && typeof c.KMApp.process === 'function' ? c.KMApp : null;
}

function resolveLib_() {
  var g = (function () { return this; })() || globalThis;

  for (var i = 0; i < LIB_CANDIDATES.length; i++) {
    var a = appOf_(g[LIB_CANDIDATES[i]]);
    if (a) return { app: a, via: '라이브러리 ' + LIB_CANDIDATES[i] };
  }
  // 개발 중 한 프로젝트에 전부 붙여넣었을 때. 개발용과 배포용 코드가
  // 갈라지지 않게 해준다 — 갈라지면 반드시 어긋나고, 어긋난 걸 늦게 안다.
  if (g.KMApp && typeof g.KMApp.process === 'function') {
    return { app: g.KMApp, via: '같은 프로젝트(개발 모드)' };
  }

  for (var k in g) {
    try {
      var b = appOf_(g[k]);
      if (b) return { app: b, via: '라이브러리 ' + k + ' (모양으로 찾음)' };
    } catch (e) {
      // 접근만으로 던지는 전역이 있다. 그건 라이브러리가 아니다.
    }
  }
  return { app: null, via: '못 찾음' };
}

/** 라이브러리를 못 찾으면 여기서 멈춘다. 안내는 라이브러리 없이 해야 한다. */
function app_() {
  var found = resolveLib_();
  if (!found.app) {
    throw new Error(
      '집계 라이브러리를 불러오지 못했어요.\n\n' +
      '확장 프로그램 → Apps Script → 왼쪽 "라이브러리" 에\n' +
      'kmoneylib 이 있는지 봐 주세요.');
  }
  return found.app;
}

/**
 * 라이브러리에 넘길 컨텍스트.
 *
 * ⚠️ **여기 있는 것들은 라이브러리에서 직접 부르면 안 된다.**
 *    PropertiesService 는 라이브러리 프로젝트의 속성을 주고,
 *    Session.getScriptTimeZone() 은 라이브러리의 시간대를 준다.
 *    유저 비밀번호도 유저 시간대도 거기 없다.
 *    Drive 고급 서비스도 마찬가지 — 여기서 켜져 있는 걸 넘긴다.
 */
function env_() {
  return {
    props: PropertiesService.getScriptProperties(),
    lock: LockService.getScriptLock(),
    gmail: GmailApp,
    drive: DriveApp,
    driveApi: Drive,
    sheets: SpreadsheetApp,
    ss: activeSheet_(),
    ui: activeUi_(),
    tz: Session.getScriptTimeZone(),
    containerVersion: CONTAINER_VERSION,
  };
}

function activeSheet_() {
  try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return null; }
}

function activeUi_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}


// ── Apps Script 가 이름으로 찾는 것들 ───────────────────────────────
//
// 아래 함수 이름은 **계약이다.** 트리거와 메뉴가 문자열로 참조하고,
// 이미 설치된 유저의 트리거도 이 이름을 가리키고 있다. 바꾸면 그 사람들의
// 자동 실행이 조용히 멈춘다.

/** 시트를 열면 메뉴가 생긴다. 단순 트리거라 컨테이너에 있어야 한다. */
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    var menu = ui.createMenu('💰 돈동생');
    var spec = app_().menuSpec();
    for (var i = 0; i < spec.length; i++) {
      if (spec[i].separator) menu.addSeparator();
      else menu.addItem(spec[i].label, spec[i].handler);
    }
    menu.addToUi();
  } catch (e) {
    // 라이브러리를 못 찾아도 메뉴는 떠야 한다. 메뉴가 없으면 유저는
    // 무엇이 잘못됐는지 물어볼 창구조차 없다.
    try {
      SpreadsheetApp.getUi().createMenu('💰 돈동생')
        .addItem('⚠️ 문제가 있어요', 'menu_version')
        .addToUi();
    } catch (ignored) {
      // 독립 스크립트면 UI 가 없다. 정상이다.
    }
    Logger.log('메뉴를 못 만들었다: ' + (e && e.message || e));
  }
}

/** 시간 트리거가 부르는 함수. */
function runDaily() {
  var r = app_().runDaily(env_());
  Logger.log(r && r.message);
}

/** 매일 자동 실행을 건다. ScriptApp 은 컨테이너에 둔다 — 트리거는 이 프로젝트의 것이다. */
function installDailyTrigger_() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(7).create();
}

/**
 * 메뉴 항목은 전부 이름만 넘기고 **동작은 라이브러리가 정한다.**
 *
 * ⚠️ Apps Script 는 메뉴 대상을 **문자열로** 찾으므로 이 이름들이 여기 있어야
 *    한다. 그런데 이 파일은 사본에 복사되면 우리가 못 고친다 — 즉 **여기
 *    없는 이름은 영원히 메뉴에 못 올린다.**
 *
 *    그래서 예비 슬롯을 미리 파 둔다. 앞으로 메뉴 항목이 필요하면 라이브러리의
 *    menuSpec 이 slot1~3 을 집어 쓰면 되고, 라벨도 동작도 버전 갱신만으로
 *    바뀐다. 예비가 없으면 항목 하나 추가하는 데 유저가 시트를 새로 떠야 한다.
 */
function menu_setup() { route_('menu_setup'); }
function menu_runNow() { route_('menu_runNow'); }
function menu_setPassword() { route_('menu_setPassword'); }
function menu_status() { route_('menu_status'); }
function menu_version() { route_('menu_version'); }
function menu_ask() { route_('menu_ask'); }
function menu_slot1() { route_('menu_slot1'); }
function menu_slot2() { route_('menu_slot2'); }
function menu_slot3() { route_('menu_slot3'); }

function route_(key) {
  withUi_(function (env) { app_().menu(env, key, installDailyTrigger_); });
}

/**
 * 메뉴에서 나는 예외는 **날 것으로 보이면 안 된다.**
 * 라이브러리를 못 찾으면 여기 오는데, 그때 'TypeError: ... is not a function'
 * 을 보여주면 유저는 무엇을 해야 할지 알 수 없다.
 */
function withUi_(fn) {
  var env = env_();
  try {
    fn(env);
  } catch (e) {
    var msg = String((e && e.message) || e);
    if (env.ui) {
      env.ui.alert('문제가 생겼어요',
        msg + '\n\n시트 스크립트: ' + CONTAINER_VERSION,
        env.ui.ButtonSet.OK);
    }
    Logger.log(msg);
  }
}


// ── 개발자용 ────────────────────────────────────────────────────────

/** 설정이 다 됐는지 확인한다. 편집기에서만 쓴다. 판단은 라이브러리가 한다. */
function setup_check() {
  var found = resolveLib_();
  Logger.log(found.app ? '✅ 라이브러리 — ' + found.via : '❌ 라이브러리를 못 찾았다');
  if (!found.app) return;
  found.app.checkSetup(env_()).forEach(function (line) { Logger.log(line); });
}

/** 마지막 메일을 이미 처리했더라도 다시 처리한다. 편집기에서만 쓴다. */
function runOnceForce() {
  var env = env_();
  var r = app_().process(env, { force: true });
  app_().writeStatus(env, r);
  Logger.log(r.message);
}
