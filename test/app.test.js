/**
 * app.gs — 파이프라인 본체.
 *
 * 이 코드는 오래 Apps Script 안에만 있어서 **유저 손에서만 실행됐다.**
 * `env` 로 서비스를 받게 바꾸면서 처음으로 node 에서 돌릴 수 있게 됐다.
 * Gmail·Drive·Sheets 를 가짜로 세워서 파이프라인을 통째로 돌린다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const H = require('./lib/helpers');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'appsscript', 'app.gs'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'appsscript', 'core.gs'), 'utf8');

/** Apps Script 의 Utilities 중 app.gs 가 쓰는 것만. */
const Utilities = {
  formatDate(d, tz, fmt) {
    // 우리는 'yyyy-MM-dd' 와 'yyyy-MM-dd HH:mm' 만 쓴다.
    const p = (x) => String(x).padStart(2, '0');
    const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return fmt.indexOf('HH:mm') === -1 ? base : `${base} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  newBlob(content, type, name) { return fakeBlob(name, content); },
};

/** app.gs 를 core 와 함께 평가한다. */
function loadApp(extra) {
  const ctx = vm.createContext(Object.assign({
    Utilities, Logger: { log() {} }, console,
    unzipEncrypted() { throw new Error('테스트에서 지정하지 않았다'); },
  }, extra));
  vm.runInContext(CORE, ctx);
  vm.runInContext(SRC, ctx);
  return ctx.KMApp;
}

// ── 가짜 Drive ────────────────────────────────────────────────────

function fakeBlob(name, content) {
  let n = name;
  return {
    getName: () => n,
    setName(x) { n = x; return this; },
    getDataAsString: () => content,
    getBlob() { return this; },
    copyBlob() { return fakeBlob(n, content); },
    _content: () => content,
  };
}

function fakeFolder(name) {
  const files = new Map();
  const folders = new Map();
  const self = {
    _files: files,
    getId: () => 'id-' + name,
    getFoldersByName(n) {
      const f = folders.get(n);
      let done = !f;
      return { hasNext: () => !done, next: () => { done = true; return f; } };
    },
    createFolder(n) { const f = fakeFolder(n); folders.set(n, f); return f; },
    getFilesByName(n) {
      const f = files.get(n);
      let done = !f;
      return { hasNext: () => !done, next: () => { done = true; return f; } };
    },
    getFiles() {
      const all = [...files.values()];
      let i = 0;
      return { hasNext: () => i < all.length, next: () => all[i++] };
    },
    createFile(blob) {
      let content = blob.getDataAsString ? blob.getDataAsString() : '';
      const file = {
        getName: () => blob.getName(),
        getBlob: () => ({ getDataAsString: () => content }),
        setContent(c) { content = c; return this; },
        setTrashed() { files.delete(blob.getName()); return this; },
      };
      files.set(blob.getName(), file);
      return file;
    },
  };
  return self;
}

function propsStub(map) {
  const m = map || {};
  return {
    _map: m,
    getProperty: (k) => (k in m ? m[k] : null),
    setProperty(k, v) { m[k] = v; return this; },
  };
}

function fakeEnv(over) {
  const root = fakeFolder('root');
  return Object.assign({
    props: propsStub({}),
    lock: { tryLock: () => true, releaseLock() {} },
    gmail: { search: () => [] },
    drive: root,
    driveApi: { Files: { create: () => ({ id: 'tmp' }) } },
    sheets: { openById: () => ({ getSheets: () => [] }) },
    ss: null,
    ui: null,
    tz: 'Asia/Seoul',
    containerVersion: '0.1.1',
    _root: root,
  }, over);
}

/** 뱅샐 메일 한 통. */
function fakeMessage(id, date, attachmentName) {
  return {
    getId: () => id,
    getDate: () => date,
    getSubject: () => '뱅크샐러드 내보내기',
    getAttachments: () => [fakeBlob(attachmentName, 'zip-bytes')],
  };
}

// ── 신선도 ────────────────────────────────────────────────────────

function daysAgo(n) {
  // ⚠️ toISOString() 을 쓰면 안 된다. UTC 로 찍힌 날짜를 dataAge 가 로컬로
  //    읽어서, 한국 시간 새벽에 돌리면 하루가 어긋나 테스트가 깜빡인다.
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())].join('-');
}

test('dataAge — 없음 / 깨짐 / 정상을 구분한다', () => {
  const A = loadApp();
  assert.equal(A.dataAge(propsStub({})).state, 'none');
  // 깨진 값을 '아직 없음' 으로 뭉개면 이 함수가 드러내려는 고장을 감춘다.
  const broken = A.dataAge(propsStub({ LAST_INGEST_DATE: '언젠가' }));
  assert.equal(broken.state, 'broken');
  assert.equal(broken.days, null);
  assert.equal(A.dataAge(propsStub({ LAST_INGEST_DATE: daysAgo(3) })).days, 3);
});

test('freshnessLine — 오래되면 경고하고 며칠인지 센다', () => {
  const A = loadApp();
  const line = A.freshnessLine(A.dataAge(propsStub({ LAST_INGEST_DATE: daysAgo(40) })));
  assert.match(line, /⚠️/);
  assert.match(line, /40일 전/);
  assert.match(line, /다시 내보내/);
});

test('freshnessLine — 최근이면 경고하지 않는다', () => {
  const A = loadApp();
  assert.doesNotMatch(A.freshnessLine(A.dataAge(propsStub({ LAST_INGEST_DATE: daysAgo(2) }))), /⚠️/);
});

test('isStale — 데이터가 없거나 깨졌으면 그것도 멈춘 것이다', () => {
  const A = loadApp();
  assert.equal(A.isStale({ state: 'none', days: null }), true);
  assert.equal(A.isStale({ state: 'broken', days: null }), true);
  assert.equal(A.isStale({ state: 'ok', days: 0 }), false);
});

// ── 시트에 쓰는 값 ────────────────────────────────────────────────

test('safeCell — 수식으로 읽힐 값을 막는다 (앞 공백 포함)', () => {
  const A = loadApp();
  // spreadsheets 권한이 있으니 =IMPORTDATA 는 구글 서버가 대신 요청을 보내는
  // 통로가 된다. 우리 문자열은 안전하지만 여기서 한 번 막는다.
  assert.equal(A.safeCell('=IMPORTDATA("http://x")'), '\'=IMPORTDATA("http://x")');
  assert.equal(A.safeCell(' =IMPORTDATA("x")'), "' =IMPORTDATA(\"x\")");
  assert.equal(A.safeCell('+1'), "'+1");
  assert.equal(A.safeCell('✅ 정상'), '✅ 정상');
});

test('writeStatusToSheet — 이름으로 찾은 시트에 쓰고 같은 문장을 두 번 안 쓴다', () => {
  const A = loadApp();
  const cells = {};
  const sheet = { getRange: (a) => ({ setValue(v) { cells[a] = v; } }) };
  const env = fakeEnv({
    props: propsStub({ LAST_INGEST_DATE: daysAgo(1) }),
    ss: {
      getSheetByName: (n) => (n === A.STATUS_SHEET ? sheet : null),
      getSheets: () => [{ getRange: () => ({ setValue() { throw new Error('남의 시트다'); } }) }],
    },
  });
  A.writeStatusToSheet(env, { ok: true, message: '처리 완료' });
  assert.match(cells[A.STATUS_CELL], /처리 완료/);
  assert.match(cells[A.CHECKED_CELL], /데이터는/);
  assert.doesNotMatch(cells[A.STATUS_CELL], /데이터는/, '신선도를 두 칸에 겹쳐 적고 있다');
});

test('writeStatusToSheet — 데이터가 멈췄으면 굵은 칸이 그 얘기를 한다', () => {
  const A = loadApp();
  const cells = {};
  const sheet = { getRange: (a) => ({ setValue(v) { cells[a] = v; } }) };
  const env = fakeEnv({
    props: propsStub({ LAST_INGEST_DATE: daysAgo(60) }),
    ss: { getSheetByName: () => sheet, getSheets: () => [sheet] },
  });
  // 트리거는 매일 성공한다. 그 초록 체크가 굵은 칸을 차지하면 안 된다.
  A.writeStatusToSheet(env, { ok: true, message: '처리할 새 메일이 없다.' });
  assert.match(cells[A.STATUS_CELL], /멈춰 있어요/);
});

// ── 비밀번호 힌트 ─────────────────────────────────────────────────

test('hint — 별 개수가 자릿수와 맞는다', () => {
  const A = loadApp();
  ['abcdef', 'a1b2c3d4', '가나다라마바사'].forEach((pw) => {
    assert.equal(A.hint(pw).length, pw.length, pw);
  });
  assert.equal(A.hint('abcdef'), 'a****f');
});

test('hint — 짧은 비밀번호는 답을 흘리지 않는다', () => {
  // '0930' → '0**0' 이면 후보가 100개로 준다. 힌트가 아니라 답이다.
  const A = loadApp();
  ['a', 'ab', 'abc', '0930', 'abcde'].forEach((pw) => {
    const h = A.hint(pw);
    assert.doesNotMatch(h, new RegExp('[' + pw + ']'), pw);
    assert.match(h, /^\d+자$/);
  });
});

test('hint — 이모지를 반쪽으로 자르지 않는다', () => {
  const A = loadApp();
  const h = A.hint('🔑abcde🔒');
  assert.equal(Array.from(h).length, 7);
  assert.equal(Array.from(h)[0], '🔑');
});

// ── 처리 이력 ─────────────────────────────────────────────────────

test('markProcessed — 보관 개수를 넘기면 오래된 것부터 버린다', () => {
  const A = loadApp();
  const props = propsStub({});
  for (let i = 0; i < A.CFG.processedKeep + 10; i++) A.markProcessed(props, 'm' + i);
  const list = A.getProcessed(props);
  assert.equal(list.length, A.CFG.processedKeep);
  assert.equal(list.indexOf('m0'), -1, '오래된 것이 남아 있다');
  assert.ok(list.indexOf('m' + (A.CFG.processedKeep + 9)) !== -1);
});

test('getProcessed — 속성이 깨져 있어도 죽지 않는다', () => {
  const A = loadApp();
  assert.deepEqual(A.getProcessed(propsStub({ PROCESSED_MESSAGE_IDS: '{{{' })), []);
});

// ── Gmail 고르기 ──────────────────────────────────────────────────

test('findAttachment — 여러 통이면 가장 최근 것', () => {
  const A = loadApp();
  const env = fakeEnv({
    gmail: {
      search: () => [{
        getMessages: () => [
          fakeMessage('old', new Date('2026-01-01'), 'a.zip'),
          fakeMessage('new', new Date('2026-06-01'), 'b.zip'),
        ],
      }],
    },
  });
  assert.equal(A.findAttachment(env).id, 'new');
});

test('findAttachment — 이미 처리한 건 건너뛴다. force 면 다시 본다', () => {
  const A = loadApp();
  const env = fakeEnv({
    props: propsStub({ PROCESSED_MESSAGE_IDS: JSON.stringify(['seen']) }),
    gmail: { search: () => [{ getMessages: () => [fakeMessage('seen', new Date(), 'a.zip')] }] },
  });
  assert.equal(A.findAttachment(env), null);
  assert.equal(A.findAttachment(env, true).id, 'seen');
});

test('findAttachment — zip 이 아닌 첨부는 무시한다', () => {
  const A = loadApp();
  const env = fakeEnv({
    gmail: { search: () => [{ getMessages: () => [fakeMessage('m', new Date(), 'report.pdf')] }] },
  });
  assert.equal(A.findAttachment(env), null);
});

// ── Drive 보관 ────────────────────────────────────────────────────

test('pruneFacts — 델타에 쓸 만큼만 남기고 오래된 것부터 지운다', () => {
  const A = loadApp();
  const folder = fakeFolder(A.CFG.folderName);
  for (let i = 1; i <= A.CFG.keepFacts + 5; i++) {
    A.putJson(folder, A.historyName('2026-01-' + String(i).padStart(2, '0')), '{}');
  }
  A.putJson(folder, A.CFG.latestName, '{}');
  A.pruneFacts(folder);
  const names = [...folder._files.keys()].filter((n) => A.CFG.historyPattern.test(n));
  assert.equal(names.length, A.CFG.keepFacts);
  // ⚠️ 최신본은 지난 기록과 접두사가 같다. 날짜 모양까지 안 보면 최신본을
  //    히스토리로 세서 지운다.
  assert.ok(folder._files.has(A.CFG.latestName), '최신본을 지우면 안 된다');
  assert.ok(!names.includes(A.historyName('2026-01-01')), '오래된 것이 남아 있다');
});

test('readPrevious — 같은 날 두 번 내보내도 자기 자신과 비교하지 않는다', () => {
  const A = loadApp();
  const folder = fakeFolder(A.CFG.folderName);
  A.putJson(folder, A.historyName('2026-06-01'), JSON.stringify({ tag: 'old' }));
  A.putJson(folder, A.historyName('2026-06-10'), JSON.stringify({ tag: 'today' }));
  const prev = A.readPrevious(folder, '2026-06-10');
  assert.equal(prev.tag, 'old');
});

test('putJson — 같은 이름이면 덮어쓰고 늘어나지 않는다', () => {
  const A = loadApp();
  const folder = fakeFolder('f');
  A.putJson(folder, 'x.json', '{"a":1}');
  A.putJson(folder, 'x.json', '{"a":2}');
  assert.equal(folder._files.size, 1);
  assert.equal(A.readJson(folder, 'x.json').a, 2);
});

// ── 파이프라인 전체 ───────────────────────────────────────────────

test('process — 비밀번호가 없으면 유저 말로 안내한다', () => {
  const A = loadApp();
  const r = A.process(fakeEnv());
  assert.equal(r.ok, false);
  assert.equal(r.step, 'setup');
  // 개발자용 함수 이름을 유저에게 보여주지 않는다.
  assert.doesNotMatch(r.message, /setup_check|_\(\)/);
  assert.match(r.message, /처음 설정하기/);
});

test('process — 새 메일이 없으면 idle', () => {
  const A = loadApp();
  const r = A.process(fakeEnv({ props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }) }));
  assert.equal(r.step, 'idle');
  assert.equal(r.ok, true);
});

test('process — 비밀번호가 틀리면 유저가 할 일을 알려준다', () => {
  const A = loadApp({ unzipEncrypted() { throw new Error('bad password'); } });
  const env = fakeEnv({
    props: propsStub({ BANKSALAD_ZIP_PASSWORD: '틀림' }),
    gmail: { search: () => [{ getMessages: () => [fakeMessage('m', new Date(), 'a.zip')] }] },
  });
  const r = A.process(env);
  assert.equal(r.step, 'decrypt');
  assert.match(r.message, /비밀번호 다시 넣기/);
  // 스크립트 속성 이름 같은 내부 사정을 유저에게 던지지 않는다.
  assert.doesNotMatch(r.message, /BANKSALAD_ZIP_PASSWORD/);
});

test('process — 끝까지 돌면 최신본과 원본 zip 이 남는다', () => {
  const sheets = {
    '가계부 내역': H.ledgerSheet([
      { day: '2026-05-01', kind: '지출', amount: 10000 },
      { day: '2026-06-10', kind: '수입', amount: 2000000 },
    ]),
    '뱅샐현황': H.statusSheet({ owner: '홍길동' }),
  };
  const A = loadApp({ unzipEncrypted: () => [fakeBlob('가계부.xlsx', 'x')] });
  const env = fakeEnv({
    props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }),
    gmail: { search: () => [{ getMessages: () => [fakeMessage('m1', new Date('2026-06-11'), 'a.zip')] }] },
    sheets: {
      openById: () => ({
        getSheets: () => Object.keys(sheets).map((n) => ({
          getName: () => n,
          getDataRange: () => ({ getValues: () => sheets[n] }),
        })),
      }),
    },
  });

  const r = A.process(env);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.step, 'done');

  const folder = env._root.getFoldersByName(A.CFG.folderName).next();
  assert.ok(folder._files.has(A.CFG.latestName), A.CFG.latestName + ' 이 없다');
  assert.ok(folder._files.has(A.historyName('2026-06-11')));
  const raw = folder.getFoldersByName('raw').next();
  assert.ok(raw._files.has('2026-06-11.zip'), '원본 zip 을 안 남겼다');

  const facts = JSON.parse(folder._files.get(A.CFG.latestName).getBlob().getDataAsString());
  assert.ok(facts.period, 'period 가 없다');

  // ⚠️ 메일 수신일(6/11)이 아니라 거래 마지막 날(6/10)이어야 한다.
  //    "데이터는 X 까지 있어요" 라고 말할 값이라 여기가 어긋나면 거짓말이 된다.
  assert.equal(env.props.getProperty('LAST_INGEST_DATE'), '2026-06-10');
  assert.deepEqual(A.getProcessed(env.props), ['m1']);
});

test('process — 두 번 돌려도 같은 날 파일이 늘어나지 않는다', () => {
  const sheets = {
    '가계부 내역': H.ledgerSheet([{ day: '2026-06-10', kind: '지출', amount: 5000 }]),
  };
  const A = loadApp({ unzipEncrypted: () => [fakeBlob('가계부.xlsx', 'x')] });
  const env = fakeEnv({
    props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }),
    gmail: { search: () => [{ getMessages: () => [fakeMessage('m1', new Date('2026-06-11'), 'a.zip')] }] },
    sheets: {
      openById: () => ({
        getSheets: () => Object.keys(sheets).map((n) => ({
          getName: () => n,
          getDataRange: () => ({ getValues: () => sheets[n] }),
        })),
      }),
    },
  });
  A.process(env, { force: true });
  const after1 = env._root.getFoldersByName(A.CFG.folderName).next()._files.size;
  A.process(env, { force: true });
  const after2 = env._root.getFoldersByName(A.CFG.folderName).next()._files.size;
  assert.equal(after2, after1, '같은 날인데 파일이 늘었다');
});

test('runDaily — 이미 돌고 있으면 건너뛴다', () => {
  const A = loadApp();
  const env = fakeEnv({ lock: { tryLock: () => false, releaseLock() {} } });
  assert.equal(A.runDaily(env).step, 'busy');
});

test('runDaily — 예외가 나도 상태를 남기고 던진다', () => {
  const A = loadApp();
  const env = fakeEnv({
    props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }),
    gmail: { search() { throw new Error('Gmail 폭발'); } },
  });
  assert.throws(() => A.runDaily(env), /Gmail 폭발/);
  // 무인 실행이라 예외를 삼키면 아무도 모른다. Drive 에는 남아야 한다.
  const folder = env._root.getFoldersByName(A.CFG.folderName).next();
  const status = JSON.parse(folder._files.get(A.CFG.statusName).getBlob().getDataAsString());
  assert.equal(status.ok, false);
  assert.match(status.message, /Gmail 폭발/);
});

// ── 유저에게 보이는 것 ────────────────────────────────────────────

test('versionText — 두 버전을 따로 보여준다', () => {
  // 하나로 합쳐 보여주면 옛 컨테이너로 도는 걸 아무도 모른다.
  const A = loadApp();
  const t = A.versionText(fakeEnv({ containerVersion: '9.9.9' }));
  assert.match(t, /시트 스크립트: 9\.9\.9/);
  assert.match(t, /집계 라이브러리: \d+\.\d+\.\d+/);
});

test('menuVersion — 설정을 날리라고 하지 않고, 절차를 늘어놓지 않는다', () => {
  const A = loadApp();
  let body = '';
  const env = fakeEnv({
    ui: { alert(title, msg) { body = msg; }, ButtonSet: { OK: 'OK' } },
  });
  A.menuVersion(env);
  // 사본을 새로 만들면 비밀번호와 트리거가 안 따라온다.
  assert.doesNotMatch(body, /사본/);
  assert.match(body, /그대로 두셔도/);
  assert.ok(body.split('\n').length < 12, '대화상자에 절차를 늘어놓고 있다');
});

test('menuRunNow — 자동 실행과 겹치면 돌리지 않는다', () => {
  const A = loadApp();
  let title = '';
  const env = fakeEnv({
    lock: { tryLock: () => false, releaseLock() {} },
    ui: { alert(t) { title = t; }, ButtonSet: { OK: 'OK' } },
  });
  A.menuRunNow(env);
  assert.equal(title, '잠시만요');
});

test('menuRunNow — 라이브러리가 폭발해도 날 것의 오류를 보여주지 않는다', () => {
  const A = loadApp({ unzipEncrypted() { throw new Error('boom'); } });
  let body = '';
  const env = fakeEnv({
    props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }),
    gmail: { search() { throw new TypeError('x is not a function'); } },
    ui: { alert(t, m) { body = m; }, ButtonSet: { OK: 'OK' } },
  });
  A.menuRunNow(env);
  assert.match(body, /시트 스크립트/, '버전을 같이 보여줘야 신고를 받을 수 있다');
});

test('대화상자 문구에 마크다운을 쓰지 않는다', () => {
  // ui.alert 는 평문만 렌더한다. **강조** 는 별표가 그대로 보인다.
  //
  // ⚠️ AGENT_GUIDE 는 **진짜 마크다운 파일**이라 별표가 맞다. 그 배열을
  //    빼고 본다 — 안 그러면 문서를 쓸 때마다 이 테스트가 막는다.
  const start = SRC.indexOf('var AGENT_GUIDE = [');
  const end = SRC.indexOf("].join('\\n')", start);
  assert.ok(start !== -1 && end !== -1, 'AGENT_GUIDE 블록을 못 찾았다');
  const withoutGuide = SRC.slice(0, start) + SRC.slice(end);

  const { strings } = require('./lib/scan')(withoutGuide);
  const bad = strings.filter((l) => l.indexOf('**') !== -1);
  assert.deepEqual(bad, [], '별표가 그대로 보인다: ' + bad.join(' | '));
});

test('AGENT.md 가 저장소 사본과 글자까지 같다', () => {
  // 두 벌이 되면 반드시 어긋난다. 저장소 쪽은 사람이 고치기 좋고,
  // app.gs 쪽은 실제로 유저 드라이브에 나가는 것이다.
  const A = loadApp();
  const repoCopy = fs.readFileSync(path.join(ROOT, 'docs', 'AGENT.md.txt'), 'utf8');
  assert.equal(A.AGENT_GUIDE, repoCopy,
    'docs/AGENT.md.txt 와 app.gs 의 AGENT_GUIDE 가 다르다');
});

test('AGENT.md 는 내용이 같으면 다시 쓰지 않는다', () => {
  const A = loadApp();
  const folder = fakeFolder('돈동생');
  A.ensureAgentGuide(folder);
  const first = folder._files.get('AGENT.md');
  A.ensureAgentGuide(folder);
  assert.strictEqual(folder._files.get('AGENT.md'), first, '매번 새로 쓰고 있다');
  assert.equal(folder._files.size, 1);
});

test('AGENT.md 가 낡았으면 갱신한다', () => {
  const A = loadApp();
  const folder = fakeFolder('돈동생');
  A.putJson(folder, 'AGENT.md', '옛날 내용');
  A.ensureAgentGuide(folder);
  assert.equal(folder._files.get('AGENT.md').getBlob().getDataAsString(), A.AGENT_GUIDE);
});

test('AGENT.md 가 쓰기 규칙과 경계를 담는다', () => {
  // 이 파일의 값어치는 두 가지다 — AI 가 내정보.json 을 쓸 줄 알게 하는 것,
  // 그리고 우리가 안 하기로 한 걸 AI 도 안 하게 하는 것.
  const A = loadApp();
  assert.match(A.AGENT_GUIDE, /내정보\.json/);
  assert.match(A.AGENT_GUIDE, /k-money\/profile@1/, '스키마가 있어야 따라 쓸 수 있다');
  assert.match(A.AGENT_GUIDE, /추천하지 마세요/, '상품 추천 금지가 빠졌다');
  assert.match(A.AGENT_GUIDE, /먼저 읽고 합치세요/, '덮어쓰면 예전 목표가 사라진다');
  assert.match(A.AGENT_GUIDE, /period/, '기간을 넘겨짚지 말라고 해야 한다');
  // 우리가 내보내는 파일 이름과 안내가 어긋나면 AI 가 못 찾는다.
  assert.ok(A.AGENT_GUIDE.indexOf(A.CFG.latestName) !== -1);
  assert.ok(A.AGENT_GUIDE.indexOf(A.CFG.profileName) !== -1);
  assert.ok(A.AGENT_GUIDE.indexOf(A.CFG.statusName) !== -1);
});

test('메뉴 항목이 컨테이너의 실제 함수를 가리킨다', () => {
  // ⚠️ 이 계약이 **두 파일에 걸쳐 있다.** app.gs 가 핸들러 이름을 정하고
  //    container.gs 가 그 이름의 함수를 갖는데, 컨테이너는 우리가 고칠 수
  //    없다. 여기서 이름을 바꾸면 이미 설치한 사람의 메뉴가 죽는다.
  const A = loadApp();
  const container = fs.readFileSync(path.join(ROOT, 'appsscript', 'container.gs'), 'utf8');
  A.menuSpec().filter((s) => !s.separator).forEach((s) => {
    assert.match(container, new RegExp('function\\s+' + s.handler + '\\s*\\('),
      s.handler + ' 이 container.gs 에 없다');
  });
});

test('상태 칸이 템플릿이 꾸민 자리와 같다', () => {
  const A = loadApp();
  const tpl = fs.readFileSync(path.join(ROOT, 'appsscript', 'template.gs'), 'utf8');
  const cell = (name) => new RegExp(name + " = '([A-Z]+\\d+)'").exec(tpl)[1];
  assert.equal(A.STATUS_CELL, cell('TEMPLATE_STATUS_CELL'));
  assert.equal(A.CHECKED_CELL, cell('TEMPLATE_CHECKED_CELL'));
});
