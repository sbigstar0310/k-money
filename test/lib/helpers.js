/**
 * 테스트용 시트 생성기.
 *
 * 실데이터(fixtures/)는 개인 금융 정보라 커밋할 수 없고, 커밋할 수 없는 것에
 * 테스트를 걸면 남이 못 돌린다. 그래서 **합성 데이터가 스펙**이고,
 * 실데이터는 있으면 돌리는 스모크 체크로만 쓴다.
 *
 * 여기서 만드는 행 배열은 Apps Script 의 getDataRange().getValues() 와
 * 같은 모양이다 — 그래서 이 테스트가 통과하면 거기서도 통과한다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** core 를 한 번만 로드해서 KM 을 돌려준다. */
function loadCore() {
  if (!globalThis.KM || !globalThis.KM.aggregate) {
    ['model', 'layout', 'analyze', 'parse', 'profile', 'aggregate'].forEach((m) => {
      require(path.join(ROOT, 'core', m + '.js'));
    });
  }
  return globalThis.KM;
}

/** Apps Script 에 올라갈 번들을 격리된 스코프에서 평가한다. */
function loadBundle() {
  const src = fs.readFileSync(path.join(ROOT, 'appsscript', 'core.gs'), 'utf8');
  const saved = globalThis.KM;
  globalThis.KM = undefined;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(src + '\nreturn globalThis.KM;')();
  } finally {
    globalThis.KM = saved;
  }
}

const LEDGER_HEADER = [
  '날짜', '시간', '타입', '대분류', '소분류', '내용', '금액', '화폐', '결제수단', '메모',
];

/**
 * 거래 목록 → '가계부 내역' 행.
 * t = { day, kind, amount, desc?, major?, minor?, currency?, method? }
 */
function ledgerSheet(txns) {
  // slice() 가 없으면 헤더를 바꾸는 테스트 하나가 모듈 상수를 오염시켜
  // 이후 모든 테스트를 무너뜨린다. 실제로 그렇게 됐었다.
  return [LEDGER_HEADER.slice()].concat(
    txns.map((t) => [
      t.day, '12:00:00', t.kind,
      t.major === undefined ? '식비' : t.major,
      t.minor === undefined ? '한식' : t.minor,
      t.desc === undefined ? '' : t.desc,
      t.amount,
      t.currency || 'KRW',
      t.method || '체크카드',
      '',
    ])
  );
}

/**
 * 잔고 → '뱅샐현황' 행.
 * opts = { owner, age, assets: [{group,name,amount}], debts: [...], investments: [...] }
 *
 * 컬럼 위치는 실측 레이아웃 그대로다 — 자산 B/C/E, 부채 F/G/I.
 */
function statusSheet(opts) {
  const o = opts || {};
  const row = (n) => new Array(n).fill(null);
  const rows = [];

  rows.push(['', '1.고객정보']);
  rows.push([null, '이름', '성별', '연령', '신용점수']);
  rows.push([null, o.owner || '홍길동', '남', o.age === undefined ? 25 : o.age, 750]);
  rows.push(row(2));

  rows.push([null, '3.재무현황']);
  rows.push([null, '항목', '상품명', null, '금액', '항목', '상품명', null, '금액']);

  // 실제 시트에는 자산이 최소 한 줄은 있다. 파서가 0건을 거부하는 게 맞으므로
  // (자산 섹션을 통째로 못 읽은 상황과 구분이 안 된다) 기본값을 채워 준다.
  const assets = o.assets || [{ group: '자유입출금 자산', name: '기본통장', amount: 0 }];
  const debts = o.debts || [];
  let lastGroup = null;
  let lastDebtGroup = null;
  const n = Math.max(assets.length, debts.length);
  for (let i = 0; i < n; i++) {
    const r = row(9);
    if (i < assets.length) {
      const a = assets[i];
      // 그룹명은 바뀔 때만 적는다 — 실제 시트가 그렇고, 이어받기(carry-forward)를 검증한다
      if (a.group !== lastGroup) { r[1] = a.group; lastGroup = a.group; }
      r[2] = a.name;
      r[4] = a.amount;
    }
    if (i < debts.length) {
      const d = debts[i];
      if (d.group !== lastDebtGroup) { r[5] = d.group; lastDebtGroup = d.group; }
      r[6] = d.name;
      r[8] = d.amount;
    }
    rows.push(r);
  }
  // 합계는 수식으로만 나온다. 읽으면 안 된다는 걸 검증하기 위해 그대로 넣는다.
  rows.push([null, '총자산', null, null, '=SUM(E7:E20)', '총부채', null, null, '=SUM(I7:I20)']);
  rows.push(row(2));

  rows.push([null, '5.투자현황']);
  rows.push([null, '투자상품종류', '금융사', '상품명', null, '투자원금', '평가금액', '수익률']);
  (o.investments || []).forEach((v) => {
    rows.push([null, v.kind || '주식', v.broker || '증권사', v.name, null, v.principal, v.value, 0]);
  });
  rows.push([null, '총계']);

  return rows;
}

/** 시트 묶음 하나 만들기. */
function sheets(txns, status) {
  const out = { '가계부 내역': ledgerSheet(txns) };
  if (status !== null) out['뱅샐현황'] = statusSheet(status || {});
  return out;
}

/** 지출 한 건 (뱅샐은 지출을 음수로 적는다). */
function expense(day, amount, extra) {
  return Object.assign({ day, kind: '지출', amount: -Math.abs(amount) }, extra || {});
}
function income(day, amount, extra) {
  return Object.assign({ day, kind: '수입', amount: Math.abs(amount) }, extra || {});
}
function transfer(day, amount, desc, extra) {
  return Object.assign({ day, kind: '이체', amount, desc }, extra || {});
}
/** 환불 — 타입은 '지출'인데 금액이 양수다. */
function refund(day, amount, extra) {
  return Object.assign({ day, kind: '지출', amount: Math.abs(amount) }, extra || {});
}

module.exports = {
  loadCore, loadBundle, sheets, ledgerSheet, statusSheet,
  expense, income, transfer, refund, LEDGER_HEADER, ROOT,
};
