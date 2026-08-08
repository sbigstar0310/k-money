/**
 * money-audit — Apps Script 자동화 검증 스크립트
 *
 * 목적: "Gmail 에서 뱅샐 첨부를 찾아 Drive 에 올리는 자동화가 보장되는가" 를
 *      코드 한 줄 안 짜고 확인하는 것. 여기가 되면 파이프라인 전체의 토대가 선다.
 *
 * 이 스크립트가 확인하는 것:
 *   1. Apps Script 가 유저 OAuth 클라이언트 없이 Gmail 을 읽는가        (= GCP 설정 불필요)
 *   2. 첨부를 Drive 에 쓸 수 있는가                                    (= 산출물 저장 가능)
 *   3. 시간 트리거가 유저 기기 전원과 무관하게 도는가                    (= 자동화 보장)
 *   4. V8 런타임이 켜져 있는가 / Rhino 를 아직 선택할 수 있는가          (= UnzipGs 가용 여부)
 *
 * 확인하지 않는 것: ZipCrypto 해제. 그건 별도 단계다.
 *
 * ── 사용법 ──────────────────────────────────────────────────────────
 *  1. script.google.com → 새 프로젝트
 *  2. 이 파일 내용을 통째로 붙여넣기
 *  3. 함수 선택기에서 `step1_checkRuntime` 실행 → 권한 승인
 *  4. 실행 로그(Ctrl+Enter)를 확인하고, 이어서 step2, step3 순서로 실행
 */

// 뱅샐 메일을 찾는 검색어. --dry-run 결과에 맞춰 조정한다.
var GMAIL_QUERY = 'has:attachment filename:zip (뱅크샐러드 OR banksalad)';
var DRIVE_FOLDER = 'money-audit';


/** STEP 1 — 런타임 확인. 권한 요청이 처음 뜨는 지점이다. */
function step1_checkRuntime() {
  Logger.log('=== STEP 1: 런타임 ===');

  // V8 이면 화살표 함수·let·템플릿리터럴이 동작한다. Rhino(ES5)면 여기서 죽는다.
  var isV8 = false;
  try {
    eval('(() => 1)()');
    isV8 = true;
  } catch (e) {
    isV8 = false;
  }
  Logger.log('V8 런타임: ' + (isV8 ? 'ON  → UnzipGs 사용 불가 (Rhino 필요)' : 'OFF → Rhino 동작 중'));
  Logger.log('→ Rhino 는 2026-01-31 sunset. V8 OFF 가 아직 되면 그 정보가 중요하다.');

  Logger.log('실행 계정: ' + Session.getEffectiveUser().getEmail());
  Logger.log('시간대   : ' + Session.getScriptTimeZone());
  Logger.log('');
  Logger.log('여기까지 왔으면 GCP 프로젝트·OAuth 클라이언트 없이 실행된 것이다.');
}


/** STEP 2 — Gmail 검색과 Drive 쓰기가 되는가. 자동화 보장의 핵심. */
function step2_gmailToDrive() {
  Logger.log('=== STEP 2: Gmail → Drive ===');

  var threads = GmailApp.search(GMAIL_QUERY, 0, 5);
  Logger.log('쿼리: ' + GMAIL_QUERY);
  Logger.log('매칭 스레드: ' + threads.length + '건');

  if (threads.length === 0) {
    Logger.log('❌ 못 찾음. GMAIL_QUERY 를 조정하라. 발신 주소로 좁히는 게 가장 확실하다.');
    return;
  }

  var found = null;
  for (var i = 0; i < threads.length && !found; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length && !found; j++) {
      var atts = msgs[j].getAttachments();
      for (var k = 0; k < atts.length; k++) {
        if (atts[k].getName().toLowerCase().indexOf('.zip') !== -1) {
          found = { att: atts[k], date: msgs[j].getDate(), subject: msgs[j].getSubject() };
          break;
        }
      }
    }
  }

  if (!found) {
    Logger.log('❌ zip 첨부를 못 찾음.');
    return;
  }

  Logger.log('✅ 첨부 발견');
  Logger.log('   제목: ' + found.subject);
  Logger.log('   수신: ' + found.date);
  Logger.log('   파일: ' + found.att.getName() + ' (' + found.att.getSize() + ' bytes)');

  // Drive 쓰기
  var folders = DriveApp.getFoldersByName(DRIVE_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER);

  var stamp = Utilities.formatDate(found.date, Session.getScriptTimeZone(), 'yyyyMMdd');
  var file = folder.createFile(found.att.copyBlob().setName(stamp + '_' + found.att.getName()));

  Logger.log('✅ Drive 저장 완료');
  Logger.log('   폴더: ' + DRIVE_FOLDER + '/');
  Logger.log('   파일: ' + file.getName());
  Logger.log('   URL : ' + file.getUrl());
  Logger.log('');
  Logger.log('→ Gmail 읽기 + Drive 쓰기가 유저 OAuth 클라이언트 없이 동작한다.');

  // 암호 zip 인지 확인 (해제는 안 한다 — 다음 단계)
  try {
    Utilities.unzip(found.att.copyBlob());
    Logger.log('⚠️  Utilities.unzip 성공 = 암호가 안 걸린 zip 이다. 예상과 다르다.');
  } catch (e) {
    Logger.log('✅ Utilities.unzip 실패 (예상대로) — 암호 zip 확인: ' + e.message);
  }
}


/** STEP 3 — 시간 트리거를 만든다. 이게 자동화 보장의 마지막 조각. */
function step3_installTrigger() {
  Logger.log('=== STEP 3: 트리거 ===');

  // 기존 트리거 정리 (중복 방지)
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'heartbeat') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('heartbeat').timeBased().everyHours(1).create();
  Logger.log('✅ heartbeat 트리거 생성 (1시간마다)');
  Logger.log('→ 노트북·폰을 전부 끈 채로 1시간 뒤 heartbeat.json 을 확인하라.');
  Logger.log('   갱신돼 있으면 "유저 기기 전원 무관"이 실증된다.');
}


/**
 * 트리거가 살아있음을 Drive 에 기록한다.
 * 실제 파이프라인에서도 이 파일이 있어야 한다 — 트리거는 조용히 죽기 때문에,
 * 리포트에 "마지막 갱신 N일 전"을 찍으려면 이 타임스탬프가 필요하다.
 */
function heartbeat() {
  var folders = DriveApp.getFoldersByName(DRIVE_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER);

  var payload = {
    last_run_at: new Date().toISOString(),
    timezone: Session.getScriptTimeZone(),
    runtime_v8: (function () { try { eval('(() => 1)()'); return true; } catch (e) { return false; } })()
  };

  var files = folder.getFilesByName('heartbeat.json');
  if (files.hasNext()) {
    files.next().setContent(JSON.stringify(payload, null, 2));
  } else {
    folder.createFile('heartbeat.json', JSON.stringify(payload, null, 2), 'application/json');
  }
  Logger.log('heartbeat: ' + payload.last_run_at);
}


/** 정리용 — 검증 끝나면 트리거를 지운다. */
function cleanup_removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log('트리거 ' + triggers.length + '개 삭제. Drive 의 money-audit 폴더는 직접 지워라.');
}
