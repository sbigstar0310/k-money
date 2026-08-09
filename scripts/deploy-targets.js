'use strict';

/**
 * 배포가 향하는 두 프로젝트. **비밀이 아니라서 저장소에 둔다.**
 *
 * ━━ 왜 여기 있나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 스크립트 ID 는 주소일 뿐이고, 이걸 안다고 남이 쓸 수 있는 게 아니다.
 * 쓰려면 **그 프로젝트에 대한 권한**이 필요하고 그건 `~/.config/k-money/deploy.json`
 * 의 토큰이 갖는다. 라이브러리 ID 는 이미 `appsscript/appsscript.json` 에
 * 커밋돼 있고 유저 사본마다 복제된다 — 감출 수 있는 값이 아니다.
 *
 * 가르는 기준은 이것이다: **비밀은 홈 디렉터리에, 주소는 저장소에.**
 * 섞으면 설정이 사람 머릿속에만 남아서, 몇 달 뒤 다시 배포할 때 못 찾는다.
 *
 * ━━ 라이브러리 ID 를 여기 안 적는 이유 ━━━━━━━━━━━━━━━━━━━━━━
 *
 * 매니페스트에 이미 있다. 두 곳에 적으면 언젠가 어긋나고, 어긋나면
 * **유저가 참조하는 라이브러리와 우리가 배포하는 라이브러리가 달라진다.**
 * 그건 오류 없이 조용히 벌어진다. 그래서 매니페스트를 유일한 출처로 둔다.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'appsscript', 'appsscript.json');

/**
 * 템플릿 시트에 바인딩된 스크립트.
 *
 * Drive 목록에 안 나타나서 API 로 찾을 수 없다. 시트 → 확장 프로그램 →
 * Apps Script → ⚙️ 프로젝트 설정 에서 사람이 한 번 읽어와야 하는 값이다.
 */
const TEMPLATE_SCRIPT_ID = '1QUM2Zq4wIV5qmNQPODMK5keSLYdTnGnoPaDL7QlgLdpl0v5C2xTlSUBS';

/** 유저 사본이 실제로 참조하는 그 ID 를 쓴다. 딴 데서 가져오지 않는다. */
function libraryScriptId() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const libs = (m.dependencies || {}).libraries || [];
  if (libs.length !== 1) {
    throw new Error('매니페스트의 libraries 가 1개가 아니다 (' + libs.length + '개)');
  }
  if (!libs[0].libraryId) throw new Error('매니페스트에 libraryId 가 없다');
  return libs[0].libraryId;
}

module.exports = {
  TEMPLATE_SCRIPT_ID: TEMPLATE_SCRIPT_ID,
  libraryScriptId: libraryScriptId,
};
