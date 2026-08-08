#!/usr/bin/env node
/**
 * package.json 의 버전을 **버전이 적힌 모든 곳**에 찍는다.
 *
 * `npm version` 훅에서 돈다. 손으로 맞추게 두면 반드시 어긋나고, 어긋나면
 * 유저가 `버전 보기` 에서 거짓말을 읽는다. 어긋난 걸 테스트가 잡긴 하지만
 * (test/main.test.js), 잡히는 시점은 **다음 릴리스**라 이미 늦다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const version = require(path.join(ROOT, 'package.json')).version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('버전이 semver 가 아니다: ' + version);
  process.exit(1);
}

fs.writeFileSync(path.join(ROOT, 'VERSION'), version + '\n');

// main.gs 는 라이브러리로 배포되지 않는다 — 유저 시트 안의 사본이다.
// 그래서 자기 버전을 스스로 들고 있어야 한다.
const mainPath = path.join(ROOT, 'appsscript', 'main.gs');
const before = fs.readFileSync(mainPath, 'utf8');
const after = before.replace(
  /var MAIN_VERSION = '[^']*'/,
  "var MAIN_VERSION = '" + version + "'");

if (after === before && !before.includes("var MAIN_VERSION = '" + version + "'")) {
  console.error('main.gs 에서 MAIN_VERSION 을 못 찾았다. 이름이 바뀌었나?');
  process.exit(1);
}
fs.writeFileSync(mainPath, after);

console.log('v' + version + ' → VERSION, appsscript/main.gs');
