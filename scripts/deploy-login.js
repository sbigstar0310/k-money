#!/usr/bin/env node
/**
 * 배포용 refresh token 을 받아 `~/.config/k-money/deploy.json` 에 저장한다.
 *
 *     node scripts/deploy-login.js
 *
 * ━━ 왜 clasp login 을 안 쓰나 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * `clasp login` 이 받는 기본 스코프에 **`cloud-platform`** 이 들어 있다.
 * 그 토큰 하나가 계정의 **모든 Apps Script 프로젝트와 GCP 전체**를 연다.
 * 여기서 필요한 건 둘뿐이다.
 *
 *     script.projects      코드 읽기·쓰기, 버전 만들기
 *     script.deployments   배포 만들기
 *
 * 이 토큰은 **유저 메일함 전체를 읽는 권한으로 도는 코드**를 배포할 수 있다.
 * 넓게 받을 이유가 없다.
 *
 * ━━ 왜 loopback 인가 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 코드를 손으로 복사해 붙이는 방식(OOB)은 구글이 막았다. 데스크톱
 * 클라이언트는 `http://127.0.0.1:<port>` 로 돌려받는 게 지금 유일한 길이다.
 * 이 서버는 **콜백 한 번만 받고 즉시 닫힌다.**
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');

const SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
].join(' ');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'k-money');
const CONFIG = process.env.KMONEY_DEPLOY_CONFIG || path.join(CONFIG_DIR, 'deploy.json');

/**
 * 이미 있는 데스크톱 클라이언트를 재사용한다.
 *
 * `secrets/client_secret.json` 은 예전 파이썬 파이프라인 때 만든 것이고
 * 타입이 `installed`(= Desktop app) 라 그대로 쓸 수 있다. **클라이언트는
 * 스코프를 안 들고 있다** — 스코프는 승인할 때 정하므로, 같은 클라이언트로
 * 받은 이 토큰은 `script.*` 둘만 갖는다. Gmail 토큰과 섞이지 않는다.
 */
const CLIENT_FILE = path.join(__dirname, '..', 'secrets', 'client_secret.json');

function loadClient() {
  if (!fs.existsSync(CLIENT_FILE)) return null;
  const j = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const c = j.installed || j.web;
  if (!c || !c.client_id || !c.client_secret) return null;
  if (!j.installed) {
    throw new Error('secrets/client_secret.json 이 데스크톱(installed) 클라이언트가 아니다 — ' +
      'web 클라이언트는 loopback 흐름을 못 쓴다');
  }
  // 등록된 redirect 의 호스트를 그대로 쓴다. localhost 로 등록해 두고
  // 127.0.0.1 로 보내면 클라이언트 설정에 따라 거부될 수 있다.
  const uri = (c.redirect_uris || [])[0] || 'http://localhost';
  return { id: c.client_id, secret: c.client_secret, host: new URL(uri).hostname };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(function (resolve) {
    rl.question(question, function (a) { rl.close(); resolve(a.trim()); });
  });
}

/** PKCE — 데스크톱 클라이언트는 시크릿을 숨길 수 없으므로 코드 교환을 묶는다. */
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier: verifier, challenge: challenge };
}

async function main() {
  console.log('배포용 토큰을 받습니다. 스코프는 둘뿐입니다:\n  ' + SCOPES.replace(/ /g, '\n  ') + '\n');

  const found = loadClient();
  let clientId;
  let clientSecret;
  let host = 'localhost';

  if (found) {
    console.log('클라이언트를 찾았습니다: secrets/client_secret.json');
    console.log('  ' + found.id.slice(0, 24) + '…  (redirect 호스트: ' + found.host + ')\n');
    clientId = found.id;
    clientSecret = found.secret;
    host = found.host;
  } else {
    console.log('GCP 콘솔의 **데스크톱 앱** OAuth 클라이언트가 필요합니다.');
    console.log('(APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app)\n');
    clientId = await ask('client ID: ');
    clientSecret = await ask('client secret: ');
  }

  if (!clientId || !clientSecret) throw new Error('client ID 와 secret 이 필요하다');

  // 주소는 저장소가 안다. 사람에게 다시 묻지 않는다 — 물으면 오타가 난다.
  const targets = require('./deploy-targets');
  console.log('대상:\n  라이브러리 ' + targets.libraryScriptId().slice(0, 24) + '…' +
    '\n  템플릿     ' + targets.TEMPLATE_SCRIPT_ID.slice(0, 24) + '…\n');

  const state = crypto.randomBytes(16).toString('hex');
  const { verifier, challenge } = pkce();

  // 서버를 먼저 띄워 포트를 확정한 뒤 URL 을 만든다.
  const server = http.createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); }); // 바인딩은 항상 루프백
  const port = server.address().port;
  const redirectUri = 'http://' + host + ':' + port;

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',            // refresh token 을 확실히 받는다
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const code = await new Promise(function (resolve, reject) {
    server.on('request', function (req, res) {
      const url = new URL(req.url, redirectUri);
      const got = url.searchParams.get('state');
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><p style="font:16px system-ui;padding:2rem">' +
        (c ? '받았습니다. 터미널로 돌아가세요.' : '실패: ' + (err || '알 수 없음')) + '</p>');
      server.close();
      if (got !== state) return reject(new Error('state 가 다르다 — 콜백을 믿을 수 없다'));
      if (!c) return reject(new Error('인증 실패: ' + (err || '코드가 없다')));
      resolve(c);
    });

    console.log('\n브라우저에서 아래를 열어 승인하세요:\n\n' + authUrl + '\n');
    try {
      execFileSync('open', [authUrl], { stdio: 'ignore' });
    } catch (e) { /* 자동으로 못 열면 위 URL 을 직접 연다 */ }
    console.log('기다리는 중…');
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    throw new Error('토큰 교환 실패 (' + res.status + '): ' + JSON.stringify(body) +
      (body.refresh_token === undefined
        ? '\n  refresh_token 이 없다. 이미 승인한 적이 있으면 구글이 안 준다 —\n' +
          '  myaccount.google.com/permissions 에서 이 앱을 지우고 다시 해라.'
        : ''));
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify({
    clientId: clientId,
    clientSecret: clientSecret,
    refreshToken: body.refresh_token,
  }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);

  console.log('\n→ ' + CONFIG + ' (chmod 600)');
  console.log('→ 확인: node scripts/deploy.js --snapshot-manifest');
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  });
}
