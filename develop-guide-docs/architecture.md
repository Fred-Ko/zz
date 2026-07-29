# ZZ 아키텍처

> **문서 상태: 현재 · 권위 있는 시스템 구조**

제품의 목적과 비목표는 [project-identity.md](project-identity.md), 계층을 나누는 이유는
[design-philosophy.md](design-philosophy.md)를 먼저 본다.

## 1. 시스템의 성격

ZZ는 Bun 기반 모노레포로 구성된 터미널 코딩 에이전트다. 핵심 제품은
`packages/coding-agent`의 `zz` CLI이며, 모델 호출·도구 실행·TUI·지속 상태·협업·장기 지식을
명확한 계층으로 분리한다.

이 포크는 upstream 코드베이스 위에 다음을 추가하거나 변경한다.

- 사용자-facing 이름과 기본 설정 루트를 `zz`, `~/.zz`, `.zz/`로 변경
- 특별한 언어 요청이 없을 때 한국어를 기본 대화 언어로 주입
- 상태줄 상세 다중 행 레이아웃
- Goal 기반 영속 Task/Spec/Plan DAG와 검증·복구 수명주기
- ZZW의 resource-aware Execution Wave와 격리된 병렬 검증·서브에이전트 실행
- `zz`에 내장된 로컬 SQLite ZZWorkflow registry
- 제거한 upstream memory를 대체하는 독립 ZZ Knowledge System
- 자동 QA 보고 기능 제거

## 2. 패키지 경계

```text
zz CLI / TUI
└─ packages/coding-agent
   ├─ packages/agent       모델 턴, tool call, 상태 머신
   ├─ packages/ai          provider 요청/스트리밍/인증
   ├─ packages/catalog     모델 카탈로그와 식별·정책
   ├─ packages/tui         터미널 렌더링과 입력
   ├─ packages/utils       로깅·경로·프로세스·공용 유틸리티
   ├─ packages/natives     Rust 네이티브 바인딩
   ├─ packages/wire        공유 wire 타입
   └─ packages/collab-web  웹 클라이언트와 도구 렌더러

ZZWorkflow (ZZW)                 ZZ Knowledge
├─ src/workflow                  ├─ src/knowledge
├─ src/workflow/execution        │
├─ src/goals/task-lifecycle.ts   ├─ src/tools/knowledge-*.ts
├─ src/goals/runtime.ts          ├─ src/prompts/knowledge
└─ src/tools/workflow-control.ts └─ src/skills/knowledge-operator
```

ZZW와 Knowledge는 `AgentSession`에서 함께 조립되지만 서로의 저장 계층이 아니다. ZZW는 Knowledge가
비활성화돼도 동작하고, Knowledge는 active ZZW Task가 없어도 명시적 사용자 요청을 처리한다.

패키지의 공개 타입과 값은 올바른 소유 패키지에서 가져온다. 특히 catalog 값은
`@oh-my-pi/pi-catalog/<module>`에서 가져오며 `pi-ai`를 우회 barrel로 사용하지 않는다.

## 3. CLI 부팅 흐름

```text
사용자: zz [args]
  │
  ▼
packages/coding-agent/scripts/zz
  │ 소스/설치 실행기
  ▼
src/cli.ts
  ├─ Bun 버전 확인
  ├─ hidden worker selector dispatch
  ├─ argv 정규화
  └─ command registry 로드
  │
  ▼
src/commands/* + src/cli/*
  │
  ▼
src/main.ts
  ├─ config/theme/model/auth 초기화
  └─ createAgentSession
  │
  ▼
src/sdk.ts → AgentSession
  ├─ InteractiveMode: TUI
  ├─ Print mode: 단발 출력
  └─ RPC mode: JSONL 서버
```

`src/cli.ts`는 worker host도 겸한다. 컴파일 바이너리에서 worker가 별도 엔트리 파일을 요구하지 않도록 현재 CLI 엔트리로 재진입한다. 숨은 selector는 upstream 호환을 위해 `__omp_worker_*` 이름을 유지할 수 있다. 새 worker를 추가하면 selector dispatch, 직접 모듈 fallback, `zz --smoke-test`를 함께 갱신한다.

ZZWorkflow도 이 프로세스 안에서 초기화된다. `zz`를 실행하면 필요한 session/lifecycle integration과
저장소 binding이 함께 생기며 별도 `zz-workflowd`를 시작하지 않는다.

## 4. 프롬프트와 규칙 합성

프롬프트는 다음 계층에서 온다.

1. coding-agent 기본 정적 프롬프트
2. 제품 기본 언어 지침
3. 전역·프로젝트 `APPEND_SYSTEM.md`
4. `AGENTS.md`/`CLAUDE.md`와 매칭된 규칙
5. 필요할 때 읽는 Skill
6. 현재 Task/Plan/Git/Evidence에서 생성한 동적 ZZWorkflow context
7. 목적별 recall이 있을 때 교체되는 advisory Knowledge working set

정적 프롬프트는 `src/prompts/**/*.md`에 두고 `import ... with { type: "text" }`로 불러온다. 동적 값은 Handlebars 데이터로 전달한다. TypeScript에서 긴 프롬프트 문자열을 조립하지 않는다.

프롬프트는 모델의 판단을 돕지만 절대 정책을 강제하지 않는다. 승인·lease·phase·operation journal·completion gate는 runtime에서 검사한다.

## 5. 상태와 권한

각 저장소의 권한을 섞지 않는다.

| 저장소                                               | 소유하는 사실                                          |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Git                                                  | 추적 파일, commit, branch, 로컬 checkpoint             |
| `~/.zz/agent/workflows/<repository-id>/workflow.db`  | 저장소별 Task 상태, event, operation, lease, heartbeat |
| `~/.zz/agent/knowledge/boundary-<hash>/knowledge.db` | Knowledge outbox, working-set 캐시, 검토 영수증        |
| Verification evidence                                | 특정 workspace snapshot에서의 검증 결과                |
| Hindsight                                            | 과거 결정·경험·사용자 선호에 대한 advisory memory      |
| 세션 로그                                            | 대화와 도구 실행 기록                                  |

Hindsight recall 결과는 현재 HEAD, 현재 설정, ZZWorkflow registry, 최신 테스트 결과를 덮어쓸 수
없다. 세션 transcript도 사건 기록이지 현재 상태를 복원하는 유일한 원본이 아니다.

### 5.1 ZZW 제어 흐름

```text
사용자 /zzw-guided-goal
  → Goal interview
  → Task Specification
  → read-only discovery
  → draft Plan DAG
  → /zzw approve-plan
  → goal continuation
  → active step tool gate
  → operation journal
  → evidence / verification
  → next step, reconciliation, or material reapproval
```

원본 `/goal`과 `/guided-goal`은 이 경로를 타지 않는다.

### 5.2 Knowledge 흐름

```text
사용자 명시 요청 또는 제한된 lifecycle trigger
  → intent/purpose 판정
  → security boundary + Global/Repository bank routing
  → taxonomy/evidence/redaction/dedup policy
  → local outbox / working set
  → Hindsight retain/recall/reflect
  → advisory result와 receipt
```

Hindsight HTTP 실패는 Knowledge provider 상태와 outbox에 격리된다. 이를 ZZW Task의 현재 상태 실패로
바꾸지 않는다.

## 6. 데이터베이스

이 포크에서 관계형 저장소는 SQLite로 통일한다.

- ZZWorkflow registry: `~/.zz/agent/workflows/<repository-id>/workflow.db`
- ZZ Knowledge policy state: `~/.zz/agent/knowledge/boundary-<hash>/knowledge.db`
- coding-agent 내부 상태: 설정과 XDG 조건에 따라 `~/.zz` 또는 `$XDG_*_HOME/zz`

SQLite 사용 시:

- `bun:sqlite`를 사용한다.
- 스키마 초기화와 migration을 idempotent하게 만든다.
- WAL과 `busy_timeout`을 사용해 같은 머신의 여러 `zz` 프로세스를 지원한다.
- 상태 갱신과 event 기록은 하나의 transaction에서 처리한다.
- event idempotency key와 workspace lease 만료·경쟁 경계를 테스트한다.
- 기존 전역 `~/.zz/agent/workflow.db`는 활성 lease가 없을 때 저장소별로 선별 이전하며 원본은 복구용으로 보존한다.
- DB 파일을 네트워크 파일시스템이나 다른 머신과 공유하는 기능은 제공하지 않는다.

upstream OMP의 기존 Memory, Mnemopi, transcript auto-retain/auto-recall과 `memory://` 프로토콜은 제거됐다. Hindsight HTTP 호출은 `src/knowledge/hindsight-client.ts` 밖에서 직접 사용하지 않는다.

Repository identity는 프로젝트 이름만으로 만들지 않는다. 가능한 경우 canonical remote와 Git
identity를 사용하고, fork remote와 project override는 사람이 읽는 표시 이름에 활용한다. Git이
없는 디렉터리에서 시작한 뒤 `git init`을 하거나 cwd/repository boundary가 바뀌면 다음 안전한
경계에서 workflow와 Knowledge binding을 다시 계산한다.

## 7. TUI와 LSP

TUI는 differential rendering을 사용하므로 `console.log`가 화면을 깨뜨린다. 모든 진단은 중앙 logger로 보낸다. 화면 문자열은 탭 치환, ANSI-aware truncate, 홈 경로 축약을 거친다.

LSP는 파일을 읽거나 수정하는 대체 수단이 아니라 의미 기반 코드 탐색 계층이다.

- definition/reference/symbol/diagnostics는 가능한 경우 LSP를 사용한다.
- LSP 결과가 없거나 서버가 준비되지 않았을 때 텍스트 검색으로 fallback한다.
- 서버 프로세스는 장기 실행·스트리밍 프로세스이므로 `Bun.spawn` 수명주기로 관리한다.
- 기본 서버 설정은 `packages/coding-agent/src/lsp/defaults.json`, 사용자 설정은 `docs/lsp-config.md`를 따른다.

상세 상태줄은 상태·작업·모델·작업공간·Git·컨텍스트·토큰·비용/한도·세션을 고정 의미 행으로
분리한다. ZZW가 활성화되면 현재 Plan step, live Execution Wave와 activity를 별도 행으로 보여준다.
같은 문맥 한도나 토큰 합계를 개별 수치와 중복 표시하지 않으며, 좁은 터미널에서도 행을 합치지 않고
값만 축약한다. 상태줄은 Registry와 session 상태의 projection이며 상태를 직접 소유하지 않는다.

## 8. 자동 QA 제거 불변식

다음 요소는 제품에 존재하지 않아야 한다.

- `report_tool_issue`
- `xd://report_issue`
- grievance SQLite DB와 push endpoint
- 모델이 자동 보고를 요청하는 시스템 프롬프트
- 최초 보고 동의 팝업
- `zz grievances`

과거 설정을 제거하는 migration 문자열과 “명령이 제거됨” 안내는 호환성을 위해 남을 수 있다. 새 telemetry가 필요하면 목적·수집 필드·보존·동의 UX·비활성화 방법을 별도 설계하고 사용자의 명시적 승인을 받아야 한다.
