/**
 * 라이브러리 공개 API — **유저 스크립트가 기대는 유일한 표면.**
 *
 * ━━ 왜 이 파일이 따로 있나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 유저는 라이브러리 **버전을 고정**한다. 우리가 내부를 고쳐도 그 유저는
 * 예전 버전에 머물 수 있고, 어느 날 버전을 올린다. 그때 `KM.parse.extract`
 * 같은 내부 경로를 직접 부르고 있었다면 이름 한 번 바꾼 걸로 남의 자동화가
 * 조용히 멈춘다.
 *
 * 그래서 내부(`KM.*`)와 공개 표면(여기)을 가른다.
 * **여기 있는 함수 이름과 인자는 계약이다.** 바꾸려면 버전을 올리고
 * 예전 이름도 한동안 같이 남겨야 한다.
 *
 * ━━ 어디에 붙나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   라이브러리 프로젝트 : core.gs + zipcrypto.gs + app.gs + 이 파일
 *   유저 프로젝트       : container.gs 하나 + 라이브러리 참조(kmoneylib)
 *
 * 개발 중에는 한 프로젝트에 전부 붙여넣어도 된다. container.gs 의
 * resolveLib_() 가 라이브러리와 전역 둘 다에서 찾으므로 코드가 갈라지지 않는다.
 */

/**
 * 파이프라인 본체(`app.gs` 의 KMApp).
 *
 * `var KMApp` 전역이 라이브러리 밖에서 보이는지는 문서로 확실하지 않다.
 * **함수는 확실히 노출된다.** 그래서 함수로도 열어 둔다 — 컨테이너는 둘 다
 * 시도한다. 확실하지 않은 것에 파이프라인 전체를 걸지 않는다.
 */
function getApp() {
  return KMApp;
}

/** 이 라이브러리의 버전. 유저가 최신인지 비교할 때 쓴다. */
function version() {
  return KM.VERSION;
}

/** 산출물 스키마. 소비자가 형식을 분기해야 할 때. */
function schema() {
  return KM.aggregate.SCHEMA;
}

/**
 * 암호 zip 해제. 실패하면 던진다 — 조용히 빈 배열을 주지 않는다.
 * @param {Blob} blob  zip
 * @param {string} password
 * @return {Blob[]}
 */
function unzip(blob, password) {
  return unzipEncrypted(blob, password);
}

/**
 * 시트 행 묶음 → 거래·잔고. 헤더가 다르면 던진다.
 * @param {Object} sheets  { '시트이름': rows }  — getDataRange().getValues() 결과
 */
function parseSheets(sheets) {
  return KM.parse.extract(sheets);
}

/**
 * 집계 → Drive 에 올릴 facts 객체.
 * @param {Object} extract  parseSheets 결과
 * @param {Object} opts     { asOf: 'YYYY-MM-DD' }
 *   개인화는 여기 안 실린다. `메모리/` 폴더의 마크다운으로 간다 —
 *   숫자와 사람 말을 섞지 않는다 (DECISIONS §2-A15).
 */
function buildFacts(extract, opts) {
  return KM.aggregate.build(extract, opts);
}

/**
 * 이전 산출물과의 차이. 이전 게 없으면 null.
 * 대화 한 세션은 지난 스냅샷을 볼 수 없고, 뱅샐은 1년치만 주므로
 * 우리가 쌓지 않으면 영구히 사라진다.
 */
function buildDelta(current, previous) {
  return KM.aggregate.delta(current, previous);
}
