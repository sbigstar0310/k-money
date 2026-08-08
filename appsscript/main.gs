/**
 * 돈동생 — 하루 한 번 도는 본체.
 *
 *   Gmail 에서 뱅샐 zip 찾기 → Drive 보관 → ZipCrypto 해제 → Sheets 변환
 *   → core 로 집계 → facts JSON 을 Drive 에 저장
 *
 * 유저 기기는 관여하지 않는다. 전부 Google 서버에서 돈다.
 *
 * ━━ 필요한 것 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   1. core.gs 또는 라이브러리 (node scripts/build-gs.js 로 생성)
 *   2. zipcrypto.gs 의 unzipEncrypted
 *   3. 서비스에서 **Drive API(고급 서비스)** — xlsx → Sheets 변환용
 *
 * ━━ 유저는 이 파일을 열지 않는다 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 배포물은 스크립트가 바인딩된 Google Sheet 하나이고, 유저는 시트 메뉴
 * '💰 돈동생' 에서만 조작한다. Apps Script 편집기도 프로젝트 설정도 안 연다.
 * 개발자용 함수(setup_check·runOnceForce)는 편집기에서만 쓴다.
 *
 * ━━ 비밀번호 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * **코드에도 시트 셀에도 쓰지 않는다.** 스크립트 속성에만 둔다.
 * 코드에 쓰면 편집 이력에 남고, 시트에 쓰면 공유하는 순간 같이 나간다.
 * 로그에도 값은 안 찍는다 — 길이와 마스킹된 힌트만.
 */

var CFG = {
  gmailQuery: 'has:attachment filename:zip (뱅크샐러드 OR banksalad)',
  folderName: 'k-money',
  rawFolderName: 'raw',
  keepFacts: 12,        // facts-*.json 보관 개수. 델타 계산에 히스토리가 필요하다
  searchThreads: 10,
  processedKeep: 50,    // 중복 처리 방지용 메시지 ID 보관 개수
};

/**
 * 코어를 어디서 찾을지.
 *
 * 라이브러리로 붙였으면 식별자 아래에, 개발 중 한 프로젝트에 통째로
 * 붙여넣었으면 전역에 있다. 덕분에 개발용 코드와 배포용 코드가 갈라지지
 * 않는다 — 갈라지면 반드시 어긋나고, 어긋난 걸 늦게 안다.
 *
 * ⚠️ **식별자 이름에 기대지 않는다.** 라이브러리를 추가할 때 식별자는
 *    프로젝트 이름에서 자동으로 채워지고(예: `kmoneylib`) 유저가 바꿀 수도
 *    있다. 이름을 하나로 못 박으면 그 한 글자 때문에 파이프라인이 통째로
 *    멈춘다. 그래서 **API 모양으로 찾는다** — `buildFacts` 를 가진 것이 코어다.
 */
// Apps Script 가 프로젝트 이름에서 자동으로 만드는 식별자가 먼저다.
// 'k-money-lib' → 'kmoneylib'. 유저가 바꿀 수도 있으므로 못 찾으면 모양으로 찾는다.
var LIB_CANDIDATES = ['kmoneylib', 'kmoney', 'KMoney'];

function api_() {
  return resolveApi_().api;
}

/** 어디서 찾았는지까지 돌려준다 — setup_check 가 진단에 쓴다. */
function resolveApi_() {
  var g = (function () { return this; })() || globalThis;

  for (var i = 0; i < LIB_CANDIDATES.length; i++) {
    var c = g[LIB_CANDIDATES[i]];
    if (c && typeof c.buildFacts === 'function') {
      return { api: c, via: '라이브러리 ' + LIB_CANDIDATES[i] };
    }
  }
  if (typeof g.buildFacts === 'function') {
    return { api: g, via: '같은 프로젝트(개발 모드)' };
  }
  // 식별자를 바꿔 붙였을 때. 전역을 훑어 모양으로 찾는다.
  for (var k in g) {
    try {
      if (g[k] && typeof g[k].buildFacts === 'function') {
        return { api: g[k], via: '라이브러리 ' + k + ' (모양으로 찾음)' };
      }
    } catch (e) {
      // 접근만으로 던지는 전역이 있다. 그건 코어가 아니다.
    }
  }
  return { api: g, via: '못 찾음' };
}

var PROP = {
  password: 'BANKSALAD_ZIP_PASSWORD',
  processed: 'PROCESSED_MESSAGE_IDS',
  passwordHint: 'BANKSALAD_ZIP_PASSWORD_HINT',
};


// ── 진입점 ─────────────────────────────────────────────────────────

/** 시간 트리거가 부르는 함수. */
function runDaily() {
  // 트리거가 겹치거나 유저가 수동 실행을 같이 눌러도 두 번 돌지 않게 한다.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    Logger.log('이미 실행 중이라 건너뛴다.');
    return;
  }
  try {
    var result = process_();
    writeStatus_(result);
    Logger.log(result.message);
  } catch (e) {
    // 무인 실행이라 예외를 삼키면 아무도 모른다. Drive 에 남겨서
    // 다음에 대화할 때 LLM 이 읽을 수 있게 한다.
    var fail = { ok: false, step: 'unknown', message: String(e && e.message || e) };
    try { writeStatus_(fail); } catch (ignored) {}
    Logger.log('❌ ' + fail.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** 수동 실행용. 마지막 메일을 이미 처리했더라도 다시 처리한다. */
function runOnceForce() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) { Logger.log('이미 실행 중'); return; }
  try {
    var r = process_({ force: true });
    writeStatus_(r);
    Logger.log(r.message);
  } finally {
    lock.releaseLock();
  }
}

/** 설정이 다 됐는지 확인한다. 실행 전에 이걸 먼저 돌려라. */
function setup_check() {
  var props = PropertiesService.getScriptProperties();
  var ok = true;

  var pw = props.getProperty(PROP.password);
  if (pw) {
    Logger.log('✅ zip 비밀번호가 스크립트 속성에 있다 (' + pw.length + '자)');
  } else {
    ok = false;
    Logger.log('❌ zip 비밀번호가 없다.');
    Logger.log('   유저 경로: 시트 메뉴 💰 돈동생 → ① 처음 설정하기');
    Logger.log('   개발 경로: 프로젝트 설정(⚙️) → 스크립트 속성 → ' + PROP.password);
    Logger.log('   ※ 코드에 적지 마라. 편집 이력에 남는다.');
  }

  var found = resolveApi_();
  var api = found.api;
  if (typeof api.buildFacts !== 'function') {
    ok = false;
    Logger.log('❌ 코어를 못 찾았다. 라이브러리를 추가했거나');
    Logger.log('   core.gs + library-api.gs 를 이 프로젝트에 붙여넣어야 한다.');
    Logger.log('   찾아본 식별자: ' + LIB_CANDIDATES.join(', ') + ' + 전역 전수');
  } else {
    Logger.log('✅ 코어 로드됨 — v' + api.version() + ' / ' + api.schema());
    Logger.log('   경로: ' + found.via);
  }

  if (typeof api.unzip !== 'function') {
    ok = false;
    Logger.log('❌ zipcrypto 를 못 찾았다.');
  } else {
    Logger.log('✅ zipcrypto 로드됨');
  }

  try {
    Drive.Files.list({ pageSize: 1 });
    Logger.log('✅ Drive API(고급 서비스) 켜져 있음');
  } catch (e) {
    ok = false;
    Logger.log('❌ Drive API 고급 서비스가 꺼져 있다. 서비스 + → Drive API 추가.');
  }

  var n = GmailApp.search(CFG.gmailQuery, 0, 5).length;
  Logger.log((n ? '✅' : '⚠️') + ' Gmail 검색 결과 ' + n + '건 — ' + CFG.gmailQuery);

  Logger.log(ok ? '\n준비 완료. runOnceForce() 를 실행해 봐라.' : '\n위 항목을 먼저 해결해라.');
}

/** 매일 자동 실행을 건다. */
function install_dailyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(7).create();
  Logger.log('✅ 매일 오전 7시 트리거 설치됨. 기기 전원과 무관하게 돈다.');
}


// ── 본체 ───────────────────────────────────────────────────────────

function process_(opts) {
  opts = opts || {};
  var props = PropertiesService.getScriptProperties();

  var password = props.getProperty(PROP.password);
  if (!password) {
    return { ok: false, step: 'setup', message: 'zip 비밀번호가 없다. setup_check() 를 실행해라.' };
  }

  var found = findAttachment_(props, opts.force);
  if (!found) {
    return { ok: true, step: 'idle', message: '처리할 새 메일이 없다.' };
  }

  var folder = ensureFolder_(DriveApp, CFG.folderName);
  var raw = ensureFolder_(folder, CFG.rawFolderName);
  var stamp = Utilities.formatDate(found.date, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // 1) 원본 보존 — 집계를 고쳤을 때 과거를 다시 계산할 수 있어야 한다
  var zipFile = putFile_(raw, stamp + '.zip', found.attachment.copyBlob());

  // 2) 해제
  var files;
  try {
    files = api_().unzip(zipFile.getBlob(), password);
  } catch (e) {
    return {
      ok: false, step: 'decrypt',
      message: 'zip 해제 실패 — 비밀번호가 다를 수 있다. 뱅샐에서 설정한 값과 ' +
               '스크립트 속성의 ' + PROP.password + ' 가 같은지 확인해라. (' + e.message + ')',
    };
  }

  var xlsx = null;
  for (var i = 0; i < files.length; i++) {
    if (files[i].getName().toLowerCase().indexOf('.xlsx') !== -1) { xlsx = files[i]; break; }
  }
  if (!xlsx) return { ok: false, step: 'unzip', message: 'zip 안에 xlsx 가 없다.' };

  // 3) xlsx → Google Sheets. openpyxl 이식이 통째로 사라지는 지점이다.
  var tmpId = null;
  var facts;
  try {
    tmpId = Drive.Files.create(
      { name: 'k-money-tmp-' + stamp, mimeType: MimeType.GOOGLE_SHEETS, parents: [raw.getId()] },
      xlsx
    ).id;

    var ss = SpreadsheetApp.openById(tmpId);
    var sheets = {};
    ss.getSheets().forEach(function (s) {
      sheets[s.getName()] = s.getDataRange().getValues();
    });

    // 4) 집계 — node 에서 검증한 그 코드
    // profile.json 은 LLM 이 대화로 채운다. 없어도 정상 동작한다.
    var extract = api_().parseSheets(sheets);
    facts = api_().buildFacts(extract, {
      asOf: stamp,
      profile: readJson_(folder, 'profile.json'),
    });
    facts.generatedAt = new Date().toISOString();
    facts.sourceMessageId = found.id;

    // 같은 날 두 번 내보내면 latest 와 날짜가 같아 델타가 전부 0이 된다.
    // 그런 날은 그 이전 스냅샷을 찾아서 비교한다.
    var d = api_().buildDelta(facts, readPrevious_(folder, stamp));
    if (d) facts.delta = d;
  } finally {
    // 변환본은 중간 산물이라 남기지 않는다. 원본 zip 이 있으면 언제든 다시 만든다.
    if (tmpId) { try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (ignored) {} }
  }

  // 5) 저장 — latest 는 고정 이름이라 커넥터가 찾기 쉽다
  var json = JSON.stringify(facts, null, 2);
  putJson_(folder, 'facts-' + stamp + '.json', json);
  putJson_(folder, 'latest.json', json);
  pruneFacts_(folder);

  markProcessed_(props, found.id);

  return {
    ok: true, step: 'done',
    message: '✅ ' + stamp + ' 처리 완료 — ' +
             (facts.period ? facts.period.days + '일치' : '거래 0건') + ', ' +
             json.length + ' bytes',
    generatedFor: stamp,
    bytes: json.length,
    flags: (facts.dataQuality && facts.dataQuality.flags || []).map(function (f) { return f.code; }),
  };
}


// ── Gmail ──────────────────────────────────────────────────────────

function findAttachment_(props, force) {
  var processed = getProcessed_(props);
  var threads = GmailApp.search(CFG.gmailQuery, 0, CFG.searchThreads);
  var best = null;

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      if (!force && processed.indexOf(m.getId()) !== -1) continue;

      var atts = m.getAttachments();
      for (var k = 0; k < atts.length; k++) {
        var a = atts[k];
        if (a.getName().toLowerCase().indexOf('.zip') === -1) continue;
        // 여러 통이 걸리면 가장 최근 것만 쓴다
        if (!best || m.getDate() > best.date) {
          best = { id: m.getId(), date: m.getDate(), attachment: a, subject: m.getSubject() };
        }
      }
    }
  }
  return best;
}

function getProcessed_(props) {
  try {
    return JSON.parse(props.getProperty(PROP.processed) || '[]');
  } catch (e) {
    return [];
  }
}

function markProcessed_(props, id) {
  var list = getProcessed_(props);
  if (list.indexOf(id) === -1) list.push(id);
  while (list.length > CFG.processedKeep) list.shift();
  props.setProperty(PROP.processed, JSON.stringify(list));
}


// ── Drive ──────────────────────────────────────────────────────────

function ensureFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function findFile_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function putFile_(folder, name, blob) {
  var existing = findFile_(folder, name);
  if (existing) existing.setTrashed(true);
  return folder.createFile(blob.setName(name));
}

function putJson_(folder, name, content) {
  var existing = findFile_(folder, name);
  if (existing) { existing.setContent(content); return existing; }
  return folder.createFile(Utilities.newBlob(content, 'application/json', name));
}

function readJson_(folder, name) {
  var f = findFile_(folder, name);
  if (!f) return null;
  try {
    return JSON.parse(f.getBlob().getDataAsString('UTF-8'));
  } catch (e) {
    return null;
  }
}

/**
 * stamp 보다 앞선 것 중 가장 최근 facts.
 * latest.json 을 그냥 쓰면 같은 날 두 번 내보냈을 때 자기 자신과 비교하게 된다.
 */
function readPrevious_(folder, stamp) {
  var names = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var n = it.next().getName();
    if (n.indexOf('facts-') === 0 && n.indexOf('.json') !== -1) names.push(n);
  }
  names.sort().reverse();
  var current = 'facts-' + stamp + '.json';
  for (var i = 0; i < names.length; i++) {
    if (names[i] < current) return readJson_(folder, names[i]);
  }
  return null;
}

/** 오래된 facts 를 정리한다. 델타에 쓸 만큼만 남긴다. */
function pruneFacts_(folder) {
  var names = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var n = it.next().getName();
    if (n.indexOf('facts-') === 0 && n.indexOf('.json') !== -1) names.push(n);
  }
  names.sort();
  while (names.length > CFG.keepFacts) {
    var f = findFile_(folder, names.shift());
    if (f) f.setTrashed(true);
  }
}

/**
 * 마지막 실행 결과. 무인 파이프라인이라 실패가 조용히 묻히면 안 된다.
 * 메일을 보내지 않고 Drive 에 남기는 이유: 대화할 때 LLM 이 같이 읽는다.
 */
function writeStatus_(result) {
  var folder = ensureFolder_(DriveApp, CFG.folderName);
  result.at = new Date().toISOString();
  putJson_(folder, 'status.json', JSON.stringify(result, null, 2));
  writeStatusToSheet_(result);
}

/**
 * 시트에 붙어 있으면 첫 화면에도 상태를 적는다.
 * 유저가 시트를 열자마자 "잘 돌고 있나" 를 보게 하는 게 목적이다 —
 * Drive 의 status.json 을 열어보라고 할 수는 없다.
 * 독립 스크립트면 조용히 넘어간다.
 */
function writeStatusToSheet_(result) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;
    var sh = ss.getSheets()[0];
    sh.getRange('B10').setValue((result.ok ? '✅ ' : '⚠️ ') + result.message);
    sh.getRange('B11').setValue(
      '마지막 확인 ' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
  } catch (e) {
    // 시트에 안 붙어 있거나 권한이 없다. 상태는 이미 Drive 에 남았으니 넘어간다.
  }
}


// ── 설치와 설정 (D7) ───────────────────────────────────────────────
//
// 유저는 Apps Script 편집기도 프로젝트 설정도 열지 않는다. 배포물은
// 스크립트가 바인딩된 Google Sheet 하나이고, 모든 조작은 시트 메뉴에서 한다.
//
// ⚠️ 비밀번호는 **코드에도 시트 셀에도 쓰지 않는다.** 스크립트 속성에만 둔다.
//    시트에 쓰면 그 시트를 공유하는 순간 같이 나가고, 코드에 쓰면 편집 이력에 남는다.

var STATUS_SHEET = '돈동생';

/** 시트를 열면 메뉴가 생긴다. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('💰 돈동생')
      .addItem('① 처음 설정하기', 'menu_setup')
      .addItem('② 지금 한 번 돌리기', 'menu_runNow')
      .addSeparator()
      .addItem('비밀번호 다시 넣기', 'menu_setPassword')
      .addItem('상태 보기', 'menu_status')
      .addItem('업데이트 확인', 'menu_checkUpdate')
      .addToUi();
  } catch (e) {
    // 시트에 바인딩되지 않은 상태(독립 스크립트)면 메뉴가 없다. 정상이다.
  }
}

/** 처음 설정 — 비밀번호를 받고 트리거를 건다. 유저가 하는 유일한 설정이다. */
function menu_setup() {
  var ui = SpreadsheetApp.getUi();
  if (!promptPassword_(ui)) return;
  install_dailyTrigger();
  ui.alert('설정 완료',
    '매일 오전 7시에 자동으로 돌아갑니다.\n\n' +
    '뱅크샐러드 앱에서 데이터를 내보낼 때 방금 넣은 비밀번호를 ' +
    '**매번 똑같이** 써 주세요. 다르면 해제하지 못합니다.\n\n' +
    "'② 지금 한 번 돌리기' 로 바로 확인해 볼 수 있어요.",
    ui.ButtonSet.OK);
}

function menu_setPassword() {
  promptPassword_(SpreadsheetApp.getUi());
}

function promptPassword_(ui) {
  var r = ui.prompt('뱅크샐러드 zip 비밀번호',
    '내보내기할 때 설정한 비밀번호를 넣어 주세요.\n' +
    '이 값은 이 스크립트 안에만 저장되고 시트에는 적히지 않습니다.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return false;

  var pw = r.getResponseText();
  if (!pw) { ui.alert('비밀번호가 비어 있습니다.'); return false; }

  PropertiesService.getScriptProperties().setProperty(PROP.password, pw);
  // 잊었을 때 확인할 수 있게 힌트만 남긴다. 값 자체는 절대 로그·시트에 안 쓴다.
  PropertiesService.getScriptProperties().setProperty(
    PROP.passwordHint, pw.charAt(0) + new Array(pw.length).join('*') + pw.charAt(pw.length - 1));
  return true;
}

function menu_runNow() {
  var ui = SpreadsheetApp.getUi();
  var r = process_({ force: true });
  writeStatus_(r);
  ui.alert(r.ok ? '완료' : '실패', r.message, ui.ButtonSet.OK);
}

function menu_status() {
  var ui = SpreadsheetApp.getUi();
  var folder = ensureFolder_(DriveApp, CFG.folderName);
  var s = readJson_(folder, 'status.json');
  var hint = PropertiesService.getScriptProperties().getProperty(PROP.passwordHint);
  ui.alert('상태',
    (s ? s.at + '\n' + s.message : '아직 한 번도 돌지 않았습니다.') +
    (hint ? '\n\n비밀번호 힌트: ' + hint : ''),
    ui.ButtonSet.OK);
}


// ── 업데이트 확인 (D8) ─────────────────────────────────────────────
//
// **코드를 받아오지 않는다. 버전 숫자만 받아 비교한다.**
//
// 원격 코드를 받아 실행하는 스크립트는 공급망 백도어다. 이 스크립트는
// Gmail 전체 읽기 권한으로 도는데, 저장소가 털리면 그 권한으로 남의 코드가
// 돈다. 그래서 가져오는 건 텍스트 한 줄이고, 갱신은 유저가 라이브러리
// 버전을 바꿔서 한다 — **매 갱신마다 명시적 동의가 일어난다.**

var VERSION_URL = 'https://raw.githubusercontent.com/sbigstar0310/k-money/main/VERSION';

function menu_checkUpdate() {
  var ui = SpreadsheetApp.getUi();
  var r = checkForUpdate();
  if (r.error) { ui.alert('확인 실패', r.error, ui.ButtonSet.OK); return; }
  ui.alert(r.outdated ? '새 버전이 있습니다' : '최신입니다',
    '지금 쓰는 버전: ' + r.current + '\n최신 버전: ' + r.latest +
    (r.outdated
      ? '\n\n확장 프로그램 → Apps Script → 라이브러리 → 버전을 바꿔 주세요.\n' +
        '설정과 데이터는 그대로 유지됩니다.'
      : ''),
    ui.ButtonSet.OK);
}

function checkForUpdate() {
  var api = api_();
  var current = (typeof api.version === 'function' && api.version()) || 'unknown';
  try {
    var res = UrlFetchApp.fetch(VERSION_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return { error: '버전 정보를 못 읽었습니다 (HTTP ' + res.getResponseCode() + ')', current: current };
    }
    // 받아온 건 "0.1.0" 같은 문자열이다. 실행하지 않는다.
    var latest = res.getContentText().trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(latest)) {
      return { error: '버전 형식이 이상합니다: ' + latest.slice(0, 40), current: current };
    }
    return { current: current, latest: latest, outdated: compareVersions_(current, latest) < 0 };
  } catch (e) {
    return { error: String(e && e.message || e), current: current };
  }
}

function compareVersions_(a, b) {
  var x = String(a).split('.'), y = String(b).split('.');
  for (var i = 0; i < 3; i++) {
    var d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
