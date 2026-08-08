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
 * ━━ 유저는 이 파일을 열 일이 없다 (읽을 수는 있다) ━━━━━━━━━━━━━
 *
 * 배포물은 스크립트가 바인딩된 Google Sheet 하나이고, 조작은 전부 시트 메뉴
 * '💰 돈동생' 에서 한다. 설치에도 편집기가 필요 없다.
 *
 * 다만 **읽으러 오는 사람은 있다.** 문서에서 "Gmail 을 읽는 도구니 직접
 * 확인해 보라" 고 안내한다. 그 사람이 처음 여는 파일이 이 파일이므로,
 * 여기 주석은 개발 메모가 아니라 **설명**으로 쓴다.
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
  staleDays: 14,        // 이만큼 새 데이터가 없으면 시트 첫 화면에서 경고한다
};

/**
 * 코어를 어디서 찾을지.
 *
 * 라이브러리로 붙였으면 식별자 아래에, 개발 중 한 프로젝트에 통째로
 * 붙여넣었으면 전역에 있다. 덕분에 개발용 코드와 배포용 코드가 갈라지지
 * 않는다 — 갈라지면 반드시 어긋나고, 어긋난 걸 늦게 안다.
 *
 * ⚠️ **식별자 이름 하나에 걸지 않는다.** 라이브러리를 추가할 때 식별자는
 *    프로젝트 이름에서 자동으로 채워지고(예: `kmoneylib`) 유저가 바꿀 수도
 *    있다. 이름을 하나로 못 박으면 그 한 글자 때문에 파이프라인이 통째로
 *    멈춘다.
 *
 *    실질적인 보장은 **매니페스트가 `userSymbol` 을 고정**하고 그게 사본에
 *    따라온다는 것이다. 아래 전역 훑기는 그 위에 덧댄 보험이고, Apps Script
 *    전역이 라이브러리 심볼을 열거 가능한 속성으로 노출하는지는 **실환경에서
 *    확인하지 않았다.** 안 되더라도 잃는 건 없지만, 믿고 설계하지는 마라.
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
  // 마지막으로 **실제 데이터를 받은** 날. 마지막 실행 시각과 다르다 —
  // 내보내기를 그만둬도 실행은 매일 성공하기 때문이다. dataAge_() 참고.
  // 값은 **거래의 마지막 날**이다 (메일 수신일이 아니다).
  lastIngest: 'LAST_INGEST_DATE',
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
  // ⚠️ 메일 **수신일**(stamp)이 아니라 거래의 **마지막 날**을 적는다.
  //    유저에게 "데이터는 X 까지 있어요" 라고 말할 참이라, 저장하는 값이
  //    그 문장과 같은 것이어야 한다. 뱅샐이 어제까지만 담아 보냈는데
  //    오늘 날짜를 적으면 그 한 줄이 거짓말이 된다.
  props.setProperty(PROP.lastIngest, (facts.period && facts.period.to) || stamp);

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
 * 데이터가 며칠째 멈춰 있는가.
 *
 * ⚠️ **이 도구가 조용히 죽는 방식이 정확히 이거다.** 유저가 뱅샐 내보내기를
 *    그만두면 매일 아침 트리거는 멀쩡히 돌고 '처리할 새 메일이 없다' 를
 *    성공으로 적는다. 시트에는 초록 체크와 **오늘 날짜**가 찍힌다. 데이터는
 *    석 달 전 것인데 화면은 계속 정상이다.
 *
 *    "마지막으로 언제 돌았나" 와 "데이터가 언제까지인가" 는 다른 질문이고,
 *    유저에게 필요한 건 두 번째다.
 */
function dataAge_(props) {
  var last = props.getProperty(PROP.lastIngest);
  if (!last) return { state: 'none', last: null, days: null };
  // 깨진 값을 '아직 없음' 으로 뭉개면 안 된다. 이 함수가 드러내려는 고장을
  // 그 자체로 감추게 된다. 상태를 따로 둔다.
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(last));
  if (!m) return { state: 'broken', last: String(last).slice(0, 20), days: null };
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var today = new Date();
  // 자정 기준으로 센다. 시각까지 넣으면 같은 날인데 0일/1일이 왔다 갔다 한다.
  var midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return {
    state: 'ok', last: last,
    days: Math.round((midnight.getTime() - d.getTime()) / 86400000),
  };
}

/** 신선도 한 줄. 오래됐으면 그 사실이 먼저 오게 한다. */
function freshnessLine_(age) {
  if (age.state === 'none') return '아직 받은 데이터가 없어요. 뱅크샐러드에서 내보내 주세요.';
  if (age.state === 'broken') {
    return '⚠️ 데이터 날짜를 읽지 못했어요 (' + age.last + '). ' +
      '한 번 더 내보내시면 다시 맞춰집니다.';
  }
  if (age.days > CFG.staleDays) {
    return '⚠️ 데이터가 ' + age.last + ' 에서 멈춰 있어요 (' + age.days + '일 전). ' +
      '뱅크샐러드 앱에서 다시 내보내 주세요.';
  }
  return '데이터는 ' + age.last + ' 까지 있어요' + (age.days > 0 ? ' (' + age.days + '일 전)' : '');
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
    // 이름으로 먼저 찾는다. 유저가 시트를 하나 추가하면 [0] 은 남의 시트다.
    var sh = ss.getSheetByName(STATUS_SHEET) || ss.getSheets()[0];
    var age = dataAge_(PropertiesService.getScriptProperties());
    var stale = age.state !== 'ok' || age.days > CFG.staleDays;
    var fresh = freshnessLine_(age);

    // 데이터가 멈춰 있으면 그게 제일 중요한 소식이다. 실행 성공보다 앞에 온다.
    // 멈춘 게 아니면 굵은 칸은 실행 결과, 아랫줄이 신선도 — 같은 문장을
    // 두 번 쓰지 않는다.
    sh.getRange('B10').setValue(safeCell_(
      stale ? fresh : (result.ok ? '✅ ' : '⚠️ ') + result.message));
    sh.getRange('B11').setValue(safeCell_(
      (stale ? (result.ok ? '✅ ' : '⚠️ ') + result.message : fresh) +
      ' · 마지막 확인 ' + localTime_(new Date())));
  } catch (e) {
    // 시트에 안 붙어 있거나 권한이 없다. 상태는 이미 Drive 에 남았으니 넘어간다.
  }
}

/**
 * 시트가 수식으로 해석하지 않게 한다.
 * 앞 공백을 넘겨보면 안 된다 — 시트는 ' =IMPORTDATA(...)' 도 수식으로 읽는다.
 */
function safeCell_(s) {
  var t = String(s);
  return /^\s*[=+\-@]/.test(t) ? "'" + t : t;
}

/** 유저에게 보이는 시각은 늘 이 계정의 시간대로. */
function localTime_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}


// ── 설치와 설정 (D7) ───────────────────────────────────────────────
//
// 유저는 Apps Script 편집기도 프로젝트 설정도 열지 않는다. 배포물은
// 스크립트가 바인딩된 Google Sheet 하나이고, 모든 조작은 시트 메뉴에서 한다.
//
// ⚠️ 비밀번호는 **코드에도 시트 셀에도 쓰지 않는다.** 스크립트 속성에만 둔다.
//    시트에 쓰면 그 시트를 공유하는 순간 같이 나가고, 코드에 쓰면 편집 이력에 남는다.

var STATUS_SHEET = '돈동생';

/**
 * 시트를 열면 메뉴가 생긴다.
 *
 * ⚠️ **사본을 만든 직후에는 안 뜨는 경우가 있다.** 새로고침하면 나온다.
 *    유저가 설치에서 제일 먼저 만나는 화면이 '메뉴가 없다' 라서, 여기서
 *    그만두는 사람이 나온다. 문서와 템플릿 첫 화면에 같이 적어 뒀다.
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('💰 돈동생')
      .addItem('① 처음 설정하기', 'menu_setup')
      .addItem('② 지금 한 번 돌리기', 'menu_runNow')
      .addSeparator()
      .addItem('비밀번호 다시 넣기', 'menu_setPassword')
      .addItem('상태 보기', 'menu_status')
      .addItem('버전 보기', 'menu_version')
      .addToUi();
  } catch (e) {
    // 독립 스크립트면 UI 가 없다 — 정상이다. 하지만 라이브러리 참조가 깨져
    // 스크립트가 로드에 실패한 경우도 여기로 온다. 그때 조용히 넘어가면
    // 유저는 '메뉴가 없다' 만 보고 원인을 영영 모른다. 로그에는 남긴다.
    Logger.log('메뉴를 못 만들었다: ' + (e && e.message || e));
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
    '「매번 똑같이」 써 주세요. 다르면 해제하지 못합니다.\n\n' +
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
  PropertiesService.getScriptProperties().setProperty(PROP.passwordHint, hint_(pw));
  return true;
}

/**
 * 첫 글자 · 자릿수 · 끝 글자. **자릿수가 맞아야 한다** — 문서에 그렇게
 * 약속해 놨고, 유저는 이 별을 세어서 비밀번호를 떠올린다. 별 개수가 하나
 * 많으면 틀린 길이로 입력하고 'zip 해제 실패' 를 본다.
 *
 * 짧은 비밀번호는 힌트가 곧 답이 된다. 3자 미만이면 자릿수만 알려준다.
 */
function hint_(pw) {
  // charAt 은 이모지를 반쪽으로 자른다. 글자 단위로 센다.
  var ch = Array.from ? Array.from(pw) : String(pw).split('');
  var n = ch.length;
  // 짧으면 힌트가 곧 답이다. '0930' 은 '0**0' 이 되어 후보가 100개로 준다.
  if (n < 6) return n + '자';
  return ch[0] + new Array(n - 1).join('*') + ch[n - 1];
}

function menu_runNow() {
  var ui = SpreadsheetApp.getUi();

  // 아침 7시 트리거와 겹칠 수 있다. 겹치면 임시 시트가 둘, latest.json 쓰기가
  // 둘이 되고 pruneFacts_ 가 서로가 쓰는 걸 지운다. runDaily 는 잠그면서
  // 정작 사람이 누르는 이 경로를 안 잠그고 있었다.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    ui.alert('잠시만요', '지금 자동 실행이 돌고 있어요. 1분 뒤에 다시 눌러 주세요.', ui.ButtonSet.OK);
    return;
  }

  try {
    var r = process_({ force: true });
    writeStatus_(r);
    ui.alert(r.ok ? '완료' : '실패', r.message, ui.ButtonSet.OK);
  } catch (e) {
    // 라이브러리를 못 찾으면 api_() 가 전역을 돌려주고 unzip 이 undefined 다.
    // 그대로 두면 유저는 'TypeError: ... is not a function' 을 본다.
    var msg = String((e && e.message) || e);
    try { writeStatus_({ ok: false, step: 'error', message: msg }); } catch (ignored) {}
    ui.alert('실패',
      msg + '\n\n' + versionText_() + '\n\n' +
      '집계 라이브러리를 못 불러온 것일 수 있어요.',
      ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}

function menu_status() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  // 상태를 '보는' 동작이 폴더를 만들면 안 된다. 없으면 없는 대로 답한다.
  var it = DriveApp.getFoldersByName(CFG.folderName);
  var s = it.hasNext() ? readJson_(it.next(), 'status.json') : null;
  var hint = props.getProperty(PROP.passwordHint);
  var at = s && s.at ? localTime_(new Date(s.at)) : null;
  ui.alert('상태',
    // 신선도가 먼저다. '마지막 실행' 은 내보내기를 그만둬도 매일 갱신된다.
    freshnessLine_(dataAge_(props)) + '\n\n' +
    (s ? '마지막 실행 ' + at + '\n' + s.message : '아직 한 번도 돌지 않았습니다.') +
    (hint ? '\n\n비밀번호 힌트: ' + hint : ''),
    ui.ButtonSet.OK);
}


// ── 버전 보기 ─────────────────────────────────────────────────────
//
// **이 스크립트는 인터넷에 나가지 않는다.** UrlFetchApp 이 한 줄도 없고,
// 매니페스트에 script.external_request 스코프도 없다. 그래서 "내 데이터가
// 어디로 새나" 는 코드를 읽지 않고 **권한 목록만 보고** 판단할 수 있다.
//
// 예전에는 GitHub 에서 버전 문자열 하나를 받아 새 버전을 알려줬다. 지웠다.
// 얻는 것(알림)보다 치르는 값이 컸다 —
//
//   · 동의 화면에 '외부 서비스 연결' 한 줄이 붙는다. Gmail 전체 읽기를
//     이미 받는 도구에서 이 줄은 "밖으로 보낼 수도 있다" 로 읽힌다.
//   · 알림을 받아도 갱신은 어차피 편집기에서 손으로 하는 일이다.
//     알림이 줄여주는 수고가 거의 없다.
//   · 네트워크·권한·404·형식 오류를 다 다뤄야 했고, 실제로 유저에게
//     "업데이트 확인에서 오류" 로 처음 새어 나갔다.
//
// 대신 지금 쓰는 버전을 보여주고, 최신은 저장소에서 보게 한다.

var PROJECT_URL = 'https://github.com/sbigstar0310/k-money';

/**
 * 이 파일(main.gs)의 버전. **라이브러리 버전과 다른 값이다.**
 *
 * 라이브러리(집계 코어)는 유저가 버전 드롭다운으로 갈아끼울 수 있지만,
 * 이 파일은 유저의 시트 안에 복사돼 있어서 **우리가 고쳐도 닿지 않는다.**
 * 두 개를 하나인 척 보여주면 옛 main.gs 로 도는 걸 아무도 모른다.
 *
 * VERSION 파일과 같아야 한다 — test/main.test.js 가 강제한다.
 */
var MAIN_VERSION = '0.1.1';

/**
 * ⚠️ **여기에 사용법을 적지 마라.** 대화상자에서 여러 줄짜리 절차를 읽고
 *    편집기를 열어 따라 하는 사람은 없다. 예전 문구가 그랬는데, 읽으면
 *    "가서 업데이트해라" 로 읽혔다 — 실제로는 **안 해도 되는 일**이다.
 *
 *    이 화면이 할 일은 두 가지뿐이다. 지금 버전을 알려주는 것(문제를
 *    신고할 때 필요하다), 그리고 **가만히 둬도 된다고 안심시키는 것.**
 */
function menu_version() {
  var ui = SpreadsheetApp.getUi();
  ui.alert('버전',
    versionText_() + '\n\n' +
    '지금 그대로 두셔도 괜찮아요.\n' +
    '업데이트는 선택이고, 안 해도 쓰던 대로 계속 돌아갑니다.\n\n' +
    '바뀐 내용이 궁금하거나 업데이트하고 싶으시면 여기를 보세요.\n' +
    '방법도 같이 적어 뒀어요.\n' + PROJECT_URL,
    ui.ButtonSet.OK);
}

/**
 * 지금 도는 버전 두 줄. 라이브러리 호출은 **컨텍스트를 넘으므로** 던질 수
 * 있다 — 공유가 풀렸거나 core.gs 없이 library-api.gs 만 올라간 경우.
 * 감싸지 않으면 버전을 보려다 오류 대화상자를 보게 된다.
 */
function versionText_() {
  var lib;
  try {
    var api = resolveApi_().api;
    lib = (typeof api.version === 'function' && api.version()) || null;
  } catch (e) {
    lib = null;
  }
  return '시트 스크립트: ' + MAIN_VERSION + '\n' +
    '집계 라이브러리: ' + (lib || '못 찾았습니다 — 확장 프로그램 → Apps Script → 라이브러리 확인');
}
