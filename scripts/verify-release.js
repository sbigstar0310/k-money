#!/usr/bin/env node
/**
 * 릴리스 정합성 검사 — **전부 문자열·정수 비교다.**
 *
 *     node scripts/verify-release.js 13
 *
 * ━━ 왜 스크립트인가 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 처음엔 이걸 에이전트에게 물었다. 그런데 여섯 항목이 **전부 동등성 비교**다.
 * 확실한 검사를 불확실한 검사로 덮어쓰는 셈이었다.
 *
 * 이 저장소가 이미 쓰는 원칙 그대로다 — **순회로 알 수 있는 걸 선택에 맡기지
 * 않는다.** 에이전트는 사람만 할 수 있는 판단에만 쓴다.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

function check(libVersion) {
  const problems = [];
  const say = function (ok, msg) { if (!ok) problems.push(msg); };

  const version = read('VERSION').trim();
  const pkg = JSON.parse(read('package.json')).version;
  const container = (read('appsscript/container.gs').match(/CONTAINER_VERSION = '([^']*)'/) || [])[1];
  const core = (read('appsscript/core.gs').match(/KM\.VERSION = '([^']*)'/) || [])[1];
  const readme = (read('README.md').match(/현재 버전 \*\*([\d.]+)\*\*/) || [])[1];

  say(pkg === version, 'package.json 버전이 VERSION 과 다르다: ' + pkg + ' vs ' + version);
  say(container === version, 'container.gs 버전이 다르다: ' + container);
  say(core === version, 'core.gs 버전이 다르다: ' + core);
  say(readme === version, 'README 버전이 다르다: ' + readme);

  const log = read('CHANGELOG.md');
  const head = log.indexOf('## ' + version + ' — ');
  say(head !== -1, 'CHANGELOG 에 ' + version + ' 항목이 없다');
  if (head !== -1) {
    const line = log.slice(head, log.indexOf('\n', head));
    say(new RegExp('라이브러리 버전 `' + libVersion + '`').test(line),
      'CHANGELOG 의 배포 번호가 ' + libVersion + ' 이 아니다: ' + line.trim());
    const section = log.slice(head, log.indexOf('\n## ', head + 1));
    say(/🔴|🟡|⚪/.test(section), '등급이 없다');
  }

  // '대기' 가 어디에도 남으면 안 된다 — 지난 릴리스가 반쯤 끝난 흔적이다.
  say(!/라이브러리 버전 대기/.test(log), "CHANGELOG 에 '대기' 가 남아 있다");

  const deployDoc = read('docs/deploy.md');
  const rows = [...deployDoc.matchAll(/^\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|/gm)];
  const last = rows[rows.length - 1];
  say(last && last[1] === String(libVersion),
    '배포 이력표 마지막 행이 ' + libVersion + ' 이 아니다: ' + (last ? last[1] : '없음'));
  say(last && last[2] === version,
    '배포 이력표 마지막 행의 코드 버전이 ' + version + ' 이 아니다');

  const manifest = JSON.parse(read('appsscript/appsscript.json'));
  const lib = manifest.dependencies.libraries[0];
  say(lib.version === String(libVersion),
    '템플릿 매니페스트의 라이브러리 참조가 ' + libVersion + ' 이 아니다: ' + lib.version);
  say(lib.developmentMode === false, 'developmentMode 가 false 가 아니다');

  try {
    execFileSync('npm', ['run', 'check'], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    problems.push('npm run check 가 실패한다');
  }

  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  say(dirty === '', '커밋 안 된 변경이 남아 있다:\n    ' + dirty.split('\n').join('\n    '));

  return problems;
}

module.exports = { check: check };

if (require.main === module) {
  const libVersion = process.argv[2];
  if (!/^[1-9]\d*$/.test(String(libVersion))) {
    console.error('사용법: node scripts/verify-release.js <라이브러리번호>');
    process.exit(1);
  }
  const problems = check(libVersion);
  if (problems.length) {
    console.error('✖ 릴리스 정합성 ' + problems.length + '건:');
    problems.forEach(function (p) { console.error('  - ' + p); });
    process.exit(1);
  }
  console.log('→ 릴리스 정합성 통과 (v' + read('VERSION').trim() + ' · 라이브러리 ' + libVersion + ')');
}
