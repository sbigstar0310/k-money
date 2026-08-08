/**
 * 템플릿 시트 꾸미기 — **개발자가 배포 전에 한 번만 실행한다.**
 *
 * 유저가 사본을 열었을 때 보는 첫 화면을 만든다. 손으로 셀을 만지지 않고
 * 코드로 하는 이유는, 나중에 템플릿을 다시 만들 때 똑같이 재현되어야 하기 때문이다.
 *
 *   1. 편집기에서 template_build() 실행
 *   2. 시트로 돌아가 확인
 *   3. 이 파일은 지워도 된다 (셀 내용은 시트에 남는다)
 */

// 상태를 적을 칸. main.gs 의 writeStatus_() 가 여기에 쓴다.
var TEMPLATE_STATUS_CELL = 'B10';
var TEMPLATE_CHECKED_CELL = 'B11';

function template_build() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheets()[0];

  sh.clear();
  sh.setName('돈동생');
  sh.setHiddenGridlines(true);

  sh.setColumnWidth(1, 40);
  sh.setColumnWidth(2, 620);

  var rows = [
    ['', '💰 돈동생'],
    ['', '자산 같이 봐주는 똑똑한 동생'],
    ['', ''],
    ['', '시작하기'],
    ['', '① 위 메뉴에서  💰 돈동생 → ① 처음 설정하기  를 눌러 주세요.'],
    ['', '② 뱅크샐러드 내보내기에 쓸 비밀번호를 한 번 넣으면 끝입니다.'],
    ['', '③ 그다음부터 매일 오전 7시에 알아서 돕니다.'],
    ['', ''],
    ['', '지금 상태'],
    ['', '아직 한 번도 돌지 않았습니다.'],
    ['', ''],
    ['', ''],
    ['', '자주 묻는 것'],
    ['', '· 데이터는 어디 있나요 —  내 드라이브의 k-money 폴더입니다. 만든 사람은 볼 수 없습니다.'],
    ['', '· 뭘 물어보면 되나요 —  Claude·ChatGPT·Gemini 에서 Google Drive 를 연결한 뒤'],
    ['', '   "내 드라이브 k-money 폴더의 latest.json 보고 이번 달 어땠는지 알려줘" 라고 해보세요.'],
    ['', '· 비밀번호를 잘못 넣었어요 —  메뉴에서 "비밀번호 다시 넣기" 를 누르세요.'],
    ['', '· 그만두려면 —  이 시트를 지우면 자동 실행도 멈춥니다.'],
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);

  // 제목
  sh.getRange('B1').setFontSize(24).setFontWeight('bold');
  sh.getRange('B2').setFontSize(11).setFontColor('#6b7280');

  // 소제목
  ['B4', 'B9', 'B13'].forEach(function (a) {
    sh.getRange(a).setFontSize(13).setFontWeight('bold').setFontColor('#111827');
  });

  // 안내 본문
  sh.getRange('B5:B7').setFontSize(11).setFontColor('#374151');
  sh.getRange('B14:B18').setFontSize(10).setFontColor('#6b7280');

  // 상태 칸 — 눈에 띄게
  sh.getRange('B10:B11').setFontSize(11).setFontColor('#374151')
    .setBackground('#f9fafb');
  sh.getRange('B10').setFontWeight('bold');

  sh.setRowHeight(1, 44);
  sh.setRowHeight(3, 10);
  sh.setRowHeight(8, 10);
  sh.setRowHeight(12, 16);
  sh.setFrozenRows(0);

  // 남는 열·행을 지워 빈 표처럼 보이지 않게 한다
  if (sh.getMaxColumns() > 3) sh.deleteColumns(4, sh.getMaxColumns() - 3);
  if (sh.getMaxRows() > 24) sh.deleteRows(25, sh.getMaxRows() - 24);

  sh.getRange('B1').activate();
  SpreadsheetApp.flush();
  Logger.log('✅ 템플릿 꾸미기 완료. 시트를 새로고침해서 확인해라.');
}
