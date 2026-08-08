/**
 * 시트 행 → 도메인 객체.
 *
 * 행(rows)은 어댑터가 공급한다. Apps Script 는 SpreadsheetApp 의 getValues(),
 * node 는 테스트 픽스처 JSON. 이 파일은 어디서 왔는지 모른다.
 *
 * ━━ 조용히 틀리느니 시끄럽게 죽는다 ━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 컬럼이 한 칸만 밀려도 금액 자리에서 화폐를 읽는다. 그래도 프로그램은
 * 멀쩡히 돌고 리포트만 틀린다. 그래서 헤더가 다르면 즉시 던진다.
 *
 * ━━ 이 시트에만 있는 함정 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. **합계가 전부 수식이다.** 총자산 =SUM(E40:E71), 순자산 =E72-I72.
 *    뱅샐이 만든 파일은 엑셀을 거친 적이 없어 계산된 값이 없다.
 *    → 합계 셀은 아예 읽지 않는다. 항상 직접 더한다.
 *
 * 2. **그룹명은 그룹의 첫 행에만 적힌다.** ('자유입출금 자산' 아래 계좌 10개)
 *    → 이어받지 않으면 계좌 대부분이 그룹 미상이 된다.
 *
 * 3. **투자성 자산 금액은 실수다** (189044.1941475332). → 원 단위로 반올림.
 *
 * 4. **행 길이가 들쭉날쭉하다.** 메모가 빈 행은 배열이 짧게 온다.
 *    → 직접 인덱싱하지 않고 cell() 로 감싼다.
 *
 * 5. **비원화 거래.** 화폐 컬럼을 읽어놓고 아무도 안 보면 USD 100 이
 *    100원으로 합산된다. → 원화가 아닌 건 따로 모아 집계에서 뺀다.
 */

var KM = (globalThis.KM = globalThis.KM || {});

KM.parse = (function () {
  'use strict';

  var M = KM.model;

  function SchemaMismatch(source, what, expected, actual) {
    var e = new Error(
      '[' + source + '] ' + what + ' 이(가) 예상과 다릅니다.\n' +
      '  예상: ' + JSON.stringify(expected) + '\n' +
      '  실제: ' + JSON.stringify(actual) + '\n' +
      '  → 앱이 내보내기 형식을 바꿨을 수 있습니다. layout.js 에 새 버전을 추가하세요.'
    );
    e.name = 'SchemaMismatch';
    e.detail = { source: source, what: what, expected: expected, actual: actual };
    return e;
  }

  function cell(row, i) {
    return row && i < row.length ? row[i] : null;
  }

  function text(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  /** 셀 → 원 단위 정수. 수식 문자열과 빈 칸은 null. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      var s = v.trim().replace(/,/g, '');
      if (!s || s.charAt(0) === '=') return null; // 수식 — 계산된 값이 없다 (함정 1)
      var n = Number(s);
      return isNaN(n) ? null : Math.round(n);
    }
    if (typeof v === 'number') return Math.round(v); // 실수로 오는 자산이 있다 (함정 3)
    return null;
  }

  /**
   * 날짜처럼 생겼는가.
   *
   * ⚠️ **`instanceof Date` 를 쓰면 안 된다.** 실측에서 이걸로 프로덕션이 깨졌다.
   *
   *    getValues() 가 만든 Date 는 **유저 스크립트 컨텍스트**의 것이고, 이 코드를
   *    라이브러리로 분리하면 **다른 컨텍스트**에서 돈다. instanceof 는 그 경계를
   *    넘지 못해 Date 가 Date 로 인식되지 않는다. 그러면 문자열 분기로 떨어져
   *    "Fri Apr 03 2026 …".slice(0,10) = "Fri Apr 03" 이 날짜가 되고,
   *    month() 가 "Fri Apr" 를 월로 잡아 **84개월짜리 산출물**이 나왔다.
   *    합계는 날짜와 무관해 멀쩡하므로 눈으로는 안 걸린다.
   *
   *    한 프로젝트에 다 넣고 테스트하면 절대 재현되지 않는다. 라이브러리로
   *    나눠야만 드러난다. → **모양으로 판별한다.**
   */
  function isDateLike(v) {
    return !!v && typeof v === 'object' &&
      typeof v.getFullYear === 'function' &&
      typeof v.getMonth === 'function' &&
      typeof v.getDate === 'function';
  }

  /**
   * 날짜 셀 → 'YYYY-MM-DD'.
   * Apps Script 는 Date 객체를, 픽스처 JSON 은 문자열을 준다.
   * UTC 변환을 거치면 하루가 밀 수 있어 로컬 연·월·일을 직접 읽는다.
   */
  function day(v) {
    if (isDateLike(v)) {
      var y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
      return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
    }
    var s = text(v);
    return s ? s.slice(0, 10) : '';
  }

  function findRow(rows, header, what, source) {
    for (var i = 0; i < rows.length; i++) {
      if (text(cell(rows[i], 1)) === header[0] && text(cell(rows[i], 2)) === header[1]) return i;
    }
    throw SchemaMismatch(source, what, header.join(' | ') + ' 헤더 행', '없음');
  }

  // ── 가계부 내역 ────────────────────────────────────────────────

  function ledger(rows, L) {
    if (!rows.length) throw SchemaMismatch(L.id, L.ledgerSheet, '헤더 1행 이상', '빈 시트');

    var header = [];
    for (var h = 0; h < L.ledgerHeader.length; h++) header.push(text(cell(rows[0], h)));
    for (var k = 0; k < L.ledgerHeader.length; k++) {
      if (header[k] !== L.ledgerHeader[k]) {
        throw SchemaMismatch(L.id, "'" + L.ledgerSheet + "' 헤더", L.ledgerHeader, header);
      }
    }

    var C = L.ledgerCols;
    var txns = [], foreign = [], unknown = {};

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var d = day(cell(r, C.day));
      if (!d) continue;

      var rawKind = text(cell(r, C.kind));
      var kind = L.kinds[rawKind];
      if (!kind) { unknown[rawKind] = true; continue; } // 넘겨짚지 않고 모아서 알린다

      var amount = num(cell(r, C.amount));
      if (amount === null) amount = 0;
      var currency = text(cell(r, C.currency)) || M.BASE_CURRENCY;

      var t = {
        day: d, kind: kind,
        major: text(cell(r, C.major)), minor: text(cell(r, C.minor)),
        desc: text(cell(r, C.desc)),
        amount: amount, currency: currency, method: text(cell(r, C.method)),
      };

      // 원화가 아닌 건 원화 합계에 섞지 않는다 (함정 5)
      if (currency !== M.BASE_CURRENCY) foreign.push(t);
      else txns.push(t);
    }

    var unknownKinds = Object.keys(unknown);
    if (unknownKinds.length) {
      throw SchemaMismatch(L.id, '거래 타입', Object.keys(L.kinds), unknownKinds);
    }
    return { txns: txns, foreign: foreign };
  }

  // ── 뱅샐현황 ───────────────────────────────────────────────────

  function profile(rows, L) {
    var r = rows[findRow(rows, L.profileHeader, '고객정보', L.id) + 1];
    var name = text(cell(r, L.profileCols.name));
    if (!name) {
      // 이름이 없으면 '이체 상대가 본인인가' 판정이 불가능하고,
      // 그 판정 위에 데이터 완결성 지표가 서 있다.
      throw SchemaMismatch(L.id, '고객정보의 이름', '계정 주인 이름', '비어 있음');
    }
    return { owner: name, age: num(cell(r, L.profileCols.age)) };
  }

  function balances(rows, L) {
    var C = L.balanceCols;
    var start = findRow(rows, L.balanceHeader, '재무현황', L.id) + 1;
    var holdings = [];
    var assetGroup = '', debtGroup = '';

    for (var i = start; i < rows.length; i++) {
      var r = rows[i];
      var label = text(cell(r, C.assetGroup));
      if (label.indexOf(L.balanceEnd) === 0) break; // 섹션 끝

      if (label) assetGroup = label; // 비어 있으면 위에서 이어받는다 (함정 2)
      var name = text(cell(r, C.assetName));
      var amount = num(cell(r, C.assetAmount));
      if (name && amount !== null) {
        holdings.push({
          bucket: L.buckets[assetGroup] || M.Bucket.OTHER,
          group: assetGroup, name: name, amount: amount,
        });
      }

      var dLabel = text(cell(r, C.debtGroup));
      if (dLabel && dLabel.indexOf(L.debtEnd) !== 0) debtGroup = dLabel;
      var dName = text(cell(r, C.debtName));
      var dAmount = num(cell(r, C.debtAmount));
      if (dName && dAmount !== null) {
        holdings.push({ bucket: M.Bucket.DEBT, group: debtGroup, name: dName, amount: dAmount });
      }
    }

    if (!holdings.length) throw SchemaMismatch(L.id, '재무현황', '자산 1건 이상', '0건');
    return holdings;
  }

  function investments(rows, L) {
    var C = L.investCols;
    var start = findRow(rows, L.investHeader, '투자현황', L.id) + 1;
    var out = [];

    for (var i = start; i < rows.length; i++) {
      var r = rows[i];
      var kind = text(cell(r, C.kind));
      if (kind.indexOf(L.investEnd) === 0) break;
      var name = text(cell(r, C.name));
      var principal = num(cell(r, C.principal));
      var value = num(cell(r, C.value));
      if (!name || principal === null || value === null) continue;
      // 수익률 컬럼은 읽지 않는다 — 원금이 0이면 뱅샐이 0을 넣는데
      // 그건 '본전'이 아니라 '계산 불가'다. model.roi 가 null 로 구분한다.
      out.push({
        kind: kind, broker: text(cell(r, C.broker)), name: name,
        principal: principal, value: value,
      });
    }
    return out;
  }

  /**
   * 전체 파싱. sheets 는 { '시트이름': rows } 형태.
   * 현황 시트는 없어도 된다 (가계부만 내보낸 경우) — 흐름 지표는 그래도 나온다.
   */
  function extract(sheets, L) {
    L = L || KM.layout.find(Object.keys(sheets));
    if (!L) {
      throw SchemaMismatch('unknown', '시트 구성', '알려진 출처의 시트', Object.keys(sheets));
    }

    var led = ledger(sheets[L.ledgerSheet] || [], L);
    var snapshot = null;
    var statusRows = sheets[L.statusSheet];
    if (statusRows && statusRows.length) {
      var p = profile(statusRows, L);
      snapshot = {
        owner: p.owner, age: p.age,
        holdings: balances(statusRows, L),
        investments: investments(statusRows, L),
      };
    }

    return {
      source: L.id + '/' + L.version,
      txns: led.txns,
      foreign: led.foreign,
      snapshot: snapshot,
    };
  }

  return {
    extract: extract, ledger: ledger, profile: profile,
    balances: balances, investments: investments,
    cell: cell, text: text, num: num, day: day, isDateLike: isDateLike,
    SchemaMismatch: SchemaMismatch,
  };
})();

if (typeof module !== 'undefined') module.exports = KM.parse;
