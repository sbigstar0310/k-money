/**
 * 출처별 시트 레이아웃 — **형식이 바뀌면 고칠 곳은 여기 한 파일이다.**
 *
 * parse.js 에는 시트 이름도 컬럼 번호도 없다. 전부 여기 있다.
 * 뱅샐이 컬럼을 바꾸면 새 버전을 만들어 LAYOUTS 에 추가하면 되고,
 * 파싱 로직과 집계는 손대지 않는다.
 *
 * 컬럼 번호는 0부터 센다 (엑셀 A열 = 0).
 * 섹션은 행 번호가 아니라 **헤더 시그니처**로 찾는다 — 뱅샐이 섹션을 하나
 * 추가하면 행 번호는 전부 밀리지만 헤더 문구는 남기 때문이다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.layout = (function () {
  'use strict';

  var B = KM.model.Bucket;
  var K = KM.model.Kind;

  var BANKSALAD_V1 = {
    id: 'banksalad',
    label: '뱅크샐러드',
    version: 'v1',

    ledgerSheet: '가계부 내역',
    ledgerHeader: ['날짜', '시간', '타입', '대분류', '소분류', '내용', '금액', '화폐', '결제수단', '메모'],
    ledgerCols: { day: 0, kind: 2, major: 3, minor: 4, desc: 5, amount: 6, currency: 7, method: 8 },

    statusSheet: '뱅샐현황',
    // [B열 문구, C열 문구] 로 섹션 헤더를 찾는다
    profileHeader: ['이름', '성별'],
    balanceHeader: ['항목', '상품명'],
    investHeader: ['투자상품종류', '금융사'],
    profileCols: { name: 1, age: 3 },
    balanceCols: {
      assetGroup: 1, assetName: 2, assetAmount: 4,
      debtGroup: 5, debtName: 6, debtAmount: 8,
    },
    investCols: { kind: 1, broker: 2, name: 3, principal: 5, value: 6 },
    balanceEnd: '총자산',
    debtEnd: '총부채',
    investEnd: '총계',

    // 출처의 어휘를 우리 어휘로. 다른 앱을 붙일 때도 같은 자리에 자기 표를 둔다.
    kinds: { '수입': K.INCOME, '지출': K.EXPENSE, '이체': K.TRANSFER },
    buckets: {
      '자유입출금 자산': B.CASH,
      '현금 자산': B.CASH,
      '전자금융 자산': B.CASH, // 페이 머니도 즉시 쓸 수 있는 돈이다
      '저축성 자산': B.SAVINGS,
      '투자성 자산': B.INVESTMENT,
      '신탁 자산': B.INVESTMENT,
      '부동산': B.PROPERTY,
      '동산': B.PROPERTY,
      '기타 실물 자산': B.PROPERTY,
      '보험 자산': B.INSURANCE,
      '연금 자산': B.PENSION,
    },
  };

  var LAYOUTS = [BANKSALAD_V1];

  /** 시트 이름만 보고 후보를 고른다. 컬럼 검증은 parse 가 엄격하게 한다. */
  function find(sheetNames) {
    for (var i = 0; i < LAYOUTS.length; i++) {
      if (sheetNames.indexOf(LAYOUTS[i].ledgerSheet) >= 0) return LAYOUTS[i];
    }
    return null;
  }

  return { LAYOUTS: LAYOUTS, BANKSALAD_V1: BANKSALAD_V1, find: find };
})();

if (typeof module !== 'undefined') module.exports = KM.layout;
