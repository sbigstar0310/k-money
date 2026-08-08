/**
 * 돈동생 — 파이프라인 본체. **라이브러리 쪽에 산다.**
 *
 * ━━ 왜 여기에 있나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 유저 시트 안의 스크립트(`container.gs`)는 **사본을 뜰 때 복사된 것이라
 * 우리가 고쳐도 닿지 않는다.** 거기 로직을 두면 버그 하나를 고쳐도 이미
 * 설치한 사람에게는 영영 전달되지 않고, 유저에게 "편집기 열고 전체 선택해서
 * 붙여넣으세요" 또는 "사본을 새로 만들고 다시 설정하세요"를 시켜야 한다.
 * 둘 다 사회 초년생에게 시킬 일이 아니다.
 *
 * 라이브러리는 버전 드롭다운 하나로 갈아끼워진다. 그래서 **바뀔 여지가 있는
 * 것은 전부 이 파일에 둔다.** 컨테이너에는 위임만 남긴다.
 *
 * ━━ env — 경계를 넘는 것은 전부 인자로 받는다 ━━━━━━━━━━━━━━━━
 *
 * ⚠️ 라이브러리 코드에서 전역 서비스를 그냥 부르면 **누구 것인지 모른다.**
 *
 *   PropertiesService.getScriptProperties()  → 라이브러리 프로젝트의 속성.
 *                                              유저 비밀번호가 거기 없다
 *   Session.getScriptTimeZone()              → 라이브러리의 시간대
 *   ScriptApp.newTrigger()                   → 어느 프로젝트에 걸리는지 불분명
 *
 * 전에 `instanceof Date` 가 라이브러리 경계를 못 넘어 84개월짜리 산출물이
 * 나온 적이 있다. **한 프로젝트에 다 넣고 테스트하면 재현되지 않는 종류다.**
 * 그래서 추측하지 않는다 — 컨테이너가 자기 컨텍스트에서 만든 것을 `env` 에
 * 담아 넘기고, 여기서는 받은 것만 쓴다.
 */

var KMApp = (function () {
  'use strict';

  var CFG = {
    gmailQuery: 'has:attachment filename:zip (뱅크샐러드 OR banksalad)',
    folderName: 'k-money',
    rawFolderName: 'raw',
    keepFacts: 12,        // facts-*.json 보관 개수. 델타 계산에 히스토리가 필요하다
    searchThreads: 10,
    processedKeep: 50,    // 중복 처리 방지용 메시지 ID 보관 개수
    staleDays: 14,        // 이만큼 새 데이터가 없으면 시트 첫 화면에서 경고한다
    // MimeType.GOOGLE_SHEETS 를 쓰지 않는다. 열거형 하나라도 경계를 덜 넘는 게 낫다.
    sheetsMime: 'application/vnd.google-apps.spreadsheet',
  };

  var PROP = {
    password: 'BANKSALAD_ZIP_PASSWORD',
    processed: 'PROCESSED_MESSAGE_IDS',
    passwordHint: 'BANKSALAD_ZIP_PASSWORD_HINT',
    // 값은 **거래의 마지막 날**이다 (메일 수신일이 아니다). dataAge_ 참고.
    lastIngest: 'LAST_INGEST_DATE',
  };

  var STATUS_CELL = 'B10';
  var CHECKED_CELL = 'B11';
  var STATUS_SHEET = '돈동생';
  var PROJECT_URL = 'https://github.com/sbigstar0310/k-money';

  // ── 본체 ─────────────────────────────────────────────────────────

  function process(env, opts) {
    opts = opts || {};
    var props = env.props;

    var password = props.getProperty(PROP.password);
    if (!password) {
      return { ok: false, step: 'setup', message: '비밀번호가 아직 없어요. 메뉴에서 ① 처음 설정하기 를 눌러 주세요.' };
    }

    var found = findAttachment(env, opts.force);
    if (!found) {
      // ⚠️ 아래 문구들은 **유저가 시트 첫 화면에서 매일 본다.**
      //    제품 전체가 존댓말인데 여기만 반말이었고, 성공했을 때조차
      //    다음에 뭘 하라는 말이 없었다. bytes 는 개발자용이라 뺐다
      //    (status.json 에는 남는다).
      return { ok: true, step: 'idle',
        message: '새로 온 뱅크샐러드 메일이 없어요. 앱에서 「파일로 받기」를 눌러 주세요.' };
    }

    var folder = ensureFolder(env.drive, CFG.folderName);
    var raw = ensureFolder(folder, CFG.rawFolderName);
    var stamp = Utilities.formatDate(found.date, env.tz, 'yyyy-MM-dd');

    // 1) 원본 보존 — 집계를 고쳤을 때 과거를 다시 계산할 수 있어야 한다
    var zipFile = putFile(raw, stamp + '.zip', found.attachment.copyBlob());

    // 2) 해제
    var files;
    try {
      files = unzipEncrypted(zipFile.getBlob(), password);
    } catch (e) {
      return {
        ok: false, step: 'decrypt',
        message: '압축을 풀지 못했어요. 뱅크샐러드에서 정한 비밀번호와 ' +
                 '여기 넣은 값이 다를 수 있어요. 메뉴의 "비밀번호 다시 넣기" 로 ' +
                 '맞춰 주세요. (' + e.message + ')',
      };
    }

    var xlsx = null;
    for (var i = 0; i < files.length; i++) {
      if (files[i].getName().toLowerCase().indexOf('.xlsx') !== -1) { xlsx = files[i]; break; }
    }
    if (!xlsx) {
      return { ok: false, step: 'unzip',
        message: '압축 안에 엑셀 파일이 없어요. 뱅크샐러드에서 다시 내보내 주세요.' };
    }

    // 3) xlsx → Google Sheets. openpyxl 이식이 통째로 사라지는 지점이다.
    var tmpId = null;
    var facts;
    try {
      tmpId = env.driveApi.Files.create(
        { name: 'k-money-tmp-' + stamp, mimeType: CFG.sheetsMime, parents: [raw.getId()] },
        xlsx
      ).id;

      var ss = env.sheets.openById(tmpId);
      var sheets = {};
      ss.getSheets().forEach(function (s) {
        sheets[s.getName()] = s.getDataRange().getValues();
      });

      // 4) 집계 — node 에서 검증한 그 코드
      // profile.json 은 LLM 이 대화로 채운다. 없어도 정상 동작한다.
      var extract = KM.parse.extract(sheets);
      facts = KM.aggregate.build(extract, {
        asOf: stamp,
        profile: readJson(folder, 'profile.json'),
      });
      facts.generatedAt = new Date().toISOString();
      facts.sourceMessageId = found.id;

      // 같은 날 두 번 내보내면 latest 와 날짜가 같아 델타가 전부 0이 된다.
      // 그런 날은 그 이전 스냅샷을 찾아서 비교한다.
      var d = KM.aggregate.delta(facts, readPrevious(folder, stamp));
      if (d) facts.delta = d;
    } finally {
      // 변환본은 중간 산물이라 남기지 않는다. 원본 zip 이 있으면 언제든 다시 만든다.
      if (tmpId) { try { env.drive.getFileById(tmpId).setTrashed(true); } catch (ignored) {} }
    }

    // 5) 저장 — latest 는 고정 이름이라 커넥터가 찾기 쉽다
    var json = JSON.stringify(facts, null, 2);
    putJson(folder, 'facts-' + stamp + '.json', json);
    putJson(folder, 'latest.json', json);
    pruneFacts(folder);

    markProcessed(props, found.id);
    // ⚠️ 메일 **수신일**(stamp)이 아니라 거래의 **마지막 날**을 적는다.
    //    유저에게 "데이터는 X 까지 있어요" 라고 말할 참이라, 저장하는 값이
    //    그 문장과 같은 것이어야 한다. 뱅샐이 어제까지만 담아 보냈는데
    //    오늘 날짜를 적으면 그 한 줄이 거짓말이 된다.
    props.setProperty(PROP.lastIngest, (facts.period && facts.period.to) || stamp);

    return {
      ok: true, step: 'done',
      message: stamp + ' 까지 정리했어요' +
               (facts.period ? ' (' + facts.period.days + '일치)' : ' (거래 0건)') +
               '. 이제 AI에게 물어보세요.',
      generatedFor: stamp,
      bytes: json.length,
      flags: (facts.dataQuality && facts.dataQuality.flags || []).map(function (f) { return f.code; }),
    };
  }

  /** 트리거가 부르는 것. 예외를 삼키지 않되 상태는 반드시 남긴다. */
  function runDaily(env) {
    // 트리거가 겹치거나 유저가 수동 실행을 같이 눌러도 두 번 돌지 않게 한다.
    if (!env.lock.tryLock(10 * 1000)) {
      return { ok: true, step: 'busy', message: '이미 실행 중이라 건너뜁니다.' };
    }
    try {
      var result = process(env);
      writeStatus(env, result);
      return result;
    } catch (e) {
      // 무인 실행이라 예외를 삼키면 아무도 모른다. Drive 에 남겨서
      // 다음에 대화할 때 LLM 이 읽을 수 있게 한다.
      var fail = { ok: false, step: 'unknown', message: String(e && e.message || e) };
      try { writeStatus(env, fail); } catch (ignored) {}
      throw e;
    } finally {
      env.lock.releaseLock();
    }
  }

  // ── Gmail ────────────────────────────────────────────────────────

  function findAttachment(env, force) {
    var processed = getProcessed(env.props);
    var threads = env.gmail.search(CFG.gmailQuery, 0, CFG.searchThreads);
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

  function getProcessed(props) {
    try {
      return JSON.parse(props.getProperty(PROP.processed) || '[]');
    } catch (e) {
      return [];
    }
  }

  function markProcessed(props, id) {
    var list = getProcessed(props);
    if (list.indexOf(id) === -1) list.push(id);
    while (list.length > CFG.processedKeep) list.shift();
    props.setProperty(PROP.processed, JSON.stringify(list));
  }

  // ── Drive ────────────────────────────────────────────────────────

  function ensureFolder(parent, name) {
    var it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
  }

  function findFile(folder, name) {
    var it = folder.getFilesByName(name);
    return it.hasNext() ? it.next() : null;
  }

  function putFile(folder, name, blob) {
    var existing = findFile(folder, name);
    if (existing) existing.setTrashed(true);
    return folder.createFile(blob.setName(name));
  }

  function putJson(folder, name, content) {
    var existing = findFile(folder, name);
    if (existing) { existing.setContent(content); return existing; }
    return folder.createFile(Utilities.newBlob(content, 'application/json', name));
  }

  function readJson(folder, name) {
    var f = findFile(folder, name);
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
  function readPrevious(folder, stamp) {
    var names = factNames(folder);
    names.sort().reverse();
    var current = 'facts-' + stamp + '.json';
    for (var i = 0; i < names.length; i++) {
      if (names[i] < current) return readJson(folder, names[i]);
    }
    return null;
  }

  function factNames(folder) {
    var names = [];
    var it = folder.getFiles();
    while (it.hasNext()) {
      var n = it.next().getName();
      if (n.indexOf('facts-') === 0 && n.indexOf('.json') !== -1) names.push(n);
    }
    return names;
  }

  /** 오래된 facts 를 정리한다. 델타에 쓸 만큼만 남긴다. */
  function pruneFacts(folder) {
    var names = factNames(folder).sort();
    while (names.length > CFG.keepFacts) {
      var f = findFile(folder, names.shift());
      if (f) f.setTrashed(true);
    }
  }

  // ── 데이터가 멈춘 걸 알아채기 ────────────────────────────────────
  //
  // ⚠️ **이 도구가 조용히 죽는 방식이 정확히 이거다.** 유저가 뱅샐 내보내기를
  //    그만두면 매일 아침 트리거는 멀쩡히 돌고 '처리할 새 메일이 없다' 를
  //    성공으로 적는다. 시트에는 초록 체크와 **오늘 날짜**가 찍힌다. 데이터는
  //    석 달 전 것인데 화면은 계속 정상이다.

  function dataAge(props) {
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
  function freshnessLine(age) {
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

  function isStale(age) {
    return age.state !== 'ok' || age.days > CFG.staleDays;
  }

  // ── 상태 쓰기 ────────────────────────────────────────────────────

  function writeStatus(env, result) {
    result.at = new Date().toISOString();
    var folder = ensureFolder(env.drive, CFG.folderName);
    putJson(folder, 'status.json', JSON.stringify(result, null, 2));
    writeStatusToSheet(env, result);
  }

  function writeStatusToSheet(env, result) {
    try {
      if (!env.ss) return;
      // 이름으로 먼저 찾는다. 유저가 시트를 하나 추가하면 [0] 은 남의 시트다.
      var sh = env.ss.getSheetByName(STATUS_SHEET) || env.ss.getSheets()[0];
      var age = dataAge(env.props);
      var stale = isStale(age);
      var fresh = freshnessLine(age);
      var ran = (result.ok ? '✅ ' : '⚠️ ') + result.message;

      // 데이터가 멈춰 있으면 그게 제일 중요한 소식이다. 실행 성공보다 앞에 온다.
      // 멈춘 게 아니면 굵은 칸은 실행 결과, 아랫줄이 신선도 — 같은 문장을
      // 두 번 쓰지 않는다.
      sh.getRange(STATUS_CELL).setValue(safeCell(stale ? fresh : ran));
      sh.getRange(CHECKED_CELL).setValue(safeCell(
        (stale ? ran : fresh) + ' · 마지막 확인 ' + localTime(env, new Date())));
    } catch (e) {
      // 시트에 안 붙어 있거나 권한이 없다. 상태는 이미 Drive 에 남았으니 넘어간다.
    }
  }

  /**
   * 시트가 수식으로 해석하지 않게 한다.
   * 앞 공백을 넘겨보면 안 된다 — 시트는 ' =IMPORTDATA(...)' 도 수식으로 읽는다.
   */
  function safeCell(s) {
    var t = String(s);
    return /^\s*[=+\-@]/.test(t) ? "'" + t : t;
  }

  /** 유저에게 보이는 시각은 늘 **유저 계정의** 시간대로. env.tz 가 그것이다. */
  function localTime(env, d) {
    return Utilities.formatDate(d, env.tz, 'yyyy-MM-dd HH:mm');
  }

  // ── 메뉴 동작 ────────────────────────────────────────────────────

  /** 메뉴 구성. 컨테이너가 이 목록대로 만든다. */
  function menuSpec() {
    return [
      { label: '① 처음 설정하기', handler: 'menu_setup' },
      { label: '② 지금 한 번 돌리기', handler: 'menu_runNow' },
      { separator: true },
      { label: '비밀번호 다시 넣기', handler: 'menu_setPassword' },
      { label: '상태 보기', handler: 'menu_status' },
      { label: '버전 보기', handler: 'menu_version' },
    ];
  }

  function menuSetup(env, installTrigger) {
    if (!promptPassword(env)) return;
    installTrigger();
    env.ui.alert('설정 완료',
      '매일 오전 7시에 자동으로 돌아갑니다.\n\n' +
      '뱅크샐러드 앱에서 데이터를 내보낼 때 방금 넣은 비밀번호를 ' +
      '「매번 똑같이」 써 주세요. 다르면 해제하지 못합니다.\n\n' +
      "'② 지금 한 번 돌리기' 로 바로 확인해 볼 수 있어요.",
      env.ui.ButtonSet.OK);
  }

  function menuSetPassword(env) {
    promptPassword(env);
  }

  function promptPassword(env) {
    var ui = env.ui;
    var r = ui.prompt('뱅크샐러드 zip 비밀번호',
      '내보내기할 때 설정한 비밀번호를 넣어 주세요.\n' +
      '이 값은 이 스크립트 안에만 저장되고 시트에는 적히지 않습니다.',
      ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return false;

    var pw = r.getResponseText();
    if (!pw) { ui.alert('비밀번호가 비어 있습니다.'); return false; }

    env.props.setProperty(PROP.password, pw);
    // 잊었을 때 확인할 수 있게 힌트만 남긴다. 값 자체는 절대 로그·시트에 안 쓴다.
    env.props.setProperty(PROP.passwordHint, hint(pw));
    return true;
  }

  /**
   * 첫 글자 · 자릿수 · 끝 글자. **자릿수가 맞아야 한다** — 문서에 그렇게
   * 약속해 놨고, 유저는 이 별을 세어서 비밀번호를 떠올린다.
   * 짧으면 힌트가 곧 답이다. '0930' → '0**0' 이면 후보가 100개로 준다.
   */
  function hint(pw) {
    // charAt 은 이모지를 반쪽으로 자른다. 글자 단위로 센다.
    // (매니페스트가 V8 을 고정하므로 Array.from 은 항상 있다. 폴백을 두면
    //  split('') 이 되는데, 그게 정확히 여기서 막으려는 동작이다.)
    var ch = Array.from(pw);
    var n = ch.length;
    if (n < 6) return n + '자';
    return ch[0] + new Array(n - 1).join('*') + ch[n - 1];
  }

  function menuRunNow(env) {
    var ui = env.ui;
    // 아침 7시 트리거와 겹칠 수 있다. 겹치면 임시 시트가 둘, latest.json 쓰기가
    // 둘이 되고 pruneFacts 가 서로가 쓰는 걸 지운다.
    if (!env.lock.tryLock(10 * 1000)) {
      ui.alert('잠시만요', '지금 자동 실행이 돌고 있어요. 1분 뒤에 다시 눌러 주세요.', ui.ButtonSet.OK);
      return;
    }
    try {
      var r = process(env, { force: true });
      writeStatus(env, r);
      ui.alert(r.ok ? '완료' : '실패', r.message, ui.ButtonSet.OK);
    } catch (e) {
      var msg = String((e && e.message) || e);
      try { writeStatus(env, { ok: false, step: 'error', message: msg }); } catch (ignored) {}
      ui.alert('실패', msg + '\n\n' + versionText(env), ui.ButtonSet.OK);
    } finally {
      env.lock.releaseLock();
    }
  }

  function menuStatus(env) {
    var ui = env.ui;
    // 상태를 '보는' 동작이 폴더를 만들면 안 된다. 없으면 없는 대로 답한다.
    var it = env.drive.getFoldersByName(CFG.folderName);
    var s = it.hasNext() ? readJson(it.next(), 'status.json') : null;
    var hintValue = env.props.getProperty(PROP.passwordHint);
    ui.alert('상태',
      // 신선도가 먼저다. '마지막 실행' 은 내보내기를 그만둬도 매일 갱신된다.
      freshnessLine(dataAge(env.props)) + '\n\n' +
      (s ? '마지막 실행 ' + localTime(env, new Date(s.at)) + '\n' + s.message
         : '아직 한 번도 돌지 않았습니다.') +
      (hintValue ? '\n\n비밀번호 힌트: ' + hintValue : ''),
      ui.ButtonSet.OK);
  }

  /**
   * ⚠️ **여기에 사용법을 적지 마라.** 대화상자에서 여러 줄짜리 절차를 읽고
   *    편집기를 열어 따라 하는 사람은 없다. 예전 문구가 그랬는데, 읽으면
   *    "가서 업데이트해라" 로 읽혔다 — 실제로는 **안 해도 되는 일**이다.
   */
  function menuVersion(env) {
    env.ui.alert('버전',
      versionText(env) + '\n\n' +
      '지금 그대로 두셔도 괜찮아요.\n' +
      '업데이트는 선택이고, 안 해도 쓰던 대로 계속 돌아갑니다.\n\n' +
      '바뀐 내용이 궁금하거나 업데이트하고 싶으시면 여기를 보세요.\n' +
      '방법도 같이 적어 뒀어요.\n' + PROJECT_URL,
      env.ui.ButtonSet.OK);
  }

  /**
   * 두 버전을 **따로** 보여준다. 시트 스크립트는 사본 안에 복사돼 있어서
   * 우리가 고쳐도 안 바뀌고, 라이브러리는 버전 드롭다운으로 바뀐다.
   * 하나로 합쳐 보여주면 옛 컨테이너로 도는 걸 아무도 모른다.
   */
  function versionText(env) {
    return '시트 스크립트: ' + (env.containerVersion || '알 수 없음') + '\n' +
      '집계 라이브러리: ' + KM.VERSION;
  }

  /**
   * 설정 점검. **줄 배열만 돌려준다** — 찍는 건 컨테이너 몫이다.
   * 진단이야말로 자주 고치게 되는 부분이라 라이브러리에 둔다.
   */
  function checkSetup(env) {
    var out = [];
    out.push('시트 스크립트 ' + (env.containerVersion || '알 수 없음') + ' / 집계 라이브러리 ' + KM.VERSION);

    var pw = env.props.getProperty(PROP.password);
    out.push(pw ? '✅ 비밀번호 있음 (' + pw.length + '자)'
                : '❌ 비밀번호 없음 — 메뉴 ① 처음 설정하기');

    try {
      env.driveApi.Files.list({ pageSize: 1 });
      out.push('✅ Drive API(고급 서비스) 켜져 있음');
    } catch (e) {
      out.push('❌ Drive API 고급 서비스가 꺼져 있다. 서비스 + → Drive API 추가.');
    }

    try {
      var n = env.gmail.search(CFG.gmailQuery, 0, 5).length;
      out.push((n ? '✅' : '⚠️') + ' Gmail 검색 결과 ' + n + '건 — ' + CFG.gmailQuery);
    } catch (e) {
      out.push('❌ Gmail 을 못 읽었다: ' + (e && e.message || e));
    }

    out.push(freshnessLine(dataAge(env.props)));
    return out;
  }

  return {
    CFG: CFG, PROP: PROP, checkSetup: checkSetup,
    STATUS_CELL: STATUS_CELL, CHECKED_CELL: CHECKED_CELL, STATUS_SHEET: STATUS_SHEET,
    process: process, runDaily: runDaily,
    findAttachment: findAttachment, getProcessed: getProcessed, markProcessed: markProcessed,
    ensureFolder: ensureFolder, findFile: findFile, putFile: putFile, putJson: putJson,
    readJson: readJson, readPrevious: readPrevious, pruneFacts: pruneFacts,
    dataAge: dataAge, freshnessLine: freshnessLine, isStale: isStale,
    writeStatus: writeStatus, writeStatusToSheet: writeStatusToSheet,
    safeCell: safeCell, localTime: localTime, hint: hint,
    menuSpec: menuSpec, menuSetup: menuSetup, menuSetPassword: menuSetPassword,
    menuRunNow: menuRunNow, menuStatus: menuStatus, menuVersion: menuVersion,
    versionText: versionText,
  };
})();
