/**
 * tick — 1분마다 도는 트리거의 스펙. **구현보다 먼저 쓴다.**
 *
 * ━━ 왜 1분인가, 그리고 왜 그게 위험한가 ━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 하루 한 번(오전 7시)이면 유저가 내보내기를 눌러도 다음 날 아침까지 AI 가
 * 옛 숫자를 읽는다. 1분마다 보면 그 틈이 사라진다. 대신 **하루 1440번**
 * 돈다. Apps Script 트리거 실행 시간 한도는 하루 90분이고, 파이프라인 한
 * 번이 14초쯤이다 — 매번 다 돌면 1440 × 14초 = 5.6시간, 한도의 네 배다.
 *
 * 그래서 이 파일이 못 박는 건 거의 다 **"아무것도 안 하는 경로"** 다.
 *   - 새 메일이 없으면 드라이브에 한 글자도 안 쓴다 (수정시각도 안 흔든다)
 *   - 실패한 메일을 매분 다시 붙잡지 않는다 (틀린 비밀번호 = 매분 14초)
 *   - 하루 한 번은 여전히 상태를 남긴다 (데이터가 멈춘 걸 알리는 자리다)
 *
 * app.test.js 의 가짜와 다른 점: 여기 드라이브는 **파일마다 id 가 있고 쓰기를
 * 전부 기록한다.** "안 썼다" 를 증명하려면 쓰기가 한 군데로 모여야 하고,
 * 거래내역 시트를 옮기고 지우는 순서를 보려면 id 로 파일을 따라가야 한다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const H = require('./lib/helpers');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'appsscript', 'app.gs'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'appsscript', 'core.gs'), 'utf8');

// ⚠️ 스크립트 속성 이름은 **버전을 넘어 살아남는 계약**이다. 유저 프로젝트에
//    한 번 저장되면 라이브러리를 갈아끼워도 남는다. 그래서 PROP 의 키가
//    아니라 저장되는 문자열 자체로 본다.
const LAST_MESSAGE_ID = 'LAST_MESSAGE_ID';
const LAST_FAILED_MESSAGE_ID = 'LAST_FAILED_MESSAGE_ID';
const LEDGER_NAME = '돈동생-거래내역';
const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
const TMP_PREFIX = 'k-money-tmp-';

// ── 시간 ──────────────────────────────────────────────────────────

/** 한국 시각으로 적은 순간. 'YYYY-MM-DD HH:mm' */
function kst(s) {
  return new Date(s.replace(' ', 'T') + ':00+09:00');
}

// 07:00 전이면 하루 정리(T5)가 끼어들 수 없다. "안 썼다" 를 보는 테스트는
// 전부 이 시각에 돌린다 — 정리가 쓴 것을 idle 이 쓴 것으로 오해하지 않게.
const EARLY = kst('2026-09-26 06:30');

/**
 * 시간대를 **진짜로** 따르는 formatDate.
 *
 * ⚠️ app.test.js 의 것은 tz 를 무시하고 호스트 시각을 쓴다. 거기선 날짜만
 *    보니 괜찮지만, tick 은 "한국 시각 07:00 이 지났나" 를 봐야 한다.
 *    호스트가 UTC 인 CI 에서 9시간 어긋난 채 초록불이 켜지면 안 된다.
 */
function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  const map = {
    yyyy: parts.year, MM: parts.month, dd: parts.day,
    HH: parts.hour, H: String(Number(parts.hour)), mm: parts.minute, ss: parts.second,
  };
  const out = fmt.replace(/yyyy|MM|dd|HH|H|mm|ss/g, (t) => map[t]);
  if (/[A-Za-z]/.test(out.replace(/'[^']*'/g, '').replace(/T/g, ''))) {
    throw new Error('가짜 formatDate 가 모르는 형식이다 (테스트 쪽을 늘려라): ' + fmt);
  }
  return out;
}

// ── 가짜 Blob ─────────────────────────────────────────────────────

function fakeBlob(name, content) {
  let n = name;
  return {
    getName: () => n,
    setName(x) { n = x; return this; },
    getDataAsString: () => content,
    getBytes: () => Buffer.from(String(content), 'utf8'),
    getBlob() { return this; },
    copyBlob() { return fakeBlob(n, content); },
    getContentType: () => 'application/octet-stream',
    _content: () => content,
  };
}

// ── 가짜 Drive (DriveApp + Drive 고급 서비스) ─────────────────────

/**
 * 하나의 드라이브를 두 창구로 본다. 코드가 DriveApp 으로 만들고 고급
 * 서비스로 옮기든, 그 반대든 같은 파일이어야 한다.
 *
 * - 모든 쓰기는 `writes` 에 한 줄씩 남는다. 폴더 만들기도 쓰기다 — 새
 *   유저 드라이브에 빈 '돈동생' 폴더가 생기는 것도 흔적이다.
 * - 휴지통은 지우지 않고 표시만 한다. 무엇이 언제 버려졌는지 봐야 한다.
 * - 영구 삭제(Files.remove)는 따로 표시한다 — 거래내역은 **휴지통**으로
 *   가야 되돌릴 수 있다.
 */
function fakeDrive() {
  const writes = [];
  const byId = new Map();
  const onTrash = [];
  let seq = 0;

  const iter = (arr) => {
    let i = 0;
    return { hasNext: () => i < arr.length, next: () => arr[i++] };
  };
  const live = (x) => !x.trashed && !x.removed;
  const children = (parent, kind) =>
    Array.from(byId.values()).filter((x) => x.kind === kind && x.parent === parent && live(x));

  function write(op, detail) { writes.push(Object.assign({ op }, detail)); }

  function trash(node, how) {
    // 순서를 보려고 **버리기 직전**에 훅을 부른다 (T6).
    onTrash.forEach((fn) => fn(node));
    if (how === 'remove') node.removed = true; else node.trashed = true;
    write(how === 'remove' ? 'remove' : 'trash', { id: node.id, name: node.name });
  }

  function makeFolder(name, parent) {
    const node = { kind: 'folder', id: 'fo-' + (++seq), name, parent, trashed: false };
    const self = {
      _node: node, _name: name,
      getId: () => node.id,
      getName: () => node.name,
      getFoldersByName: (n) => iter(children(node, 'folder').filter((f) => f.name === n).map((f) => f.api)),
      getFolders: () => iter(children(node, 'folder').map((f) => f.api)),
      getFilesByName: (n) => iter(children(node, 'file').filter((f) => f.name === n).map((f) => f.api)),
      getFiles: () => iter(children(node, 'file').map((f) => f.api)),
      getFilesByType: (m) => iter(children(node, 'file').filter((f) => f.mimeType === m).map((f) => f.api)),
      createFolder(n) {
        write('createFolder', { name: n });
        return makeFolder(n, node);
      },
      createFile(blob) {
        const content = blob.getDataAsString ? blob.getDataAsString() : '';
        write('createFile', { name: blob.getName() });
        return makeFile({ name: blob.getName(), content, parent: node, mimeType: 'application/octet-stream' });
      },
      addFile(file) { write('move', { id: file.getId() }); byId.get(file.getId()).parent = node; return self; },
      removeFile() { return self; },
      setTrashed(t) { if (t) trash(node); return self; },
      isTrashed: () => node.trashed,
    };
    node.api = self;
    byId.set(node.id, node);
    return self;
  }

  /** 쓰기 기록 없이 파일을 놓는다 — 테스트 준비용. */
  function makeFile({ name, content, parent, mimeType, source }) {
    const node = {
      kind: 'file', id: 'fi-' + (++seq), name, parent, mimeType,
      content: content === undefined ? '' : content,
      // 네이티브 시트가 **어느 xlsx 에서 변환됐는지.** 우리가 집계한 그
      // 데이터가 남는지 보려고 붙잡아 둔다.
      source: source === undefined ? null : source,
      trashed: false, removed: false,
    };
    const self = {
      _node: node,
      getId: () => node.id,
      getName: () => node.name,
      getMimeType: () => node.mimeType,
      getBlob: () => fakeBlob(node.name, node.content),
      getSize: () => Buffer.byteLength(String(node.content), 'utf8'),
      getDateCreated: () => new Date(0),
      getParents: () => iter(node.parent ? [node.parent.api] : []),
      isTrashed: () => node.trashed,
      setName(n) { write('rename', { id: node.id, from: node.name, to: n }); node.name = n; return self; },
      setContent(c) { write('setContent', { id: node.id, name: node.name }); node.content = c; return self; },
      setTrashed(t) { if (t) trash(node); else node.trashed = false; return self; },
      moveTo(dest) { write('move', { id: node.id, to: dest.getName() }); node.parent = dest._node; return self; },
      makeCopy(n, dest) {
        write('copy', { id: node.id });
        return makeFile({ name: n || node.name, content: node.content, mimeType: node.mimeType,
          source: node.source, parent: dest ? dest._node : node.parent }).api;
      },
    };
    node.api = self;
    byId.set(node.id, node);
    return self;
  }

  const rootApi = makeFolder('내 드라이브', null);
  const root = rootApi._node;

  const need = (id) => {
    const n = byId.get(id);
    if (!n || n.removed) throw new Error('File not found: ' + id);
    return n;
  };
  const folderOf = (id) => (id ? need(id) : root);
  // md5Checksum 은 드라이브가 **구글 문서가 아닌 파일에만** 준다. 진짜처럼.
  const meta = (n) => Object.assign({ id: n.id, name: n.name, mimeType: n.mimeType, trashed: n.trashed,
    parents: n.parent ? [n.parent.id] : [] },
    n.mimeType === SHEETS_MIME ? {} : { md5Checksum: md5(n.content) });

  /** Files.list 의 q 중 우리가 쓸 법한 것만. 모르는 조건은 조용히 무시하지 않는다. */
  function query(q) {
    const clauses = String(q || '').split(/\s+and\s+/i).filter(Boolean);
    return Array.from(byId.values()).filter((n) => n.kind === 'file' && !n.removed).filter((n) =>
      clauses.every((c) => {
        let m;
        if ((m = /^name\s*=\s*'(.*)'$/.exec(c))) return n.name === m[1];
        if ((m = /^name\s+contains\s+'(.*)'$/.exec(c))) return n.name.indexOf(m[1]) !== -1;
        if ((m = /^mimeType\s*=\s*'(.*)'$/.exec(c))) return n.mimeType === m[1];
        if ((m = /^'(.*)'\s+in\s+parents$/.exec(c))) return !!n.parent && n.parent.id === m[1];
        if ((m = /^trashed\s*=\s*(true|false)$/.exec(c))) return String(n.trashed) === m[1];
        throw new Error('가짜 Files.list 가 모르는 q 조건이다 (테스트 쪽을 늘려라): ' + c);
      }));
  }

  const app = Object.assign(rootApi, {
    getRootFolder: () => rootApi,
    getFileById: (id) => need(id).api,
    getFolderById: (id) => need(id).api,
  });

  const api = {
    Files: {
      create(resource, blob) {
        const r = resource || {};
        const parent = folderOf(r.parents && r.parents[0]);
        write('Files.create', { name: r.name });
        const f = makeFile({
          name: r.name || (blob && blob.getName()) || 'untitled',
          content: r.mimeType === SHEETS_MIME ? '' : (blob ? blob.getDataAsString() : ''),
          mimeType: r.mimeType || 'application/octet-stream',
          source: blob ? blob.getDataAsString() : null,
          parent,
        });
        return meta(f._node);
      },
      update(resource, fileId, blob, opts) {
        const n = need(fileId);
        const r = resource || {};
        const o = opts || {};
        write('Files.update', { id: fileId, resource: r, opts: o });
        if (o.addParents) n.parent = folderOf(String(o.addParents).split(',')[0]);
        if (r.name !== undefined) n.name = r.name;
        if (r.trashed === true) trash(n);
        return meta(n);
      },
      copy(resource, fileId) {
        const n = need(fileId);
        const r = resource || {};
        write('Files.copy', { id: fileId });
        const f = makeFile({ name: r.name || n.name, content: n.content, mimeType: n.mimeType,
          source: n.source, parent: r.parents ? folderOf(r.parents[0]) : n.parent });
        return meta(f._node);
      },
      get: (fileId) => meta(need(fileId)),
      remove(fileId) { trash(need(fileId), 'remove'); },
      list(opts) { return { files: query(opts && opts.q).map(meta) }; },
    },
  };
  api.Files.delete = api.Files.remove;

  return {
    app, api, writes, byId, onTrash, makeFile, makeFolder,
    /** 살아 있는 모든 파일. */
    liveFiles: () => Array.from(byId.values()).filter((n) => n.kind === 'file' && live(n)),
    folder(name, parentApi) {
      const p = parentApi ? parentApi._node : root;
      return children(p, 'folder').filter((f) => f.name === name).map((f) => f.api)[0] || null;
    },
  };
}

// ── 세계 하나 ─────────────────────────────────────────────────────

function propsStub(map) {
  const m = map || {};
  return {
    _map: m,
    getProperty: (k) => (k in m ? m[k] : null),
    setProperty(k, v) { m[k] = String(v); return this; },
    deleteProperty(k) { delete m[k]; return this; },
  };
}

/** 뱅샐 메일 한 통. 첨부 내용에 id 를 넣어 메일마다 zip 이 다르게 한다. */
function fakeMessage(id, date) {
  return {
    getId: () => id,
    getDate: () => date,
    getSubject: () => '뱅크샐러드 내보내기',
    getAttachments: () => [fakeBlob('banksalad.zip', 'zip-' + id)],
  };
}

const GOOD_SHEETS = (lastDay) => ({
  '가계부 내역': H.ledgerSheet([
    { day: '2026-05-01', kind: '지출', amount: 10000 },
    { day: lastDay || '2026-06-10', kind: '수입', amount: 2000000 },
  ]),
  '뱅샐현황': H.statusSheet({ owner: '홍길동' }),
});

/**
 * 테스트 하나가 쓰는 전부. `w.mails`, `w.sheetData`, `w.now`, `w.unzip` 을
 * 바꿔 가며 tick 을 여러 번 부른다 — 1분마다 도는 것의 스펙이라 한 번만
 * 부르는 테스트로는 아무것도 못 본다.
 */
function world(opts) {
  const o = opts || {};
  const drive = fakeDrive();
  const w = {
    drive,
    mails: o.mails || [],
    sheetData: o.sheetData || GOOD_SHEETS(),
    now: o.now || EARLY,
    unzipCalls: 0,
    // 기본은 성공. 틀린 비밀번호는 이걸 던지게 바꾼다.
    unzip: o.unzip || ((blob) => [fakeBlob('가계부.xlsx', 'xlsx-of-' + blob.getDataAsString())]),
    gmailSearches: 0,
    sheetOpens: 0,
    cells: [],
    lock: null,
    tabOrders: {},
    display: null,
    noDisplay: false,
  };

  w.lock = {
    free: o.lockFree === undefined ? true : o.lockFree,
    tries: 0, releases: 0,
    tryLock() { this.tries++; return this.free; },
    waitLock() { this.tries++; if (!this.free) throw new Error('lock timeout'); },
    releaseLock() { this.releases++; },
    hasLock() { return this.free; },
  };

  const sheetTab = { getRange: (a) => ({ setValue(v) { w.cells.push([a, v]); } }) };

  w.env = {
    props: propsStub(Object.assign({ BANKSALAD_ZIP_PASSWORD: '0930' }, o.props)),
    lock: w.lock,
    gmail: {
      search: () => {
        w.gmailSearches++;
        return w.mails.length ? [{ getMessages: () => w.mails.slice() }] : [];
      },
    },
    drive: drive.app,
    driveApi: drive.api,
    sheets: {
      openById(id) {
        w.sheetOpens++;
        // 없는 id 를 열면 진짜처럼 던진다 — 치운 임시 시트를 다시 여는 버그를 잡는다.
        drive.app.getFileById(id);
        if (w.onOpen) w.onOpen(id);
        const data = w.sheetData;
        // 탭 순서는 **스프레드시트마다** 따로 든다. 거래내역으로 남은 그 시트의
        // 첫 탭이 무엇인지 봐야 한다 (커넥터 미리보기는 첫 탭을 읽는다).
        if (!w.tabOrders[id]) w.tabOrders[id] = Object.keys(data);
        const order = w.tabOrders[id];
        let active = null;
        const tab = (n) => ({
          getName: () => n,
          getIndex: () => order.indexOf(n) + 1,
          getDataRange: () => ({ getValues: () => data[n] }),
          // 화면에 보이는 글자. 따로 안 주면 문자열 셀은 그대로 보인다.
          getRange: (row, col, rows, cols) => ({
            getDisplayValues() {
              if (w.noDisplay) throw new Error('getDisplayValues 를 못 쓰는 세계');
              const shown = w.display && w.display[n];
              return data[n].slice(row - 1, row - 1 + rows).map((r, i) =>
                r.slice(col - 1, col - 1 + cols).map((v, j) =>
                  shown && j === 0 && col === 2 ? shown[row - 1 + i] : (typeof v === 'string' ? v : String(v))));
            },
          }),
        });
        return {
          getSheets: () => order.map(tab),
          getSheetByName: (n) => (order.indexOf(n) === -1 ? null : tab(n)),
          setActiveSheet(sh) { active = sh.getName(); return sh; },
          moveActiveSheet(pos) {
            const i = order.indexOf(active);
            order.splice(i, 1);
            order.splice(pos - 1, 0, active);
          },
        };
      },
    },
    // 컨테이너에 붙은 시트. 상태 칸(B10·B11)에 무엇이 언제 써지는지 본다.
    ss: { getSheetByName: () => sheetTab, getSheets: () => [sheetTab] },
    ui: null,
    tz: 'Asia/Seoul',
    containerVersion: '0.1.1',
    now: () => w.now,
  };

  w.A = loadApp({
    unzipEncrypted(blob, pw) { w.unzipCalls++; return w.unzip(blob, pw); },
  });

  /** 지금까지의 쓰기 수. `w.writesSince(mark)` 로 한 tick 이 쓴 것만 본다. */
  w.mark = () => ({ drive: drive.writes.length, cells: w.cells.length });
  w.writesSince = (m) => ({
    drive: drive.writes.slice(m.drive),
    cells: w.cells.slice(m.cells),
  });
  w.home = () => drive.folder(w.A.CFG.folderName);
  w.raw = () => (w.home() ? drive.folder(w.A.CFG.rawFolderName, w.home()) : null);
  w.status = () => {
    const home = w.home();
    const f = home && home.getFilesByName(w.A.CFG.statusName);
    return f && f.hasNext() ? JSON.parse(f.next().getBlob().getDataAsString()) : null;
  };
  /** 돈동생 폴더 안의 살아 있는 거래내역 시트들. 하나여야 한다. */
  w.ledgers = () => drive.liveFiles().filter((n) => n.name === LEDGER_NAME);
  w.tmps = () => drive.liveFiles().filter((n) => n.name.indexOf(TMP_PREFIX) === 0);
  w.prop = (k) => w.env.props.getProperty(k);
  return w;
}

function loadApp(extra) {
  const ctx = vm.createContext(Object.assign({
    Utilities: {
      formatDate,
      newBlob(content, type, name) { return fakeBlob(name, content); },
      // Apps Script 처럼 **부호 있는 바이트**로 준다 (-128..127).
      computeDigest(alg, s, charset) {
        assert.equal(alg, 'MD5');
        assert.equal(charset, 'UTF_8');
        return Array.from(crypto.createHash('md5').update(String(s), 'utf8').digest())
          .map((b) => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
    },
    Logger: { log() {} }, console,
    unzipEncrypted() { throw new Error('테스트에서 지정하지 않았다'); },
  }, extra));
  vm.runInContext(CORE, ctx);
  vm.runInContext(SRC, ctx);
  return ctx.KMApp;
}

/**
 * tick 을 부른다. **아직 없으면 그 사실을 그대로 말한다** — TypeError
 * 'is not a function' 으로 떨어지면 가짜가 틀렸는지 구현이 없는지 모른다.
 */
function tick(w) {
  assert.equal(typeof w.A.tick, 'function', '미구현: KMApp.tick(env) 이 아직 없다');
  return w.A.tick(w.env);
}

function requireTick(w) {
  assert.equal(typeof w.A.tick, 'function', '미구현: KMApp.tick(env) 이 아직 없다');
}

/** 던져도 되고 실패로 돌려줘도 되는 자리. 어느 쪽이든 결과를 모은다. */
function attempt(fn) {
  try { return fn(); } catch (e) { return { threw: e, ok: false }; }
}

function assertNoWrites(w, m, why) {
  const d = w.writesSince(m);
  assert.deepEqual(d.drive.map((x) => x.op + ':' + (x.name || x.id || '')), [],
    why + ' — 드라이브에 썼다');
  assert.deepEqual(d.cells, [], why + ' — 시트 상태 칸을 건드렸다');
}

// ── 0. 가짜가 멀쩡한가 ────────────────────────────────────────────

test('가짜 세계 — 지금 코드의 runForced 가 이 가짜로 끝까지 돈다', () => {
  // 아래 테스트들이 빨간 이유가 "tick 이 없어서" 여야 한다. 가짜가 틀려서
  // 빨간 거면 스펙이 아니라 소음이다. 그래서 이미 있는 경로로 먼저 확인한다.
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))] });
  const r = w.A.runForced(w.env);
  assert.equal(r.step, 'done', r.message);
  assert.ok(w.status(), '상태 파일이 없다');
  assert.ok(w.raw()._node, 'raw 폴더가 없다');
  assert.deepEqual(w.tmps().map((n) => n.name), [], '지금 코드도 임시 시트를 치운다');
});

// ── T1. 새 메일이 없으면 아무것도 쓰지 않는다 ──────────────────────

test('tick — 가장 최근 메일이 이미 처리한 것이면 idle, 드라이브도 시트도 안 건드린다', () => {
  // ⚠️ 1분마다 돈다. 여기서 상태 파일 하나만 덮어도 하루 1440번 수정시각이
  //    흔들리고, 커넥터가 폴더를 "방금 바뀐 것" 으로 읽는다. idle 은 진짜로
  //    아무 일도 없어야 한다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    props: { [LAST_MESSAGE_ID]: 'm1' },
  });
  const m = w.mark();
  const r = tick(w);
  assert.equal(r.ok, true);
  assert.equal(r.step, 'idle', '이미 처리한 메일인데 idle 이 아니다: ' + r.step);
  assertNoWrites(w, m, 'idle');
  assert.equal(w.sheetOpens, 0, 'idle 인데 시트를 열었다 — 파이프라인이 돌았다');
  assert.equal(w.unzipCalls, 0, 'idle 인데 압축을 풀었다');
  assert.equal(w.status(), null, 'idle 인데 writeStatus 가 불렸다');
  // 잠금은 잡는다 — 수동 실행과 겹쳐서 반쯤 쓴 상태를 읽으면 안 된다.
  assert.ok(w.lock.tries >= 1, '잠금을 안 잡았다');
  assert.equal(w.lock.releases, w.lock.tries, '잠금을 안 풀었다');
});

// ── T8. 메일이 아예 없어도 조용하다 ───────────────────────────────

test('tick — 메일도 처리 기록도 없으면 idle 이고 아무것도 안 쓴다', () => {
  // 설치 직후, 아직 한 번도 내보내지 않은 사람. 지금 runDaily 는 이걸
  // '새 메일 없음' 으로 **상태 파일에 적는다** — 하루 한 번이면 괜찮지만
  // 매분이면 설치만 해 둔 사람의 드라이브가 하루 1440번 바뀐다.
  const w = world({ mails: [] });
  const m = w.mark();
  const r = tick(w);
  assert.equal(r.ok, true, '메일이 없는 건 실패가 아니다');
  assert.equal(r.step, 'idle');
  assertNoWrites(w, m, '메일 없음');
  assert.equal(w.home(), null, '빈 돈동생 폴더를 만들었다');
});

// ── T2. 새 메일이면 끝까지 돈다 ───────────────────────────────────

test('tick — 새 메일이면 runDaily 와 같은 결과를 내고, 성공한 뒤에야 처리 기록을 남긴다', () => {
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    props: { [LAST_MESSAGE_ID]: 'm0' },
  });
  // ⚠️ **기록을 먼저 남기면 안 된다.** 집계 중에 죽으면(6분 초과, 드라이브
  //    오류) 기록만 남고 다음 tick 이 "이미 처리했다" 며 넘어간다 — 그 메일은
  //    영영 처리되지 않는다. 파이프라인 한가운데서 들여다본다.
  let midRun = 'not-reached';
  w.onOpen = () => { midRun = w.prop(LAST_MESSAGE_ID); };

  const r = tick(w);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.step, 'done', r.message);
  assert.notEqual(midRun, 'not-reached', '파이프라인이 시트를 안 열었다');
  assert.notEqual(midRun, 'm1', '집계가 끝나기 전에 처리 기록을 남겼다');
  assert.equal(w.prop(LAST_MESSAGE_ID), 'm1', '성공했는데 처리 기록을 안 남겼다');

  // runDaily 와 같은 산출물.
  const home = w.home();
  assert.ok(home.getFilesByName(w.A.CFG.latestName).hasNext(), '최신본이 없다');
  assert.equal(w.status().step, 'done', '상태 파일에 결과가 안 남았다');
  assert.equal(w.prop('LAST_INGEST_DATE'), '2026-06-10');

  // 그리고 바로 다음 분에는 조용하다.
  const m = w.mark();
  const again = tick(w);
  assert.equal(again.step, 'idle');
  assertNoWrites(w, m, '처리 직후의 다음 tick');
});

// ── T3. 실패한 메일을 매분 다시 붙잡지 않는다 ──────────────────────

test('tick — 비밀번호가 틀린 메일은 한 번 실패를 남기고, 같은 메일이면 다시 안 푼다', () => {
  // ⚠️ 틀린 비밀번호는 유저가 고치기 전까지 **계속** 틀린다. 매분 다시 풀면
  //    14초 × 1440 = 하루 5.6시간 — 트리거 한도 90분을 한낮 전에 다 쓰고,
  //    그다음부터는 **맞는 메일이 와도** 안 돈다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    unzip: () => { throw new Error('bad password'); },
  });
  requireTick(w);   // attempt 가 '미구현' 을 삼키지 않게 먼저 본다

  const first = attempt(() => tick(w));
  assert.equal(first.ok, false);
  assert.equal(first.step, 'decrypt', '첫 번째는 실제로 풀어 보고 실패해야 한다');
  assert.equal(w.unzipCalls, 1);
  assert.equal(w.prop(LAST_FAILED_MESSAGE_ID), 'm1', '실패한 메일을 기록하지 않았다');
  assert.notEqual(w.prop(LAST_MESSAGE_ID), 'm1', '실패했는데 처리한 것으로 적었다');
  // 유저는 이 실패를 봐야 한다 — 한 번은 상태에 남는다.
  assert.equal(w.status() && w.status().ok, false, '실패를 상태 파일에 안 남겼다');

  for (let i = 0; i < 3; i++) {
    const m = w.mark();
    const r = tick(w);
    assert.equal(r.step, 'waiting', '같은 실패 메일인데 ' + r.step + ' 로 답했다');
    assertNoWrites(w, m, '실패 대기 중인 tick');
  }
  assert.equal(w.unzipCalls, 1, '같은 메일을 매분 다시 풀고 있다');
});

test('tick — 시트 모양이 안 맞아 던진 메일도 매분 다시 안 돌린다', () => {
  // 뱅샐이 양식을 바꾸면 우리가 라이브러리를 고칠 때까지 계속 던진다.
  // 비밀번호와 같은 문제다 — 원인이 유저 쪽이든 우리 쪽이든 다음 분에 저절로
  // 낫지 않는다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: { '엉뚱한 시트': [['a', 'b']] },
  });
  requireTick(w);
  const first = attempt(() => w.A.tick(w.env));
  assert.equal(first.ok, false, '모양이 안 맞는데 성공했다');
  assert.equal(w.sheetOpens, 1, '첫 번째는 실제로 시트를 열어 봐야 한다');
  assert.equal(w.prop(LAST_FAILED_MESSAGE_ID), 'm1', '던진 실패를 기록하지 않았다');
  assert.equal(w.status() && w.status().ok, false, '실패를 상태 파일에 안 남겼다');

  const m = w.mark();
  const r = tick(w);
  assert.equal(r.step, 'waiting');
  assert.equal(w.sheetOpens, 1, '같은 메일로 파이프라인을 다시 돌렸다');
  assertNoWrites(w, m, '실패 대기 중인 tick');
});

test('tick — 다른 새 메일이 오면 실패 기록과 상관없이 다시 돈다', () => {
  // 유저가 비밀번호를 맞춰 **다시 내보내는 것**이 가장 흔한 복구 경로다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    unzip: () => { throw new Error('bad password'); },
  });
  requireTick(w);
  attempt(() => tick(w));
  assert.equal(w.prop(LAST_FAILED_MESSAGE_ID), 'm1');

  w.unzip = (blob) => [fakeBlob('가계부.xlsx', 'xlsx-of-' + blob.getDataAsString())];
  w.mails.push(fakeMessage('m2', kst('2026-06-12 09:00')));
  const r = tick(w);
  assert.equal(r.step, 'done', '새 메일인데 대기 상태에 갇혔다: ' + r.step);
  assert.equal(w.unzipCalls, 2);
  assert.equal(w.prop(LAST_MESSAGE_ID), 'm2');
});

test('tick — 두 tick 사이에 메일이 둘 오면 가장 최근 것 하나만 처리한다 (앞의 것을 놓치는 게 아니다)', () => {
  // 1분 안에 두 번 내보내도 앞 메일을 따로 처리할 이유가 없다. 처리는 언제나
  // 가장 최근 zip 하나이고(findAttachment), 앞 메일을 뒤늦게 처리하면 그게
  // 바로 과거로 걸어가는 버그다. 열쇠는 "바뀌었나" 만 알면 된다 — 몇 통이
  // 왔는지 셀 필요가 없어서 맨 위 하나로 충분하다.
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))] });
  requireTick(w);
  tick(w);
  assert.equal(w.prop(LAST_MESSAGE_ID), 'm1');

  const seen = [];
  w.unzip = (blob) => { seen.push(blob.getDataAsString()); return [fakeBlob('가계부.xlsx', 'xlsx-of-' + blob.getDataAsString())]; };
  w.mails.push(fakeMessage('m2', kst('2026-06-12 09:00')));
  w.mails.push(fakeMessage('m3', kst('2026-06-12 09:01')));

  const r = tick(w);
  assert.equal(r.step, 'done');
  assert.deepEqual(seen, ['zip-m3'], '가장 최근 메일 하나만 풀어야 한다');
  assert.equal(w.prop(LAST_MESSAGE_ID), 'm3');

  const m = w.mark();
  assert.equal(tick(w).step, 'idle', 'm2 를 뒤늦게 처리하러 가면 과거로 걷는다');
  assertNoWrites(w, m, '두 번째 tick');
});

test('tick — 손으로 돌리면(runForced) 실패한 같은 메일도 다시 본다', () => {
  // 비밀번호만 고치고 메일은 그대로인 경우. 메뉴의 "비밀번호 다시 넣기" 다음에
  // "지금 한 번 돌리기" 가 대기를 뚫어야 한다 — 아니면 유저는 뱅샐에서
  // 다시 내보내는 수밖에 없다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    unzip: () => { throw new Error('bad password'); },
  });
  requireTick(w);
  attempt(() => tick(w));
  assert.equal(tick(w).step, 'waiting');
  assert.equal(w.unzipCalls, 1);

  w.unzip = (blob) => [fakeBlob('가계부.xlsx', 'xlsx-of-' + blob.getDataAsString())];
  const r = w.A.runForced(w.env);
  assert.equal(r.step, 'done', '손으로 돌렸는데 실패 기록에 막혔다: ' + r.step);
  assert.equal(w.unzipCalls, 2);
  assert.equal(w.prop(LAST_MESSAGE_ID), 'm1', '손으로 성공한 것도 처리 기록에 남아야 다음 tick 이 조용하다');

  const m = w.mark();
  assert.equal(tick(w).step, 'idle', '손으로 고친 뒤에도 대기 상태가 남았다');
  assertNoWrites(w, m, '수동 복구 뒤의 tick');
});

// ── T4. 겹치면 건너뛴다 ───────────────────────────────────────────

test('tick — 잠금을 못 잡으면 busy, 아무것도 안 쓴다', () => {
  // 수동 실행이 14초 도는 동안 tick 이 들어온다. 1분 간격이면 드물지 않다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    lockFree: false,
  });
  const m = w.mark();
  const r = tick(w);
  assert.equal(r.step, 'busy');
  assert.ok(w.lock.tries >= 1, '잠금을 시도조차 안 했다');
  assertNoWrites(w, m, 'busy');
  assert.equal(w.unzipCalls, 0, '잠금 없이 파이프라인을 돌렸다');
  assert.equal(w.prop(LAST_MESSAGE_ID), null);
  assert.equal(w.prop(LAST_FAILED_MESSAGE_ID), null, 'busy 를 실패로 적었다 — 다음 tick 이 대기에 갇힌다');
});

// ── T5. 하루 한 번은 상태를 남긴다 ────────────────────────────────

test('tick — 한국 시각 07:00 이후 그날 첫 tick 만 상태를 쓴다', () => {
  // ⚠️ idle 이 아무것도 안 쓰면, 유저가 내보내기를 그만뒀을 때 시트의
  //    "데이터가 멈춰 있어요" 경고도 영영 안 갱신된다. 지금 매일 7시
  //    트리거가 하던 그 일은 남아야 한다 — 하루 한 번, 같은 시각에.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    props: { [LAST_MESSAGE_ID]: 'm1', LAST_INGEST_DATE: '2026-06-10' },
  });
  requireTick(w);

  const run = (when) => {
    w.now = kst(when);
    const m = w.mark();
    const r = tick(w);
    return { r, d: w.writesSince(m) };
  };
  const wrote = (x) => x.d.drive.length > 0;

  let x = run('2026-09-26 06:59');
  assert.ok(!wrote(x), '07:00 전인데 상태를 썼다');
  assert.equal(w.status(), null);

  x = run('2026-09-26 07:00');
  assert.ok(wrote(x), '07:00 첫 tick 인데 상태를 안 썼다 (idle 이라도 하루 한 번은 쓴다)');
  assert.ok(w.status(), '상태 파일이 없다');
  assert.ok(x.d.cells.length > 0, '시트 상태 칸을 안 갱신했다 — 멈춤 경고가 여기 뜬다');
  assert.equal(x.r.ok, true);

  x = run('2026-09-26 07:01');
  assert.ok(!wrote(x), '같은 날 두 번 썼다');
  x = run('2026-09-26 23:59');
  assert.ok(!wrote(x), '같은 날 두 번 썼다 (밤)');

  // ⚠️ 한국 9/27 06:59 는 UTC 로 9/26 21:59 다. 날짜를 UTC 로 세면 여기서는
  //    우연히 맞고, 바로 아래에서 틀린다.
  x = run('2026-09-27 06:59');
  assert.ok(!wrote(x), '다음 날 07:00 전인데 썼다');

  // 한국 9/27 07:30 = UTC 9/26 22:30. UTC 로 날짜를 세면 "9/26 은 이미
  // 했다" 로 건너뛴다 — env.tz 를 안 쓴 구현이 여기서 걸린다.
  x = run('2026-09-27 07:30');
  assert.ok(wrote(x), '한국 날짜로 새 날인데 안 썼다 — 시간대를 UTC 나 호스트 기준으로 센다');
});

test('tick — 그날 첫 tick 이 07:00 보다 한참 늦어도 한 번은 쓴다', () => {
  // 트리거가 한도에 걸렸거나 오후에 설치한 날. "정확히 07:00 에만" 이면
  // 그날은 상태가 통째로 빠진다.
  const w = world({
    mails: [],
    props: { LAST_INGEST_DATE: '2026-06-10' },
  });
  w.now = kst('2026-09-28 15:00');
  const m = w.mark();
  tick(w);
  assert.ok(w.writesSince(m).drive.length > 0, '늦은 첫 tick 이 하루 정리를 건너뛰었다');
  assert.ok(w.status(), '상태 파일이 없다');

  const m2 = w.mark();
  w.now = kst('2026-09-28 15:01');
  tick(w);
  assertNoWrites(w, m2, '같은 날 두 번째');
});

// ── T6. 거래내역 시트를 남긴다 ────────────────────────────────────

function withOldLedger(w) {
  // 지난번 실행이 남긴 거래내역. 준비라서 쓰기 기록에 안 남긴다.
  const home = w.drive.makeFolder(w.A.CFG.folderName, w.drive.app._node);
  return w.drive.makeFile({ name: LEDGER_NAME, mimeType: SHEETS_MIME, parent: home._node, source: 'xlsx-of-old' });
}

test('tick — 성공하면 돈동생 폴더에 네이티브 시트 거래내역이 하나 남고, 옛것은 새것이 생긴 뒤에 버린다', () => {
  // 임시 시트를 그냥 지우지 않고 남기면 유저가 거래를 시트로 직접 볼 수 있고,
  // AI 커넥터도 JSON 이 요약한 것 너머를 읽을 수 있다.
  // ⚠️ **옛것을 먼저 버리면** 그 사이에 실행이 죽었을 때(6분 초과) 거래내역이
  //    아예 없는 상태가 된다. 새것이 자리를 잡은 뒤에 버린다.
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))] });
  const old = withOldLedger(w);
  const oldId = old.getId();

  let newExistedWhenOldTrashed = null;
  w.drive.onTrash.push((node) => {
    if (node.id !== oldId) return;
    newExistedWhenOldTrashed = w.ledgers().some((n) => n.id !== oldId && n.parent === w.home()._node);
  });

  const r = tick(w);
  assert.equal(r.step, 'done', r.message);

  const ledgers = w.ledgers();
  assert.equal(ledgers.length, 1,
    '살아 있는 거래내역이 ' + ledgers.length + '개다 (하나여야 한다) — 미구현이면 0개');
  const kept = ledgers[0];
  assert.notEqual(kept.id, oldId, '옛 거래내역이 그대로다 — 새로 받은 걸 반영 안 했다');
  assert.equal(kept.mimeType, SHEETS_MIME, '네이티브 구글 시트가 아니다');
  assert.equal(kept.parent, w.home()._node, '거래내역이 돈동생 폴더에 없다 (raw/ 는 "열지 마세요" 자리다)');
  assert.equal(kept.source, 'xlsx-of-zip-m1', '남은 시트가 이번에 집계한 그 xlsx 가 아니다');

  assert.equal(old._node.trashed, true, '옛 거래내역을 휴지통으로 안 보냈다');
  assert.equal(old._node.removed, false, '옛 거래내역을 영구 삭제했다 — 휴지통이어야 되돌린다');
  assert.equal(newExistedWhenOldTrashed, true, '새 거래내역이 생기기 전에 옛것을 버렸다');

  assert.deepEqual(w.tmps().map((n) => n.name), [], '임시 시트가 남았다');
});

test('tick — 같은 메일로 다시 돌려도(runForced) 거래내역은 하나다', () => {
  // 드라이브는 같은 이름을 막지 않는다. 매번 새로 만들고 옛것을 못 찾으면
  // 거래내역이 실행마다 하나씩 늘어난다.
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))] });
  tick(w);
  w.A.runForced(w.env);
  w.A.runForced(w.env);
  assert.equal(w.ledgers().length, 1, '거래내역이 ' + w.ledgers().length + '개다 (하나여야 한다) — 미구현이면 0개');
  assert.deepEqual(w.tmps().map((n) => n.name), [], '임시 시트가 남았다');
});

test('tick — 집계가 던지면 새 거래내역을 남기지 않고 옛것을 지킨다', () => {
  // 반쯤 변환된 시트가 '거래내역' 이름을 달면 AI 가 그걸 진짜로 읽는다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: { '엉뚱한 시트': [['a', 'b']] },
  });
  const old = withOldLedger(w);
  requireTick(w);

  const r = attempt(() => w.A.tick(w.env));
  assert.equal(r.ok, false, '집계가 던졌는데 성공했다');
  assert.equal(old._node.trashed, false, '실패했는데 옛 거래내역을 버렸다');
  assert.deepEqual(w.ledgers().map((n) => n.id), [old.getId()],
    '거래내역이 옛것 하나가 아니다 — 실패한 변환본이 남았다');
  assert.deepEqual(w.tmps().map((n) => n.name), [], '임시 시트가 남았다');
});

// ── T7. 과거 데이터 가드와 같은 편에 선다 ──────────────────────────

test('tick — behind 이면 거래내역도 옛것을 그대로 두고 새 변환본은 버린다', () => {
  // ⚠️ 최신본(JSON)은 과거로 안 가는데 거래내역만 5월 데이터로 바뀌면, AI 가
  //    두 파일에서 서로 다른 "지금" 을 읽는다. 가드는 둘에 똑같이 걸려야 한다.
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))] });
  assert.equal(tick(w).step, 'done');
  const first = w.ledgers();
  assert.equal(first.length, 1, '첫 실행 뒤 거래내역이 ' + first.length + '개다 — 미구현이면 0개');
  const keptId = first[0].id;

  // 나중에 받은 메일인데 안의 데이터는 5월까지뿐이다.
  w.mails = [fakeMessage('m2', kst('2026-06-20 09:00'))];
  w.sheetData = {
    '가계부 내역': H.ledgerSheet([{ day: '2026-05-01', kind: '지출', amount: 3000 }]),
    '뱅샐현황': H.statusSheet({ owner: '홍길동' }),
  };
  const r = tick(w);
  assert.equal(r.step, 'behind', r.message);

  assert.deepEqual(w.ledgers().map((n) => n.id), [keptId],
    'behind 인데 거래내역이 바뀌었다 — 최신본과 다른 시점을 가리킨다');
  const stray = w.drive.liveFiles().filter((n) => n.mimeType === SHEETS_MIME && n.id !== keptId);
  assert.deepEqual(stray.map((n) => n.name), [], '버렸어야 할 변환본이 남았다');

  // behind 는 실패가 아니다 — 지켜낸 것이다. 매분 다시 돌리지 않는다.
  assert.equal(w.prop(LAST_MESSAGE_ID), 'm2', 'behind 를 처리한 것으로 안 적었다 — 매분 다시 돈다');
  const m = w.mark();
  assert.equal(tick(w).step, 'idle');
  assertNoWrites(w, m, 'behind 다음 tick');
});

// ── T9. 옛 트리거는 그대로 ────────────────────────────────────────

test('runDaily — 처리 기록이 있어도 예전처럼 매번 끝까지 돈다', () => {
  // 이미 사본을 뜬 사람의 컨테이너에는 매일 7시 runDaily 트리거가 걸려 있고
  // 우리가 못 고친다. 처리 기록을 보고 건너뛰면, 그 사람들은 tick 도 없는데
  // runDaily 까지 멈춰서 **아무것도 안 돈다.**
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    props: { [LAST_MESSAGE_ID]: 'm1', [LAST_FAILED_MESSAGE_ID]: 'm1' },
  });
  const r = w.A.runDaily(w.env);
  assert.equal(r.step, 'done', 'runDaily 가 처리 기록에 막혔다: ' + r.step);
  assert.equal(w.unzipCalls, 1);
  assert.ok(w.status(), 'runDaily 가 상태를 안 남겼다');
});

test('runDaily — 새 메일이 없어도 예전처럼 상태를 남긴다', () => {
  // 하루 한 번 도는 옛 트리거에는 이게 유일한 "살아 있다" 신호다.
  const w = world({ mails: [] });
  const r = w.A.runDaily(w.env);
  assert.equal(r.step, 'idle');
  assert.ok(w.status(), 'runDaily idle 이 상태를 안 남겼다');
});

// ── T10. 아직 설정 전 ─────────────────────────────────────────────

test('tick — 비밀번호가 없으면 setup, 07:00 이 지나도 아무것도 안 쓰고 Gmail 도 안 본다', () => {
  // 사본에 트리거만 걸리고 ① 처음 설정하기 를 안 누른 사람. 매분 상태를
  // 쓰면 빈 '돈동생' 폴더가 생기고, 하루 한 번 정리도 알릴 게 없다 —
  // 메뉴 ① 을 누르는 순간 안내가 나온다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    props: { BANKSALAD_ZIP_PASSWORD: '' },
  });
  w.now = kst('2026-09-26 07:30');
  const m = w.mark();
  const r = tick(w);
  assert.equal(r.step, 'setup');
  assertNoWrites(w, m, '설정 전');
  assert.equal(w.gmailSearches, 0, '설정 전인데 Gmail 을 뒤졌다 — 매분 도는 비용이다');
  assert.equal(w.home(), null, '빈 돈동생 폴더를 만들었다');
  assert.equal(w.prop(LAST_MESSAGE_ID), null, '보지도 않은 메일을 처리했다고 적었다');
});

// ── T11. 실패 대기 중의 하루 정리 ──────────────────────────────────

test('tick — 실패 대기 중에 하루 정리가 돌아도 실패를 성공처럼 덮지 않는다', () => {
  // ⚠️ 07:00 정리가 idle 처럼 ✅ 를 쓰면, 틀린 비밀번호가 다음 날 아침부터
  //    "정상" 으로 보인다. 유저는 고칠 이유를 잃는다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    unzip: () => { throw new Error('bad password'); },
  });
  requireTick(w);
  attempt(() => tick(w));
  assert.equal(w.status().ok, false);

  w.now = kst('2026-09-26 07:05');
  const m = w.mark();
  const r = tick(w);
  assert.equal(r.step, 'waiting');
  assert.equal(w.unzipCalls, 1, '하루 정리가 실패한 메일을 다시 풀었다');
  const d = w.writesSince(m);
  assert.ok(d.drive.length > 0, '대기 중이라도 하루 한 번은 상태를 남겨야 한다');
  const s = w.status();
  assert.equal(s.ok, false, '하루 정리가 실패를 성공으로 덮었다');
  assert.equal(s.step, 'waiting');
  assert.match(s.message, /압축을 풀지 못했어요/, '무엇이 실패했는지가 사라졌다');
  assert.ok(d.cells.some(([, v]) => /^⚠️/.test(String(v))), '시트에 ⚠️ 가 아니라 ✅ 가 떴다');
  assert.ok(!d.cells.some(([, v]) => /^✅/.test(String(v))), '시트에 ✅ 가 떴다');

  // 같은 날 두 번째는 조용하다.
  const m2 = w.mark();
  w.now = kst('2026-09-26 07:06');
  assert.equal(tick(w).step, 'waiting');
  assertNoWrites(w, m2, '같은 날 두 번째 대기');
});

// ── T12. 싼 열쇠와 처리한 메일이 갈려도 매분 돌지 않는다 ──────────────

test('tick — 맨 위 스레드가 옛 zip 에 달린 답장이어도, 가장 최근 zip 을 한 번 처리하고 조용해진다', () => {
  // Gmail 은 스레드를 **마지막 활동 순**으로 준다. 옛 zip 스레드에 답장이
  // 달리면 그 스레드가 맨 위다. 싼 열쇠(맨 위 스레드의 마지막 메일)와
  // 처리한 메일(가장 최근 zip)이 다르다 — 둘을 비교하는 구현은 여기서
  // 매분 14초를 돈다.
  const reply = { getId: () => 'reply', getDate: () => kst('2026-06-13 10:00'),
    getSubject: () => 'Re: 뱅크샐러드 내보내기', getAttachments: () => [] };
  const oldZip = fakeMessage('old', kst('2026-06-01 09:00'));
  const newZip = fakeMessage('new', kst('2026-06-12 09:00'));
  const w = world({ mails: [] });
  w.env.gmail.search = (q, start, max) => {
    w.gmailSearches++;
    const threads = [
      { getMessages: () => [oldZip, reply] },
      { getMessages: () => [newZip] },
    ];
    return threads.slice(start || 0, (start || 0) + (max || threads.length));
  };

  const r = tick(w);
  assert.equal(r.step, 'done', r.message);
  assert.equal(w.unzipCalls, 1);
  const latest = JSON.parse(w.home().getFilesByName(w.A.CFG.latestName).next().getBlob().getDataAsString());
  assert.equal(latest.sourceMessageId, 'new', '가장 최근 zip 이 아니라 맨 위 스레드의 것을 처리했다');
  // AI 가 Gmail 커넥터로 본 메일 시각과 비교할 값.
  assert.equal(latest.sourceMessageDate, kst('2026-06-12 09:00').toISOString());

  const m = w.mark();
  assert.equal(tick(w).step, 'idle', '열쇠와 처리한 메일이 달라서 다시 돌았다');
  assert.equal(w.unzipCalls, 1);
  assertNoWrites(w, m, '갈린 열쇠 다음 tick');
});

// ── T13. 달별 거래 파일 ───────────────────────────────────────────
//
// 실측 (2026-09-25): 드라이브 커넥터의 read_file_content 는 2,320줄짜리
// 거래내역 시트에서 **60줄쯤의 표본**만 준다. 페이지를 넘길 방법이 없고,
// 다운로드는 파일 전체를 base64 로 대화에 붓는다. JSON 은 통째로 읽혔다.
// 그래서 "8월 5일 7만원 뭐였어?" 는 시트로는 못 답한다 — 달마다 JSON 을 둔다.

const MONTH_DIR = '거래';
const monthName = (ym) => '거래-' + ym + '.json';

/** 돈동생/거래/ 안의 살아 있는 파일. { 이름: node } */
function monthFiles(w) {
  const home = w.home();
  const dir = home && w.drive.folder(MONTH_DIR, home);
  if (!dir) return {};
  const out = {};
  w.drive.liveFiles().filter((n) => n.parent === dir._node).forEach((n) => { out[n.name] = n; });
  return out;
}

function readMonth(w, ym) {
  const f = monthFiles(w)[monthName(ym)];
  assert.ok(f, monthName(ym) + ' 이 없다 — 있는 것: ' + Object.keys(monthFiles(w)).join(', '));
  return JSON.parse(f.content);
}

/** 이번 실행이 거래/ 에 쓴 것만. */
function monthWrites(w, m) {
  return w.writesSince(m).drive.filter((x) => /^거래-/.test(x.name || '') ||
    (x.id && monthIdSet(w).has(x.id)));
}
function monthIdSet(w) {
  return new Set(Object.values(monthFiles(w)).map((n) => n.id));
}

/** 시트처럼 **최신이 위**인 가계부 행. [날짜, 시간, 타입, 금액, 내용, 메모] */
function ledgerRows(list) {
  return [H.ledgerSheet([])[0]].concat(list.map((x) =>
    [x[0], x[1], x[2], '식비', '한식', x[4] || '', x[3], 'KRW', '체크카드', x[5] || '']));
}

test('달별 거래 — done 이면 들어 있는 달마다 거래-YYYY-MM.json 이 생기고, 모양이 시트와 같다', () => {
  const w = world({
    mails: [fakeMessage('m1', kst('2026-08-11 09:00'))],
    sheetData: {
      // ⚠️ 뱅샐현황이 **먼저** 온다. 거래내역의 첫 탭이 가계부여야 한다.
      '뱅샐현황': H.statusSheet({ owner: '홍길동' }),
      '가계부 내역': ledgerRows([
        ['2026-08-10', '19:05', '지출', -70000, '가게갑', '회식'],
        ['2026-08-05', '08:30:15', '지출', -4500, '카페을'],
        ['2026-07-31', '23:59:59', '수입', 2000000, '급여'],
      ]),
    },
  });
  const r = tick(w);
  assert.equal(r.step, 'done', r.message);

  assert.deepEqual(Object.keys(monthFiles(w)).sort(), [monthName('2026-07'), monthName('2026-08')]);
  const aug = readMonth(w, '2026-08');
  assert.equal(aug.month, '2026-08');
  assert.deepEqual(aug.columns, ['날짜', '시간', '타입', '대분류', '소분류', '내용', '금액', '화폐', '결제수단', '메모']);
  assert.equal(aug.count, aug.rows.length, 'count 가 rows 와 안 맞는다');
  assert.equal(aug.count, 2);
  // 최신이 위, 금액은 숫자에 뱅샐 부호 그대로, 시간은 시트에 보이는 그대로.
  assert.deepEqual(aug.rows[0], ['2026-08-10', '19:05', '지출', '식비', '한식', '가게갑', -70000, 'KRW', '체크카드', '회식']);
  assert.deepEqual(aug.rows[1].slice(0, 2), ['2026-08-05', '08:30:15']);
  assert.equal(readMonth(w, '2026-07').count, 1);
  assert.equal(r.monthFiles && r.monthFiles.written, 2, '결과에 몇 달을 썼는지 안 남겼다');
});

test('달별 거래 — 거래내역 시트의 첫 탭은 가계부 내역이고, 다른 탭도 남는다', () => {
  // 커넥터 미리보기는 **첫 탭**을 읽는다. 뱅샐현황이 먼저면 거래가 한 줄도 안 보인다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: {
      '뱅샐현황': H.statusSheet({ owner: '홍길동' }),
      '가계부 내역': H.ledgerSheet([{ day: '2026-06-10', kind: '지출', amount: -5000 }]),
    },
  });
  assert.equal(tick(w).step, 'done');
  const kept = w.ledgers();
  assert.equal(kept.length, 1);
  assert.deepEqual(w.tabOrders[kept[0].id], ['가계부 내역', '뱅샐현황']);
});

test('달별 거래 — 같은 내보내기를 다시 돌리면 한 달도 다시 쓰지 않고, 바뀐 달만 쓴다', () => {
  const rows = [
    ['2026-06-10', '12:00', '지출', -5000, '가게갑'],
    ['2026-05-01', '12:00', '지출', -10000, '가게을'],
  ];
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: { '가계부 내역': ledgerRows(rows), '뱅샐현황': H.statusSheet({ owner: '홍길동' }) },
  });
  assert.equal(tick(w).step, 'done');

  let m = w.mark();
  const again = w.A.runForced(w.env);
  assert.equal(again.step, 'done');
  assert.deepEqual(monthWrites(w, m), [], '내용이 같은데 달 파일을 다시 썼다');
  assert.equal(again.monthFiles.unchanged, 2);

  // 새 메일에 6월 거래가 하나 늘었다 → 6월만.
  w.mails = [fakeMessage('m2', kst('2026-06-12 09:00'))];
  w.sheetData = { '가계부 내역': ledgerRows([['2026-06-11', '09:00', '지출', -3000, '가게병']].concat(rows)),
    '뱅샐현황': H.statusSheet({ owner: '홍길동' }) };
  m = w.mark();
  assert.equal(tick(w).step, 'done');
  const touched = monthWrites(w, m).map((x) => x.op + ':' + (x.name || ''));
  assert.deepEqual(touched, ['setContent:' + monthName('2026-06')]);
  assert.equal(readMonth(w, '2026-06').count, 2);
  assert.equal(Object.keys(monthFiles(w)).length, 2, '같은 달 파일이 둘이 됐다');
});

test('달별 거래 — behind · 실패 · idle 이면 한 글자도 안 쓴다', () => {
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))] });
  assert.equal(tick(w).step, 'done');
  const before = JSON.stringify(Object.keys(monthFiles(w)).sort());

  // behind — 더 옛 데이터.
  w.mails = [fakeMessage('m2', kst('2026-06-20 09:00'))];
  w.sheetData = {
    '가계부 내역': H.ledgerSheet([{ day: '2026-04-01', kind: '지출', amount: 3000 }]),
    '뱅샐현황': H.statusSheet({ owner: '홍길동' }),
  };
  let m = w.mark();
  assert.equal(tick(w).step, 'behind');
  assert.deepEqual(monthWrites(w, m), [], 'behind 인데 달 파일을 썼다');
  assert.equal(JSON.stringify(Object.keys(monthFiles(w)).sort()), before, 'behind 가 4월 파일을 만들었다');

  // 실패 — 틀린 비밀번호.
  w.mails = [fakeMessage('m3', kst('2026-06-21 09:00'))];
  w.unzip = () => { throw new Error('bad password'); };
  m = w.mark();
  const bad = attempt(() => w.A.tick(w.env));
  assert.equal(bad.ok, false);
  assert.deepEqual(monthWrites(w, m), [], '실패인데 달 파일을 썼다');

  // idle.
  w.mails = [fakeMessage('m1', kst('2026-06-11 09:00'))];
  w.env.props.setProperty(LAST_MESSAGE_ID, 'm1');
  m = w.mark();
  assert.equal(tick(w).step, 'idle');
  assertNoWrites(w, m, 'idle');
});

test('달별 거래 — 새 내보내기에 없는 옛 달 파일은 남는다 (뱅샐 1년 창을 넘어 쌓인다)', () => {
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: { '가계부 내역': ledgerRows([
      ['2026-06-10', '12:00', '지출', -5000],
      ['2026-03-01', '12:00', '지출', -1000],
    ]) },
  });
  assert.equal(tick(w).step, 'done');
  w.mails = [fakeMessage('m2', kst('2026-07-02 09:00'))];
  w.sheetData = { '가계부 내역': ledgerRows([['2026-07-01', '12:00', '지출', -7000]]) };
  assert.equal(tick(w).step, 'done');
  assert.deepEqual(Object.keys(monthFiles(w)).sort(),
    ['2026-03', '2026-06', '2026-07'].map(monthName));
  assert.equal(readMonth(w, '2026-03').rows[0][6], -1000);
});

test('달별 거래 — 새 내보내기가 달 중간에서 시작하면 그 앞의 옛 줄은 지킨다', () => {
  // 뱅샐 1년 창은 달 중간에서 시작한다 (9/25 에 내보내면 작년 9/25 부터).
  // 그 달을 통째로 덮으면 전에 받아 둔 9/1~9/24 가 사라진다.
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: { '가계부 내역': ledgerRows([
      ['2026-06-10', '12:00', '지출', -5000],
      ['2026-05-20', '12:00', '지출', -2000, '옛것도 새것에도'],
      ['2026-05-02', '12:00', '지출', -1000, '옛 내보내기에만'],
    ]) },
  });
  assert.equal(tick(w).step, 'done');
  w.mails = [fakeMessage('m2', kst('2026-06-12 09:00'))];
  w.sheetData = { '가계부 내역': ledgerRows([
    ['2026-06-11', '12:00', '지출', -9000],
    ['2026-06-10', '12:00', '지출', -5000],
    ['2026-05-20', '12:00', '지출', -2500, '옛것도 새것에도'], // 뱅샐에서 고쳤다
  ]) };
  assert.equal(tick(w).step, 'done');
  const may = readMonth(w, '2026-05');
  assert.deepEqual(may.rows.map((r) => [r[0], r[6]]), [['2026-05-20', -2500], ['2026-05-02', -1000]]);
  assert.equal(may.count, 2);
});

test('달별 거래 — 1899-12-30 기준 시각 셀도 시트에 보이는 시각 그대로다', () => {
  // ⚠️ 시각만 있는 셀은 getValues() 가 1899-12-30 날짜의 Date 로 준다.
  //    Asia/Seoul 은 1899 년에 LMT(+8:27:52)라, Utilities.formatDate 로
  //    찍으면 분·초가 32분 8초 밀린다. 시트에 보이는 글자를 써야 한다.
  const t1899 = new Date(Date.UTC(1899, 11, 30, 5, 30, 15)); // 한국 표준시 14:30:15
  const shifted = formatDate(t1899, 'Asia/Seoul', 'HH:mm:ss');
  assert.notEqual(shifted, '14:30:15', '가짜 formatDate 가 LMT 를 안 따른다 — 이 테스트가 아무것도 못 본다');

  const sheet = [H.ledgerSheet([])[0],
    ['2026-06-10', t1899, '지출', '식비', '한식', '가게갑', -5000, 'KRW', '체크카드', '']];

  // (1) 진짜 Apps Script — 화면 글자가 있다.
  const w = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))], sheetData: { '가계부 내역': sheet } });
  w.display = { '가계부 내역': ['시간', '14:30:15'] };
  assert.equal(tick(w).step, 'done');
  assert.equal(readMonth(w, '2026-06').rows[0][1], '14:30:15');

  // (2) 화면 글자를 못 얻어도 LMT 로 밀리지 않는다.
  const w2 = world({ mails: [fakeMessage('m1', kst('2026-06-11 09:00'))], sheetData: { '가계부 내역': sheet } });
  w2.noDisplay = true;
  assert.equal(tick(w2).step, 'done');
  assert.equal(readMonth(w2, '2026-06').rows[0][1], '14:30:15');
});

test('달별 거래 — 화면 글자가 오전/오후 형식이어도 24시간으로 적는다', () => {
  const w = world({
    mails: [fakeMessage('m1', kst('2026-06-11 09:00'))],
    sheetData: { '가계부 내역': ledgerRows([
      ['2026-06-10', 'x', '지출', -5000], ['2026-06-09', 'x', '지출', -5000], ['2026-06-08', 'x', '지출', -5000],
    ]) },
  });
  w.display = { '가계부 내역': ['시간', '오후 2:05', '오전 12:10:09', 'PM 12:00'] };
  assert.equal(tick(w).step, 'done');
  assert.deepEqual(readMonth(w, '2026-06').rows.map((r) => r[1]), ['14:05', '00:10:09', '12:00']);
});
