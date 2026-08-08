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
 *   1. core.gs 가 같은 프로젝트에 있어야 한다 (node scripts/build-gs.js 로 생성)
 *   2. zipcrypto.gs 의 unzipEncrypted 가 필요하다
 *   3. 서비스에서 **Drive API(고급 서비스)** 를 켜야 한다 — xlsx → Sheets 변환용
 *   4. 프로젝트 설정 → 스크립트 속성에 zip 비밀번호를 넣어야 한다 (아래)
 *
 * ━━ 비밀번호 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * **코드에 적지 않는다.** 프로젝트 설정 화면의 '스크립트 속성' 에 넣는다.
 * 코드에 적으면 편집 이력에 남고, 프로젝트를 복사·공유하는 순간 같이 나간다.
 * setup_check() 가 제대로 들어갔는지만 확인해 준다.
 */

var CFG = {
  gmailQuery: 'has:attachment filename:zip (뱅크샐러드 OR banksalad)',
  folderName: 'k-money',
  rawFolderName: 'raw',
  keepFacts: 12,        // facts-*.json 보관 개수. 델타 계산에 히스토리가 필요하다
  searchThreads: 10,
  processedKeep: 50,    // 중복 처리 방지용 메시지 ID 보관 개수
};

var PROP = {
  password: 'BANKSALAD_ZIP_PASSWORD',
  processed: 'PROCESSED_MESSAGE_IDS',
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
    Logger.log('   프로젝트 설정(⚙️) → 스크립트 속성 → 속성 추가');
    Logger.log('   속성: ' + PROP.password);
    Logger.log('   값  : 뱅샐 내보내기에서 설정한 비밀번호');
    Logger.log('   ※ 코드에 적지 마라. 편집 이력에 남는다.');
  }

  if (typeof KM === 'undefined' || !KM.aggregate) {
    ok = false;
    Logger.log('❌ core.gs 가 없다. node scripts/build-gs.js 로 만들어 붙여넣어라.');
  } else {
    Logger.log('✅ core 로드됨 — ' + KM.aggregate.SCHEMA);
  }

  if (typeof unzipEncrypted === 'undefined') {
    ok = false;
    Logger.log('❌ zipcrypto.gs 가 없다.');
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
    files = unzipEncrypted(zipFile.getBlob(), password);
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
    var extract = KM.parse.extract(sheets);
    facts = KM.aggregate.build(extract, { asOf: stamp });
    facts.generatedAt = new Date().toISOString();
    facts.sourceMessageId = found.id;

    // 같은 날 두 번 내보내면 latest 와 날짜가 같아 델타가 전부 0이 된다.
    // 그런 날은 그 이전 스냅샷을 찾아서 비교한다.
    var d = KM.aggregate.delta(facts, readPrevious_(folder, stamp));
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
}
