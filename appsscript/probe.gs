/**
 * 포맷 탐침 — 어떤 파일 형식이 LLM 커넥터에 읽히는지 알아낸다.
 *
 * 실측으로 확인된 것: Drive 에 application/json 으로 올린 파일은
 * 커넥터의 기본 읽기 경로와 검색 스니펫 양쪽에서 **빈 문자열**로 나온다.
 * 284 bytes 짜리도 그랬으니 크기가 아니라 MIME 타입 문제다.
 * 명시적 다운로드(base64)만 되는데, 유저가 대화할 때 쓰이는 경로가 아니다.
 *
 * 그래서 어떤 형식이 통하는지 한 번에 재 본다.
 *
 * ⚠️ **숫자는 전부 가짜다.** 이 파일들은 외부 서비스(LLM 커넥터)가 읽어가는
 *    것이 목적이라, 실제 금융 데이터를 넣으면 그게 곧 유출이다.
 *    확인이 끝나면 probe_cleanup() 으로 지운다.
 *
 *   1. probe_formats()  실행 → 로그의 파일 ID 를 대화에 붙여넣는다
 *   2. 어느 형식이 읽히는지 확인
 *   3. probe_cleanup()  실행 → 흔적 삭제
 */

var PROBE_FOLDER = 'k-money-probe';

/** 전부 가짜 값. 실제 잔고와 무관하다. */
function probeFacts_() {
  return {
    schema: 'k-money/facts@1',
    note: 'PROBE — 전부 가짜 숫자다. 실제 데이터가 아니다.',
    period: { from: '2020-01-01', to: '2020-12-31', days: 366 },
    flow: { income: 11111111, expense: 2222222, avgMonthlyExpense: 333333 },
    balance: { netWorth: 44444444, buckets: { cash: 4000000, savings: 400000 } },
    transfers: { self: { net: 555 }, external: { net: 66666, gross: 777777 } },
  };
}

function probeMarkdown_(f) {
  return [
    '# 돈동생 리포트 (PROBE)',
    '',
    '> 아래 숫자는 전부 가짜다. 형식 실험용 파일이다.',
    '',
    '## 기간',
    f.period.from + ' ~ ' + f.period.to + ' (' + f.period.days + '일)',
    '',
    '## 흐름',
    '| 항목 | 금액 |',
    '| --- | ---: |',
    '| 수입 | ' + f.flow.income + ' |',
    '| 지출 | ' + f.flow.expense + ' |',
    '| 월평균 지출 | ' + f.flow.avgMonthlyExpense + ' |',
    '',
    '## 잔고',
    '순자산 ' + f.balance.netWorth,
    '현금성 ' + f.balance.buckets.cash + ' / 저축성 ' + f.balance.buckets.savings,
    '',
    '## 이체',
    '본인 순액 ' + f.transfers.self.net,
    '타인 순액 ' + f.transfers.external.net + ' / 총액 ' + f.transfers.external.gross,
    '',
    'PROBE_CANARY_7F3A — 이 문자열이 보이면 이 형식은 읽힌다.',
  ].join('\n');
}

function probe_formats() {
  var folder = probeFolder_();
  var f = probeFacts_();
  var json = JSON.stringify(f, null, 2);
  var md = probeMarkdown_(f);
  var out = [];

  // 1) JSON — 지금 쓰는 형식. 대조군이다.
  out.push(['json  ', probePut_(folder, 'probe.json', json, 'application/json')]);

  // 2) 순수 텍스트
  out.push(['txt   ', probePut_(folder, 'probe.txt', md, 'text/plain')]);

  // 3) .md 확장자 + 마크다운 MIME
  out.push(['md    ', probePut_(folder, 'probe.md', md, 'text/markdown')]);

  // 4) Google Docs — 커넥터 지원 목록에 명시된 형식
  var doc = DocumentApp.create('probe-doc');
  doc.getBody().setText(md);
  doc.saveAndClose();
  var docFile = DriveApp.getFileById(doc.getId());
  folder.addFile(docFile);
  DriveApp.getRootFolder().removeFile(docFile);
  out.push(['gdoc  ', doc.getId()]);

  // 5) Google Sheets — 표라서 숫자를 다루기엔 오히려 자연스러울 수 있다
  var ss = SpreadsheetApp.create('probe-sheet');
  var sh = ss.getSheets()[0];
  sh.getRange(1, 1, 7, 2).setValues([
    ['항목', '값'],
    ['PROBE_CANARY_7F3A', '형식 실험용 · 가짜 숫자'],
    ['수입', f.flow.income],
    ['지출', f.flow.expense],
    ['순자산', f.balance.netWorth],
    ['이체 본인순액', f.transfers.self.net],
    ['이체 타인총액', f.transfers.external.gross],
  ]);
  var ssFile = DriveApp.getFileById(ss.getId());
  folder.addFile(ssFile);
  DriveApp.getRootFolder().removeFile(ssFile);
  out.push(['gsheet', ss.getId()]);

  Logger.log('=== 포맷 탐침 (숫자는 전부 가짜) ===');
  for (var i = 0; i < out.length; i++) Logger.log('  ' + out[i][0] + '  ' + out[i][1]);
  Logger.log('\n위 ID 들을 대화에 붙여넣어라. 확인 후 probe_cleanup() 을 실행해라.');
}

function probePut_(folder, name, content, mime) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) it.next().setTrashed(true);
  return folder.createFile(Utilities.newBlob(content, mime, name)).getId();
}

function probeFolder_() {
  var it = DriveApp.getFoldersByName(PROBE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PROBE_FOLDER);
}

/**
 * 2차 탐침 — 1차에서 알아낸 것을 좁힌다.
 *
 * 1차 결과:
 *   application/json  → 빈 문자열 (기본 읽기 경로·검색 스니펫 양쪽)
 *   text/plain        → 읽힘. 다만 마크다운 특수문자가 이스케이프된다
 *   Google Docs/Sheets→ 읽힘
 *
 * 그래서 남은 질문 둘:
 *   (a) **JSON 내용을 text/plain 으로** 올리면? 기계 정확성과 가독성을 둘 다 얻는다.
 *   (b) 정확히 **어떤 문자가** 이스케이프되나? 그걸 알면 피해서 쓸 수 있다.
 */
function probe_formats2() {
  var folder = probeFolder_();
  var f = probeFacts_();

  // (a) JSON 문자열을 text/plain 으로. 키에 밑줄이 있는 것과 없는 것을 같이 넣어
  //     밑줄 이스케이프가 파싱을 깨뜨리는지 본다.
  var jsonish = JSON.stringify({
    schema: 'k-money/facts@1',
    note: 'PROBE 가짜 숫자',
    flow: f.flow,
    balance: f.balance,
    flags: [
      { code: 'unclassified_external_transfers', amount: 777777 },
      { code: 'ownerMatchedByMaskedName', count: 44 },
    ],
    canary: 'PROBE CANARY 7F3A',
  }, null, 2);

  // (b) 문자 고문 — 무엇이 살아남는지 한 줄로 본다
  var torture = [
    'CHARTEST START',
    'brace { } bracket [ ] paren ( ) angle < >',
    'punct : ; , . ! ? / \\ | + = % & @ $',
    'md hash # star * under _ tilde ~ tick ` dash - gt >',
    'quote " single \' won ￦ 원 · … —',
    'CHARTEST END',
  ].join('\n');

  var ids = [
    ['json-as-text ', probePut_(folder, 'probe2-json.txt', jsonish, 'text/plain')],
    ['chartest     ', probePut_(folder, 'probe2-chars.txt', torture, 'text/plain')],
  ];

  Logger.log('=== 2차 탐침 (숫자는 전부 가짜) ===');
  for (var i = 0; i < ids.length; i++) Logger.log('  ' + ids[i][0] + '  ' + ids[i][1]);
  Logger.log('\n확인 후 probe_cleanup() 을 실행해라.');
}

/** 탐침 흔적을 전부 지운다. */
function probe_cleanup() {
  var it = DriveApp.getFoldersByName(PROBE_FOLDER);
  var n = 0;
  while (it.hasNext()) { it.next().setTrashed(true); n++; }
  // 폴더 밖에 남았을 수 있는 것들도 이름으로 훑는다
  ['probe-doc', 'probe-sheet'].forEach(function (name) {
    var fit = DriveApp.getFilesByName(name);
    while (fit.hasNext()) { fit.next().setTrashed(true); n++; }
  });
  Logger.log('✅ 탐침 ' + n + '건 휴지통으로 옮겼다.');
}
