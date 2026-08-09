#!/usr/bin/env node
/**
 * 배포용 디렉터리를 만든다 — `appsscript/` → `build/library/` · `build/template/`
 *
 *     node scripts/build-deploy.js
 *     node scripts/build-deploy.js --lib-version 13   # 템플릿 매니페스트에 번호 주입
 *
 * ━━ 왜 두 디렉터리로 가르나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 두 프로젝트를 한 디렉터리에서 올릴 수 없다. Apps Script API 는 요청마다
 * **`appsscript` 라는 이름의 매니페스트 하나**를 요구하는데, 라이브러리와
 * 템플릿은 매니페스트 내용이 반드시 다르다. 같은 폴더에 둘을 놓을 방법이 없다.
 *
 * 그리고 `projects.updateContent` 는 **요청에 없는 원격 파일을 전부 지운다.**
 * 무시 목록(.claspignore 류)으로 거르는 방식은 거르기에 실패하는 순간 원격
 * 파일이 조용히 사라진다. 그래서 여기서는 **화이트리스트로 복사**한다 —
 * 목록에 없으면 안 올라가고, 목록에 있는데 없으면 죽는다.
 *
 * ━━ 이 파일이 없애는 사고 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * `container.gs` 와 `appsscript.json` 은 **한 짝이다.** 매니페스트에서
 * `script.external_request` 를 뺐는데 `container.gs` 는 옛 버전이라
 * "지정된 권한으로는 UrlFetchApp.fetch 을(를) 호출할 수 없습니다" 가 났었다.
 *
 * 둘이 같은 디렉터리에서 **한 번의 요청으로** 나가면 갈릴 수가 없다.
 * 규칙을 사람이 기억하는 게 아니라 구조가 보장한다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'appsscript');
const OUT = path.join(ROOT, 'build');

/**
 * 어디로 무엇이 가는가 — **이 목록이 계약이다.**
 *
 * `template.gs` 가 어디에도 없는 것이 의도다. 개발자가 템플릿 시트를 꾸밀 때
 * 한 번 쓰는 도구이고, 유저에게도 라이브러리에도 갈 이유가 없다.
 *
 * 라이브러리에 매니페스트가 없는 것도 의도다. §manifest 주석 참조.
 */
const TARGETS = {
  library: {
    files: ['core.gs', 'zipcrypto.gs', 'app.gs', 'library-api.gs'],
    manifest: null,
  },
  template: {
    files: ['container.gs'],
    manifest: 'appsscript.json',
  },
};

/**
 * ⚠️ **라이브러리 매니페스트를 여기서 만들지 않는다.**
 *
 * 라이브러리 프로젝트의 매니페스트는 저장소에 없고 편집기에만 있다.
 * 무엇이 켜져 있는지(고급 서비스·시간대·스코프) 여기서 추측해 새로 쓰면,
 * 틀렸을 때 **다음 배포부터 조용히 다른 프로젝트가 된다.**
 *
 * 그래서 `deploy.js` 가 **살아 있는 프로젝트에서 읽어 그대로 되쓴다.**
 * 처음 한 번 `--snapshot-manifest` 로 저장소에 내려받아 두면 그다음부터는
 * 대조까지 한다. 없는 것을 지어내는 것보다 있는 것을 가져오는 게 맞다.
 */
const LIBRARY_MANIFEST_SNAPSHOT = 'appsscript.library.json';

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** 파일 순서가 곧 실행 순서다. 배열 순서를 그대로 쓴다. */
function copyFiles(target, names, destDir) {
  names.forEach(function (name) {
    const from = path.join(SRC, name);
    if (!fs.existsSync(from)) {
      throw new Error(target + ' 에 넣을 ' + name + ' 이 appsscript/ 에 없다');
    }
    fs.copyFileSync(from, path.join(destDir, name));
  });
}

/**
 * 템플릿 매니페스트에 라이브러리 배포 번호를 주입한다.
 *
 * ⚠️ 이 값을 손으로 적으려다 **두 번 연속 틀렸다** (3인 줄 알았는데 4,
 *    5인 줄 알았는데 7). 틀리면 유저는 **오류 없이 옛 코드로 돈다.**
 *    그래서 배포 API 가 돌려준 번호만 여기로 들어온다.
 */
function writeTemplateManifest(destDir, libVersion) {
  const src = path.join(SRC, TARGETS.template.manifest);
  const manifest = JSON.parse(fs.readFileSync(src, 'utf8'));

  const libs = (manifest.dependencies || {}).libraries || [];
  if (libs.length !== 1) {
    throw new Error('템플릿 매니페스트의 libraries 가 1개가 아니다 (' + libs.length + '개)');
  }

  // 개발 모드는 라이브러리 **편집 권한**이 있어야 돈다. 개발자 환경에서만
  // 잘 돌고 유저 사본에서만 깨지는 종류라 여기서 막는다.
  if (libs[0].developmentMode !== false) {
    throw new Error('developmentMode 가 false 가 아니다 — 유저 사본에서 깨진다');
  }

  if (libVersion !== null) {
    if (!/^\d+$/.test(String(libVersion))) {
      throw new Error('라이브러리 버전이 정수가 아니다: ' + libVersion +
        ' (deploymentId 를 잘못 넘겼나?)');
    }
    libs[0].version = String(libVersion);
  }

  fs.writeFileSync(path.join(destDir, 'appsscript.json'),
    JSON.stringify(manifest, null, 2) + '\n');
  return libs[0].version;
}

function build(libVersion) {
  rmrf(OUT);

  const result = {};
  Object.keys(TARGETS).forEach(function (target) {
    const destDir = path.join(OUT, target);
    fs.mkdirSync(destDir, { recursive: true });
    copyFiles(target, TARGETS[target].files, destDir);
    result[target] = TARGETS[target].files.slice();
  });

  const pinned = writeTemplateManifest(path.join(OUT, 'template'), libVersion);
  result.template.push('appsscript.json');

  // 라이브러리 매니페스트 스냅샷이 저장소에 있으면 같이 내보낸다.
  // deploy.js 가 살아 있는 것과 **대조**하는 데 쓴다 (덮어쓰기용이 아니다).
  const snapshot = path.join(SRC, LIBRARY_MANIFEST_SNAPSHOT);
  if (fs.existsSync(snapshot)) {
    fs.copyFileSync(snapshot, path.join(OUT, 'library', LIBRARY_MANIFEST_SNAPSHOT));
  }

  return { files: result, libVersion: pinned, hasSnapshot: fs.existsSync(snapshot) };
}

module.exports = {
  TARGETS: TARGETS,
  LIBRARY_MANIFEST_SNAPSHOT: LIBRARY_MANIFEST_SNAPSHOT,
  OUT: OUT,
  build: build,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--lib-version');
  const libVersion = i === -1 ? null : argv[i + 1];

  const out = build(libVersion);
  console.log('→ build/library/   ' + out.files.library.join(' ') +
    (out.hasSnapshot ? '  (+매니페스트 스냅샷)' : '  (매니페스트는 배포 때 원격에서 읽는다)'));
  console.log('→ build/template/  ' + out.files.template.join(' ') +
    '  (라이브러리 v' + out.libVersion + ')');
}
