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
    agentName: 'AGENT.md',
    memoryFolder: '메모리',
    // 주제가 이보다 많으면 상태 파일에 memoryOverflow 로 적는다. 시트에는
    // 안 띄운다 — 굵은 칸 두 개는 '데이터가 멈췄다' 와 실행 결과의 자리고,
    // 주제가 좀 많은 건 그 둘을 밀어낼 만한 소식이 아니다.
    memoryMax: 40,
    // 한 번에 휴지통으로 보낼 수 있는 최대 개수. **이 도구가 유저 것을 지우는
    // 유일한 자리라서** 상한을 둔다. 묶기가 잘못돼 전부 한 주제로 뭉치는 날이
    // 와도 피해가 여기서 멈추고, 다음 실행에서 이어 지운다.
    memoryTrashBudget: 200,
    // 지난 기록은 '돈동생-YYYY-MM-DD.json'. 최신본과 접두사가 같으므로
    // 날짜 모양까지 봐야 한다 — 안 그러면 최신본을 히스토리로 세서 지운다.
    historyPattern: /^돈동생-\d{4}-\d{2}-\d{2}\.json$/,
    keepFacts: 12,        // 지난 기록 보관 개수. 델타 계산에 히스토리가 필요하다
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
    // 메모리 파일을 **한 번이라도** 본 날. 상태 파일은 매일 덮이므로
    // "지금 비어 있다" 와 "여태 한 번도 없었다" 를 여기 아니면 못 가른다.
    memorySeen: 'MEMORY_FIRST_SEEN',
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

    var found = findAttachment(env, opts.force);
    if (!found) {
      return { ok: true, step: 'idle',
        message: '새로 온 뱅크샐러드 메일이 없어요. 앱에서 「파일로 받기」를 눌러 주세요.' };
    }

    var folder = ensureFolder(env.drive, CFG.folderName);
    var raw = ensureFolder(folder, CFG.rawFolderName);
    ensureAgentGuide(folder);
    // 빈 폴더라도 만들어 둔다 — AI 에게 "여기 써도 된다" 는 신호다.
    ensureFolder(folder, CFG.memoryFolder);
    var stamp = Utilities.formatDate(found.date, env.tz, 'yyyy-MM-dd');

    // 1) 원본 보존 — 집계를 고쳤을 때 과거를 다시 계산할 수 있어야 한다
    var zipFile = putFile(raw, stamp + '.zip', found.attachment.copyBlob());

    var xlsx = openXlsx(zipFile, password);
    if (xlsx.error) return xlsx.error;

    return persist(env, folder, buildFacts(env, folder, raw, xlsx.blob, stamp, found), stamp, found);
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
   * 임시 시트는 중간 산물이라 **어떤 경로로 나가든 반드시 치운다.**
   * 집계가 던져도 finally 가 돈다.
   */
  function buildFacts(env, folder, raw, xlsx, stamp, found) {
    var tmpId = null;
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

      // node 에서 검증한 그 코드.
      // 개인화는 메모리 폴더의 마크다운으로 간다 — facts 에 싣지 않는다.
      var facts = KM.aggregate.build(KM.parse.extract(sheets), { asOf: stamp, profile: null });
      facts.generatedAt = new Date().toISOString();
      facts.sourceMessageId = found.id;

      // 같은 날 두 번 내보내면 최신본과 날짜가 같아 델타가 전부 0이 된다.
      // 그런 날은 그 이전 스냅샷을 찾아서 비교한다.
      // ⚠️ **비교 기준은 파일 이름의 기준과 같아야 한다.** 히스토리는 받은
      //    날(stamp)로 이름 짓는다 — 아래 persist 와 같은 기준이다.
      var d = KM.aggregate.delta(facts, readPrevious(folder, stamp));
      if (d) facts.delta = d;
      return facts;
    } finally {
      if (tmpId) { try { env.drive.getFileById(tmpId).setTrashed(true); } catch (ignored) {} }
    }
  }

  /** 5) 저장 — 최신본은 고정 이름이라 AI 가 찾기 쉽다. */
  function persist(env, folder, facts, stamp, found) {
    var json = JSON.stringify(facts, null, 2);

    // ⚠️ **이름은 '받은 날', 내용은 '데이터 날짜'.** 한때 파일 이름도
    //    데이터 날짜로 지었는데, 그러면 **매일 거래하지 않는 사람은 히스토리가
    //    한 개만 남는다.** 데이터 마지막 날이 안 움직이니 매 실행이 같은 파일을
    //    덮어쓰고, readPrevious 가 자기보다 앞선 걸 못 찾아 delta 가 영영
    //    안 나온다 (실측: 순자산이 120만원 움직였는데 보고 0건).
    //    파일 이름은 **스냅샷의 정체**고, generatedFor 는 **내용**이다.
    putJson(folder, historyName(stamp), json);
    putJson(folder, CFG.latestName, json);
    pruneFacts(folder);

    markProcessed(env.props, found.id);
    // ⚠️ 메일 **수신일**이 아니라 거래의 **마지막 날**을 적는다.
    //    유저에게 "데이터는 X 까지 있어요" 라고 말할 값이라, 저장하는 것이
    //    그 문장과 같아야 한다.
    var day = facts.generatedFor || stamp;
    env.props.setProperty(PROP.lastIngest, day);

    return {
      ok: true, step: 'done',
      message: day + ' 까지 정리했어요' +
               (facts.period ? ' (' + facts.period.days + '일치)' : ' (거래 0건)') +
               '. 이제 AI에게 물어보세요.',
      generatedFor: day,
      bytes: json.length,
      flags: (facts.dataQuality && facts.dataQuality.flags || []).map(function (f) { return f.code; }),
    };
  }

  /**
   * 잠금을 잡고 한 번 돌린다. **모든 실행 경로가 여기를 지난다.**
   *
   * ⚠️ 예전엔 runOnceForce 만 잠금 없이 돌았고, 그게 하필 컨테이너에 있어서
   *    이미 사본을 뜬 사람에게는 영영 못 고치는 상태였다. 겹치면 임시 시트가
   *    둘, 최신본 쓰기가 둘이 되고 pruneFacts 가 서로 쓰는 걸 지운다.
   */
  function runGuarded(env, opts) {
    if (!env.lock.tryLock(10 * 1000)) {
      return { ok: true, step: 'busy', message: '이미 실행 중이라 건너뜁니다.' };
    }
    try {
      var result = process(env, opts);
      writeStatus(env, result);
      return result;
    } catch (e) {
      var fail = { ok: false, step: 'unknown', message: String(e && e.message || e) };
      try { writeStatus(env, fail); } catch (ignored) {}
      throw e;
    } finally {
      env.lock.releaseLock();
    }
  }

  /** 트리거가 부르는 것. 예외를 삼키지 않되 상태는 반드시 남긴다. */
  function runDaily(env) {
    return runGuarded(env, {});
  }

  /** 편집기에서 손으로 돌릴 때. 이미 처리한 메일도 다시 본다. */
  function runForced(env) {
    return runGuarded(env, { force: true });
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
      '# 이 폴더를 읽는 AI에게',
      '',
      '여기는 **돈동생**이 만든 폴더입니다. 한국의 가계부 앱(뱅크샐러드)에서 내보낸',
      '거래 내역을 매일 정리해 둡니다. 이 파일을 먼저 읽고 시작하세요.',
      '',
      '기간은 사용자가 뱅크샐러드에서 고릅니다(최소 1년). **얼마나 담겼는지는',
      '`돈동생-최신.json`의 `period`를 보세요.** 몇 년치라고 넘겨짚지 마세요.',
      '',
      '## 읽는 순서',
      '',
      '1. 이 파일 (지금 읽고 있는 것)',
      '2. **`메모리/` 폴더** — 사용자에 대해 이미 알고 있는 것. 답하기 전에 읽으세요',
      '3. `돈동생-최신.json` — 숫자',
      '',
      '2번을 건너뛰면 사용자는 지난 대화를 처음부터 다시 설명해야 합니다.',
      '그걸 없애려고 이 폴더가 있습니다.',
      '',
      '## 파일',
      '',
      '| 파일 | 무엇 |',
      '|---|---|',
      '| `돈동생-최신.json` | **이걸 읽으세요.** 가장 최근 집계 |',
      '| `돈동생-YYYY-MM-DD.json` | 지난 기록(최근 12개). 지난번과의 차이는 이미 최신본의 `delta` 에 있어요 — 여기까지 열 일은 드뭅니다 |',
      '| `메모리/` | 사용자에 대해 알게 된 것. **여기를 먼저 읽으세요** |',
      '| `돈동생-상태.json` | 마지막 실행 결과. 사용자가 "왜 안 돌아?" 물을 때만 |',
      '| `raw/` | 원본 zip. 열지 마세요 |',
      '',
      '## 숫자를 다룰 때',
      '',
      '`돈동생-최신.json` 안의 `hints`에 각 필드의 뜻과 계산 규약이 적혀 있습니다.',
      '**그걸 따르세요.** 특히:',
      '',
      '- 금액은 원(KRW) 단위 정수입니다',
      '- `expense`는 이미 환불을 차감한 순액입니다. 다시 빼지 마세요',
      '- `pace`와 `avgMonthlyExpense`는 보정된 값입니다. 직접 다시 유도하지 마세요',
      '- `otherTotal` 같은 필드는 목록에서 **잘려나간 나머지**입니다. 합계를 검산할 때',
      '  같이 더하세요',
      '',
      '**없는 키는 만들어내지 마세요.** 돈동생은 믿을 수 없는 값을 아예 빼고',
      '`...Omitted` 필드에 이유를 적습니다. 예를 들어 `pace.monthlyOmitted`가 있으면',
      '"월 얼마 모으는지"는 지금 데이터로 답할 수 없다는 뜻입니다. 추정해서 채우지 말고,',
      '왜 없는지 설명하세요.',
      '',
      '`dataQuality.flags`를 확인하세요. 여기 뭔가 있으면 그걸 감안해서 답해야 합니다.',
      '',
      '## 사용자를 기억하는 법 — `메모리/` 폴더',
      '',
      '대화에서 알게 된 것을 **`메모리/` 폴더에 마크다운으로 적어 두세요.**',
      '안 적으면 대화가 끝나는 순간 사라집니다. 목표, 수입, 사는 형편, 신경 쓰는 것 —',
      '숫자든 문장이든 상관없습니다.',
      '',
      '### 파일 이름 규칙',
      '',
      '```',
      '메모리/2026-08-09-목표.md',
      '메모리/2026-08-09-수입.md',
      '메모리/2026-08-09-이직생각.md',
      '        └날짜┘ └주제┘',
      '```',
      '',
      '**주제 하나에 파일 하나입니다.** 날짜를 앞에 붙이는 건 이름이 겹치지 않게',
      '하려는 것뿐이에요. 돈동생이 매일 아침 **주제별로 가장 최신 것만 남기고',
      '나머지는 휴지통으로** 보냅니다.',
      '',
      '### 주제 이름은 이 목록에서 고르세요',
      '',
      '**새 이름을 지어내지 마세요.** 같은 뜻을 세션마다 다르게 부르면',
      '(`목표` / `재무목표` / `새해목표`) 돈동생은 서로 다른 주제로 보고 **셋 다',
      '남깁니다.** 그러면 다음 대화에서 당신은 서로 모순되는 파일 여러 개를 읽게 돼요.',
      '그건 기억이 없는 것보다 나쁩니다.',
      '',
      '| 주제 | 여기 담을 것 |',
      '|---|---|',
      '| `목표` | 모으려는 금액과 시점 |',
      '| `수입` | 월 실수령, 상여·부수입의 주기 |',
      '| `고정지출` | 월세·관리비처럼 매달 정해진 것 |',
      '| `가족` | 용돈·부양처럼 **돈이 오가는** 것만 |',
      '| `일` | 고용 형태 등 수입의 안정성에 걸리는 것 |',
      '| `습관` | 사용자가 스스로 말한 소비 성향 |',
      '| `제약` | 대출 상환, 만기, 못 건드리는 돈 |',
      '| `선호` | 어떻게 답해주길 바라는지 |',
      '',
      '여기에 안 맞는 게 나오면 **`기타` 하나에 모으세요.** 새 주제를 만들지 마세요.',
      '',
      '### 그래서 갱신하는 법',
      '',
      '당신은 파일을 **고칠 수도 지울 수도 없습니다.** 새로 만드는 것만 됩니다.',
      '그러니 어떤 주제를 갱신할 때는:',
      '',
      '1. `메모리/` 를 훑어 **그 주제의 현재 파일을 먼저 읽으세요**',
      '2. **읽었는데 내용이 비어 있으면 거기서 멈추세요.** 방금 만들어진 파일은',
      '   몇 분 동안 빈 문자열로 읽힙니다 — 내용이 없는 게 아니라 아직 안 보이는',
      '   거예요. 여기서 새로 쓰면 **원래 있던 것을 지우는 것과 같습니다.**',
      '   사용자에게 "조금 전에 저장한 게 아직 안 읽혀요. 다음에 이어갈게요" 라고',
      '   말하고 쓰지 마세요',
      '3. 아직 맞는 내용은 가져오고, 바뀐 건 새 값으로, 틀린 건 버리고',
      '4. **오늘 날짜로 같은 주제 이름의 파일을 새로 만드세요**',
      '',
      '**읽기를 건너뛰고 쓰면 그 주제에 대해 예전에 알던 것이 사라집니다.**',
      '',
      '새 파일에는 **지금 참인 것만** 담으세요. "예전엔 260만이었는데 지금은 300만"',
      '같은 이력은 필요할 때만 남기고, 보통은 최신 값만 두면 됩니다.',
      '',
      '주제 이름은 **기존 파일에 쓰인 것을 그대로** 쓰세요. `목표` 를 `재무목표` 로',
      '바꾸면 돈동생이 다른 주제로 보고 둘 다 남깁니다.',
      '',
      '### 파일 안에는',
      '',
      '맨 위에 언제·어디서 나온 말인지 적어 두세요. 나중에 당신이 이걸 다시 읽을 때',
      '갱신할지 판단하는 근거가 됩니다.',
      '',
      '```markdown',
      '# 목표',
      '',
      '- 3년 안에 5천만원 (2029-08까지)',
      '- 그다음은 전세 보증금. 금액은 아직 안 정함',
      '',
      '---',
      '2026-08-09 · 사용자가 직접 말함',
      '```',
      '',
      '추정한 값이면 그렇게 적으세요. `2026-08-09 · 내가 추정 (사용자 확인 안 함)`.',
      '그리고 사용자에게 **되물어서** 확인받으세요.',
      '',
      '파일은 **일반 텍스트로** 만드세요. 커넥터에 "구글 형식으로 변환" 옵션이 있으면',
      '꺼 주세요. 구글 문서로 변환되면 `#` `*` `_` `[` `]` 가 이스케이프돼서 다음에',
      '당신이 읽을 때 깨져 보입니다. 표나 코드블록은 쓰지 마세요.',
      '',
      '### 적지 않는 것',
      '',
      '`메모리/` 는 **가계부 옆에 놓인 메모**입니다. 사용자는 여기에 인생이 기록될',
      '거라고 예상하지 않았어요. 다음은 사용자가 직접 "이건 적어 둬" 라고 말하지',
      '않는 한 적지 마세요.',
      '',
      '- 병명·진단·복약·정신건강. 병원비가 지출에 잡혀도 **금액만** 다루고',
      '  무슨 병인지는 적지 마세요',
      '- 회사 이름, 직책, 이직하려는 곳, 연봉 협상 내용',
      '- 연애·이혼·별거, 가족과의 갈등',
      '- 종교·정치·성적 지향',
      '- 남의 개인정보 (친구·동료의 이름과 사정)',
      '',
      '**돈에 영향을 주는 사실만** 남기세요. "2027년 3월에 목돈 300만원이 필요하다"',
      '는 적어도 되고, **왜 필요한지는 안 적어도 됩니다.**',
      '',
      '사용자가 "그건 기억하지 마" 라고 하면 그 말이 우선입니다. 이미 적어 뒀다면',
      '어느 파일인지 알려주고 지우는 법을 안내하세요.',
      '',
      '### 이럴 땐 쓰지 마세요',
      '',
      '파일을 만드는 건 **사용자가 새로 알려준 것이 있을 때만**입니다.',
      '',
      '- 숫자를 계산하거나 비교만 한 대화 → 쓰지 마세요. 그건 `돈동생-최신.json`',
      '  에 이미 있고 내일 다시 계산됩니다',
      '- 이미 적혀 있는 것과 같은 내용 → 쓰지 마세요. 날짜만 바뀐 파일이 쌓입니다',
      '- 사용자가 확실히 말하지 않은 추측 → 먼저 물어보고, 답을 들은 뒤에 쓰세요',
      '- 사용자가 지나가듯 한 말 → 한 번 더 나오면 그때 쓰세요',
      '',
      '한 대화에서 **주제를 두세 개 넘게 쓰고 있다면 너무 많이 쓰는 겁니다.**',
      '',
      '### 못 쓰는 경우',
      '',
      '드라이브 연결이 읽기 전용이면 파일을 만들 수 없습니다. 그때는 사용자에게',
      '내용을 보여주고 "`돈동생/메모리/` 에 이 이름으로 저장해 두시면 다음에도',
      '기억해요" 라고 알려주세요.',
      '',
      '## 하지 않을 것',
      '',
      '돈동생은 **사실·계산·비교까지만** 합니다. 당신도 그 선을 지켜주세요.',
      '',
      '- 특정 금융상품을 추천하지 마세요 (어떤 적금, 어떤 ETF)',
      '- 사고팔라고 하지 마세요',
      '- 수익률을 가정한 미래 자산을 단정하지 마세요. 하려면 가정을 명시하고',
      '  "그 이율이 맞다면"이라고 조건을 다세요',
      '',
      '사용자가 물으면 "저는 투자 조언을 할 수 없어요"라고 말하되, **사실은 다 보여주세요.**',
      '지금 얼마 있고, 어디에 쓰고 있고, 이 페이스면 언제쯤인지는 계산해서 알려줘도 됩니다.',
      '판단은 사용자가 합니다.',
      '',
      '## 데이터가 오래됐을 때',
      '',
      '`돈동생-최신.json`의 `period.to`가 2주 이상 지났으면, 사용자가 뱅크샐러드에서',
      '내보내기를 안 한 겁니다. 답을 하되 **먼저 알려주세요** — 오래된 숫자로 이야기하면',
      '사용자는 지금 상황인 줄 압니다.',
      '',
      '내보내는 법: 뱅크샐러드 앱 → 가계부 → 톱니바퀴 → 파일로 받기 →',
      '설치할 때 쓴 구글 주소로, 같은 비밀번호로.'
  ].join('\n') + '\n';

  /** 내용이 달라졌을 때만 쓴다. 매번 덮으면 수정시각만 흔들린다. */
  function ensureAgentGuide(folder) {
    var f = findFile(folder, CFG.agentName);
    if (f) {
      try {
        if (f.getBlob().getDataAsString('UTF-8') === AGENT_GUIDE) return;
      } catch (e) {
        // 못 읽으면 새로 쓴다
      }
      f.setContent(AGENT_GUIDE);
      return;
    }
    folder.createFile(Utilities.newBlob(AGENT_GUIDE, 'text/markdown', CFG.agentName));
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
  //    내용은 읽지 않는다. 합치지도 않는다 — 그건 해석이고 우리 일이 아니다.
  //    "3월엔 260만이라 했고 7월엔 300만이라 했는데 뭐가 맞나" 는 AI 가
  //    새 파일을 쓸 때 정리할 문제다.

  /** 'YYYY-MM-DD[-HHMM]-주제.md' 에서 주제만. 규칙에 안 맞으면 null. */
  function memoTopic(name) {
    var base = String(name).replace(/\.md$/i, '');
    var m = /^(\d{4}-\d{2}-\d{2})(?:[T\-_ ]\d{2}:?\d{2})?[-_ ](.+)$/.exec(base);
    return m && m[2] ? m[2].trim() : null;
  }

  /**
   * 묶는 열쇠. **사람 눈에 같은 주제면 같은 열쇠가 나와야 한다.**
   *
   * ⚠️ **한글은 같은 글자가 두 가지 바이트로 온다.** macOS 가 만든 파일 이름은
   *    자모가 풀린 NFD('ㄱㅗㅁㅍㅛ')로 오고 AI 가 쓴 건 NFC('목표')로 온다.
   *    눈으로는 똑같은데 문자열로는 다르다 — 묶지 않으면 둘 다 살아남아
   *    다음 대화에서 AI 가 **서로 모순되는 파일 두 개**를 읽는다.
   *    그건 우리가 이 폴더를 만든 이유의 정반대다.
   */
  function topicKey(topic) {
    return String(topic).normalize('NFC').replace(/\s+/g, '').toLowerCase();
  }

  /**
   * 주제마다 최신 하나만 남긴다.
   *
   * ⚠️ **순서는 파일 이름이 아니라 드라이브 생성 시각으로 본다.** AI 가 붙인
   *    날짜는 시간대를 틀리거나 오늘이 며칠인지 몰라 어긋날 수 있다.
   *    이름에서 가져오는 건 주제뿐이다.
   * ⚠️ **규칙에 안 맞는 이름은 건드리지 않는다.** 유저가 직접 넣어 둔 파일을
   *    우리가 지우면 안 된다.
   * ⚠️ 영구 삭제가 아니라 휴지통이다. AI 가 잘못 갱신해도 30일 안에 되돌린다.
   */
  function pruneMemory(folder) {
    var it = folder.getFoldersByName(CFG.memoryFolder);
    if (!it.hasNext()) return null;
    var mem = it.next();

    // ⚠️ **{} 가 아니라 Object.create(null).** 평범한 객체는 'toString' ·
    //    'constructor' 를 이미 갖고 있다. 파일 하나가 '2026-08-09-toString.md'
    //    이면 `!byTopic[topic]` 이 거짓이라 배열을 안 만들고, 곧바로
    //    함수에 .push 를 불러 **TypeError 로 실행 전체가 죽는다.**
    //    '__proto__' 는 더 조용하다 — 대입이 프로토타입을 갈아 끼워서
    //    Object.keys 에 안 잡히고 그 주제만 영영 안 치워진다.
    var byTopic = Object.create(null);
    var matched = 0;
    var unnamed = 0;

    var files = mem.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var name = f.getName();
      var topic = memoTopic(name);
      if (!topic) { unnamed++; continue; }
      matched++;
      var key = topicKey(topic);
      if (!byTopic[key]) byTopic[key] = [];
      // getDateCreated() 는 드라이브 호출이다. 비교 함수 안에서 부르면
      // 파일 하나를 정렬 내내 몇 번씩 다시 묻는다. 여기서 한 번만 본다.
      byTopic[key].push({ file: f, at: f.getDateCreated().getTime(), name: name });
    }

    var keys = Object.keys(byTopic);
    var trashed = 0;
    var capped = false;
    for (var k = 0; k < keys.length; k++) {
      var list = byTopic[keys[k]].sort(function (a, b) {
        // 같은 초에 만들어진 두 개는 이름이 큰 쪽(=나중 날짜)을 남긴다.
        // 안 정하면 어느 쪽이 살지 실행마다 달라진다.
        return b.at - a.at || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
      });
      for (var i = 1; i < list.length; i++) {
        if (trashed >= CFG.memoryTrashBudget) { capped = true; break; }
        list[i].file.setTrashed(true);
        trashed++;
      }
      if (capped) break;
    }

    var out = { topics: keys.length, trashed: trashed, files: matched };
    if (unnamed) out.unnamed = unnamed;
    if (capped) out.trashCapped = true;
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
  function markMemorySeen(props, files, at) {
    if (props.getProperty(PROP.memorySeen)) return true;
    if (!files) return false;
    props.setProperty(PROP.memorySeen, String(at).slice(0, 10));
    return true;
  }

  function writeStatus(env, result) {
    result.at = new Date().toISOString();
    var folder = ensureFolder(env.drive, CFG.folderName);
    // 첫 실행이 idle 이어도 안내는 있어야 한다 — 유저가 폴더를 먼저 열 수 있다.
    ensureAgentGuide(folder);
    ensureFolder(folder, CFG.memoryFolder);
    var mem = pruneMemory(folder);
    if (mem) {
      result.memory = mem;
      if (mem.topics > CFG.memoryMax) result.memoryOverflow = mem.topics;
      if (!markMemorySeen(env.props, mem.files, result.at)) result.memoryNeverUsed = true;
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
    findAttachment: findAttachment, getProcessed: getProcessed, markProcessed: markProcessed,
    ensureFolder: ensureFolder, findFile: findFile, putFile: putFile, putJson: putJson,
    readJson: readJson, readPrevious: readPrevious, pruneFacts: pruneFacts,
    dataAge: dataAge, freshnessLine: freshnessLine, isStale: isStale,
    ensureAgentGuide: ensureAgentGuide, AGENT_GUIDE: AGENT_GUIDE,
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
