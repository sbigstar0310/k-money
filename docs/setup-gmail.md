# Gmail 첨부 다운로드 설정

기본 Gmail 커넥터에는 **첨부 다운로드 기능이 없다.** 그래서 Gmail API를 직접 호출한다.
읽기 전용 스코프(`gmail.readonly`)만 요청하므로 이 도구는 메일을 보내거나 지우거나 라벨을 바꿀 수 없다.

## 1. Google Cloud 프로젝트 + Gmail API 활성화

1. https://console.cloud.google.com/ → 새 프로젝트 생성 (이름 아무거나, 예: `money-audit`)
2. **API 및 서비스 → 라이브러리** → "Gmail API" 검색 → **사용**

## 2. OAuth 동의 화면

1. **API 및 서비스 → OAuth 동의 화면**
2. User Type: **외부(External)** 선택 (개인 Gmail이면 이것뿐)
3. 앱 이름 / 지원 이메일 / 개발자 연락처만 채우고 저장
4. **테스트 사용자**에 본인 Gmail 주소를 추가 — 이걸 빼먹으면 인증 시 `access_denied`가 난다
5. 게시 상태는 **테스트**로 두면 된다. 앱 심사 필요 없음
   - 단, 테스트 모드의 refresh token은 **7일 후 만료**된다. 만료되면 `money-audit ingest`를 다시 돌려 재인증하면 된다

## 3. OAuth 클라이언트 ID 발급

1. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 애플리케이션 유형: **데스크톱 앱**
3. JSON 다운로드 → 프로젝트의 `secrets/client_secret.json` 으로 저장

```sh
mkdir -p secrets && chmod 700 secrets
mv ~/Downloads/client_secret_*.json secrets/client_secret.json
chmod 600 secrets/client_secret.json
```

> `secrets/` 는 `.gitignore` 에 등록돼 있다. 커밋되지 않는다.

## 4. 첫 실행

```sh
uv run money-audit ingest --dry-run   # 후보 메일만 확인, 다운로드 안 함
```

브라우저가 열리고 Google 동의를 요구한다. "이 앱은 확인되지 않았습니다" 경고가 뜨면
**고급 → (앱 이름)(으)로 이동** 을 눌러 진행한다 (본인이 만든 테스트 앱이라 정상).

동의하면 `secrets/gmail_token.json` 이 생성되고, 이후로는 브라우저가 뜨지 않는다.

## 5. 검색 쿼리 조정

기본 쿼리는 `.env` 의 `BANKSALAD_GMAIL_QUERY` 에 있다:

```
has:attachment filename:zip (뱅크샐러드 OR banksalad)
```

`--dry-run` 결과에 원하는 메일이 안 잡히면 Gmail 웹에서 검색해 보고 쿼리를 맞춘다.
발신 주소를 알면 그게 가장 확실하다: `from:no-reply@banksalad.com has:attachment`

## 6. 실제 인제스트

```sh
uv run money-audit ingest
```

최신 첨부를 받아 `data/raw/` 에 저장하고, `.env` 의 비밀번호로 풀어 `data/extracted/` 에 넣은 뒤,
엑셀 시트 구조(시트명 · 헤더 · 샘플 행)를 JSON으로 출력한다.

## 문제 해결

| 증상 | 원인 |
|---|---|
| `access_denied` | OAuth 동의 화면의 **테스트 사용자**에 본인 계정이 없음 |
| `invalid_grant` | 테스트 모드 refresh token 7일 만료 — `secrets/gmail_token.json` 지우고 재실행 |
| 첨부를 못 찾음 | 쿼리 문제. `--dry-run` 으로 후보를 보면서 조정 |
| `비밀번호가 틀렸습니다` | `.env` 의 `BANKSALAD_ZIP_PASSWORD` 확인 |
| 파일명이 깨짐 | 처리됨 — UTF-8 플래그 없는 zip은 CP437→UTF-8/CP949로 재디코딩한다 |
