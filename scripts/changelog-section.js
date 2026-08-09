#!/usr/bin/env node
/**
 * CHANGELOG 에서 한 버전의 절만 잘라낸다 — GitHub 릴리스 노트용.
 *
 *     node scripts/changelog-section.js > /tmp/notes.md
 *     node scripts/changelog-section.js 0.4.2
 *
 * 릴리스 노트를 손으로 복사하면 언젠가 다른 버전을 붙인다. 유저가 읽는
 * 유일한 안내가 CHANGELOG 인데, 릴리스에 붙는 게 그것과 다르면 안 된다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function section(version) {
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const head = log.indexOf('## ' + version + ' — ');
  if (head === -1) throw new Error('CHANGELOG 에 ' + version + ' 항목이 없다');
  const next = log.indexOf('\n## ', head + 1);
  // 헤더 줄은 릴리스 제목이 이미 말하므로 본문만 낸다.
  const body = log.slice(log.indexOf('\n', head) + 1, next === -1 ? log.length : next);
  return body.trim() + '\n';
}

module.exports = { section: section };

if (require.main === module) {
  const version = process.argv[2] || fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  try {
    process.stdout.write(section(version));
  } catch (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  }
}
