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

    // ⚠️ **이름이 유저의 어휘여야 한다.** 예전엔 k-money/latest.json 이었는데,
    //    유저가 자연스럽게 쓸 말('돈', '가계부', '소비')이 한 글자도 없어서
    //    커넥터가 찾으려면 유저가 정확한 파일명을 외워 불러줘야 했다.
    //    "k-money 폴더의 latest.json 보고 알려줘" 는 안내가 아니라 주문이다.
    folderName: '돈동생',
    rawFolderName: 'raw',
    latestName: '돈동생-최신.json',
    statusName: '돈동생-상태.json',
    // 통용되는 이름 그대로. 이름에 한국어가 없어도 커넥터가 **내용으로**
    // 찾는다 (실측) — core 의 AGENT_FILE 과 같아야 한다.
    agentName: 'AGENT.md',
    memoryFolder: '메모리',
    // 주제가 이보다 많으면 상태 파일에 memoryOverflow 로 적는다. 시트에는
    // 안 띄운다 — 굵은 칸 두 개는 '데이터가 멈췄다' 와 실행 결과의 자리고,
    // 주제가 좀 많은 건 그 둘을 밀어낼 만한 소식이 아니다.
    memoryMax: 40,
    // 한 번에 휴지통으로 보낼 수 있는 최대 개수. **setTrashed 하나가 드라이브
    // 왕복 한 번**이고, 정리는 상태를 쓰기 **전에** 6분짜리 실행 예산 안에서
    // 돈다. 상한이 없으면 파일이 수천 개인 폴더가 시간 초과로 죽으면서 상태
    // 파일까지 못 쓰게 만든다. 남은 건 다음 실행에서 이어 지운다.
    memoryTrashBudget: 200,
    // 지난 기록은 '돈동생-YYYY-MM-DD.json'. 최신본과 접두사가 같으므로
    // 날짜 모양까지 봐야 한다 — 안 그러면 최신본을 히스토리로 세서 지운다.
    historyPattern: /^돈동생-\d{4}-\d{2}-\d{2}\.json$/,
    keepFacts: 12,        // 지난 기록 보관 개수. 델타 계산에 히스토리가 필요하다
    searchThreads: 10,
    staleDays: 14,        // 이만큼 새 데이터가 없으면 시트 첫 화면에서 경고한다
    // MimeType.GOOGLE_SHEETS 를 쓰지 않는다. 열거형 하나라도 경계를 덜 넘는 게 낫다.
    sheetsMime: 'application/vnd.google-apps.spreadsheet',
    // 뱅샐 xlsx 를 변환한 네이티브 시트. 뱅샐이 준 행 그대로다 — 우리가
    // 고치거나 거르지 않는다. "이 결제 뭐였지?" 는 요약 JSON 이 못 답한다.
    // ⚠️ raw/ 가 아니라 돈동생 폴더에 둔다. raw/ 는 "열지 마세요" 자리다.
    ledgerName: '돈동생-거래내역',
    // 달별 거래 파일. '돈동생/거래/거래-2026-08.json'. writeMonths 참고.
    // ⚠️ 이름이 곧 검색어다 — AI 는 "8월" 을 들으면 '거래-2026-08' 로 찾는다.
    monthFolder: '거래',
    monthPrefix: '거래-',
    tmpPrefix: 'k-money-tmp-',
    // 하루 정리(상태·메모리·AGENT.md)를 하는 시각. 유저 시간대 기준.
    upkeepHour: 7,
    // tick 이 잠금을 기다리는 시간. 1분마다 도는 것이 10초씩 기다리면
    // 수동 실행과 겹칠 때마다 그만큼 하루 한도(90분)를 태운다.
    // 못 잡으면 다음 분에 또 온다 — 기다릴 이유가 없다.
    tickLockMs: 500,
  };

  var PROP = {
    password: 'BANKSALAD_ZIP_PASSWORD',
    passwordHint: 'BANKSALAD_ZIP_PASSWORD_HINT',
    // 값은 **거래의 마지막 날**이다 (메일 수신일이 아니다). dataAge_ 참고.
    lastIngest: 'LAST_INGEST_DATE',
    // 메모리 파일을 **한 번이라도** 본 날. 상태 파일은 매일 덮이므로
    // "지금 비어 있다" 와 "여태 한 번도 없었다" 를 여기 아니면 못 가른다.
    memorySeen: 'MEMORY_FIRST_SEEN',
    // ⚠️ 아래 셋은 **버전을 넘어 살아남는 계약**이다 (test/tick.test.js).
    //    값은 메일 id 가 아니라 **probeKey 가 본 열쇠**다 — 둘은 거의 늘 같지만
    //    같다고 가정하지 않는다. probeKey 참고.
    lastMessage: 'LAST_MESSAGE_ID',
    lastFailed: 'LAST_FAILED_MESSAGE_ID',
    // 실패 문장. 하루 정리가 상태를 다시 쓸 때 실패를 성공처럼 덮지 않게
    // 들고 있는다 — 상태 파일을 읽으러 드라이브에 가지 않아도 된다.
    lastFailedMessage: 'LAST_FAILED_MESSAGE',
    // 하루 정리를 한 날 (유저 시간대 'yyyy-MM-dd').
    lastUpkeep: 'LAST_UPKEEP_DATE',
  };

  var STATUS_CELL = 'B10';
  var CHECKED_CELL = 'B11';
  var STATUS_SHEET = '돈동생';
  var PROJECT_URL = 'https://github.com/sbigstar0310/k-money';

  // ── 본체 ─────────────────────────────────────────────────────────

  function process(env, opts) {
    opts = opts || {};
    var password = env.props.getProperty(PROP.password);
    if (!password) {
      return { ok: false, step: 'setup', message: '비밀번호가 아직 없어요. 메뉴에서 ① 처음 설정하기 를 눌러 주세요.' };
    }

    var found = findAttachment(env);
    if (!found) {
      return { ok: true, step: 'idle',
        message: '새로 온 뱅크샐러드 메일이 없어요. 앱에서 「파일로 받기」를 눌러 주세요.' };
    }

    var folder = ensureFolder(env.drive, CFG.folderName);
    var raw = ensureFolder(folder, CFG.rawFolderName);
    ensureAgentGuide(folder, env);
    // 빈 폴더라도 만들어 둔다 — AI 에게 "여기 써도 된다" 는 신호다.
    ensureFolder(folder, CFG.memoryFolder);
    var stamp = Utilities.formatDate(found.date, env.tz, 'yyyy-MM-dd');

    // 1) 원본 보존 — 집계를 고쳤을 때 과거를 다시 계산할 수 있어야 한다
    var zipFile = putFile(raw, stamp + '.zip', found.attachment.copyBlob());

    var xlsx = openXlsx(zipFile, password);
    if (xlsx.error) return xlsx.error;

    // 집계가 던지면 buildFacts 가 자기 임시 시트를 치운다. 여기서부터는
    // 변환본을 **거래내역으로 올릴지 버릴지** 우리가 정한다.
    var built = buildFacts(env, folder, raw, xlsx.blob, stamp, found);
    var kept = false;
    try {
      var result = persist(env, folder, built.facts, stamp, found);
      // ⚠️ behind 면 올리지 않는다. 최신본(JSON)은 과거로 안 갔는데 거래내역만
      //    옛 데이터로 바뀌면, AI 가 두 파일에서 서로 다른 "지금" 을 읽는다.
      //    달별 파일도 같은 편에 선다 — done 일 때만 쓴다.
      if (result.step === 'done') {
        ledgerFirst(built, result);
        kept = promoteLedger(env, folder, raw, built.sheetId, result);
        // 거래내역처럼 **못 써도 실행은 성공이다.** 최신본은 이미 썼다.
        try {
          result.monthFiles = writeMonths(env, folder,
            monthRows(built.ledger.values, ledgerTimes(env, built.ledger), env));
        } catch (e) {
          result.monthFilesError = String(e && e.message || e).slice(0, 200);
        }
      }
      return result;
    } finally {
      if (!kept) trashQuietly(env, built.sheetId);
    }
  }

  /**
   * 변환본을 '돈동생-거래내역' 으로 올리고, 그다음에야 옛것을 버린다.
   *
   * ⚠️ **순서가 전부다.** 옛것을 먼저 버리면 그 사이에 실행이 죽었을 때
   *    (6분 초과) 거래내역이 아예 없는 상태가 된다. 새것이 자리를 잡은 뒤에
   *    버리면 최악이 "잠깐 두 개" 이고, 그건 다음 실행이 치운다.
   * ⚠️ 옛것은 실행 **전에** 목록을 떠 둔다. 방금 이름을 바꾼 파일이 이름
   *    검색에 언제 잡힐지는 드라이브 마음이라, 새것을 이름으로 거르지 않고
   *    id 로 거른다.
   * ⚠️ 영구 삭제가 아니라 휴지통이다. 30일 안에 되돌릴 수 있어야 한다.
   *
   * 거래내역을 못 올려도 **실행은 성공이다** — 최신본은 이미 썼다.
   * 대신 결과에 적고 false 를 돌려준다 (그러면 부른 쪽이 변환본을 치운다).
   */
  function promoteLedger(env, folder, raw, sheetId, result) {
    var olds = [];
    try {
      var it = folder.getFilesByName(CFG.ledgerName);
      while (it.hasNext()) olds.push(it.next().getId());
      // 이름 바꾸기와 옮기기를 요청 하나로. 둘로 나누면 그 사이에 죽었을 때
      // raw/ 안에 '거래내역' 이름의 파일이 남는다.
      env.driveApi.Files.update({ name: CFG.ledgerName }, sheetId, null,
        { addParents: folder.getId(), removeParents: raw.getId() });
    } catch (e) {
      result.ledgerError = String(e && e.message || e).slice(0, 200);
      return false;
    }
    olds.forEach(function (id) {
      if (id === sheetId) return;
      // 하나 못 버려도 나머지는 버린다. 남은 건 다음 실행이 다시 본다.
      try { env.drive.getFileById(id).setTrashed(true); } catch (ignored) {}
    });
    return true;
  }

  function trashQuietly(env, id) {
    if (!id) return;
    try { env.drive.getFileById(id).setTrashed(true); } catch (ignored) {}
  }

  /**
   * 거래내역 시트의 첫 탭을 '가계부 내역' 으로. 다른 탭(뱅샐현황)은 그대로 둔다.
   *
   * ⚠️ 드라이브 커넥터의 미리보기는 **첫 탭**을 읽는다. 뱅샐 xlsx 는
   *    뱅샐현황이 먼저라, 그대로 두면 AI 가 거래를 한 줄도 못 본다.
   * 못 옮겨도 실행은 성공이다 — 결과에만 적는다.
   */
  function ledgerFirst(built, result) {
    try {
      var led = built.ledger;
      if (!led || !led.tab || led.tab.getIndex() === 1) return;
      built.ss.setActiveSheet(led.tab);
      built.ss.moveActiveSheet(1);
    } catch (e) {
      result.ledgerOrderError = String(e && e.message || e).slice(0, 200);
    }
  }

  // ── 달별 거래 파일 ───────────────────────────────────────────────
  //
  // ⚠️ **시트로는 거래 하나를 못 찾는다** (실측 2026-09-25). 드라이브 커넥터의
  //    read_file_content 는 2천 줄 넘는 거래내역에서 60줄쯤의 **표본**만 주고
  //    다음 쪽이 없다. 다운로드는 파일 전체를 base64 로 대화에 붓는다.
  //    JSON 은 통째로 읽힌다. 그래서 달마다 하나씩 둔다 — "8월 5일 7만원" 은
  //    '거래-2026-08.json' 하나만 열면 된다.
  //
  // ⚠️ 파싱된 거래(KM.parse.extract)로 만들지 않는다. 거기엔 시간·메모가 없고
  //    타입은 우리 어휘로 바뀌었고 외화는 따로 빠져 있다. 이 파일은 **뱅샐이 준
  //    줄 그대로**여야 해서 원본 행에서 만든다. 날짜만 core 의 day() 를 쓴다 —
  //    달을 가르는 기준이 최신본의 달과 같아야 한다.

  /**
   * 시간 칸이 **시트에 보이는 글자.** 못 얻으면 null (그러면 값으로 푼다).
   *
   * ⚠️ 시각만 있는 셀은 getValues() 가 1899-12-30 의 Date 로 준다. Asia/Seoul 은
   *    1899 년에 LMT(+8:27:52)라, 그 Date 를 formatDate 로 찍으면 32분 8초가
   *    밀린다. 화면 글자는 시트가 찍은 그대로라 이 문제가 없다. 열 하나만
   *    읽는다 — 2천 줄에 호출 한 번이다.
   */
  function ledgerTimes(env, ledger) {
    try {
      var n = ledger.values.length;
      if (!n) return null;
      return ledger.tab.getRange(1, 2, n, 1).getDisplayValues().map(function (r) { return r[0]; });
    } catch (e) {
      return null;
    }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** '14:05', '오후 2:05', 'PM 2:05:09' → 'HH:mm' 또는 'HH:mm:ss'. 초는 있을 때만. */
  function timeFromText(s) {
    var t = String(s).trim();
    var m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
    if (!m) return null;
    var h = Number(m[1]);
    var pm = /오후|PM/i.test(t), am = /오전|AM/i.test(t);
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    return pad2(h) + ':' + m[2] + (m[3] ? ':' + m[3] : '');
  }

  /**
   * 화면 글자가 없을 때 값으로 푼다.
   *
   * ⚠️ Date 면 **로컬 시·분이나 formatDate 로 읽지 않는다** — 둘 다 1899 년의
   *    LMT 를 따라 밀린다. 시트는 시각을 **지금의 표준 오프셋**(한국 +9:00)으로
   *    Date 에 담으므로, UTC 시각에 그 오프셋을 더해 읽는다. 오프셋은 현대
   *    날짜로 잰다. 진짜 Apps Script 에서는 화면 글자가 있어서 여기 안 온다.
   */
  function timeFromValue(v, offsetMs) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string') return timeFromText(v) || v.trim();
    if (typeof v === 'number') {
      var secs = Math.round((v - Math.floor(v)) * 86400) % 86400;
      return pad2(Math.floor(secs / 3600)) + ':' + pad2(Math.floor(secs / 60) % 60) + ':' + pad2(secs % 60);
    }
    if (KM.parse.isDateLike(v)) {
      var d = new Date(v.getTime() + offsetMs);
      return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
    }
    return String(v);
  }

  /** 유저 시간대의 지금 오프셋(ms). formatDate 한 번. */
  function tzOffsetMs(env) {
    var now = new Date(Math.floor(Date.now() / 1000) * 1000);
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
      .exec(Utilities.formatDate(now, env.tz, 'yyyy-MM-dd HH:mm:ss'));
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - now.getTime();
  }

  /** 금액 칸 → 숫자. 뱅샐 부호 그대로. 외화 소수점은 살린다. */
  function amountOf(v) {
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    return KM.parse.num(v);
  }

  /**
   * 가계부 행 → { 'YYYY-MM': [행, …] }. **시트 순서 그대로**(뱅샐은 최신이 위).
   * 날짜가 없는 줄은 뺀다 — parse 의 ledger 와 같은 기준이다.
   */
  function monthRows(values, times, env) {
    var out = {};
    var offset = null;
    var T = KM.parse.text;
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      var day = KM.parse.day(r[0]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      var shown = times && times[i] !== undefined ? timeFromText(times[i]) : null;
      var time = shown;
      if (time === null) {
        if (offset === null && KM.parse.isDateLike(r[1])) offset = tzOffsetMs(env);
        time = timeFromValue(r[1], offset || 0);
      }
      var ym = day.slice(0, 7);
      (out[ym] = out[ym] || []).push([day, time, T(r[2]), T(r[3]), T(r[4]), T(r[5]),
        amountOf(r[6]), T(r[7]), T(r[8]), T(r[9])]);
    }
    return out;
  }

  /**
   * 달 파일 본문. **한 줄에 거래 하나** — 통째로 한 줄이면 커넥터가 잘라 보여줄
   * 때 어디서 끊겼는지 모른다. 들여쓰기는 안 한다 (2천 줄이면 토큰이 크다).
   *
   * ⚠️ sourceMessageDate 같은 **실행마다 바뀌는 값을 넣지 않는다.** 넣으면 모든
   *    달이 매번 달라져서 "바뀐 달만 쓴다" 가 무너진다. 신선함은 최신본이 말한다.
   */
  function monthJson(ym, rows) {
    return '{"month":' + JSON.stringify(ym) +
      ',"columns":' + JSON.stringify(KM.layout.BANKSALAD_V1.ledgerHeader) +
      ',"count":' + rows.length +
      ',"rows":[\n' + rows.map(function (r) { return JSON.stringify(r); }).join(',\n') + '\n]}\n';
  }

  function md5Hex(s) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
      .map(function (b) { return ((b + 256) % 256 + 0x100).toString(16).slice(1); }).join('');
  }

  /**
   * 달마다 '거래/거래-YYYY-MM.json' 을 쓴다. **바뀐 달만.**
   *
   * ⚠️ **드라이브 왕복을 센다.** 2천 줄에 이미 24초고 한도는 6분이다.
   *    폴더 찾기 한 번, 목록 한 번(Files.list 가 md5Checksum 을 같이 준다 —
   *    파일을 열어 읽지 않고 비교한다), 그리고 바뀐 달만 쓰기. 보통은 이번 달
   *    하나다.
   *
   * ⚠️ **덮어쓰기 규칙.** done 은 behind 가드를 지난 것이라 가진 것보다 옛
   *    데이터가 아니다 — 그래서 이번 내보내기에 **있는 달은** 이번 것으로 덮는다
   *    (뱅샐에서 고친 분류·메모가 반영돼야 한다).
   *    - 이번 내보내기에 **없는 달은 건드리지 않는다.** 뱅샐 창은 1년이라
   *      옛 달은 여기서만 남는다. 뱅샐에서 한 달치를 통째로 지운 경우에도
   *      남는데, 지우는 쪽이 틀리면 되돌릴 수 없어서 그쪽을 택했다.
   *    - **가장 옛 달은 반쪽일 수 있다.** 1년 창은 달 중간에서 시작한다
   *      (9/25 에 내보내면 작년 9/25 부터). 그 달만 옛 파일을 한 번 읽어서
   *      이번 첫날보다 앞선 줄을 뒤에 붙인다. 통째로 덮으면 9/1~9/24 가
   *      사라진다. 첫날이 1일이면 읽지도 않는다.
   *    - 끝쪽(이번 마지막 날보다 뒤)은 합치지 않는다 — behind 가드가 그런 옛
   *      파일이 있을 수 없게 막는다.
   */
  function writeMonths(env, folder, months) {
    var keys = Object.keys(months).sort();
    var info = { months: keys.length, written: 0, unchanged: 0 };
    if (!keys.length) return info;

    var dir = ensureFolder(folder, CFG.monthFolder);
    var have = {};
    var token = null;
    do {
      var page = env.driveApi.Files.list({
        q: "'" + dir.getId() + "' in parents and trashed = false",
        fields: 'nextPageToken, files(id, name, md5Checksum)',
        pageSize: 1000, pageToken: token || undefined,
      });
      (page.files || []).forEach(function (f) { if (!have[f.name]) have[f.name] = f; });
      token = page.nextPageToken || null;
    } while (token);

    // 이번 내보내기의 첫날. 시트 순서를 믿지 않고 가장 옛 달에서 센다.
    var first = months[keys[0]].reduce(function (a, r) { return r[0] < a ? r[0] : a; }, '9999');

    keys.forEach(function (ym) {
      var name = CFG.monthPrefix + ym + '.json';
      var prev = have[name];
      var rows = months[ym];
      if (prev && ym === keys[0] && first.slice(8) !== '01') {
        rows = rows.concat(olderRows(env, prev.id, first));
      }
      var content = monthJson(ym, rows);
      if (prev && prev.md5Checksum && prev.md5Checksum === md5Hex(content)) {
        info.unchanged++;
        return;
      }
      if (prev) env.drive.getFileById(prev.id).setContent(content);
      else dir.createFile(Utilities.newBlob(content, 'application/json', name));
      info.written++;
    });
    return info;
  }

  /** 옛 달 파일에서 before 보다 앞선 줄. 못 읽거나 모양이 다르면 없는 셈 친다. */
  function olderRows(env, id, before) {
    try {
      var old = JSON.parse(env.drive.getFileById(id).getBlob().getDataAsString('UTF-8'));
      if (JSON.stringify(old.columns) !== JSON.stringify(KM.layout.BANKSALAD_V1.ledgerHeader)) return [];
      return (old.rows || []).filter(function (r) { return String(r[0]) < before; });
    } catch (e) {
      return [];
    }
  }

  /** 2) 해제 — zip 안에서 xlsx 를 꺼낸다. */
  function openXlsx(zipFile, password) {
    var files;
    try {
      files = unzipEncrypted(zipFile.getBlob(), password);
    } catch (e) {
      return { error: {
        ok: false, step: 'decrypt',
        message: '압축을 풀지 못했어요. 뱅크샐러드에서 정한 비밀번호와 ' +
                 '여기 넣은 값이 다를 수 있어요. 메뉴의 "비밀번호 다시 넣기" 로 ' +
                 '맞춰 주세요. (' + e.message + ')',
      } };
    }
    for (var i = 0; i < files.length; i++) {
      if (files[i].getName().toLowerCase().indexOf('.xlsx') !== -1) return { blob: files[i] };
    }
    return { error: { ok: false, step: 'unzip',
      message: '압축 안에 엑셀 파일이 없어요. 뱅크샐러드에서 다시 내보내 주세요.' } };
  }

  /**
   * 3~4) xlsx → Google Sheets → 집계. 실패하면 던진다 (runGuarded 가 받는다).
   *
   * 변환본은 { facts, sheetId } 로 돌려준다 — 거래내역으로 올릴지는
   * process 가 persist 결과를 보고 정한다.
   * ⚠️ **던질 때는 여기서 치운다.** 반쯤 변환된 시트가 남으면 다음에 누가
   *    그걸 거래내역으로 착각한다.
   */
  function buildFacts(env, folder, raw, xlsx, stamp, found) {
    var tmpId = null;
    var ok = false;
    try {
      tmpId = env.driveApi.Files.create(
        { name: CFG.tmpPrefix + stamp, mimeType: CFG.sheetsMime, parents: [raw.getId()] },
        xlsx
      ).id;

      var ss = env.sheets.openById(tmpId);
      var sheets = {};
      var tabs = {};
      ss.getSheets().forEach(function (s) {
        sheets[s.getName()] = s.getDataRange().getValues();
        tabs[s.getName()] = s;
      });
      // 달별 파일과 탭 순서는 done 일 때만 쓴다 — 여기서는 들고만 간다.
      var L = KM.layout.find(Object.keys(sheets));
      var ledger = L ? { tab: tabs[L.ledgerSheet], values: sheets[L.ledgerSheet], layout: L } : null;

      // node 에서 검증한 그 코드.
      // 개인화는 메모리 폴더의 마크다운으로 간다 — facts 에 싣지 않는다.
      var facts = KM.aggregate.build(KM.parse.extract(sheets), { asOf: stamp });
      facts.generatedAt = new Date().toISOString();
      facts.sourceMessageId = found.id;
      // AI 가 "갱신해줘" 를 받았을 때 Gmail 커넥터로 본 최신 뱅샐 메일 시각과
      // 비교하는 값이다. 받은 날(stamp)은 날짜뿐이라 같은 날 두 번 내보내면
      // 못 가른다. getTime 으로 새로 만든다 — Date 가 경계를 넘어올 때
      // 무엇이 따라오는지 가정하지 않는다 (맨 위 instanceof 사고).
      facts.sourceMessageDate = new Date(found.date.getTime()).toISOString();

      // 같은 날 두 번 내보내면 최신본과 날짜가 같아 델타가 전부 0이 된다.
      // 그런 날은 그 이전 스냅샷을 찾아서 비교한다.
      // ⚠️ **비교 기준은 파일 이름의 기준과 같아야 한다.** 히스토리는 받은
      //    날(stamp)로 이름 짓는다 — 아래 persist 와 같은 기준이다.
      var d = KM.aggregate.delta(facts, readPrevious(folder, stamp));
      if (d) facts.delta = d;
      ok = true;
      return { facts: facts, sheetId: tmpId, ss: ss, ledger: ledger };
    } finally {
      if (!ok) trashQuietly(env, tmpId);
    }
  }

  /** 5) 저장 — 최신본은 고정 이름이라 AI 가 찾기 쉽다. */
  function persist(env, folder, facts, stamp, found) {
    var json = JSON.stringify(facts, null, 2);

    // ⚠️ **이름은 '받은 날', 내용은 '데이터 날짜'.** 한때 파일 이름도
    //    데이터 날짜로 지었는데, 그러면 **매일 거래하지 않는 사람은 히스토리가
    //    한 개만 남는다.** 데이터 마지막 날이 안 움직이니 매 실행이 같은 파일을
    //    덮어쓰고, readPrevious 가 자기보다 앞선 걸 못 찾아 delta 가 영영
    //    안 나온다 (실측: 순자산이 백만원대로 움직였는데 보고 0건).
    //    파일 이름은 **스냅샷의 정체**고, generatedFor 는 **내용**이다.
    // ⚠️ 메일 **수신일**이 아니라 거래의 **마지막 날**을 적는다.
    //    유저에게 "데이터는 X 까지 있어요" 라고 말할 값이라, 저장하는 것이
    //    그 문장과 같아야 한다.
    var day = facts.generatedFor || stamp;

    // 히스토리는 언제나 남긴다 — 이름이 받은 날 기준이라 부딪히지 않고,
    // 나중에 집계를 고쳤을 때 다시 계산할 근거가 된다.
    putJson(folder, historyName(stamp), json);

    // ⚠️ **최신본은 절대 과거로 가지 않는다.** 메일이 최신이라고 그 안의
    //    데이터가 최신인 건 아니다 — 뱅샐은 내보낼 기간을 고를 수 있어서,
    //    유저가 과거 구간을 다시 내보내면 '가장 최근 메일'이 더 옛날 데이터를
    //    들고 온다. 그때 최신본을 덮으면 AI 가 2주 전 잔액을 오늘로 읽는다.
    //    메일을 어떻게 고르든 이 가드가 마지막 방어선이다.
    var prev = readJson(folder, CFG.latestName);
    var prevDay = prev && (prev.generatedFor || null);
    if (prevDay && day < prevDay) {
      pruneFacts(folder);
      return {
        // ⚠️ 실패가 아니다 — 지켜낸 것이다. 시트가 result.message 앞에 ✅ 를
        //    붙이므로(writeStatusToSheet) 문장도 그렇게 읽혀야 한다.
        //    데이터가 정말 오래됐으면 신선도 줄이 먼저 나가니 여기서 다시
        //    "내보내 주세요" 를 말할 필요가 없다.
        ok: true, step: 'behind',
        message: '이미 가진 데이터(' + prevDay + ')가 더 최신이라 그대로 뒀어요. ' +
                 '이 메일은 ' + day + ' 까지였어요.',
        generatedFor: prevDay,
      };
    }

    putJson(folder, CFG.latestName, json);
    pruneFacts(folder);
    env.props.setProperty(PROP.lastIngest, day);

    return {
      ok: true, step: 'done',
      message: day + ' 까지 정리했어요' +
               (facts.period ? ' (' + facts.period.days + '일치)' : ' (거래 0건)') +
               '. 이제 AI에게 물어보세요.',
      generatedFor: day,
      // ⚠️ `.length` 가 아니다 — 그건 UTF-16 코드유닛이고, 한국어라 실제
      //    바이트는 1.14배다. 유저가 상태 파일에서 보는 값이니 드라이브가
      //    세는 것과 같아야 한다.
      bytes: Utilities.newBlob(json).getBytes().length,
      flags: (facts.dataQuality && facts.dataQuality.flags || []).map(function (f) { return f.code; }),
    };
  }

  /**
   * 잠금을 잡고 한 번 돌린다. **모든 실행 경로가 여기를 지난다.**
   *
   * ⚠️ 예전엔 runOnceForce 만 잠금 없이 돌았고, 그게 하필 컨테이너에 있어서
   *    이미 사본을 뜬 사람에게는 영영 못 고치는 상태였다. 겹치면 임시 시트가
   *    둘, 최신본 쓰기가 둘이 되고 pruneFacts 가 서로 쓰는 걸 지운다.
   *
   * 처리 기록(LAST_MESSAGE_ID)은 **보지 않고** 남기기만 한다. 보는 건 tick
   * 뿐이다 — 손으로 돌린 것도 기록이 남아야 다음 tick 이 조용하다.
   */
  function runGuarded(env, opts) {
    if (!env.lock.tryLock(10 * 1000)) {
      return { ok: true, step: 'busy', message: '이미 실행 중이라 건너뜁니다.' };
    }
    try {
      // 비밀번호가 없으면 process 가 Gmail 전에 돌아선다. 여기서도 안 본다.
      var key = env.props.getProperty(PROP.password) ? probeKey(env) : null;
      return runLocked(env, key);
    } catch (e) {
      // probeKey 가 던진 경우. runLocked 가 던진 건 거기서 이미 상태를 남겼다.
      if (!e || !e.kmStatusWritten) {
        try { writeStatus(env, { ok: false, step: 'unknown', message: String(e && e.message || e) }); } catch (ignored) {}
      }
      throw e;
    } finally {
      env.lock.releaseLock();
    }
  }

  /**
   * 잠금을 쥔 채로 파이프라인을 한 번 돌리고, 상태와 처리 기록을 남긴다.
   *
   * ⚠️ **처리 기록은 끝난 뒤에만 남긴다.** 먼저 남기면 집계 중에 죽었을 때
   *    (6분 초과, 드라이브 오류) 기록만 남고 다음 tick 이 "이미 처리했다" 며
   *    넘어간다 — 그 메일은 영영 처리되지 않는다.
   * ⚠️ key 는 **돌리기 전에** 본 것이다. 도는 사이에 새 메일이 오면 우리는
   *    그걸 처리했을 수도 있지만 기록은 옛 key 다 — 다음 tick 이 한 번 더
   *    돈다. 반대(안 본 메일을 처리했다고 적기)보다 이쪽이 안전하다.
   */
  function runLocked(env, key) {
    var result;
    try {
      result = process(env, {});
    } catch (e) {
      var fail = { ok: false, step: 'unknown', message: String(e && e.message || e) };
      try { writeStatus(env, fail); } catch (ignored) {}
      remember(env, key, fail);
      try { e.kmStatusWritten = true; } catch (ignored) {}
      throw e;
    }
    // 상태 쓰기보다 **먼저** 남긴다. 파이프라인은 끝났다 — 상태 파일 하나를
    // 못 썼다고 다음 분에 14초짜리를 또 돌 이유가 없다.
    remember(env, key, result);
    writeStatus(env, result);
    return result;
  }

  /**
   * 실행 결과를 처리 기록에 남긴다.
   *
   * - 성공·behind·idle → 처리한 것. 다음 tick 은 조용하다
   *   (behind 는 실패가 아니라 지켜낸 것이다. 매분 다시 돌 이유가 없다)
   * - 실패 → 실패한 것. **같은 메일이면 tick 이 다시 안 돈다.** 틀린
   *   비밀번호는 유저가 고칠 때까지 계속 틀린다 — 매분 다시 풀면 14초 ×
   *   1440 으로 하루 한도(90분)를 한낮 전에 다 쓰고, 그다음부터는 맞는 메일이
   *   와도 안 돈다. 새 메일이나 손으로 돌리기(runForced)가 대기를 푼다
   * - setup → 아무것도 안 남긴다. 메일을 본 적도 없다
   */
  function remember(env, key, result) {
    if (!key || result.step === 'setup') return;
    if (result.ok) {
      env.props.setProperty(PROP.lastMessage, key);
      env.props.deleteProperty(PROP.lastFailed);
      env.props.deleteProperty(PROP.lastFailedMessage);
    } else {
      env.props.setProperty(PROP.lastFailed, key);
      // 스크립트 속성은 값 하나에 9KB 까지다. 문장 하나면 충분하다.
      env.props.setProperty(PROP.lastFailedMessage, String(result.message || '').slice(0, 500));
    }
  }

  /** 옛 트리거(매일 7시)가 부르는 것. 예외를 삼키지 않되 상태는 반드시 남긴다. */
  function runDaily(env) {
    return runGuarded(env, {});
  }

  /**
   * 편집기·메뉴에서 손으로 돌릴 때.
   *
   * 처리 이력이 없어진 뒤로 runDaily 와 하는 일이 같다. 이름을 남겨 두는 건
   * container.gs 의 runOnceForce 와 메뉴가 부르고 있어서다 — 사본을 이미 뜬
   * 사람의 컨테이너는 못 고친다. 실패 대기(LAST_FAILED_MESSAGE_ID)도 안 본다 —
   * 비밀번호만 고친 사람에게 남은 유일한 복구 경로다.
   */
  function runForced(env) {
    return runGuarded(env, {});
  }

  // ── tick — 1분마다 ───────────────────────────────────────────────
  //
  // ⚠️ **하루 1440번 돈다.** 트리거 실행 시간 한도는 하루 90분이고, 라이브러리를
  //    붙인 채 아무것도 안 하는 실행이 이미 1.4초쯤이다 (실측). 파이프라인 한
  //    번은 14초. 그래서 이 함수의 거의 전부는 **아무것도 안 하는 경로**를
  //    싸게 만드는 일이다.
  //
  //    새 메일이 없으면: 잠금 → Gmail 검색 하나 → 속성 비교 → 끝.
  //    드라이브도 시트도 안 연다. 상태 파일도 안 쓴다 — 매분 쓰면 수정시각이
  //    하루 1440번 흔들리고 커넥터가 폴더를 "방금 바뀐 것" 으로 읽는다.
  //
  //    대신 하루 한 번(유저 시간대 07:00 이후 첫 tick)은 상태를 쓴다. 유저가
  //    내보내기를 그만뒀을 때 "데이터가 멈춰 있어요" 를 띄울 자리가 그것뿐이다.

  /**
   * 1분 트리거가 부르는 것.
   *
   * 돌려주는 step: setup · busy · idle · waiting(실패한 같은 메일) · 그리고
   * 새 메일이면 process 의 것(done · behind · decrypt …).
   */
  function tick(env) {
    // ⚠️ 비밀번호가 없으면 아무것도 안 한다. 잠금도 Gmail 도 안 본다.
    //    설정 전에 트리거만 걸린 사본이 매분 상태를 쓰면 빈 폴더가 생긴다.
    //    유저는 메뉴 ① 을 누를 때 안내를 받는다.
    if (!env.props.getProperty(PROP.password)) {
      return { ok: true, step: 'setup', message: '비밀번호가 아직 없어요. 메뉴에서 ① 처음 설정하기 를 눌러 주세요.' };
    }
    if (!env.lock.tryLock(CFG.tickLockMs)) {
      return { ok: true, step: 'busy', message: '이미 실행 중이라 건너뜁니다.' };
    }
    try {
      var now = nowOf(env);
      var key = probeKey(env);
      var done = env.props.getProperty(PROP.lastMessage);
      var failed = env.props.getProperty(PROP.lastFailed);

      if (key && key !== done && key !== failed) {
        var result = runLocked(env, key);
        // 방금 상태를 썼다. 07:00 이후라면 그게 오늘의 정리다.
        if (upkeepDue(env, now)) env.props.setProperty(PROP.lastUpkeep, localDay(env, now));
        return result;
      }

      var quiet = !key
        ? { ok: true, step: 'idle',
            message: '받은 뱅크샐러드 메일이 아직 없어요. 앱에서 「파일로 받기」를 눌러 주세요.' }
        : key === done
          ? { ok: true, step: 'idle',
              message: '새 내보내기가 없어요. 받은 데이터 그대로예요.' }
          // ⚠️ **대기는 성공이 아니다.** 하루 정리가 이걸 상태에 쓸 때 ✅ 가 붙으면
          //    틀린 비밀번호가 다음 날 아침 조용히 "정상" 으로 덮인다.
          //    지난 실패 문장을 그대로 들고 간다.
          : { ok: false, step: 'waiting',
              message: (env.props.getProperty(PROP.lastFailedMessage) || '지난번 메일을 처리하지 못했어요.') +
                ' — 같은 메일이라 다시 시도하지 않았어요. 고친 뒤 \'② 지금 한 번 돌리기\' 를 ' +
                '누르거나, 뱅크샐러드에서 다시 내보내 주세요.' };

      if (upkeepDue(env, now)) {
        // ⚠️ 표시를 **먼저** 남긴다. 상태 쓰기가 드라이브 오류로 던지면, 표시가
        //    없을 때 그날 남은 tick 이 전부 다시 시도한다 — 매분 몇 초씩.
        env.props.setProperty(PROP.lastUpkeep, localDay(env, now));
        writeStatus(env, quiet);
      }
      return quiet;
    } finally {
      env.lock.releaseLock();
    }
  }

  /** 테스트가 시각을 넣을 수 있게. 함수든 Date 든 받는다. */
  function nowOf(env) {
    if (typeof env.now === 'function') return env.now();
    return env.now || new Date();
  }

  /**
   * ⚠️ **날짜는 유저 시간대로 센다.** 한국 07:30 은 UTC 로 전날 22:30 이다.
   *    UTC 나 서버 시각으로 세면 "그날은 이미 했다" 며 하루를 통째로 건너뛴다.
   */
  function localDay(env, d) {
    return Utilities.formatDate(d, env.tz, 'yyyy-MM-dd');
  }

  /** 오늘(유저 시간대) 아직 정리를 안 했고 07:00 이 지났나. 늦게라도 한 번은 한다. */
  function upkeepDue(env, now) {
    if (Number(Utilities.formatDate(now, env.tz, 'H')) < CFG.upkeepHour) return false;
    return env.props.getProperty(PROP.lastUpkeep) !== localDay(env, now);
  }

  // ── Gmail ────────────────────────────────────────────────────────

  /**
   * "새 메일이 왔나" 를 보는 가장 싼 열쇠. **가장 최근 스레드의 마지막 메일 id.**
   *
   * 검색 하나(스레드 1개) + getMessages 하나. 첨부는 안 연다 — 첨부를 여는 건
   * 메일마다 왕복이고, 이건 하루 1440번 돈다.
   *
   * ⚠️ **처리할 메일(findAttachment)과 같은 것을 고르려고 하지 않는다.**
   *    findAttachment 는 스레드 10개를 뒤져 zip 이 붙은 가장 최근 메일을 고르고,
   *    여기는 맨 위 스레드 하나만 본다. 스레드는 **마지막 활동 순**이라 옛 zip
   *    스레드에 답장 하나만 달려도 둘이 갈린다. 둘을 비교하면 영영 "새 메일"
   *    이라 매분 14초를 돌거나, 반대로 영영 못 돈다.
   *    그래서 **이 열쇠는 비교에만 쓰고, 처리 뒤에도 이 열쇠를 그대로 적는다**
   *    (remember). 같은 함수가 쓰고 같은 함수가 읽으니 어긋날 수가 없다.
   *    처리 자체는 언제나 findAttachment 가 고른 가장 최근 zip 이다 — 과거로
   *    걸어가지 않는다 (아래 findAttachment 의 ⚠️).
   *
   *    새 zip 메일이 오면 그 메일이 전체에서 가장 최근이니 그 스레드가 맨
   *    위로 오고 열쇠가 바뀐다 — 놓치지 않는다. 답장 같은 딴 메일이 와도
   *    열쇠가 바뀌는데, 그러면 한 번 더 돌고(같은 결과) 다시 조용해진다.
   */
  function probeKey(env) {
    var threads = env.gmail.search(CFG.gmailQuery, 0, 1);
    if (!threads || !threads.length) return null;
    var messages = threads[0].getMessages();
    return messages.length ? messages[messages.length - 1].getId() : null;
  }

  /**
   * 메일함에서 **무조건 가장 최근** 뱅샐 zip 메일을 고른다.
   *
   * ⚠️ 예전엔 '처리 안 한 것 중 가장 최근'이었다. 그러면 밀린 옛날 메일이
   *    남아 있는 동안 **매 실행이 하루씩 과거로 걸어간다.** 실측: 8/8 메일을
   *    처리한 다음 실행이 7/26 메일을 집어서 최신본을 2주 전으로 덮었다.
   *    처리 이력(PROCESSED_MESSAGE_IDS)은 중복 처리를 막으려던 건데, 이
   *    제품에서 중복 처리는 무해하고 **과거로 가는 것이 유해하다.** 지키려던
   *    것이 애초에 틀려서 목록째 없앴다. 같은 메일을 다시 처리해도 stamp 가
   *    같아 히스토리 이름도 같으니 아무것도 쌓이지 않는다.
   */
  function findAttachment(env) {
    var threads = env.gmail.search(CFG.gmailQuery, 0, CFG.searchThreads);
    var best = null;

    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      for (var j = 0; j < messages.length; j++) {
        var m = messages[j];
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

  // ── Drive ────────────────────────────────────────────────────────

  function ensureFolder(parent, name) {
    var it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
  }

  function findFile(folder, name) {
    var it = folder.getFilesByName(name);
    return it.hasNext() ? it.next() : null;
  }

  /**
   * ⚠️ **같은 내용이면 손대지 않는다.** 이제 새 메일이 없어도 매일 최신 메일을
   *    다시 처리하므로, 무조건 덮으면 같은 zip 이 매일 하나씩 휴지통으로 간다
   *    (1년이면 365개). 유저 드라이브라 조용히 쌓이면 안 된다.
   */
  function putFile(folder, name, blob) {
    var existing = findFile(folder, name);
    if (existing) {
      if (existing.getSize() === blob.getBytes().length) return existing;
      existing.setTrashed(true);
    }
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
   * 최신본을 그냥 쓰면 같은 날 두 번 내보냈을 때 자기 자신과 비교하게 된다.
   */
  function historyName(stamp) {
    return '돈동생-' + stamp + '.json';
  }

  function readPrevious(folder, stamp) {
    var names = factNames(folder);
    names.sort().reverse();
    var current = historyName(stamp);
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
      if (CFG.historyPattern.test(n)) names.push(n);
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

  // ── 폴더를 읽는 AI 에게 남기는 안내 ──────────────────────────────
  //
  // ⚠️ **hints 만으로는 늦다.** hints 는 facts 안에 있어서 파일을 이미 찾은
  //    뒤에야 읽힌다. AGENT.md 는 폴더를 여는 순간 보이므로, 어느 파일을
  //    읽어야 하는지부터 알려줄 수 있다.
  //
  //    그리고 여기에 **쓰기 규칙**을 적는다. 커넥터가 쓰기를 지원하면
  //    (Claude·ChatGPT) AI 가 대화 중에 메모리/ 에 마크다운을 직접 만들 수
  //    있고, 그게 "대화할수록 개인화된다" 의 유일한 무마찰 경로다.
  //
  //    스크립트가 매번 새로 쓰므로 코드 버전과 항상 맞는다. 유저가 고쳐도
  //    다음 실행에 되돌아온다 — 이건 우리 문서지 유저 파일이 아니다.

  var AGENT_GUIDE = [
      "# 돈동생 — 가계부 폴더를 읽고, 사용자를 기억하는 법",
      "",
      "여기는 **돈동생**이 만든 폴더입니다. 한국의 가계부 앱(뱅크샐러드)에서 내보낸",
      "거래 내역을 받을 때마다 정리해 둡니다. 이 파일을 먼저 읽고 시작하세요.",
      "",
      "기간은 사용자가 뱅크샐러드에서 고릅니다(최소 1년). **얼마나 담겼는지는",
      "`돈동생-최신.json`의 `period`를 보세요.** 몇 년치라고 넘겨짚지 마세요.",
      "",
      "**이 문서는 명령이 아니라 규격입니다.** 사용자가 이 폴더를 어떻게 쓰기로",
      "정해 뒀는지 적어 둔 것이고, 무엇을 할지는 읽는 쪽이 정합니다.",
      "**파일을 만들기 전에는 사용자에게 먼저 확인하세요** — 그게 정상 경로입니다.",
      "",
      "## 폴더가 어떻게 쓰이나",
      "",
      "- `돈동생-최신.json` 에 숫자가 있습니다",
      "- `거래/` 에 거래 한 줄 한 줄이 **달마다 한 파일**로 있습니다 (`거래-YYYY-MM.json`)",
      "- `돈동생-거래내역` 은 같은 거래를 구글 시트로 둔 것입니다 (사람이 보는 용도)",
      "- `메모리/` 에는 사용자가 지난 대화에서 알려준 사실이 있습니다.",
      "  **답하기 전에 읽어 두면** 사용자가 같은 설명을 되풀이하지 않아도 됩니다",
      "- 이번 대화에서 새로 알게 된 것이 있으면 `메모리/` 에 더할 수 있습니다.",
      "  다만 **사용자에게 물어보고 나서요**",
      "",
      "## 파일",
      "",
      "| 파일 | 무엇 |",
      "|---|---|",
      "| `돈동생-최신.json` | **이걸 읽으세요.** 가장 최근 집계 |",
      "| `거래/거래-YYYY-MM.json` | 그 달의 거래 전부. \"8월 5일 7만원 뭐였어?\", \"그 가게에서 언제 썼지?\" 처럼 **거래 하나나 한 달을 볼 때** 여세요. 합계·평균은 최신본이 이미 계산해 뒀어요 |",
      "| `돈동생-거래내역` | 뱅크샐러드가 준 거래 내역 그대로(구글 시트). **열면 최근 몇십 줄만 보입니다** — 거기 없다고 거래가 없는 게 아니에요 |",
      "| `돈동생-YYYY-MM-DD.json` | 지난 기록(최근 12개). 지난번과의 차이는 이미 최신본의 `delta` 에 있어요 — 여기까지 열 일은 드뭅니다 |",
      "| `메모리/` | 사용자에 대해 알게 된 것. **읽고, 그리고 쓰는 곳입니다** |",
      "| `돈동생-상태.json` | 마지막 실행 결과. 사용자가 \"왜 안 돌아?\" 물을 때만 |",
      "| `raw/` | 원본 zip. 열지 마세요 |",
      "",
      "## 거래 하나를 찾을 때",
      "",
      "`돈동생-거래내역` 시트는 열어도 **최근 거래 몇십 줄만 보입니다.** 나머지는 안 보이고",
      "다음 쪽도 없어요. 그러니 특정 거래나 특정 달을 물으면 **그 달의 파일을 여세요.**",
      "`거래` 폴더 안에서 **제목으로 찾으면** 됩니다 — 2026년 8월이면 `거래-2026-08.json`.",
      "",
      "- `columns` 가 칸 이름, `rows` 가 거래입니다. **최신이 위**예요",
      "- `count` 가 그 달 거래 수입니다. `rows` 개수와 다르면 파일이 잘려서 읽힌 거예요",
      "- 금액은 뱅크샐러드 부호 그대로입니다 (지출은 보통 음수)",
      "- 시간은 뱅크샐러드 화면에 보이는 그대로입니다",
      "- 파일이 없는 달은 거래가 없었거나, 내보낸 기간 밖입니다",
      "- 뱅크샐러드 내보내기는 1년치까지지만, 한 번 받은 달의 파일은 **계속 남습니다**",
      "",
      "## 데이터가 오래됐을 때",
      "",
      "`돈동생-최신.json`의 `period.to`가 2주 이상 지났으면, 사용자가 뱅크샐러드에서",
      "내보내기를 안 한 겁니다. 답을 하되 **먼저 알려주세요** — 오래된 숫자로 이야기하면",
      "사용자는 지금 상황인 줄 압니다. \"이번 달\"을 물었는데 데이터가 지난달에서",
      "끝나 있으면 특히 그렇습니다.",
      "",
      "내보내는 법: 뱅크샐러드 앱 → 가계부 → 톱니바퀴 → 파일로 받기 →",
      "설치할 때 쓴 구글 주소로, 같은 비밀번호로.",
      "",
      "## \"갱신해줘\" 라고 하면",
      "",
      "**새 데이터는 사용자가 뱅크샐러드 앱에서 내보내기를 눌러야만 생깁니다.**",
      "당신도 돈동생도 뱅크샐러드에서 데이터를 끌어올 수 없어요. 돈동생은 1분마다",
      "메일함을 보고, 내보내기 메일이 오면 2분쯤 안에 이 폴더를 새로 씁니다.",
      "",
      "그러니 \"갱신해줘\", \"최신으로 해줘\" 를 받으면 **Gmail 커넥터로 뱅크샐러드의 가장",
      "최근 내보내기 메일 시각**을 보고, `돈동생-최신.json` 의 `sourceMessageDate`",
      "(돈동생이 마지막으로 처리한 메일의 시각, UTC)와 비교해서 셋 중 하나로 답하세요.",
      "",
      "- 같으면 → **이미 최신입니다.** 더 새로 받으려면 앱에서 다시 내보내야 해요",
      "- 메일이 더 나중이면 → \"HH:MM 에 온 내보내기가 있어요. 2분쯤 안에 반영됩니다\"",
      "  (시각은 사용자 시간대로). 조금 뒤에 다시 읽으세요.",
      "  **온 지 10분이 넘었는데도 그대로면** 처리에 실패한 겁니다. 반영된다고 하지 말고",
      "  `돈동생-상태.json` 의 `message` 를 전하세요",
      "- 최근에 온 메일이 없으면 → \"새로 내보낸 게 없어요. 뱅크샐러드 앱에서",
      "  파일로 받기를 눌러 주세요\" 와 위의 내보내는 법",
      "",
      "Gmail 커넥터가 없으면 그렇다고 말하고, `sourceMessageDate` 가 언제인지만",
      "알려주세요. **확인하지 않은 신선함을 말하지 마세요.** \"최신으로 갱신했어요\" 는",
      "당신이 할 수 있는 일이 아닙니다.",
      "",
      "## 사용자를 기억하는 법 — `메모리/` 폴더",
      "",
      "### 이건 당신의 메모리가 아닙니다",
      "",
      "판단에 필요한 사실만 적습니다.",
      "",
      "- `메모리/` 는 **사용자 소유 드라이브에 있는 사용자의 파일**입니다",
      "- 사용자가 이 도구를 설치할 때 만들어진 폴더고, **무엇을 위한 자리인지",
      "  설치 안내에서 읽고** 시작했습니다",
      "- 쓰기는 사용자가 직접 연결한 커넥터를 통해 나갑니다",
      "- 사용자는 언제든 열어보고, 고치고, 지웁니다. 돈동생은 이 글을 계산에 쓰지 않습니다",
      "",
      "여기에 메모를 남기는 것과, 당신이 사용자 정보를 당신 쪽에 보관하는 것은",
      "다른 일입니다. 어느 규칙을 적용할지는 당신이 판단하세요 — 위 네 줄이",
      "그 판단에 필요한 사실입니다.",
      "",
      "### 쓰기 전에 물어보세요",
      "",
      "남의 드라이브에 파일을 만드는 일입니다. **확인 없이 쓰지 마세요.**",
      "대신 **먼저 제안해 주세요** — 사용자는 이 폴더가 있다는 걸 잊고 있을 때가",
      "많고, 물어보지 않으면 기억할 기회 자체가 안 생깁니다.",
      "",
      "> 오늘 말씀하신 이사·월세를 `메모리/` 에 적어둘까요?",
      "> 다음 대화에서 다시 설명 안 하셔도 돼요.",
      "",
      "무엇을 적을지 미리 보여주면 사용자가 판단하기 쉽습니다.",
      "\"그건 빼\" 라고 하면 그 말이 우선이고, 이미 적어 뒀다면 어느 파일인지",
      "알려주고 지우는 법을 안내하세요.",
      "",
      "### 언제 물어보나",
      "",
      "**사용자가 자기 형편을 말하면 그때가 제안할 때입니다.** 수입이 바뀐다,",
      "이사한다, 차를 판다, 얼마를 모으고 싶다 — 이런 건 `돈동생-최신.json` 이",
      "절대 모르는 것이고 다음 달 거래 내역에도 안 나옵니다.",
      "**이 대화에서 안 물어보면 그냥 사라집니다.**",
      "",
      "한 대화에서 주제 서넛이 나오는 건 흔한 일이고, 한꺼번에 물어보면 됩니다.",
      "",
      "### 적지 않는 것",
      "",
      "`메모리/` 는 **가계부 옆에 놓인 메모**입니다. 사용자는 여기에 인생이 기록될",
      "거라고 예상하지 않았어요. **돈에 영향을 주는 사실만** 남기세요.",
      "\"2027년 3월에 목돈 300만원이 필요하다\" 는 적어도 되고,",
      "**왜 필요한지는 안 적어도 됩니다.**",
      "",
      "사용자가 직접 \"이건 적어 둬\" 라고 하지 않는 한 아래는 적지 마세요.",
      "",
      "- 병명·진단·복약·정신건강. 병원비가 지출에 잡혀도 금액만 다루고",
      "  **무슨 병인지는 적지 마세요**",
      "- 회사 이름, 직책, 이직하려는 곳, 연봉 협상 내용",
      "- 연애·이혼·별거, 가족과의 갈등",
      "- 종교·정치·성적 지향",
      "- 남의 개인정보 (친구·동료의 이름과 사정)",
      "",
      "**라벨도 일반화하세요.** 금액만 적었다고 안전한 게 아닙니다 —",
      "`정신건강의학과 월 5만원` 은 항목 이름에서 진단이 그대로 복원됩니다.",
      "`의료비 월 5만원` 이면 충분합니다.",
      "",
      "안 적기로 한 게 있으면 **사용자에게 말해 주세요.** \"병원 다니시는 건 안 적고",
      "금액만 볼게요\" 한마디가, 사용자가 이 폴더를 믿게 되는 유일한 순간입니다.",
      "",
      "### 파일 이름 규칙",
      "",
      "```",
      "메모리/2026-08-09-목표.md",
      "메모리/2026-08-09-수입.md",
      "        └날짜┘ └주제┘",
      "```",
      "",
      "날짜는 **오늘 날짜**입니다 — 위 예시의 날짜를 그대로 베끼지 마세요.",
      "이름은 반드시 `.md` 로 끝나야 합니다.",
      "",
      "**주제 하나에 파일 하나입니다.** 날짜를 앞에 붙이는 건 이름이 겹치지 않게",
      "하려는 것뿐이에요. 돈동생이 매일 아침 **주제별로 가장 최신 것만 남기고",
      "나머지는 휴지통으로** 보냅니다.",
      "",
      "같은 날 같은 주제를 **두 번** 갱신해야 하면 시각을 붙이세요 —",
      "`2026-08-09T14:30-수입.md`. 날짜만 쓰면 이름이 그대로 겹칩니다.",
      "",
      "### 주제 이름은 이 목록에서 고르세요",
      "",
      "**새 이름을 지어내지 마세요.** 같은 뜻을 세션마다 다르게 부르면",
      "(`목표` / `재무목표` / `새해목표`) 돈동생은 서로 다른 주제로 보고 **셋 다",
      "남깁니다.** 그러면 다음 대화에서 당신은 서로 모순되는 파일 여러 개를 읽게 돼요.",
      "그건 기억이 없는 것보다 나쁩니다.",
      "",
      "| 주제 | 여기 담을 것 |",
      "|---|---|",
      "| `목표` | 모으려는 금액과 시점 |",
      "| `수입` | 월 실수령, 상여·부수입의 주기 |",
      "| `고정지출` | 월세·관리비처럼 매달 정해진 것 |",
      "| `가족` | 용돈·부양처럼 **돈이 오가는** 것만 |",
      "| `일` | 고용 형태 등 수입의 안정성에 걸리는 것 |",
      "| `습관` | 사용자가 스스로 말한 소비 성향 |",
      "| `제약` | 대출 상환, 만기, 못 건드리는 돈 |",
      "| `선호` | 어떻게 답해주길 바라는지 |",
      "",
      "여기에 안 맞는 게 나오면 **`기타` 하나에 모으세요.** 새 주제를 만들지 마세요.",
      "",
      "### 그래서 갱신하는 법",
      "",
      "당신은 파일을 **고칠 수도 지울 수도 없습니다.** 새로 만드는 것만 됩니다.",
      "그러니 어떤 주제를 갱신할 때는:",
      "",
      "1. `메모리/` 를 훑어 **그 주제의 현재 파일을 먼저 읽으세요**",
      "2. 읽었는데 **내용이 비어 있으면**:",
      "   - **이번 대화에서 당신이 직접 쓴 파일이라면** 그 내용을 당신이 알고 있으니",
      "     그대로 이어서 쓰세요. 비어 보이는 건 드라이브 반영이 늦은 것뿐입니다",
      "   - 그게 아니면 **거기서 멈추세요.** 방금 만들어진 파일은 몇 분 동안 빈",
      "     문자열로 읽힙니다 — 내용이 없는 게 아니라 아직 안 보이는 거예요. 여기서",
      "     새로 쓰면 **원래 있던 것을 지우는 것과 같습니다.** 사용자에게 \"조금 전에",
      "     저장한 게 아직 안 읽혀요\" 라고 말하고 쓰지 마세요",
      "3. 아직 맞는 내용은 가져오고, 바뀐 건 새 값으로, 틀린 건 버리고",
      "4. **오늘 날짜로 같은 주제 이름의 파일을 새로 만드세요**",
      "",
      "**읽기를 건너뛰고 쓰면 그 주제에 대해 예전에 알던 것이 사라집니다.**",
      "(폴더가 통째로 비어 있는 건 다릅니다 — 아직 아무도 안 쓴 것이니 그냥 쓰세요.)",
      "",
      "새 파일에는 **지금 참인 것**과 **날짜가 정해진 예정**만 담으세요.",
      "\"2026-09부터 월 180만원\" 처럼 시작일이 있으면 그 날짜와 함께 적으면 됩니다.",
      "\"예전엔 260만이었는데\" 같은 지난 이력은 보통 필요 없습니다.",
      "",
      "### 파일 안에는",
      "",
      "맨 위에 언제·어디서 나온 말인지 적어 두세요. 나중에 당신이 이걸 다시 읽을 때",
      "갱신할지 판단하는 근거가 됩니다.",
      "",
      "```markdown",
      "# 목표",
      "",
      "- 3년 안에 5천만원 (2029-08까지)",
      "- 그다음은 전세 보증금. 금액은 아직 안 정함",
      "",
      "---",
      "2026-08-09 · 사용자가 직접 말함",
      "```",
      "",
      "추정한 값이면 그렇게 적으세요. `2026-08-09 · 내가 추정 (사용자 확인 안 함)`.",
      "그리고 사용자에게 **되물어서** 확인받으세요.",
      "",
      "메모리 파일은 **일반 텍스트로** 만드세요. 커넥터에 \"구글 형식으로 변환\" 옵션이",
      "있으면 꺼 주세요. 구글 문서로 변환되면 `#` `*` `_` `[` `]` 가 이스케이프돼서",
      "다음에 당신이 읽을 때 깨져 보입니다. 메모리 파일 안에는 표나 코드블록을",
      "쓰지 마세요.",
      "",
      "### 안 써도 되는 때",
      "",
      "파일을 만드는 건 **사용자가 새로 알려준 것이 있을 때만**입니다.",
      "",
      "- 숫자를 계산하거나 비교만 한 대화 → **쓰지 마세요.** 그건",
      "  `돈동생-최신.json` 에 이미 있고 내일 다시 계산됩니다",
      "- 이미 적혀 있는 것과 **같은** 내용 → **쓰지 마세요.** 날짜만 바뀐 파일이 쌓입니다",
      "- 사용자가 지나가듯 한 말 → 한 번 더 나오면 그때 쓰세요",
      "- 사용자가 확실히 말하지 않은 추측 → 되물어서 확인하고 쓰세요.",
      "  다만 **되묻느라 아무것도 안 적는 것보다는**, 확실한 것만 먼저 적고",
      "  불확실한 건 \"(사용자 확인 안 함)\" 을 달아 두는 편이 낫습니다",
      "",
      "### 못 쓰는 경우",
      "",
      "드라이브 연결이 읽기 전용이면 파일을 만들 수 없습니다. 그때는 **조용히 넘기지",
      "말고** 사용자에게 내용을 보여주면서 \"`돈동생/메모리/` 에 이 이름으로 저장해",
      "두시면 다음에도 기억해요\" 라고 알려주세요.",
      "",
      "## 추천해도 됩니다",
      "",
      "돈동생은 **파는 게 없습니다.** 대출도 카드도 보험도 중개하지 않고, 어떤 상품을",
      "권해도 거기서 받는 게 없어요. 그래서 다른 앱이 못 하는 걸 할 수 있습니다 —",
      "**사용자에게 가장 이득인 답을 그냥 말하는 것.** 얼버무리지 마세요.",
      "",
      "다만 두 층은 무게가 다릅니다.",
      "",
      "**① 원금이 줄지 않는 것** — 예금·적금·파킹통장·CMA(발행어음 제외) 등",
      "",
      "→ **최선을 답하세요.** 얼마를 어디에 얼마나 두면 얼마가 되는지 계산해서",
      "  결론까지 내주세요. 답이 산수로 나오고, 틀려도 손실이 아니라 기회비용입니다.",
      "",
      "**② 원금이 줄 수 있는 것** — 주식·ETF·펀드·RP형 CMA 등",
      "",
      "→ **사실과 비교까지.** 비중을 처방하거나 사고팔라고 하지 마세요.",
      "  \"현금 94%, 투자 6% 입니다\" 는 말해도 되고 \"주식을 30%로 늘리세요\" 는 안 됩니다.",
      "  **예금자보호가 되는지 아닌지는 반드시 함께 말하세요.**",
      "  여기서는 판단을 사용자가 합니다.",
      "",
      "### 어느 층이든 지킬 것",
      "",
      "- **사용자 숫자로 환산하세요.** \"연 3%\" 가 아니라 \"890만원을 6개월 두면",
      "  세후 12만원이고, 1억까지 가는 페이스가 월 2만원 빨라져요\"",
      "- **찾아온 숫자와 계산한 숫자를 구분하세요.** 금리와 상품 조건은 당신이 검색한",
      "  것이고 **돈동생이 검증하지 않았습니다.** 언제 기준인지 밝히고, 확인할 곳을",
      "  알려주세요 — 금융감독원 \u0027금융상품 한눈에\u0027(finlife.fss.or.kr).",
      "  검색을 못 하는 상황이면 모르는 채로 답하지 말고 그 사실을 말하세요",
      "- **우대조건과 한도를 빠뜨리지 마세요.** 급여이체·카드실적이 붙은 금리,",
      "  한도를 넘으면 뚝 떨어지는 파킹통장 금리가 흔합니다",
      "- **수익률을 단정하지 마세요.** 가정을 밝히고 \"그 이율이 맞다면\" 을 다세요",
      "- **보장하지 마세요.** \"무조건\", \"확실히\" 는 쓰지 않습니다",
      "",
      "## 숫자를 다룰 때",
      "",
      "`돈동생-최신.json` 안의 `hints`에 각 필드의 뜻과 계산 규약이 적혀 있습니다.",
      "**그걸 따르세요.** 특히:",
      "",
      "- 금액은 원(KRW) 단위 정수입니다",
      "- `expense`는 이미 환불을 차감한 순액입니다. 다시 빼지 마세요",
      "- `pace`와 `avgMonthlyExpense`는 보정된 값입니다. 직접 다시 유도하지 마세요",
      "- `otherTotal` 같은 필드는 목록에서 **잘려나간 나머지**입니다. 합계를 검산할 때",
      "  같이 더하세요",
      "",
      "**없는 키는 만들어내지 마세요.** 돈동생은 믿을 수 없는 값을 아예 빼고",
      "`...Omitted` 필드에 이유를 적습니다. 예를 들어 `pace.monthlyOmitted`가 있으면",
      "\"월 얼마 모으는지\"는 지금 데이터로 답할 수 없다는 뜻입니다. 추정해서 채우지 말고,",
      "왜 없는지 설명하세요.",
      "",
      "`dataQuality.flags`를 확인하세요. 여기 뭔가 있으면 그걸 감안해서 답해야 합니다.",
  ].join('\n') + '\n';

  // ── 옛 컨테이너(≤ 0.4.5)용 AGENT.md ─────────────────────────────
  //
  // ⚠️ **라이브러리만 올린 사람은 여전히 하루 한 번 돈다.** 트리거는 컨테이너가
  //    걸고, 옛 컨테이너는 매일 07:00 runDaily 를 건다. 그런데 AGENT.md 는
  //    라이브러리가 쓴다 — 1분짜리 문장을 그대로 내보내면 AI 가 "2분 안에
  //    반영돼요" 라고 **거짓말을 한다.** 그래서 per-minute 원본(docs/AGENT.md.txt)
  //    에서 그 두 군데만 갈아 끼운 사본을 옛 컨테이너에 준다.
  //    원본에서 줄이 바뀌어 못 찾으면 test/app.test.js 가 빨간불을 켠다.
  var AGENT_DAILY_SWAPS = [
    [[
      "당신도 돈동생도 뱅크샐러드에서 데이터를 끌어올 수 없어요. 돈동생은 1분마다",
      "메일함을 보고, 내보내기 메일이 오면 2분쯤 안에 이 폴더를 새로 씁니다.",
    ], [
      "당신도 돈동생도 뱅크샐러드에서 데이터를 끌어올 수 없어요. 돈동생은 **하루 한 번,",
      "아침 7시쯤** 메일함을 보고 이 폴더를 새로 씁니다. 그 사이에 온 내보내기는",
      "다음 아침 7시까지 기다립니다 — 사용자가 시트 메뉴에서 직접 돌리지 않는 한요.",
    ]],
    [[
      "- 메일이 더 나중이면 → \"HH:MM 에 온 내보내기가 있어요. 2분쯤 안에 반영됩니다\"",
      "  (시각은 사용자 시간대로). 조금 뒤에 다시 읽으세요.",
      "  **온 지 10분이 넘었는데도 그대로면** 처리에 실패한 겁니다. 반영된다고 하지 말고",
      "  `돈동생-상태.json` 의 `message` 를 전하세요",
    ], [
      "- 메일이 더 나중이면 → \"HH:MM 에 온 내보내기가 있어요. 아침 7시쯤 정리될 때",
      "  반영돼요. 바로 보려면 돈동생 시트 메뉴에서 ② 지금 한 번 돌리기 를 눌러 주세요\"",
      "  (시각은 사용자 시간대로. 7시 이후에 온 메일이면 **내일** 아침입니다).",
      "  **곧 반영된다고 하지 마세요** — 누르기 전에는 아침까지 그대로입니다.",
      "  **그 전에 온 메일인데 7시가 지나도 그대로면** 처리에 실패한 겁니다.",
      "  반영된다고 하지 말고 `돈동생-상태.json` 의 `message` 를 전하세요",
    ]],
  ];

  var AGENT_GUIDE_DAILY = (function () {
    var text = AGENT_GUIDE;
    for (var i = 0; i < AGENT_DAILY_SWAPS.length; i++) {
      text = text.split(AGENT_DAILY_SWAPS[i][0].join('\n'))
        .join(AGENT_DAILY_SWAPS[i][1].join('\n'));
    }
    return text;
  })();

  /** 1분마다 tick 을 거는 컨테이너부터. 이 버전 이상이어야 "1분" 을 말한다. */
  var PER_MINUTE_SINCE = '0.4.6';

  /**
   * 이 사본이 1분마다 도는가 — 컨테이너 버전으로 가른다.
   *
   * ⚠️ **모르면 하루 한 번으로 본다.** 버전이 없거나 깨졌을 때 "2분 안에"
   *    라고 했다가 틀리면 AI 가 거짓말을 하고, "아침 7시쯤" 이라고 했다가
   *    틀리면 조금 늦게 기대할 뿐이다. 틀려도 덜 해로운 쪽으로.
   */
  function perMinute(env) {
    var v = semver(env && env.containerVersion);
    var min = semver(PER_MINUTE_SINCE);
    if (!v) return false;
    for (var i = 0; i < 3; i++) {
      if (v[i] !== min[i]) return v[i] > min[i];
    }
    return true;
  }

  /** '0.4.6' · 'v0.4.6' · '0.4.6-rc1' → [0, 4, 6]. 그 밖은 null. */
  function semver(s) {
    var m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(String(s == null ? '' : s));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function agentGuide(env) {
    return perMinute(env) ? AGENT_GUIDE : AGENT_GUIDE_DAILY;
  }

  /** 내용이 달라졌을 때만 쓴다. 매번 덮으면 수정시각만 흔들린다. */
  function ensureAgentGuide(folder, env) {
    var text = agentGuide(env);
    var f = findFile(folder, CFG.agentName);
    if (f) {
      try {
        if (f.getBlob().getDataAsString('UTF-8') === text) return;
      } catch (e) {
        // 못 읽으면 새로 쓴다
      }
      f.setContent(text);
      return;
    }
    folder.createFile(Utilities.newBlob(text, 'text/markdown', CFG.agentName));
  }

  // ── 메모리 정리 ──────────────────────────────────────────────────
  //
  // ⚠️ **AI 는 만들 줄만 안다.** 드라이브 커넥터에 수정도 삭제도 없다.
  //    같은 이름으로 다시 쓰면 덮이지 않고 **파일이 하나 더 생긴다** (실측).
  //    그래서 AI 에게 "고쳐 써라" 를 시킬 수 없다.
  //
  //    역할을 가른다. **AI 는 쌓고, 우리는 치운다.**
  //    AI 는 'YYYY-MM-DD-주제.md' 로 새 파일만 만든다 (이름이 안 부딪힌다).
  //    우리는 주제별로 묶어 **최신 하나만 남기고 나머지를 휴지통으로** 보낸다.
  //
  //    내용은 읽지 않는다. 합치지도 않는다 — 왜 그런지는 DECISIONS §2-A15.

  /**
   * 'YYYY-MM-DD[T14:30[:05]]-주제.md' 에서 주제만. 규칙에 안 맞으면 null.
   *
   * ⚠️ **`.md` 로 끝나야 한다.** 예전엔 확장자를 먼저 떼고 나머지를 검사해서,
   *    `2026-08-09-카드명세.pdf` 가 '카드명세.pdf' 라는 주제로 잡혔다.
   *    날짜를 앞에 붙여 정리해 둔 유저의 명세서·사진이 **날마다 하나씩
   *    휴지통으로 갔다.** 여기가 이 도구에서 유저 파일을 지우는 유일한
   *    자리라 규칙이 이름 전체를 덮어야 한다.
   * ⚠️ **맨 시각(1430)은 안 받는다.** 받으면 '2026-08-09-2030-은퇴계획.md' 의
   *    2030 을 20시 30분으로 읽어서 **2040-은퇴계획과 같은 주제가 된다** —
   *    서로 다른 둘 중 하나가 지워진다. 시각은 `T` 나 공백이 앞에 붙어야
   *    시각이다. 못 알아본 이름은 안 지워질 뿐이라 그 방향이 안전하다.
   */
  function memoTopic(name) {
    var m = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:?\d{2}(?::?\d{2})?)?[-_ ](.+)\.md$/i
      .exec(String(name));
    // 공백뿐인 주제는 '' 가 되는데, 계약은 null 이다. '' 를 흘리면
    // === null 로 보는 다음 사람이 조용히 틀린다.
    return (m && m[1].trim()) || null;
  }

  /**
   * 묶는 열쇠. **사람 눈에 같은 주제면 같은 열쇠가 나와야 한다.**
   *
   * ⚠️ **한글은 같은 글자가 두 가지 바이트로 온다.** macOS 가 만든 이름은
   *    자모가 풀려서(NFD) 오고 AI 가 쓴 건 NFC 로 온다. 눈으로는 똑같은데
   *    문자열로는 달라서, 묶지 않으면 둘 다 살아남는다 — DECISIONS §2-A15.
   *    NFKC 가 아니라 NFC 다. NFKC 는 전각·호환 문자까지 접어서 **서로 다른
   *    주제를 실제로 합쳐 버린다.**
   */
  function topicKey(topic) {
    return String(topic).normalize('NFC').replace(/\s+/g, '').toLowerCase();
  }

  /** 최신이 먼저. 같은 초면 이름이 큰 쪽(=나중 날짜)이 산다. */
  function byNewest(a, b) {
    return b.at - a.at || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  }

  /**
   * 주제마다 최신 하나만 남긴다.
   *
   * ⚠️ **순서는 드라이브 생성 시각으로 본다.** AI 가 붙인 날짜는 시간대를
   *    틀리거나 오늘이 며칠인지 몰라 어긋난다. 이름은 동점일 때만 본다.
   * ⚠️ **규칙에 안 맞는 이름은 건드리지 않는다.** 유저가 직접 넣어 둔
   *    파일을 우리가 지우면 안 된다 (memoTopic 참고).
   * ⚠️ 영구 삭제가 아니라 휴지통이다. AI 가 잘못 갱신해도 30일 안에 되돌린다.
   * ⚠️ **한 파일이 실패해도 나머지는 계속 치운다.** 공유 폴더에서는 남이
   *    만든 파일에 setTrashed 가 'Access denied' 로 던진다. 그 하나 때문에
   *    멈추면 그날부터 정리가 영영 안 된다.
   */
  function pruneMemory(folder) {
    // ⚠️ **폴더도 이름이 겹칠 수 있다.** 파일과 같은 이유다 — 드라이브는
    //    막지 않는다. 하나만 보면 나머지 '메모리' 는 영영 안 치워지고,
    //    커넥터는 양쪽을 다 읽는다. 전부 모아서 한 번에 묶는다.
    var folders = folder.getFoldersByName(CFG.memoryFolder);
    if (!folders.hasNext()) return null;

    // ⚠️ **{} 가 아니라 Object.create(null).** 평범한 객체는 'constructor' 를
    //    이미 갖고 있다. 파일 하나가 '2026-08-09-constructor.md' 이면
    //    `!byTopic[key]` 가 거짓이라 배열을 안 만들고, 곧바로 함수에 .push 를
    //    불러 **TypeError 로 실행 전체가 죽는다.** ('toString' 으로는 재현이
    //    안 된다 — topicKey 가 소문자로 접어서 'tostring' 이 되고 그건
    //    프로토타입에 없다. 원래 소문자인 이름이라야 부딪힌다.)
    //    '__proto__' 는 더 조용하다 — 대입이 프로토타입을 갈아 끼워서
    //    Object.keys 에 안 잡히고 그 주제만 영영 안 치워진다.
    var byTopic = Object.create(null);
    var memos = 0;
    var unnamed = 0;

    while (folders.hasNext()) {
      var files = folders.next().getFiles();
      while (files.hasNext()) {
        var f = files.next();
        var name = f.getName();
        var topic = memoTopic(name);
        if (!topic) { unnamed++; continue; }
        memos++;
        var key = topicKey(topic);
        if (!byTopic[key]) byTopic[key] = [];
        // getDateCreated() 는 드라이브 호출이다. 비교 함수 안에서 부르면
        // 파일 하나를 정렬 내내 몇 번씩 다시 묻는다. 여기서 한 번만 본다.
        byTopic[key].push({ file: f, at: f.getDateCreated().getTime(), name: name });
      }
    }

    var keys = Object.keys(byTopic);
    var victims = [];
    keys.forEach(function (k) {
      var list = byTopic[k].sort(byNewest);
      for (var i = 1; i < list.length; i++) victims.push(list[i].file);
    });

    var capped = victims.length > CFG.memoryTrashBudget;
    var trashed = 0;
    var failed = 0;
    victims.slice(0, CFG.memoryTrashBudget).forEach(function (file) {
      try { file.setTrashed(true); trashed++; } catch (e) { failed++; }
    });

    var out = { topics: keys.length, trashed: trashed, memos: memos };
    if (unnamed) out.unnamed = unnamed;
    if (capped) out.trashCapped = true;
    if (failed) out.trashFailed = failed;
    return out;
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

  /**
   * 메모리를 한 번이라도 본 적이 있는지. 처음 본 날을 남기고 true 를 준다.
   *
   * ⚠️ **'지금 비었다' 로는 아무것도 못 판단한다.** 어제 설치한 사람도 비어
   *    있고, 커넥터가 읽기 전용이라 AI 가 여섯 달째 한 줄도 못 쓴 사람도
   *    비어 있다. 상태 파일은 매일 덮여서 어제를 못 본다 — 그래서 여기서만
   *    가를 수 있다. "왜 기억을 못 해?" 를 받았을 때 볼 자리다.
   */
  function markMemorySeen(props, memos, at) {
    if (props.getProperty(PROP.memorySeen)) return true;
    if (!memos) return false;
    // ⚠️ 잘라서 날짜만 남기지 않는다. at 은 UTC ISO 인데 앞 10자를 떼면
    //    한국 시각 오전 9시 전에 도는 날은 **어제 날짜**가 박힌다.
    //    (test/app.test.js 의 daysAgo 가 같은 이유로 toISOString 을 피한다.)
    //    통째로 두면 자를 일이 없다.
    props.setProperty(PROP.memorySeen, String(at));
    return true;
  }

  function writeStatus(env, result) {
    result.at = new Date().toISOString();
    var folder = ensureFolder(env.drive, CFG.folderName);
    // 첫 실행이 idle 이어도 안내는 있어야 한다 — 유저가 폴더를 먼저 열 수 있다.
    ensureAgentGuide(folder, env);
    ensureFolder(folder, CFG.memoryFolder);
    // ⚠️ **정리가 실패해도 상태는 남아야 한다.** 여기서 던지면 아래
    //    putJson 과 시트 쓰기가 통째로 날아가고, runGuarded 의 catch 가
    //    부르는 writeStatus 도 같은 자리에서 또 던진다 — 결국 **"왜 아무
    //    일도 안 일어나?" 를 진단할 파일 자체가 안 써진다.** 청소부가
    //    넘어진 것과 파이프라인이 선 것은 다른 사건이다.
    var mem = null;
    try {
      mem = pruneMemory(folder);
    } catch (e) {
      result.memoryError = String(e && e.message || e).slice(0, 200);
    }
    if (mem) {
      result.memory = mem;
      if (mem.topics > CFG.memoryMax) result.memoryOverflow = mem.topics;
      var everUsed = markMemorySeen(env.props, mem.memos, result.at);
      if (!everUsed) result.memoryNeverUsed = true;
    }
    putJson(folder, CFG.statusName, JSON.stringify(result, null, 2));
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

  /**
   * 메뉴 구성. 컨테이너가 이 목록대로 만든다.
   *
   * ⚠️ handler 는 **컨테이너에 실제로 있는 함수 이름**이어야 한다. Apps Script 가
   *    문자열로 찾기 때문이다. 컨테이너는 우리가 못 고치므로, 여기서 쓸 수 있는
   *    이름은 이미 정해져 있다 — menu_setup·menu_runNow·menu_setPassword·
   *    menu_status·menu_version·menu_ask, 그리고 예비 menu_slot1~3.
   *
   *    항목을 새로 만들 때는 **예비 슬롯을 쓴다.** 그러면 라벨도 동작도 라이브러리
   *    갱신만으로 바뀐다. 예비를 다 쓰면 그때는 컨테이너를 고쳐야 하고,
   *    그건 이미 설치한 사람에게 닿지 않는다.
   */
  function menuSpec() {
    return [
      { label: '① 처음 설정하기', handler: 'menu_setup' },
      { label: '② 지금 한 번 돌리기', handler: 'menu_runNow' },
      { separator: true },
      { label: '🤖 AI에게 물어보기', handler: 'menu_ask' },
      { label: '상태 보기', handler: 'menu_status' },
      { separator: true },
      { label: '비밀번호 다시 넣기', handler: 'menu_setPassword' },
      { label: '버전 보기', handler: 'menu_version' },
    ];
  }

  /**
   * 컨테이너가 메뉴 클릭을 전부 여기로 넘긴다.
   * 동작을 라이브러리가 쥐고 있어야 나중에 고칠 수 있다.
   */
  function menu(env, key, installTrigger) {
    if (key === 'menu_setup') return menuSetup(env, installTrigger);
    if (key === 'menu_runNow') return menuRunNow(env);
    if (key === 'menu_setPassword') return menuSetPassword(env);
    if (key === 'menu_status') return menuStatus(env);
    if (key === 'menu_version') return menuVersion(env);
    if (key === 'menu_ask') return menuAsk(env);
    // 예비 슬롯은 아직 쓰이지 않는다. 메뉴에 없으므로 눌릴 일도 없다.
    env.ui.alert('아직 준비 중이에요', '이 항목은 다음 버전에서 동작합니다.', env.ui.ButtonSet.OK);
  }

  /**
   * ⚠️ **유저는 우리 파일 이름을 외울 이유가 없다.**
   *    예전 안내는 "k-money 폴더의 latest.json 보고 알려줘" 였다. 폴더도
   *    파일명도 우리 구현이지 유저의 어휘가 아니다. 그래서 이름을 한국어로
   *    바꾸고, 그마저도 외우지 않게 문장을 통째로 준다.
   */
  function menuAsk(env) {
    env.ui.alert('AI에게 물어보기',
      '① 쓰시는 AI에 구글 드라이브를 연결해 두세요.\n' +
      '    Claude: 설정 → 커넥터\n' +
      '    ChatGPT: 설정 → 앱(Apps)\n' +
      '    Gemini: 설정 및 도움말 → 연결된 앱\n\n' +
      '② 이렇게 물어보세요.\n\n' +
      '    돈동생 파일 보고 이번 달 내 소비 어땠는지 알려줘\n\n' +
      '한 번 읽고 나면 그다음부터는 짧게 물어도 알아들어요.\n' +
      '    "이번 달 왜 많이 썼어?"\n' +
      '    "매달 똑같이 나가는 돈이 얼마야?"\n\n' +
      '구독이 없으면 내 드라이브의 ' + CFG.folderName + ' 폴더에서\n' +
      CFG.latestName + ' 를 받아 대화창에 끌어다 놓으셔도 됩니다. 결과는 같아요.',
      env.ui.ButtonSet.OK);
  }

  function menuSetup(env, installTrigger) {
    if (!promptPassword(env)) return;
    // ⚠️ 어떤 트리거를 거는지는 컨테이너가 정한다 (지금은 1분마다 tick).
    //    이름을 여기서 가정하지 않는다 — 옛 컨테이너는 매일 runDaily 를 건다.
    //    그래서 "언제 정리되나" 도 컨테이너 버전을 보고 말한다 (perMinute).
    installTrigger();
    env.ui.alert('설정 완료',
      (perMinute(env)
        ? '뱅크샐러드에서 내보내면 1분쯤 안에 자동으로 정리돼요.\n' +
          '매일 오전 7시쯤에는 상태도 한 번 점검합니다.\n\n'
        : '뱅크샐러드에서 내보내면 매일 아침 7시쯤 자동으로 정리돼요.\n\n') +
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
    var r;
    try {
      r = runForced(env);
    } catch (e) {
      ui.alert('실패', String((e && e.message) || e) + '\n\n' + versionText(env), ui.ButtonSet.OK);
      return;
    }
    if (r.step === 'busy') {
      ui.alert('잠시만요', '지금 자동 실행이 돌고 있어요. 1분 뒤에 다시 눌러 주세요.', ui.ButtonSet.OK);
      return;
    }
    ui.alert(r.ok ? '완료' : '실패', r.message, ui.ButtonSet.OK);
  }

  function menuStatus(env) {
    var ui = env.ui;
    // 상태를 '보는' 동작이 폴더를 만들면 안 된다. 없으면 없는 대로 답한다.
    var it = env.drive.getFoldersByName(CFG.folderName);
    var s = it.hasNext() ? readJson(it.next(), CFG.statusName) : null;
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
    process: process, runDaily: runDaily, runForced: runForced, runGuarded: runGuarded,
    tick: tick, probeKey: probeKey, promoteLedger: promoteLedger,
    monthRows: monthRows, monthJson: monthJson, writeMonths: writeMonths,
    findAttachment: findAttachment,
    ensureFolder: ensureFolder, findFile: findFile, putFile: putFile, putJson: putJson,
    readJson: readJson, readPrevious: readPrevious, pruneFacts: pruneFacts,
    dataAge: dataAge, freshnessLine: freshnessLine, isStale: isStale,
    ensureAgentGuide: ensureAgentGuide, AGENT_GUIDE: AGENT_GUIDE,
    AGENT_GUIDE_DAILY: AGENT_GUIDE_DAILY, agentGuide: agentGuide, perMinute: perMinute,
    memoTopic: memoTopic, topicKey: topicKey, pruneMemory: pruneMemory,
    markMemorySeen: markMemorySeen,
    writeStatus: writeStatus, writeStatusToSheet: writeStatusToSheet,
    safeCell: safeCell, localTime: localTime, hint: hint,
    menuSpec: menuSpec, menu: menu, menuSetup: menuSetup, menuSetPassword: menuSetPassword,
    menuRunNow: menuRunNow, menuStatus: menuStatus, menuVersion: menuVersion,
    menuAsk: menuAsk, historyName: historyName,
    versionText: versionText,
  };
})();
