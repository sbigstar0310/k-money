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

/**
 * 가짜 Drive 폴더.
 *
 * ⚠️ **이름을 열쇠로 쓰는 Map 이 아니라 배열이다.** 드라이브는 같은 이름을
 *    막지 않는다 — 같은 이름으로 두 번 만들면 덮이지 않고 **두 개가 된다**
 *    (실측). 파일도 **폴더도** 그렇다. Map 으로 두면 그 제약이 사라져서,
 *    메모리 정리가 풀려는 문제 자체가 테스트 안에서는 일어나지 않는다.
 */
function fakeFolder(name) {
  const files = [];
  const folders = [];
  const iter = (arr) => {
    let i = 0;
    return { hasNext: () => i < arr.length, next: () => arr[i++] };
  };
  const self = {
    // 들여다보기용. 이름이 겹치면 겹친 만큼 다 센다.
    _names: () => files.map((f) => f.getName()),
    _has: (n) => files.some((f) => f.getName() === n),
    _get: (n) => files.filter((f) => f.getName() === n)[0],
    _count: () => files.length,
    getId: () => 'id-' + name,
    getFoldersByName(n) { return iter(folders.filter((f) => f._name === n)); },
    createFolder(n) { const f = fakeFolder(n); folders.push(f); return f; },
    getFilesByName(n) { return iter(files.filter((f) => f.getName() === n)); },
    getFiles() { return iter(files.slice()); },
    createFile(blob) {
      let content = blob.getDataAsString ? blob.getDataAsString() : '';
      // ⚠️ 이름을 **만들 때 붙잡는다.** blob.getName() 을 그대로 물고 있으면
      //    나중에 blob.setName() 을 부른 쪽이 이미 만들어진 파일 이름까지
      //    소급해서 바꾼다 — 실제 드라이브는 안 그런다.
      const fileName = blob.getName();
      const file = {
        getName: () => fileName,
        getBlob: () => ({ getDataAsString: () => content }),
        // 테스트가 필요하면 덮어쓴다. 기본값이 같으므로 동점 처리도 지난다.
        getDateCreated: () => new Date(0),
        setContent(c) { content = c; return this; },
        setTrashed() {
          const i = files.indexOf(file);
          if (i >= 0) files.splice(i, 1);
          return this;
        },
      };
      files.push(file);
      return file;
    },
  };
  self._name = name;
  return self;
}

/**
 * 메모리 폴더에 파일을 놓는다. `['이름', '생성시각']` 또는 그냥 `'이름'`.
 * 돌려주는 `mem` 은 첫 번째 메모리 폴더다.
 */
function memoryWith(A, names) {
  const root = fakeFolder('돈동생');
  const mem = root.createFolder(A.CFG.memoryFolder);
  const files = names.map((n) => {
    const [name, t] = Array.isArray(n) ? n : [n, null];
    const f = mem.createFile(fakeBlob(name, 'x'));
    if (t) f.getDateCreated = () => new Date(t);
    return f;
  });
  return { root, mem, files };
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
  const names = folder._names().filter((n) => A.CFG.historyPattern.test(n));
  assert.equal(names.length, A.CFG.keepFacts);
  // ⚠️ 최신본은 지난 기록과 접두사가 같다. 날짜 모양까지 안 보면 최신본을
  //    히스토리로 세서 지운다.
  assert.ok(folder._has(A.CFG.latestName), '최신본을 지우면 안 된다');
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
  assert.equal(folder._count(), 1);
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
  assert.ok(folder._has(A.CFG.latestName), A.CFG.latestName + ' 이 없다');
  // ⚠️ 히스토리 이름은 **받은 날**(6/11)이다. 데이터 날짜로 지으면 매일
  //    거래하지 않는 사람은 파일이 한 개만 남고 delta 가 영영 안 나온다.
  assert.ok(folder._has(A.historyName('2026-06-11')),
    '히스토리 이름이 받은 날이 아니다: ' + folder._names().join(', '));
  const raw = folder.getFoldersByName('raw').next();
  // 원본 zip 은 메일 받은 날로 남긴다 — 언제 받은 파일인지가 여기선 중요하다.
  assert.ok(raw._has('2026-06-11.zip'), '원본 zip 을 안 남겼다');

  const facts = JSON.parse(folder._get(A.CFG.latestName).getBlob().getDataAsString());
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
  const after1 = env._root.getFoldersByName(A.CFG.folderName).next()._count();
  A.process(env, { force: true });
  const after2 = env._root.getFoldersByName(A.CFG.folderName).next()._count();
  assert.equal(after2, after1, '같은 날인데 파일이 늘었다');
});

test('모든 실행 경로가 잠금을 지난다', () => {
  // 예전엔 runOnceForce 만 잠금 없이 돌았고, 그게 하필 컨테이너에 있어서
  // 이미 사본을 뜬 사람에게는 영영 못 고치는 상태였다.
  const A = loadApp();
  ['runDaily', 'runForced'].forEach((fn) => {
    let locked = false;
    const env = fakeEnv({
      lock: { tryLock: () => { locked = true; return false; }, releaseLock() {} },
    });
    const r = A[fn](env);
    assert.ok(locked, fn + ' 이 잠금을 안 잡는다');
    assert.equal(r.step, 'busy');
  });
});

test('runForced 는 이미 처리한 메일도 다시 본다', () => {
  const A = loadApp({ unzipEncrypted() { throw new Error('여기까지 왔으면 통과'); } });
  const env = fakeEnv({
    props: propsStub({
      BANKSALAD_ZIP_PASSWORD: '0930',
      PROCESSED_MESSAGE_IDS: JSON.stringify(['seen']),
    }),
    gmail: { search: () => [{ getMessages: () => [fakeMessage('seen', new Date(), 'a.zip')] }] },
  });
  assert.equal(A.runDaily(env).step, 'idle', '평소엔 건너뛴다');
  assert.equal(A.runForced(env).step, 'decrypt', 'force 면 다시 본다');
});

test('매일 거래하지 않아도 스냅샷이 쌓이고 delta 가 나온다', () => {
  // ⚠️ 한때 히스토리 이름을 **데이터 마지막 날**로 지었다. 그러면 거래가
  //    없는 날에는 이름이 안 바뀌어 매 실행이 같은 파일을 덮어쓰고,
  //    readPrevious 가 자기보다 앞선 걸 못 찾아 delta 가 영영 안 나왔다.
  //    실측: 순자산이 120만원 움직였는데 보고 0건, 히스토리 1개.
  const sheets = (netWorth) => ({
    '가계부 내역': H.ledgerSheet([{ day: '2026-06-02', kind: '지출', amount: -1000 }]),
    '뱅샐현황': H.statusSheet({
      owner: '홍길동',
      assets: [{ group: '자유입출금 자산', name: '통장', amount: netWorth }],
    }),
  });
  const A = loadApp({ unzipEncrypted: () => [fakeBlob('가계부.xlsx', 'x')] });
  const env = fakeEnv({ props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }) });

  const run = (mailDay, netWorth) => {
    const cur = sheets(netWorth);
    env.gmail = { search: () => [{ getMessages: () => [fakeMessage('m' + mailDay, new Date(mailDay + 'T09:00:00'), 'a.zip')] }] };
    env.sheets = {
      openById: () => ({
        getSheets: () => Object.keys(cur).map((n) => ({
          getName: () => n,
          getDataRange: () => ({ getValues: () => cur[n] }),
        })),
      }),
    };
    return A.process(env, { force: true });
  };

  run('2026-06-03', 10000000);
  run('2026-06-04', 10800000);
  const folder = env._root.getFoldersByName(A.CFG.folderName).next();
  const history = folder._names().filter((n) => A.CFG.historyPattern.test(n));
  assert.equal(history.length, 2, '스냅샷이 안 쌓인다: ' + history.join(', '));

  const latest = JSON.parse(folder._get(A.CFG.latestName).getBlob().getDataAsString());
  assert.ok(latest.delta, 'delta 가 안 나왔다');
  assert.equal(latest.delta.netWorth, 800000);
});

test('readPrevious 의 비교 기준이 쓰는 기준과 같다', () => {
  // 두 기준이 어긋나면 자기 자신과 비교해 delta 가 전부 0이 되거나 사라진다.
  const A = loadApp();
  const src = fs.readFileSync(path.join(ROOT, 'appsscript', 'app.gs'), 'utf8');
  assert.match(src, /readPrevious\(folder, stamp\)/, '비교 기준이 stamp 가 아니다');
  assert.match(src, /putJson\(folder, historyName\(stamp\), json\)/, '쓰는 기준이 stamp 가 아니다');
});

test('임시 시트는 집계가 던져도 치운다', () => {
  // 이 정리가 refactor 의 존재 이유인데 테스트가 없었다 — finally 를 통째로
  // 지워도 스위트가 초록이었다.
  const trashed = [];
  const A = loadApp({
    unzipEncrypted: () => [fakeBlob('가계부.xlsx', 'x')],
  });
  const env = fakeEnv({
    props: propsStub({ BANKSALAD_ZIP_PASSWORD: '0930' }),
    gmail: { search: () => [{ getMessages: () => [fakeMessage('m', new Date('2026-06-11'), 'a.zip')] }] },
    driveApi: { Files: { create: () => ({ id: 'tmp-1' }) } },
    sheets: { openById() { throw new Error('시트 읽기 폭발'); } },
  });
  env.drive.getFileById = (id) => ({ setTrashed: () => trashed.push(id) });

  assert.throws(() => A.process(env, { force: true }), /시트 읽기 폭발/);
  assert.deepEqual(trashed, ['tmp-1'], '임시 시트가 남았다');
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
  const status = JSON.parse(folder._get(A.CFG.statusName).getBlob().getDataAsString());
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
  const first = folder._get('AGENT.md');
  A.ensureAgentGuide(folder);
  assert.strictEqual(folder._get('AGENT.md'), first, '매번 새로 쓰고 있다');
  assert.equal(folder._count(), 1);
});

test('AGENT.md 가 낡았으면 갱신한다', () => {
  const A = loadApp();
  const folder = fakeFolder('돈동생');
  A.putJson(folder, 'AGENT.md', '옛날 내용');
  A.ensureAgentGuide(folder);
  assert.equal(folder._get('AGENT.md').getBlob().getDataAsString(), A.AGENT_GUIDE);
});

test('AGENT.md 가 쓰기 규칙과 경계를 담는다', () => {
  const A = loadApp();
  assert.match(A.AGENT_GUIDE, /고칠 수도 지울 수도 없습니다/,
    'AI 가 자기 제약을 알아야 갱신 절차를 따른다');
  assert.match(A.AGENT_GUIDE, /먼저 읽으세요/, '읽고 나서 새로 쓰라고 해야 한다');
  assert.match(A.AGENT_GUIDE, /지금 참인 것만/, '이력을 쌓으면 모순이 남는다');
  assert.match(A.AGENT_GUIDE, /새 이름을 지어내지 마세요/,
    '주제 이름이 흔들리면 중복 주제가 된다');
  assert.match(A.AGENT_GUIDE, /추천하지 마세요/, '상품 추천 금지가 빠졌다');
  assert.match(A.AGENT_GUIDE, /period/, '기간을 넘겨짚지 말라고 해야 한다');
  // 우리가 쓰는 이름과 안내가 어긋나면 AI 가 못 찾는다.
  assert.ok(A.AGENT_GUIDE.indexOf(A.CFG.latestName) !== -1);
  assert.ok(A.AGENT_GUIDE.indexOf(A.CFG.memoryFolder) !== -1);
  assert.ok(A.AGENT_GUIDE.indexOf(A.CFG.statusName) !== -1);
});

test('AGENT.md 가 AI 쪽 저장 방침과의 충돌을 먼저 끊는다', () => {
  // ⚠️ **실측에서 이것 때문에 한 줄도 안 적혔다.** AI 가 "재무 정보는
  //    저장하지 않는다" 는 자기 서비스 방침을 유저의 드라이브 폴더에까지
  //    적용했다. 그 폴더는 유저 파일이지 AI 의 저장소가 아니다 —
  //    안내문이 먼저 말해 주지 않으면 매번 같은 자리에서 멎는다.
  const A = loadApp();
  assert.match(A.AGENT_GUIDE, /당신의 메모리가 아닙니다/, '충돌을 안 끊고 있다');
  assert.match(A.AGENT_GUIDE, /방침은 여기에 적용되지\s*\n?\s*않습니다/,
    'AI 쪽 방침이 여기 적용 안 된다고 명시해야 한다');
});

test('AGENT.md 가 언제 쓰는지를 말하고, 브레이크가 액셀을 덮지 않는다', () => {
  // ⚠️ 처음엔 '쓰지 마세요' 가 14문장, '쓰세요' 가 8문장이었다. 자제 규칙을
  //    쌓다 보니 **안내문 전체가 순 감속**이 됐고, 실제로 AI 는 아무것도
  //    안 적었다. 트리거가 명시돼야 하고, 감속이 가속보다 많으면 안 된다.
  const A = loadApp();
  assert.match(A.AGENT_GUIDE, /언제 쓰나/, '쓸 시점을 알려주는 절이 없다');
  assert.match(A.AGENT_GUIDE, /지금 안 적으면 사라집니다/, '왜 지금인지가 빠졌다');
  assert.match(A.AGENT_GUIDE, /답을 마치기 전에/, '언제까지 적을지가 없다');

  const brakes = (A.AGENT_GUIDE.match(/쓰지 마세요|적지 마세요|만들지 마세요|하지 마세요|지어내지 마세요/g) || []).length;
  const gas = (A.AGENT_GUIDE.match(/적어 두세요|적으세요|새로 만드세요|만드세요|쓰세요|쓸 때입니다/g) || []).length;
  assert.ok(gas >= brakes, '감속 ' + brakes + ' 문장 vs 가속 ' + gas + ' 문장 — 또 기울었다');
});

// ── 메모리 ────────────────────────────────────────────────────────

test('memoTopic — 날짜를 벗기고 주제만 남긴다', () => {
  const A = loadApp();
  assert.equal(A.memoTopic('2026-08-09-목표.md'), '목표');
  assert.equal(A.memoTopic('2026-08-09_수입.md'), '수입');
  assert.equal(A.memoTopic('2026-08-09T14:30-이직생각.md'), '이직생각');
  // 초까지 붙은 ISO 도 받는다. 예전엔 여기서 null 이 나와 그 주제가
  // **영영 안 치워졌다** — 모순되는 파일이 계속 쌓이는 쪽이다.
  assert.equal(A.memoTopic('2026-08-09T14:30:05-목표.md'), '목표');
  assert.equal(A.memoTopic('2026-08-09 14:30-목표.md'), '목표');
});

test('memoTopic — .md 가 아니면 규칙 밖이다', () => {
  // ⚠️ 예전엔 확장자를 먼저 떼고 나머지를 봐서 '2026-08-09-카드명세.pdf' 가
  //    '카드명세.pdf' 라는 주제로 잡혔다. 날짜를 앞에 붙여 정리해 둔 유저의
  //    명세서·사진이 날마다 하나씩 휴지통으로 갔다.
  const A = loadApp();
  ['2026-08-09-카드명세.pdf', '2026-07-01-가족사진.jpg', '2026-08-09-메모.txt']
    .forEach((n) => assert.equal(A.memoTopic(n), null, n));
});

test('memoTopic — 맨 네 자리 숫자를 시각으로 읽지 않는다', () => {
  // ⚠️ 읽으면 '2030-은퇴계획' 과 '2040-은퇴계획' 이 같은 주제가 되고
  //    **서로 다른 둘 중 하나가 지워진다.** 못 알아보는 쪽이 안전하다.
  const A = loadApp();
  assert.equal(A.memoTopic('2026-08-09-2030-은퇴계획.md'), '2030-은퇴계획');
  assert.notEqual(
    A.memoTopic('2026-08-09-2030-은퇴계획.md'),
    A.memoTopic('2026-08-10-2040-은퇴계획.md'),
    '서로 다른 두 주제가 하나로 합쳐졌다');
});

test('memoTopic — 규칙에 안 맞으면 null (유저 파일을 건드리지 않는다)', () => {
  const A = loadApp();
  [ '메모.md', 'AGENT.md', '내가 쓴 글.md', '2026-목표.md',
    '2026-08-09-   .md' ].forEach((n) => {
    // '' 가 아니라 null 이어야 한다. 계약이 그렇고, === null 로 보는
    // 다음 사람이 조용히 틀린다.
    assert.strictEqual(A.memoTopic(n), null, n);
  });
});

test('pruneMemory — 주제마다 최신 하나만 남긴다', () => {
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-01-목표.md', '2026-08-01'],
    ['2026-08-09-목표.md', '2026-08-09'],
    ['2026-08-05-수입.md', '2026-08-05'],
  ]);
  const r = A.pruneMemory(root);
  assert.equal(r.topics, 2);
  assert.equal(r.trashed, 1);
  assert.ok(!mem._has('2026-08-01-목표.md'), '옛 것이 남아 있다');
  assert.ok(mem._has('2026-08-09-목표.md'), '최신을 지웠다');
  assert.ok(mem._has('2026-08-05-수입.md'), '다른 주제를 건드렸다');
});

test('pruneMemory — 순서는 파일 이름이 아니라 생성 시각으로 본다', () => {
  // AI 가 날짜를 틀리게 붙일 수 있다. 시간대를 모르거나 오늘이 며칠인지 모른다.
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-20-목표.md', '2026-08-01'],   // 이름은 8/20 인데 먼저 만들어졌다
    ['2026-08-01-목표.md', '2026-08-20'],
  ]);
  A.pruneMemory(root);
  assert.ok(mem._has('2026-08-01-목표.md'), '이름만 보고 지웠다');
  assert.ok(!mem._has('2026-08-20-목표.md'));
});

test('pruneMemory — 규칙에 안 맞는 파일은 손대지 않는다', () => {
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    '내가 직접 쓴 메모.md',
    '사진.png',
    '2026-08-09-카드명세.pdf',   // 날짜가 붙어 있어도 .md 가 아니면 남의 것이다
    '2026-07-01-가족사진.jpg',
  ]);
  const r = A.pruneMemory(root);
  assert.equal(r.trashed, 0, '유저 파일을 지웠다');
  assert.equal(r.unnamed, 4, '유저 파일이 몇 개인지 안 세고 있다');
  assert.equal(r.memos, 0);
  assert.equal(mem._count(), 4, '유저 파일을 지웠다');
});

// ── 메모리: 이름이 열쇠라서 생기는 것들 ──────────────────────────────

test('pruneMemory — 주제가 constructor 여도 죽지 않는다', () => {
  // ⚠️ 평범한 {} 는 'constructor' 를 이미 갖고 있다. 배열을 안 만들고 함수에
  //    .push 를 불러 TypeError 가 나고, 그 예외가 writeStatus 를 타고 올라가
  //    **매일 아침 실행 전체를 죽인다.** 파일 하나로 도구가 멎는다.
  //
  //    'toString' 으로는 이걸 못 잡는다 — topicKey 가 소문자로 접어서
  //    'tostring' 이 되고, 그건 프로토타입에 없다. 원래 소문자인 이름이라야
  //    실제로 부딪힌다.
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-01-constructor.md', '2026-08-01'],
    ['2026-08-09-constructor.md', '2026-08-09'],
  ]);
  const r = A.pruneMemory(root);       // 던지면 여기서 끝난다
  assert.equal(r.trashed, 1);
  assert.ok(mem._has('2026-08-09-constructor.md'));
});

test('pruneMemory — 주제가 __proto__ 여도 조용히 새지 않는다', () => {
  // {} 에서는 대입이 프로토타입을 갈아 끼워서 Object.keys 에 안 잡힌다.
  // 죽지는 않지만 그 주제만 영영 안 치워진다 — 더 찾기 어려운 쪽이다.
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-01-__proto__.md', '2026-08-01'],
    ['2026-08-09-__proto__.md', '2026-08-09'],
  ]);
  const r = A.pruneMemory(root);
  assert.equal(r.topics, 1, '주제로 세지 못했다');
  assert.equal(r.trashed, 1, '옛 것이 남았다');
  assert.ok(mem._has('2026-08-09-__proto__.md'));
});

test('topicKey — 눈에 같은 주제는 같은 열쇠가 나온다', () => {
  const A = loadApp();
  // macOS 가 만든 이름은 자모가 풀려서 온다. 눈으로는 구분이 안 된다.
  const nfd = '목표'.normalize('NFD');
  assert.notEqual(nfd, '목표', '이 환경에서는 NFD 가 안 만들어진다 — 테스트가 무의미하다');
  assert.equal(A.topicKey(nfd), A.topicKey('목표'));
  assert.equal(A.topicKey('고정 지출'), A.topicKey('고정지출'));
  assert.equal(A.topicKey('Goal'), A.topicKey('goal'));
  // 서로 다른 주제까지 뭉개면 안 된다.
  assert.notEqual(A.topicKey('목표'), A.topicKey('수입'));
});

test('pruneMemory — 자모가 풀린 이름도 같은 주제로 묶는다', () => {
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-01-' + '목표'.normalize('NFD') + '.md', '2026-08-01'],
    ['2026-08-09-목표.md', '2026-08-09'],
  ]);
  const r = A.pruneMemory(root);
  assert.equal(r.topics, 1, '같은 주제를 둘로 봤다 — AI 가 모순되는 파일 둘을 읽는다');
  assert.equal(r.trashed, 1);
  assert.ok(mem._has('2026-08-09-목표.md'));
});

test('pruneMemory — 이름이 똑같은 파일이 둘이어도 하나만 남는다', () => {
  // ⚠️ 드라이브는 같은 이름을 막지 않는다. AI 가 하루에 같은 주제를 두 번
  //    쓰면 이름이 글자 하나까지 같은 파일이 **두 개** 생긴다.
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-09-목표.md', '2026-08-09T01:00:00Z'],
    ['2026-08-09-목표.md', '2026-08-09T09:00:00Z'],
  ]);
  assert.equal(mem._count(), 2, '가짜 드라이브가 이름으로 덮어썼다 — 제약이 사라졌다');
  const r = A.pruneMemory(root);
  assert.equal(r.trashed, 1);
  assert.equal(mem._count(), 1);
});

test('pruneMemory — 생성 시각이 같으면 이름이 큰 쪽을 남긴다', () => {
  // 한 턴에 두 개를 쓰면 초까지 같을 수 있다. 안 정해 두면 어느 쪽이
  // 살아남을지 실행마다 달라진다.
  const A = loadApp();
  const { root, mem } = memoryWith(A, [
    ['2026-08-09-목표.md', '2026-08-09T00:00:00Z'],
    ['2026-08-10-목표.md', '2026-08-09T00:00:00Z'],
  ]);
  const r = A.pruneMemory(root);
  assert.equal(r.trashed, 1);
  assert.ok(mem._has('2026-08-10-목표.md'), '동점에서 옛 날짜를 남겼다');
});

test('pruneMemory — 한 번에 지우는 개수에 상한이 있다', () => {
  // setTrashed 하나가 드라이브 왕복 한 번이고, 정리는 상태를 쓰기 전에
  // 6분짜리 실행 예산 안에서 돈다. 상한이 없으면 시간 초과가 상태 파일까지
  // 못 쓰게 만든다.
  const A = loadApp();
  const n = A.CFG.memoryTrashBudget + 5;
  const names = [];
  for (let i = 0; i < n; i++) {
    // 이름까지 똑같은 파일 n 개 — 드라이브가 허용하는 그 모양 그대로.
    names.push(['2026-08-09-목표.md', new Date(Date.UTC(2026, 7, 9, 0, 0, i))]);
  }
  const { root, mem } = memoryWith(A, names);
  const r = A.pruneMemory(root);
  assert.equal(r.trashed, A.CFG.memoryTrashBudget, '상한을 넘겨 지웠다');
  assert.equal(r.trashCapped, true, '잘렸다고 알리지 않았다');
  assert.equal(mem._count(), n - A.CFG.memoryTrashBudget);
});

test('pruneMemory — 상한에 딱 맞으면 잘렸다고 하지 않는다', () => {
  // 예산을 정확히 다 쓴 것과 남은 걸 못 지운 것은 다른 사건이다.
  const A = loadApp();
  const names = [];
  for (let i = 0; i <= A.CFG.memoryTrashBudget; i++) {
    names.push(['2026-08-09-목표.md', new Date(Date.UTC(2026, 7, 9, 0, 0, i))]);
  }
  const r = A.pruneMemory(memoryWith(A, names).root);
  assert.equal(r.trashed, A.CFG.memoryTrashBudget);
  assert.equal(r.trashCapped, undefined, '딱 맞았는데 잘렸다고 한다');
});

test('pruneMemory — 한 파일이 못 지워져도 나머지는 계속 치운다', () => {
  // ⚠️ 공유 폴더에서는 남이 만든 파일에 setTrashed 가 'Access denied' 로
  //    던진다. 그 하나 때문에 멈추면 **그날부터 정리가 영영 안 된다.**
  const A = loadApp();
  const { root, mem, files } = memoryWith(A, [
    ['2026-08-01-목표.md', '2026-08-01'],
    ['2026-08-09-목표.md', '2026-08-09'],
    ['2026-08-01-수입.md', '2026-08-01'],
    ['2026-08-09-수입.md', '2026-08-09'],
  ]);
  files[0].setTrashed = () => { throw new Error('Access denied: DriveApp'); };

  const r = A.pruneMemory(root);
  assert.equal(r.trashed, 1, '멀쩡한 쪽을 안 치웠다');
  assert.equal(r.trashFailed, 1, '실패를 안 알렸다');
  assert.ok(mem._has('2026-08-01-목표.md'), '못 지운 건 남아 있어야 한다');
  assert.ok(!mem._has('2026-08-01-수입.md'), '다른 주제가 막혔다');
});

test('pruneMemory — 이름이 같은 메모리 폴더가 둘이어도 다 치운다', () => {
  // ⚠️ 드라이브는 폴더 이름도 안 막는다. 하나만 보면 나머지는 영영 안
  //    치워지고, 커넥터는 양쪽을 다 읽어 모순되는 파일을 본다.
  const A = loadApp();
  const root = fakeFolder('돈동생');
  const a = root.createFolder(A.CFG.memoryFolder);
  const b = root.createFolder(A.CFG.memoryFolder);
  const put = (folder, name, t) => {
    const f = folder.createFile(fakeBlob(name, 'x'));
    f.getDateCreated = () => new Date(t);
  };
  put(a, '2026-08-01-목표.md', '2026-08-01');
  put(b, '2026-08-09-목표.md', '2026-08-09');

  const r = A.pruneMemory(root);
  assert.equal(r.topics, 1, '두 폴더의 같은 주제를 따로 셌다');
  assert.equal(r.trashed, 1);
  assert.equal(a._count(), 0, '첫 폴더의 옛 것이 남았다');
  assert.ok(b._has('2026-08-09-목표.md'), '최신을 지웠다');
});

test('pruneMemory — getDateCreated 를 파일마다 한 번만 묻는다', () => {
  // 드라이브 호출이다. 비교 함수 안에서 부르면 정렬 내내 다시 묻는다.
  const A = loadApp();
  const names = [];
  for (let i = 1; i <= 8; i++) names.push('2026-08-0' + i + '-목표.md');
  const { root, files } = memoryWith(A, names);
  let calls = 0;
  files.forEach((f, i) => {
    f.getDateCreated = () => { calls++; return new Date('2026-08-0' + (i + 1)); };
  });
  A.pruneMemory(root);
  assert.equal(calls, 8, '파일당 한 번을 넘었다 (' + calls + '회)');
});

test('markMemorySeen — 처음 본 때를 남기고, 그 전까지는 never 로 답한다', () => {
  const A = loadApp();
  const props = propsStub({});
  // 비어 있으면 아직 못 본 것이다 — 기록도 남기지 않는다.
  assert.equal(A.markMemorySeen(props, 0, '2026-08-08T22:05:00.000Z'), false);
  assert.equal(props.getProperty('MEMORY_FIRST_SEEN'), null);
  // ⚠️ 앞 10자만 떼면 '2026-08-08' 이 되는데 그건 한국 시각으로 8/9 오전
  //    7시다. 매일 아침 도는 트리거는 늘 그 구간에 걸린다. 통째로 둔다.
  assert.equal(A.markMemorySeen(props, 3, '2026-08-08T22:05:00.000Z'), true);
  assert.equal(props.getProperty('MEMORY_FIRST_SEEN'), '2026-08-08T22:05:00.000Z');
  // 그 뒤에 다 지워져도 '한 번도 없었다' 로 돌아가지 않는다.
  assert.equal(A.markMemorySeen(props, 0, '2026-09-01T00:00:00.000Z'), true);
  assert.equal(props.getProperty('MEMORY_FIRST_SEEN'), '2026-08-08T22:05:00.000Z',
    '처음 본 때가 밀렸다');
});

test('writeStatus — 정리가 실패해도 상태 파일은 남는다', () => {
  // ⚠️ 여기서 던지면 상태 파일과 시트가 통째로 안 써지고, runGuarded 의
  //    catch 가 부르는 writeStatus 도 같은 자리에서 또 던진다. **"왜 아무
  //    일도 안 일어나?" 를 진단할 파일 자체가 사라진다.**
  const A = loadApp();
  const env = fakeEnv({});
  const folder = A.ensureFolder(env.drive, A.CFG.folderName);
  const mem = folder.createFolder(A.CFG.memoryFolder);
  mem.getFiles = () => { throw new Error('Service Drive is temporarily unavailable'); };

  A.writeStatus(env, { ok: true, message: '처리 완료' });   // 던지면 여기서 끝난다
  const status = JSON.parse(folder._get(A.CFG.statusName).getBlob().getDataAsString());
  assert.equal(status.ok, true, '실행 결과가 정리 실패에 묻혔다');
  assert.match(status.memoryError, /temporarily unavailable/);
});

test('writeStatus — 메모리를 한 번도 못 봤으면 상태에 적는다', () => {
  // "왜 기억을 못 해?" 를 받았을 때, 커넥터가 읽기 전용인지 그냥 안 쓴
  // 건지를 가를 유일한 자리다.
  const A = loadApp();
  const env = fakeEnv({});
  A.writeStatus(env, { ok: true, message: '처리할 새 메일이 없어요.' });
  const folder = env._root.getFoldersByName(A.CFG.folderName).next();
  const status = () => JSON.parse(folder._get(A.CFG.statusName).getBlob().getDataAsString());
  assert.equal(status().memoryNeverUsed, true);
  assert.equal(status().memory.memos, 0);

  // AI 가 한 번 쓰고 나면 사라진다.
  const mem = folder.getFoldersByName(A.CFG.memoryFolder).next();
  mem.createFile(fakeBlob('2026-08-09-목표.md', 'x'));
  A.writeStatus(env, { ok: true, message: '처리 완료' });
  assert.equal(status().memoryNeverUsed, undefined, '이미 봤는데 아직 never 라고 한다');
  assert.equal(status().memory.memos, 1);
});

test('pruneMemory — 메모리 폴더가 없으면 조용히 넘어간다', () => {
  const A = loadApp();
  assert.equal(A.pruneMemory(fakeFolder('돈동생')), null);
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
