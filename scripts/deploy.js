#!/usr/bin/env node
/**
 * Apps Script 프로젝트에 올리고, 버전을 만들고, **올라간 것을 되읽어 대조한다.**
 *
 *     node scripts/deploy.js --snapshot-manifest   # 처음 한 번: 원격 매니페스트를 저장소로
 *     node scripts/deploy.js --library             # 라이브러리 업로드 + 배포 → 번호 출력
 *     node scripts/deploy.js --template            # 템플릿 업로드 (번호 주입 후)
 *
 * ━━ 왜 clasp 를 안 쓰나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 셋 다 이 저장소에서는 비싼 값이다.
 *
 *   1. `clasp login` 기본 스코프에 `cloud-platform` 이 들어간다. 토큰 하나가
 *      계정의 **모든 Apps Script + GCP 전체**를 연다. 여기서 필요한 건
 *      `script.projects` + `script.deployments` 둘뿐이다
 *   2. 의존성이 생긴다. 이 저장소는 `dependencies` 가 0개고 CI 가 npm
 *      레지스트리에 접촉조차 안 한다 — 그게 지금 공급망 경로를 닫고 있다
 *   3. clasp 3.x 는 Node ≥ 22 를 요구한다. 여기는 20 이다
 *
 * 그리고 clasp 는 **비대화형에서 매니페스트가 바뀌면 push 를 건너뛰고 종료 코드
 * 0 을 낸다** (`isInteractive = process.stdout.isTTY`). 이 프로젝트가 제일
 * 무서워하는 종류의 실패다. 직접 치면 애초에 안 만난다.
 *
 * ━━ 자격증명 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * `~/.config/k-money/deploy.json` (chmod 600). **저장소에 두지 않는다.**
 * 이 토큰은 유저 메일함 전체를 읽는 권한으로 도는 코드를 배포할 수 있다.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SNAPSHOT = path.join(ROOT, 'appsscript', 'appsscript.library.json');
const CONFIG = process.env.KMONEY_DEPLOY_CONFIG ||
  path.join(os.homedir(), '.config', 'k-money', 'deploy.json');

const API = 'https://script.googleapis.com/v1';

// ─── 자격증명 ────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    throw new Error(
      '배포 설정이 없다: ' + CONFIG + '\n' +
      '  {\n' +
      '    "clientId": "...", "clientSecret": "...", "refreshToken": "...",\n' +
      '    "libraryScriptId": "...", "templateScriptId": "..."\n' +
      '  }\n' +
      '  스코프는 script.projects + script.deployments 둘만 받는다.');
  }

  // 이 파일은 남의 메일함을 읽는 코드를 배포할 수 있는 열쇠다.
  // 그룹·기타 읽기 권한이 열려 있으면 진행하지 않는다.
  const mode = fs.statSync(CONFIG).mode & 0o077;
  if (mode !== 0) {
    throw new Error(CONFIG + ' 의 권한이 너무 넓다 — chmod 600 하고 다시 실행해라');
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  ['clientId', 'clientSecret', 'refreshToken', 'libraryScriptId', 'templateScriptId']
    .forEach(function (k) {
      if (!cfg[k]) throw new Error('배포 설정에 ' + k + ' 가 없다');
    });
  return cfg;
}

async function accessToken(cfg) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // 토큰이 죽는 조건이 여럿이라 원문을 그대로 보여준다 — 짐작하게 두지 않는다.
    throw new Error('access token 을 못 받았다 (' + res.status + '): ' +
      JSON.stringify(body) + '\n' +
      '  refresh token 은 이럴 때 죽는다: 동의화면이 "테스트 중"(7일) /\n' +
      '  6개월 미사용 / 계정 비밀번호 변경 / 사용자가 직접 취소');
  }
  return body.access_token;
}

async function api(token, method, url, body) {
  const res = await fetch(API + url, {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403
      ? '\n  403 이면 대개 이것이다: script.google.com/home/usersettings 에서\n' +
        '  "Google Apps Script API" 토글이 꺼져 있다. 계정 단위 설정이라 프로그램으로 못 켠다.'
      : '';
    throw new Error(method + ' ' + url + ' 실패 (' + res.status + '): ' + text + hint);
  }
  return text ? JSON.parse(text) : {};
}

// ─── 파일 ↔ API 표현 ─────────────────────────────────────────────────

/** `core.gs` → { name: 'core', type: 'SERVER_JS' } · 매니페스트는 이름이 고정이다. */
function toApiFile(fileName, source) {
  if (fileName === 'appsscript.json') return { name: 'appsscript', type: 'JSON', source: source };
  if (fileName.endsWith('.gs')) {
    return { name: fileName.slice(0, -3), type: 'SERVER_JS', source: source };
  }
  if (fileName.endsWith('.html')) {
    return { name: fileName.slice(0, -5), type: 'HTML', source: source };
  }
  throw new Error('올릴 수 없는 파일 형식: ' + fileName);
}

function readBuild(target, names) {
  return names.map(function (n) {
    return toApiFile(n, fs.readFileSync(path.join(BUILD, target, n), 'utf8'));
  });
}

function findManifest(files) {
  const m = files.filter(function (f) { return f.name === 'appsscript'; })[0];
  if (!m) throw new Error('원격 프로젝트에 매니페스트가 없다 — 잘못된 scriptId 인가?');
  return m;
}

// ─── 되읽기 대조 ─────────────────────────────────────────────────────

/**
 * 올린 것과 구글이 **실제로 저장한 것**을 맞춰 본다.
 *
 * `.gs` 는 바이트로, 매니페스트는 **파싱해서** 비교한다. JSON 은 우리가
 * 다시 찍어내면서 들여쓰기가 달라지는데, 그건 내용의 차이가 아니다.
 * 바이트로 보면 매번 틀렸다고 나와서 **경보가 무의미해진다.**
 */
function diffFiles(sent, got) {
  const problems = [];
  const gotByName = {};
  got.forEach(function (f) { gotByName[f.name] = f; });

  sent.forEach(function (f) {
    const g = gotByName[f.name];
    if (!g) { problems.push(f.name + ' 이 원격에 없다'); return; }
    if (f.type === 'JSON') {
      const a = JSON.stringify(JSON.parse(f.source));
      const b = JSON.stringify(JSON.parse(g.source));
      if (a !== b) problems.push(f.name + ' 매니페스트 내용이 다르다');
    } else if (f.source !== g.source) {
      problems.push(f.name + ' 내용이 다르다 (' + f.source.length + ' vs ' + g.source.length + '자)');
    }
    delete gotByName[f.name];
  });

  // 남은 것 = 우리가 안 보냈는데 원격에 있는 것.
  // updateContent 는 요청에 없는 파일을 지우므로 원칙적으로 없어야 한다.
  Object.keys(gotByName).forEach(function (n) {
    problems.push(n + ' 이 원격에만 있다 (안 보냈는데 남았다)');
  });

  return problems;
}

// ─── 명령 ────────────────────────────────────────────────────────────

async function snapshotManifest(token, cfg) {
  const content = await api(token, 'GET', '/projects/' + cfg.libraryScriptId + '/content');
  const m = findManifest(content.files || []);
  const pretty = JSON.stringify(JSON.parse(m.source), null, 2) + '\n';
  fs.writeFileSync(SNAPSHOT, pretty);
  console.log('→ ' + path.relative(ROOT, SNAPSHOT) + ' (원격에서 내려받음)');
  console.log(pretty);
}

async function deployLibrary(token, cfg, description) {
  const build = require('./build-deploy');

  // 매니페스트는 지어내지 않는다. 원격 것을 읽어 **그대로 되쓴다.**
  const before = await api(token, 'GET', '/projects/' + cfg.libraryScriptId + '/content');
  const manifest = findManifest(before.files || []);

  if (fs.existsSync(SNAPSHOT)) {
    const a = JSON.stringify(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
    const b = JSON.stringify(JSON.parse(manifest.source));
    if (a !== b) {
      throw new Error(
        '원격 라이브러리 매니페스트가 저장소 스냅샷과 다르다.\n' +
        '  누군가 편집기에서 고쳤다는 뜻이다. 확인하고 --snapshot-manifest 로 갱신해라.');
    }
  }

  const files = readBuild('library', build.TARGETS.library.files).concat([manifest]);
  await api(token, 'PUT', '/projects/' + cfg.libraryScriptId + '/content', { files: files });

  // 배포를 만들면 버전이 자동으로 생기고, **번호가 응답에 실려 온다.**
  // 손으로 읽어 적으려다 두 번 연속 틀린 그 숫자다.
  const dep = await api(token, 'POST', '/projects/' + cfg.libraryScriptId + '/deployments',
    { versionNumber: undefined, manifestFileName: 'appsscript', description: description });
  const version = (dep.deploymentConfig || {}).versionNumber;
  if (!/^\d+$/.test(String(version))) {
    throw new Error('배포 응답에 정수 versionNumber 가 없다: ' + JSON.stringify(dep));
  }

  // 구글이 실제로 저장한 그 버전을 되읽어 맞춰 본다.
  const after = await api(token, 'GET',
    '/projects/' + cfg.libraryScriptId + '/content?versionNumber=' + version);
  const problems = diffFiles(files, after.files || []);
  if (problems.length) {
    throw new Error('올린 것과 저장된 것이 다르다 (버전 ' + version + '):\n  - ' +
      problems.join('\n  - '));
  }

  return { version: version, deploymentId: dep.deploymentId, files: files.length };
}

async function deployTemplate(token, cfg) {
  const build = require('./build-deploy');
  const names = build.TARGETS.template.files.concat([build.TARGETS.template.manifest]);
  const files = readBuild('template', names);

  await api(token, 'PUT', '/projects/' + cfg.templateScriptId + '/content', { files: files });

  // 템플릿은 버전을 안 만든다 — 유저가 "사본 만들기" 로 뜨는 건 HEAD 다.
  const after = await api(token, 'GET', '/projects/' + cfg.templateScriptId + '/content');
  const problems = diffFiles(files, after.files || []);
  if (problems.length) {
    throw new Error('템플릿: 올린 것과 저장된 것이 다르다:\n  - ' + problems.join('\n  - '));
  }

  const m = JSON.parse(findManifest(files).source);
  return { libVersion: m.dependencies.libraries[0].version, files: files.length };
}

// ─── 진입점 ──────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const token = await accessToken(cfg);

  if (argv.includes('--snapshot-manifest')) {
    await snapshotManifest(token, cfg);
    return;
  }

  if (argv.includes('--library')) {
    const i = argv.indexOf('--description');
    const desc = i === -1 ? 'v' + fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()
      : argv[i + 1];
    const out = await deployLibrary(token, cfg, desc);
    console.log('→ 라이브러리 ' + out.files + '개 파일, 배포 버전 ' + out.version +
      ' (' + out.deploymentId + ')');
    console.log('→ 되읽기 대조 통과');
    // 다음 단계가 파싱한다. 마지막 줄에 번호만 낸다.
    console.log('LIBRARY_VERSION=' + out.version);
    return;
  }

  if (argv.includes('--template')) {
    const out = await deployTemplate(token, cfg);
    console.log('→ 템플릿 ' + out.files + '개 파일 (라이브러리 v' + out.libVersion + ')');
    console.log('→ 되읽기 대조 통과');
    return;
  }

  throw new Error('무엇을 할지 안 골랐다: --snapshot-manifest | --library | --template');
}

module.exports = { toApiFile: toApiFile, diffFiles: diffFiles, CONFIG: CONFIG };

if (require.main === module) {
  main().catch(function (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  });
}
