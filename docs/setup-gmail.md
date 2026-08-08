# Gmail 첨부 다운로드 설정 — ⚠️ 개발자 전용

> **이 문서는 Python 참조 구현(`k-money ingest`) 전용이다. 유저는 이 절차를 하지 않는다.**
>
> Apps Script 내장 서비스(GmailApp·DriveApp)는 **유저 OAuth 클라이언트를 요구하지 않는다** —
> 스크립트가 유저 계정에서 유저 권한으로 실행되기 때문이다.
> 유저가 하는 것은 `README.md` §3-1 의 3조작(Sheet 사본 → 비번 입력 → 권한 승인)이 전부다.
>
> 아래 절차(GCP 프로젝트 · OAuth 클라이언트 · 테스트 사용자 등록 · 터미널)는
> **개발 중 실데이터로 검증할 때만** 필요하다.
>
> 그리고 이 경로에는 구조적 한계가 있다: `gmail.readonly` 는 **restricted scope** 라
> Testing 상태에서 **refresh token 이 7일 만료**된다. 프로덕션 게시로 풀리지만
> 앱 심사 + CASA 보안 감사가 필요하다. **즉 이 경로로는 자동화를 보장할 수 없다.**
> 그게 인제스트를 Apps Script 로 옮긴 진짜 이유다.

기본 Gmail 커넥터에는 **첨부 다운로드 기능이 없다.** 그래서 Gmail API를 직접 호출한다.
읽기 전용 스코프(`gmail.readonly`)만 요청하므로 이 도구는 메일을 보내거나 지우거나 라벨을 바꿀 수 없다.

> Google Cloud Console은 2025~2026년에 개편됐다. 예전 "API 및 서비스 → OAuth 동의 화면" 메뉴는
> 사라지고 **Google Auth Platform**(Branding / Audience / Data access / Clients)으로 옮겨졌다.
> 아래는 새 UI 기준이다.

소요 시간 5~10분. 전부 무료.

---

## 0. 사전 확인

- 로그인한 Google 계정이 **뱅샐 메일을 받는 계정과 같아야 한다** (`sbigstar0930@gmail.com`).
  Console 우측 상단 아바타로 확인. 다르면 계정 전환 먼저.

## 1. 프로젝트 생성

1. https://console.cloud.google.com/projectcreate
2. **프로젝트 이름**: `k-money` (아무거나. 조직 없으면 위치는 "조직 없음")
3. **만들기** → 우측 상단 알림에서 생성 완료되면 **프로젝트 선택**

> 이후 모든 화면에서 상단 프로젝트 선택기가 `k-money`인지 계속 확인할 것.
> 다른 프로젝트에 설정을 만들고 헤매는 게 가장 흔한 실수다.

## 2. Gmail API 사용 설정

1. https://console.cloud.google.com/apis/library/gmail.googleapis.com
2. 프로젝트가 `k-money`인지 확인 → **사용(Enable)**

이 단계를 빼먹으면 나중에 `Gmail API has not been used in project ... before or it is disabled` 에러가 난다.

## 3. Google Auth Platform 설정

https://console.cloud.google.com/auth/overview → 처음이면 **시작하기(Get started)**

### 3-1. Branding (앱 정보)

| 항목 | 값 |
|---|---|
| 앱 이름 | `k-money` (동의 화면에 표시됨. 아무거나) |
| 사용자 지원 이메일 | 본인 Gmail |
| 개발자 연락처 정보 | 본인 Gmail |

로고·홈페이지·개인정보처리방침은 **비워둬도 된다** (테스트 모드에서는 불필요).

### 3-2. Audience (대상)

| 항목 | 값 |
|---|---|
| User type | **외부(External)** |

개인 Gmail 계정은 "내부(Internal)"를 못 고른다. Workspace 조직 계정이면 Internal이 더 편하다.

**여기서 가장 중요한 단계:**

> **테스트 사용자(Test users) → 사용자 추가 → 본인 Gmail 주소 입력 → 저장**

이걸 빼먹으면 인증 시 `Error 403: access_denied`가 난다. **가장 흔한 실패 지점이다.**

게시 상태는 **테스트(Testing)** 그대로 둔다. "앱 게시(Publish app)"는 **누르지 말 것** —
아래 §7 참고.

### 3-3. Data access (스코프) — 선택

**건너뛰어도 된다.** 테스트 모드에서는 코드가 요청하는 스코프가 그대로 동의 화면에 뜬다.

명시하고 싶으면: **범위 추가 또는 삭제 → 필터에 `gmail.readonly` 입력 →
`.../auth/gmail.readonly` 체크 → 업데이트 → 저장**.
"제한된 범위(Restricted)"로 분류된다고 경고가 뜨는데, 테스트 모드에서는 문제없다.

## 4. OAuth 클라이언트 ID 발급

1. Google Auth Platform → **Clients(클라이언트)** → **클라이언트 만들기**
2. **애플리케이션 유형: 데스크톱 앱(Desktop app)** ← 웹 앱 아님. 리디렉션 URI를 물어보면 유형을 잘못 고른 것이다
3. 이름: `k-money-cli`
4. **만들기** → 팝업에서 **JSON 다운로드**

> 팝업을 닫아버렸어도 괜찮다. Clients 목록에서 해당 클라이언트 우측 **다운로드 아이콘**으로 다시 받을 수 있다.

파일을 프로젝트로 옮긴다:

```sh
cd ~/Desktop/02_Projects/k-money
mkdir -p secrets && chmod 700 secrets
mv ~/Downloads/client_secret_*.json secrets/client_secret.json
chmod 600 secrets/client_secret.json
```

확인:

```sh
ls -l secrets/                      # -rw------- 이어야 함
git check-ignore -v secrets/client_secret.json   # 무시되는지 확인
```

> `secrets/` 는 `.gitignore` 에 등록돼 있다. 커밋되지 않는다.
> 이 JSON에는 client_secret이 들어 있지만 **데스크톱 앱 클라이언트 시크릿은 기밀이 아니다**
> (OAuth 스펙상 public client). 그래도 굳이 공개할 이유는 없으니 커밋하지 않는다.

## 5. 첫 실행 — 인증

```sh
uv run k-money ingest --dry-run
```

1. 브라우저가 자동으로 열린다
2. 계정 선택 → **뱅샐 메일 받는 계정** 선택
3. **"Google에서 확인하지 않은 앱입니다"** 경고 → **고급 → k-money(안전하지 않음)으로 이동**
   - 본인이 방금 만든 테스트 앱이라 정상이다. 심사를 안 받았을 뿐
4. 권한 요청: **"Gmail 메시지 및 설정 보기"** → **계속**
5. 터미널에 `The authentication flow has completed` → 브라우저 탭 닫아도 됨

성공하면 `secrets/gmail_token.json` 이 생기고, 이후로는 브라우저가 안 뜬다.

`--dry-run`은 다운로드 없이 **후보 메일만** 출력한다:

```
INFO    쿼리 매칭 메일 3건
INFO    후보: 2026-07-26 | 뱅크샐러드 가계부 내보내기 | 홍길동님_2025-07-26~2026-07-26.zip | 412.3 KB
INFO    dry-run — 다운로드하지 않고 종료합니다.
```

## 6. 쿼리 조정

후보에 원하는 메일이 안 잡히면 `.env` 의 `BANKSALAD_GMAIL_QUERY` 를 고친다.
기본값:

```
has:attachment filename:zip (뱅크샐러드 OR banksalad)
```

**가장 확실한 방법**: Gmail 웹에서 그 메일을 열어 발신 주소를 확인하고 그걸로 좁힌다.

```
from:no-reply@banksalad.com has:attachment filename:zip
```

Gmail 검색 문법이 그대로 통한다: `newer_than:60d`, `subject:내보내기`, `has:attachment` 등.
웹 Gmail 검색창에서 먼저 테스트해보고 그대로 복사하는 게 빠르다.

## 7. 테스트 모드의 제약 — 반드시 알아둘 것

**refresh token이 7일 후 만료된다.** 테스트(Testing) 상태 앱의 정책이다.
만료되면 다음 실행에서 `invalid_grant` 가 뜬다. 해결:

```sh
rm secrets/gmail_token.json
uv run k-money ingest --dry-run   # 브라우저 재인증
```

**"앱 게시"로 해결되지 않는다.** `gmail.readonly` 는 Google이 **제한된 범위(Restricted scope)**
로 분류한 스코프라, 프로덕션으로 게시하려면 앱 인증 심사 + 연간 보안 평가(CASA)가 필요하다.
개인 도구에는 과하다.

> ⚠️ **이건 플러그인 배포에 직접 영향을 준다.**
> 뱅샐 인제스트는 월 1회 도는데 토큰은 7일마다 죽는다 = 유저가 **매달 재인증**해야 한다.
> `/set-up` 이 이 사실을 미리 알려주고, `invalid_grant` 를 감지하면 재인증을 자동으로
> 띄워주도록 설계해야 한다. 조용히 실패하면 유저는 "자동화가 고장났다"고 느낀다.
>
> 대안은 있지만 각각 대가가 있다 — 아직 미결이다:
> - Google Workspace 계정이면 Internal 앱으로 만들 수 있고, 7일 제한이 없다
> - `gmail.addons.current.message.readonly` 등 더 좁은 스코프도 여전히 restricted다
> - Gmail을 아예 우회하고 유저가 zip을 직접 폴더에 넣는 경로 (자동화 포기)

## 8. 실제 인제스트

```sh
uv run k-money ingest
```

최신 첨부를 `data/raw/` 에 저장 → `.env` 의 비밀번호로 해제해 `data/extracted/` 에 넣고 →
엑셀 시트 구조(시트명 · 헤더 · 샘플 행)를 JSON으로 출력한다.

이 출력이 인제스터의 첫 스펙이 된다.

---

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `Error 403: access_denied` | Audience → **테스트 사용자**에 본인 계정 없음. 추가 후 재시도 |
| `Gmail API has not been used in project...` | §2를 안 했거나 다른 프로젝트에서 함 |
| `invalid_grant` | 테스트 모드 토큰 7일 만료. `rm secrets/gmail_token.json` 후 재실행 |
| 리디렉션 URI를 물어봄 | 클라이언트 유형을 "웹 앱"으로 만든 것. **데스크톱 앱**으로 다시 생성 |
| `OAuth 클라이언트 파일이 없습니다` | `secrets/client_secret.json` 경로/파일명 확인 |
| `쿼리 매칭 메일 0건` | §6 쿼리 조정. 계정이 맞는지도 확인 |
| `비밀번호가 틀렸습니다` | `.env` 의 `BANKSALAD_ZIP_PASSWORD` 확인 |
| 브라우저가 안 열림 | SSH 등 헤드리스 환경. 터미널에 뜬 URL을 수동으로 복사해 접속 |
| 파일명이 깨짐 | 처리됨 — UTF-8 플래그 없는 zip은 CP437→UTF-8/CP949로 재디코딩 |

## 참고

- [Gmail API Python 퀵스타트](https://developers.google.com/workspace/gmail/api/quickstart/python)
- [OAuth 동의 화면 설정 (Workspace 가이드)](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [앱 대상(Audience) 관리](https://support.google.com/cloud/answer/15549945)
- [OAuth 앱 브랜딩 관리](https://support.google.com/cloud/answer/15549049)
