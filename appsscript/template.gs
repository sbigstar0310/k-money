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

// 상태를 적을 칸. 라이브러리의 app.gs 가 여기에 쓴다 (KMApp.STATUS_CELL).
var TEMPLATE_STATUS_CELL = 'B10';
var TEMPLATE_CHECKED_CELL = 'B11';

// ⚠️ **rows 배열에 줄을 끼워 넣지 마라.** 아래 서식과 위 상수가 전부 행 번호로
//    박혀 있고, app.gs 도 같은 칸에 쓴다. 한 줄만 밀어도 상태가 엉뚱한
//    칸에 찍히는데 **오류는 안 난다** — 유저 화면은 영영 첫 문구 그대로 남는다.
//    **상태 칸 아래(자주 묻는 것)는 늘려도 된다.** 위쪽만 건드리지 마라.
//    테스트가 '지금 상태' 머리글이 상태 칸 바로 위에 있는지 확인한다.

function template_build() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheets()[0];

  sh.clear();
  sh.setName('돈동생');
  sh.setHiddenGridlines(true);

  sh.setColumnWidth(1, 40);
  sh.setColumnWidth(2, 760);

  var rows = [
    ['', '💰 돈동생'],
    ['', '자산 같이 봐주는 똑똑한 동생   ·   메뉴가 안 보이면 새로고침(Cmd/Ctrl+R)'],
    ['', ''],
    ['', '시작하기'],
    ['', '① 위 메뉴의  💰 돈동생 → ① 처음 설정하기  →  앞으로 쓸 비밀번호를 정합니다.'],
    ['', '② 뱅크샐러드 앱 → 가계부 → 톱니바퀴 → 파일로 받기 → 이 구글 주소로, 같은 비밀번호로.   ← 이걸 해야 시작됩니다'],
    ['', '③ 메일이 오면 알아서 정리합니다. 앞으로 하실 일도 ② 하나뿐이에요.'],
    ['', ''],
    ['', '지금 상태'],
    ['', '아직 한 번도 돌지 않았습니다.'],
    ['', ''],
    ['', ''],
    ['', '자주 묻는 것'],
    ['', '· 데이터는 어디 있나요 —  내 구글 드라이브의 돈동생 폴더, 나만 볼 수 있어요. 서버로 안 갑니다.'],
    ['', '· 뭘 물어보면 되나요 —  Claude·ChatGPT 설정에서 구글 드라이브를 연결한 뒤'],
    ['', '   "돈동생 파일 보고 이번 달 어땠는지 알려줘" 라고만 하시면 됩니다.'],
    ['', '   자세한 건 메뉴의  🤖 AI에게 물어보기  를 눌러 보세요. 무료 계정도 됩니다.'],
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

  // 안내 본문. ② 는 유저가 반드시 해야 하는 유일한 일이라 굵게 둔다 —
  // 여기를 안 하면 트리거는 매일 성공하는데 데이터가 영영 안 들어온다.
  sh.getRange('B5:B7').setFontSize(11).setFontColor('#374151');
  sh.getRange('B6').setFontWeight('bold').setFontColor('#111827');
  sh.getRange('B14:B19').setFontSize(10).setFontColor('#6b7280');

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
