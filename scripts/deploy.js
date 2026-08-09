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
  ['clientId', 'clientSecret', 'refreshToken'].forEach(function (k) {
    if (!cfg[k]) throw new Error('배포 설정에 ' + k + ' 가 없다 — npm run release:login');
  });

  // 주소는 저장소가 안다. 설정 파일에 옛 값이 남아 있어도 그건 안 쓴다 —
  // 두 곳에 적힌 값은 언젠가 어긋나고, 어긋나면 엉뚱한 프로젝트에 배포된다.
  const targets = require('./deploy-targets');
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    refreshToken: cfg.refreshToken,
    libraryScriptId: targets.libraryScriptId(),
    templateScriptId: targets.TEMPLATE_SCRIPT_ID,
  };
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

/**
 * `--library` 가 남긴 실제 배포 번호. 사람이 두 숫자를 눈으로 맞추지 않게 한다.
 *
 * 커밋이 다르면 무시한다 — 다른 커밋에서 배포한 번호를 이번 템플릿에 박으면
 * 유저가 엉뚱한 라이브러리를 받는다. 없는 것보다 낡은 게 나쁘다.
 */
function readDeployed() {
  const p = path.join(BUILD, '.deployed.json');
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const head = require('./build-deploy').gitHead();
  if (head && d.gitHead && d.gitHead !== head) return null;
  return String(d.libVersion);
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
    // 이름과 내용이 같아도 타입이 다르면 다른 파일이다 (SERVER_JS ↔ HTML).
    if (f.type !== g.type) problems.push(f.name + ' 의 타입이 다르다 (' + f.type + ' vs ' + g.type + ')');
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

async function deployLibrary(token, cfg, description, opts) {
  const build = require('./build-deploy');
  build.assertFresh('library');

  // 매니페스트는 지어내지 않는다. 원격 것을 읽어 **그대로 되쓴다.**
  const before = await api(token, 'GET', '/projects/' + cfg.libraryScriptId + '/content');
  const manifest = findManifest(before.files || []);

  // ⚠️ 원격 파일 목록을 **덮어쓰기 전에** 본다. `updateContent` 는 요청에 없는
  //    파일을 전부 지우므로, 편집기에서 누가 파일을 추가해 뒀다면 우리가
  //    그걸 말없이 삭제하게 된다. 덮은 뒤에는 알 방법이 없다.
  const expected = build.TARGETS.library.files
    .map(function (f) { return f.replace(/\.gs$/, ''); }).concat(['appsscript']).sort();
  const remote = (before.files || []).map(function (f) { return f.name; }).sort();
  if (JSON.stringify(expected) !== JSON.stringify(remote)) {
    throw new Error('원격 라이브러리의 파일 목록이 예상과 다르다.\n' +
      '  예상: ' + expected.join(' ') + '\n  실제: ' + remote.join(' ') + '\n' +
      '  편집기에서 누가 고쳤다는 뜻이다. 그대로 올리면 그 파일이 조용히 지워진다.');
  }

  // 스냅샷이 없으면 **대조가 통째로 꺼진다.** 꺼진 줄 모르고 도는 게 최악이라
  // 없으면 죽는다. 처음이면 --snapshot-manifest 로 받아 **읽어보고** 커밋한다.
  if (!fs.existsSync(SNAPSHOT)) {
    if (!opts || !opts.allowMissingSnapshot) {
      throw new Error('appsscript/appsscript.library.json 이 없다.\n' +
        '  node scripts/deploy.js --snapshot-manifest 로 받아서 내용을 확인하고 커밋해라.\n' +
        '  (정말 대조 없이 가려면 --allow-missing-snapshot)');
    }
  } else {
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

  // ⚠️ **버전을 먼저 만든다.** `deployments.create` 에 versionNumber 를 안 주면
  //    버전이 생기는 게 아니라 **HEAD 배포**가 된다. 편집기의 "새 배포" 버튼이
  //    버전을 만들어 주는 것과 API 는 다르다 — 구글 자신의 clasp 도
  //    versionNumber 가 없으면 versions.create 를 먼저 부른다.
  const ver = await api(token, 'POST', '/projects/' + cfg.libraryScriptId + '/versions',
    { description: description });
  const version = ver.versionNumber;
  // 0 은 HEAD 다. 정규식만 쓰면 통과해서 유저 매니페스트에 박히고,
  // HEAD 참조는 라이브러리 편집 권한이 있어야 돌아 **유저 사본에서만 깨진다.**
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('versions.create 가 정수 버전을 안 줬다: ' + JSON.stringify(ver));
  }

  const dep = await api(token, 'POST', '/projects/' + cfg.libraryScriptId + '/deployments',
    { versionNumber: version, manifestFileName: 'appsscript', description: description });
  if ((dep.deploymentConfig || {}).versionNumber !== version) {
    throw new Error('배포가 다른 버전을 가리킨다: 만든 건 ' + version +
      ', 배포는 ' + JSON.stringify((dep.deploymentConfig || {}).versionNumber));
  }

  // 구글이 실제로 저장한 그 버전을 되읽어 맞춰 본다.
  const after = await api(token, 'GET',
    '/projects/' + cfg.libraryScriptId + '/content?versionNumber=' + version);
  const problems = diffFiles(files, after.files || []);
  if (problems.length) {
    throw new Error('올린 것과 저장된 것이 다르다 (버전 ' + version + '):\n  - ' +
      problems.join('\n  - '));
  }

  fs.writeFileSync(path.join(BUILD, '.deployed.json'),
    JSON.stringify({ libVersion: version, deploymentId: dep.deploymentId, gitHead: build.gitHead() }, null, 2) + '\n');

  return { version: version, deploymentId: dep.deploymentId, files: files.length };
}

async function deployTemplate(token, cfg, expectLibVersion) {
  const build = require('./build-deploy');
  build.assertFresh('template');

  const names = build.TARGETS.template.files.concat([build.TARGETS.template.manifest]);
  const files = readBuild('template', names);

  // ⚠️ **여기가 이 파이프라인에서 가장 조용한 실패 자리다.** 템플릿이 옛
  //    라이브러리 번호를 가리키면 새로 사본 뜨는 사람이 옛 코드를 받는데
  //    오류가 하나도 안 난다. 그래서 방금 배포한 번호와 **반드시** 맞춘다.
  const pinned = JSON.parse(findManifest(files).source)
    .dependencies.libraries[0].version;
  const want = expectLibVersion === undefined ? readDeployed() : String(expectLibVersion);
  if (!want) {
    throw new Error('어느 라이브러리 번호를 기대하는지 모른다.\n' +
      '  --expect-lib-version <N> 을 주거나, 같은 세션에서 --library 를 먼저 돌려라.');
  }
  if (pinned !== want) {
    throw new Error('템플릿이 가리키는 라이브러리 번호가 다르다: 매니페스트 ' + pinned +
      ', 기대 ' + want + '\n  node scripts/build-deploy.js --lib-version ' + want + ' 를 먼저 돌려라.');
  }

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

const MODES = ['--snapshot-manifest', '--library', '--template', '--preflight', '--check-config'];

async function main() {
  const argv = process.argv.slice(2);

  // ⚠️ 예전엔 첫 매치에서 반환해서 `--library --template` 을 주면 템플릿이
  //    **조용히 안 나갔다.** 한 줄로 묶어 쓴 사람은 나갔다고 믿는다.
  const picked = MODES.filter(function (m) { return argv.includes(m); });
  if (picked.length === 0) throw new Error('무엇을 할지 안 골랐다: ' + MODES.join(' | '));
  if (picked.length > 1) {
    throw new Error('한 번에 하나만 한다. 준 것: ' + picked.join(' ') +
      '\n  라이브러리 → record-deploy → 다시 빌드 → 템플릿 순서라 묶을 수 없다.');
  }
  const mode = picked[0];

  // 자격증명 파일을 열지 않고 존재·권한만 본다. 에이전트가 디버깅하려고
  // `cat` 하는 순간 토큰이 트랜스크립트에 박히므로, 그럴 이유를 안 만든다.
  if (mode === '--check-config') {
    loadConfig();
    console.log('→ 배포 설정 있음, 권한 OK');
    return;
  }

  const cfg = loadConfig();
  const token = await accessToken(cfg);

  // 나가기 전에 **읽기만** 해본다. 토큰 만료(동의화면 "테스트 중"이면 7일)와
  // Apps Script API 토글 꺼짐을 배포 도중이 아니라 시작 전에 잡는다.
  if (mode === '--preflight') {
    await api(token, 'GET', '/projects/' + cfg.libraryScriptId + '/content');
    await api(token, 'GET', '/projects/' + cfg.templateScriptId + '/content');
    console.log('→ 토큰 유효, 두 프로젝트 모두 읽힘');
    return;
  }

  if (mode === '--snapshot-manifest') {
    await snapshotManifest(token, cfg);
    return;
  }

  if (mode === '--library') {
    const i = argv.indexOf('--description');
    const desc = i === -1 ? 'v' + fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()
      : argv[i + 1];
    const out = await deployLibrary(token, cfg, desc,
      { allowMissingSnapshot: argv.includes('--allow-missing-snapshot') });
    console.log('→ 라이브러리 ' + out.files + '개 파일, 배포 버전 ' + out.version +
      ' (' + out.deploymentId + ')');
    console.log('→ 되읽기 대조 통과');
    // 다음 단계가 파싱한다. 마지막 줄에 번호만 낸다.
    console.log('LIBRARY_VERSION=' + out.version);
    return;
  }

  const j = argv.indexOf('--expect-lib-version');
  const out = await deployTemplate(token, cfg, j === -1 ? undefined : argv[j + 1]);
  console.log('→ 템플릿 ' + out.files + '개 파일 (라이브러리 v' + out.libVersion + ')');
  console.log('→ 되읽기 대조 통과');
}

module.exports = { toApiFile: toApiFile, diffFiles: diffFiles, CONFIG: CONFIG };

if (require.main === module) {
  main().catch(function (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  });
}
