#!/usr/bin/env node
/**
 * 배포 번호를 **적어야 할 세 곳에 한 번에** 적는다.
 *
 *     node scripts/record-deploy.js 13
 *
 *   CHANGELOG.md              '라이브러리 버전 대기' → '라이브러리 버전 `13`'
 *   docs/deploy.md            배포 이력표에 행 추가
 *   appsscript/appsscript.json  라이브러리 참조 version
 *
 * ━━ 왜 한 스크립트인가 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 세 곳이 어긋나면 각각 다르게 고장난다.
 *
 *   CHANGELOG 가 틀리면   유저가 드롭다운에서 **엉뚱한 번호**를 고른다
 *   deploy.md 가 비면     다음 배포 때 무엇이 최신인지 우리가 모른다
 *   매니페스트가 옛것이면 **새로 사본 뜨는 사람이 옛 라이브러리를 받는다**
 *
 * 마지막이 제일 조용하다 — 오류 없이 옛 코드로 돌고, 아무도 모른다.
 * 그래서 하나라도 못 고치면 **아무것도 안 고치고 죽는다.**
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const DEPLOY_DOC = path.join(ROOT, 'docs', 'deploy.md');
const MANIFEST = path.join(ROOT, 'appsscript', 'appsscript.json');

const BEGIN = '<!-- BEGIN:deploy-history -->';
const END = '<!-- END:deploy-history -->';

/** CHANGELOG 최신 항목의 '대기' 를 실제 번호로 바꾼다. */
function recordChangelog(text, version, libVersion) {
  const head = '## ' + version + ' — ';
  const at = text.indexOf(head);
  if (at === -1) throw new Error('CHANGELOG 에 ' + version + ' 항목이 없다');

  const eol = text.indexOf('\n', at);
  const line = text.slice(at, eol);

  if (/라이브러리 버전 `\d+`/.test(line)) {
    const already = line.match(/라이브러리 버전 `(\d+)`/)[1];
    if (already !== String(libVersion)) {
      throw new Error('CHANGELOG 에 이미 다른 번호가 적혀 있다: ' + already +
        ' (지금 배포는 ' + libVersion + ')');
    }
    return { text: text, changed: false };
  }

  if (!/라이브러리 버전 대기/.test(line)) {
    throw new Error('CHANGELOG 헤더에 라이브러리 버전 자리가 없다:\n  ' + line);
  }

  return {
    text: text.slice(0, at) +
      line.replace('라이브러리 버전 대기', '라이브러리 버전 `' + libVersion + '`') +
      text.slice(eol),
    changed: true,
  };
}

/**
 * 배포 이력표에 행을 붙인다.
 *
 * ⚠️ `gen-agent-guide.js` 와 같은 함정이 있다 — 마커를 잘못 잡으면 **그 사이가
 *    통째로 지워지는데 아무 에러도 안 난다.** 그래서 지우려는 구간이 정말
 *    표인지(모든 줄이 `|` 로 시작하는지) 먼저 본다.
 */
function recordHistory(text, version, libVersion, note) {
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END, from);
  if (from === -1 || to === -1) {
    throw new Error('docs/deploy.md 에서 ' + BEGIN + ' / ' + END + ' 마커를 못 찾았다');
  }

  const inner = text.slice(from + BEGIN.length, to).trim();
  const lines = inner.split('\n');
  if (!lines.every(function (l) { return l.trim().startsWith('|'); })) {
    throw new Error('마커 사이가 표가 아니다 — 끝을 잘못 잡았다');
  }

  const existing = lines.filter(function (l) {
    return new RegExp('^\\|\\s*' + libVersion + '\\s*\\|').test(l.trim());
  });
  if (existing.length) return { text: text, changed: false };

  // ⚠️ 배포 번호는 늘어나기만 한다. 재실행이 옛 번호를 물고 오면 이력표만
  //    조용히 넘어가고 CHANGELOG·매니페스트는 그 옛 번호로 바뀐다.
  const numbers = lines
    .map(function (l) { return (l.trim().match(/^\|\s*(\d+)\s*\|/) || [])[1]; })
    .filter(Boolean).map(Number);
  const max = numbers.length ? Math.max.apply(null, numbers) : 0;
  if (Number(libVersion) < max) {
    throw new Error('배포 번호가 뒤로 간다: 이력표 최대 ' + max + ', 지금 ' + libVersion);
  }

  const row = '| ' + libVersion + ' | ' + version + ' | ' + note + ' |';
  return {
    text: text.slice(0, from + BEGIN.length) + '\n' + lines.concat([row]).join('\n') + '\n' +
      text.slice(to),
    changed: true,
  };
}

/** 템플릿 매니페스트의 라이브러리 참조를 올린다. 새 사본이 이걸 보고 뜬다. */
function recordManifest(text, libVersion) {
  const manifest = JSON.parse(text);
  const libs = (manifest.dependencies || {}).libraries || [];
  if (libs.length !== 1) throw new Error('매니페스트의 libraries 가 1개가 아니다');
  if (libs[0].version === String(libVersion)) return { text: text, changed: false };

  // 들여쓰기를 보존하려고 문자열 치환을 쓴다. JSON 을 다시 찍으면 저장소
  // 파일의 형식이 통째로 바뀌어 diff 가 읽을 수 없게 된다.
  const before = '"version": "' + libs[0].version + '"';
  const after = '"version": "' + libVersion + '"';
  if (text.split(before).length !== 2) {
    throw new Error('매니페스트에서 version 을 한 곳으로 특정하지 못했다');
  }
  return { text: text.replace(before, after), changed: true };
}

function run(libVersion, note) {
  if (!/^\d+$/.test(String(libVersion))) {
    throw new Error('라이브러리 버전이 정수가 아니다: ' + libVersion +
      ' (deploymentId 를 넘겼나?)');
  }
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

  // 셋 다 메모리에서 먼저 만든다. 하나라도 실패하면 아무것도 안 쓴다.
  const a = recordChangelog(fs.readFileSync(CHANGELOG, 'utf8'), version, libVersion);
  const b = recordHistory(fs.readFileSync(DEPLOY_DOC, 'utf8'), version, libVersion, note);
  const c = recordManifest(fs.readFileSync(MANIFEST, 'utf8'), libVersion);

  // ⚠️ 검증만 원자적이면 부족하다. 쓰기 세 번 중 두 번째가 실패하면
  //    (EACCES·ENOSPC·중간에 죽음) CHANGELOG 만 갱신되고 나머지는 옛것이다.
  //    그래서 전부 `.tmp` 에 쓴 뒤 rename 으로 바꾼다 — 같은 파일시스템의
  //    rename 은 원자적이라 반쯤 쓰인 파일이 남지 않는다.
  const writes = [[CHANGELOG, a], [DEPLOY_DOC, b], [MANIFEST, c]]
    .filter(function (w) { return w[1].changed; });
  const tmps = [];
  try {
    writes.forEach(function (w) {
      const tmp = w[0] + '.tmp';
      fs.writeFileSync(tmp, w[1].text);
      tmps.push([tmp, w[0]]);
    });
    tmps.forEach(function (t) { fs.renameSync(t[0], t[1]); });
  } catch (e) {
    tmps.forEach(function (t) { try { fs.unlinkSync(t[0]); } catch (x) { /* 이미 옮겨졌다 */ } });
    throw e;
  }

  return {
    version: version,
    libVersion: String(libVersion),
    changed: { changelog: a.changed, history: b.changed, manifest: c.changed },
  };
}

module.exports = {
  BEGIN: BEGIN,
  END: END,
  recordChangelog: recordChangelog,
  recordHistory: recordHistory,
  recordManifest: recordManifest,
  run: run,
};

/**
 * `deploy.js --library` 가 남긴 실제 배포 번호.
 *
 * ⚠️ 번호를 손으로 넘기는 자리가 여기 하나 남아 있었다. 이 파이프라인이
 *    없애려던 게 정확히 "사람이 숫자를 옮겨 적는 것" 인데, 마지막 한 곳에서
 *    다시 옮겨 적고 있었다. 인자를 주면 그걸 쓰고, 안 주면 여기서 읽는다.
 */
function deployedVersion() {
  const p = path.join(ROOT, 'build', '.deployed.json');
  if (!fs.existsSync(p)) return null;
  return String(JSON.parse(fs.readFileSync(p, 'utf8')).libVersion);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const given = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const libVersion = given || deployedVersion();
  const i = argv.indexOf('--note');
  const note = i === -1 ? '' : argv[i + 1];

  if (given && deployedVersion() && given !== deployedVersion()) {
    console.error('✖ 준 번호(' + given + ')가 방금 배포한 번호(' + deployedVersion() + ')와 다르다');
    process.exit(1);
  }

  if (!libVersion) {
    console.error('사용법: node scripts/record-deploy.js [라이브러리번호] [--note "한 줄"]');
    console.error('  번호를 생략하면 build/.deployed.json 에서 읽는다 (--library 를 먼저 돌린 경우)');
    process.exit(1);
  }
  try {
    const out = run(libVersion, note);
    // ⚠️ `+` 가 `||` 보다 먼저 묶여서 fallback 이 절대 안 나오던 자리다.
    //    아무것도 안 했을 때 "적었다" 로 읽히면 이 스크립트의 유일한 출력이
    //    거짓말을 하는 셈이다.
    const done = Object.keys(out.changed).filter(function (k) { return out.changed[k]; });
    console.log('→ ' + out.version + ' ← 라이브러리 ' + out.libVersion + '  ' +
      (done.length ? done.join(' · ') : '(이미 다 적혀 있어 바꾼 것 없음)'));
  } catch (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  }
}
