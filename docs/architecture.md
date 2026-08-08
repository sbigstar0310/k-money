# 아키텍처 — 주기적 자율 실행 + 라이브 대화

> 2026-08-08 조사 기준. 요구사항: (1) 매일 정해진 시각에 보고서, (2) 유저가 직접 대화 인터랙션.

## 핵심: "에이전트를 어디서 돌릴 것인가"가 유일한 갈림길

나머지(파싱, 감사 로직, 리포트 생성)는 어디서 돌리든 같은 코드다.
그래서 **엔진과 호스트를 분리**하는 게 유일하게 되돌릴 수 있는 결정이다.

```
┌─────────────────────────────────────────────────────┐
│  엔진 (호스트 무관, 이번에 만든 것)                    │
│    k_money.ingest   메일 → zip → 해제 → 파싱      │
│    k_money.audit    감사 규칙 (미구현)            │
│    k_money.report   리포트 렌더 (미구현)          │
│    → MCP 서버로 노출                                  │
└────────────────────┬────────────────────────────────┘
                     │  같은 엔진을 세 가지 호스트가 호출
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
  로컬 스케줄러   Claude Code    Managed Agents
  (launchd/cron)   Routines       Deployments
```

## 호스트 후보 3가지

| | **A. 로컬 스케줄러** | **B. Claude Code Routines** | **C. Managed Agents 배포** |
|---|---|---|---|
| 어디서 도나 | 내 맥 | Anthropic 클라우드 | Anthropic 클라우드 |
| 트리거 | launchd / cron (제한 없음) | cron(**최소 1시간 간격**) · webhook · API · GitHub | cron + timezone |
| 로컬 `.env` 접근 | ✅ | ❌ | ❌ (Vault 사용) |
| 로컬 파일 저장 | ✅ | ❌ | ❌ (세션 컨테이너, 휘발성) |
| 시크릿 보관 | 내 디스크 | 커넥터 OAuth | Vault (egress에서 치환, 샌드박스는 placeholder만 봄) |
| 세션 간 상태 | 파일시스템 | 리포지토리/커넥터 | Memory Store |
| 라이브 대화 | Claude Code 세션 | ❌ (트리거 기반) | 세션 + SSE 이벤트 스트림 |
| 비용 | 구독 내 | 구독 내 (프리뷰 중 일일 실행 한도) | **토큰 + 세션 시간당 $0.08** |
| 노트북 닫으면 | ❌ 안 돎 | ✅ 돎 | ✅ 돎 |

### B(Routines)가 이 프로젝트에 안 맞는 이유 — 결정적

Routines는 **Anthropic 클라우드에서 돌기 때문에 내 로컬 `.env`도, 로컬 파일도 못 읽는다.**
그러면 뱅샐 zip을 받아올 경로는 Gmail 커넥터뿐인데, **커넥터에는 첨부 다운로드 기능이 없다.**
즉 앞서 웹 채팅에서 막혔던 바로 그 벽에 그대로 다시 부딪힌다.

Routines는 "리포지토리와 커넥터로 완결되는 일"(백로그 정리, 의존성 점검, 데일리 브리프)에 맞는 도구다.
로컬 시크릿으로 외부 API를 때려야 하는 이 프로젝트와는 궁합이 안 맞는다.

### C(Managed Agents)는 되지만, 지금은 아니다

CMA는 요구사항을 **전부** 만족한다 — cron 배포로 매일 리포트, 세션 스트림으로 라이브 대화,
Vault `environment_variable` 크리덴셜은 샌드박스 안에서 placeholder로만 보이고 실제 값은 egress에서
치환되므로 "시크릿이 모델 컨텍스트를 통과하면 안 된다"는 원칙과도 정면으로 부합한다.

문제는 배포 단위다. CMA는 Claude Code 플러그인이 아니라 **API 위에 얹는 별도 제품**이라,
유저마다 `ANTHROPIC_API_KEY`를 만들고 토큰 + 시간당 $0.08을 직접 부담해야 한다.
"플러그인 두 줄로 끝"이라는 확정된 온보딩 전략과 충돌한다.

## 권고: A로 시작하고, 엔진을 C로 옮길 수 있게 만든다

**1단계 (지금)** — 로컬 우선
- 엔진: 순수 Python 패키지 + MCP 서버
- 스케줄: macOS `launchd` (플러그인 `/set-up`이 plist를 깔아준다)
- 라이브 대화: 로컬 Claude Code 세션에서 플러그인 사용
- 데이터·시크릿 전부 로컬. 추가 비용 0.

**2단계 (필요해지면)** — 하이브리드
- 같은 MCP 서버를 CMA 에이전트에 물리고 cron 배포 생성
- 시크릿은 `.env` → Vault 로 이동
- 리포트는 메일/슬랙으로 푸시

핵심은 **1단계 코드를 2단계에서 다시 안 쓰게 만드는 것**이다. 그러려면 지금부터:
- 파일시스템 경로를 하드코딩하지 말고 설정에서 주입 (→ `config.py`)
- 감사 로직이 "Claude Code에서 돈다"고 가정하지 않게, 순수 함수로 유지
- 모든 I/O를 `ingest` 계층에 가둬서 데이터 소스 교체가 국소화되게

### 정직한 한계

**노트북을 닫으면 1단계는 안 돈다.** launchd는 잠든 맥을 깨우지 못한다.
"매일 아침 8시 정각"은 보장되지 않고 "다음에 맥을 열었을 때"가 된다.
개인 자산 감사는 몇 시간 늦어도 치명적이지 않으니 감수할 만하다고 보지만,
정시성이 진짜 요구사항이면 그건 1단계를 건너뛰고 C로 가야 한다는 신호다.

## 출처

- [Claude Code Routines 가이드](https://makerkit.dev/blog/tutorials/claude-code-routines-guide)
- [Routines vs Managed Agents 비교](https://www.developersdigest.tech/blog/claude-code-routines-vs-managed-agents-schedules)
- [Managed Agents 공식 문서](https://platform.claude.com/docs/en/managed-agents/overview)
- [Scheduled Claude Agents 정리](https://inventivehq.com/blog/claude-managed-agents-scheduled-routines)
