# ZZ 설계 철학

> **문서 상태: 현재 · 권위 있는 설계 원칙**

이 문서는 ZZ의 기능 목록이 아니라 기능을 어떤 원칙으로 설계하는지 설명한다. 구체적인 상태
필드와 API는 [controlled-workflow.md](controlled-workflow.md), Knowledge taxonomy와 Hindsight
계약은 [knowledge-system.md](knowledge-system.md)를 따른다.

## 1. 모델과 제어 시스템 사이의 프로토콜

ZZ에서 prompt, rule, skill, tool, command, runtime은 같은 지시를 여러 번 표현하는 장식이 아니다.
각각 다른 권한을 가진 프로토콜 계층이다.

| 계층                  | 담아야 하는 것                                              | 담지 말아야 하는 것          |
| --------------------- | ----------------------------------------------------------- | ---------------------------- |
| Prompt                | 기본 행동 원칙, 권한 우선순위, 현재 phase 안내              | 변경 가능한 현재 상태의 원본 |
| Rule                  | 긴 세션에서도 반복해야 하는 저장소 규칙                     | 승인·lease의 실제 판정       |
| Skill                 | 특정 상황에서 필요한 상세 절차                              | 모든 turn에 필요한 상태 dump |
| Model tool            | 조회, 구조화된 제안, 관찰·결과 보고                         | 사용자만 할 수 있는 승인     |
| Slash command/TUI     | 사용자의 시작·승인·중단·검토                                | 모델의 내부 추론 대체        |
| Runtime               | tool gating, state transition, evidence freshness, recovery | 의미 판단을 위한 장문 지식   |
| Registry/Git/Evidence | 현재의 권위 있는 사실                                       | 장기 의미 기억               |
| Hindsight             | 과거 경험과 지식의 검색·종합                                | 현재 workspace의 권위 상태   |

설계 규칙은 다음 한 문장으로 요약된다.

> 모델이 알아야 하는 것은 prompt와 skill로, 모델이 제안할 것은 tool로, 절대로 어기면 안 되는
> 것은 runtime으로, 현재 사실은 Registry·Git·Evidence로, 과거 지식은 Knowledge로 관리한다.

## 2. 권위와 freshness가 내용보다 먼저다

같은 문장이 여러 곳에 있더라도 더 그럴듯한 문장을 고르는 것이 아니라 소유권과 freshness로
판정한다.

```text
runtime policy
  > approved Task Specification
  > authoritative ZZW Registry
  > current Git/workspace/fresh evidence
  > repository rules and current user instruction
  > skill guidance
  > recalled Knowledge
```

예를 들어 Hindsight에 “빌드는 `bun run build:old`”가 저장돼 있어도 현재 `package.json`이
`bun run build`를 정의하면 현재 파일이 우선한다. 반대로 코드에서 즉시 알 수 없는 과거 설계의
실패 이유는 Knowledge가 다시 조사할 비용을 줄여 줄 수 있다.

모든 파생 상태에는 원본이 있어야 한다.

- TUI Todo: Plan DAG의 projection
- 상태줄 phase: Registry의 projection
- memory working set: Hindsight recall 결과의 교체 가능한 projection
- completion 설명: Specification과 fresh evidence의 projection

projection을 직접 수정해 원본 상태를 바꾸지 않는다.

## 3. 자율성은 승인 횟수가 아니라 승인된 범위 안의 판단력이다

좋은 제어 시스템은 모델을 매 동작마다 멈추게 하지 않는다. 사용자는 목표, 범위, 성공 조건,
고위험 권한을 승인하고 에이전트는 그 경계 안에서 조사·수정·진단·재검증을 자율적으로 수행한다.

다시 승인이 필요한 경우:

- 파일·시스템·도구 권한 범위가 확대됨
- 새로운 high-risk 또는 복구 곤란한 작업이 추가됨
- 성공 조건이나 검증 조건이 약해짐
- 이미 승인한 구현 전략의 핵심 계약이 바뀜
- 완료된 결과를 무효화하고 큰 downstream closure를 다시 수행해야 함

다시 승인이 필요하지 않은 경우:

- 컴파일 오류를 같은 구현 단계에서 수정
- 승인된 테스트를 위해 로컬 DB·Kafka·Docker 같은 전제를 준비
- 한 단계를 더 작은 단계로 나누되 권한 상한이 그대로임
- 같은 성공 조건을 더 강하게 검증
- 구현 중 발견한 세부 작업을 승인된 milestone 안에서 구체화

이 구분이 없으면 에이전트는 일을 하는 대신 Plan만 고치고 승인을 반복한다.

## 4. Plan은 실행 중 학습하는 구조다

초기 Plan은 미래를 완벽히 예측하는 문서가 아니다. 현재 증거로 실행 가능한 가장 좋은 가설이다.
구현이 진행되면 새 파일, 숨은 dependency, 잘못된 assumption, 더 좋은 validator가 발견된다.

ZZW는 이를 다음처럼 다룬다.

```text
초기 Plan DAG
  ├─ 확실한 근거리 concrete step
  └─ 불확실한 원거리 milestone
             │ discovery 결과
             ▼
       structural expansion
             │ 계약 밖의 권한/위험 발견
             ▼
         material patch → 사용자 승인
```

Plan version이 늘었다는 사실만으로 실패나 사용자 개입을 의미하지 않는다. 핵심은 어떤 계약이
바뀌었고, 어떤 step과 evidence가 보존되며, 어떤 dependency closure가 stale인지 설명하는 것이다.

## 5. 실패를 하나의 상태로 뭉개지 않는다

모든 non-zero exit를 Plan 실패로 취급하면 승인 폭주와 계획 churn이 생긴다. 최소한 다음을
구분한다.

| 종류                    | 예                                           | 기본 처리                            |
| ----------------------- | -------------------------------------------- | ------------------------------------ |
| implementation feedback | 타입 오류, 테스트가 드러낸 코드 결함         | 같은 step에서 수정 후 재검증         |
| missing precondition    | 로컬 서비스 미기동, 생성 파일 필요           | 승인 범위 안에서 전제 준비 후 재시도 |
| execution/tool failure  | timeout, tool 자체 장애                      | journal과 실제 효과를 reconcile      |
| contradicted assumption | 사용 중인 API가 예상과 다름                  | 영향 closure를 계산해 최소 patch     |
| material scope change   | 새 외부 시스템·migration·위험 권한 필요      | patch 후 사용자 재승인               |
| invalid verification    | validator가 성공 조건을 실제로 검증하지 않음 | validation 계약 수정·재검증          |

같은 operation의 결과가 불명확하면 자동 재시도보다 reconciliation이 먼저다. 중복 실행이 안전한지
모르면서 “한 번 더” 실행하는 것은 복구가 아니다.

## 6. 성공 주장이 아니라 증거를 저장한다

“완료했습니다”는 모델의 주장이다. ZZW completion은 다음이 연결될 때만 성립한다.

```text
approved specification
  └─ success condition / verification requirement
       └─ Plan validation step
            └─ declared validator
                 └─ actual result
                      └─ current workspace fingerprint
```

tool 호출 성공은 expected effect가 발생했다는 증거가 아닐 수 있고, 테스트 성공도 이후 파일이
바뀌면 stale이다. 증거는 source, outcome, trust, snapshot, version, timestamp를 가진다.

## 7. 로컬 우선과 장애 격리

Task 실행에 필요한 제어 상태는 `zz` 프로세스와 로컬 SQLite 안에 둔다. 이 선택은 설치를 단순화하는
것뿐 아니라 장애 경계를 명확하게 한다.

- `zz`만 실행하면 ZZW runtime이 함께 시작된다.
- 별도 `zz-workflowd`나 workflow daemon을 관리하지 않는다.
- 저장소마다 workflow DB를 분리해 unrelated task가 섞이지 않게 한다.
- same-machine 동시성은 WAL, `busy_timeout`, lease로 다룬다.
- 멀티머신 공유는 Git의 명시적 checkpoint/handoff 범위로 제한한다.
- Hindsight 장애는 Knowledge outbox 문제이며 ZZW 현재 상태의 장애가 아니다.

외부 서비스를 추가할 때는 편의보다 “서비스가 죽었을 때 어떤 기능까지 영향받는가”를 먼저
설계한다.

## 8. 장기 지식은 context dump가 아니다

더 많은 기억을 넣는다고 더 좋은 판단이 보장되지 않는다. ZZ Knowledge의 목표는 기억량이 아니라
현재 결정에 영향을 줄 수 있는 검증된 지식을 적절한 범위와 깊이로 가져오는 것이다.

### Retain

- 미래 사용 목적이 있어야 한다.
- current task progress와 raw transcript는 제외한다.
- scope, form, domain, source, confidence, applicability를 분류한다.
- 중복·충돌을 quick recall로 확인한다.
- 관련 evidence를 보존한다.
- 한 사용자 요청의 여러 항목은 request group으로 묶는다.

### Recall

- 목적과 depth를 명시한다.
- Global, Repository, Task scope를 필요만큼 선택한다.
- working set을 교체해 과거 recall을 대화에 누적하지 않는다.
- observation/mental model을 우선하고 필요할 때 source facts를 확장한다.

### Reflect

- 단일 사실 조회에 사용하지 않는다.
- 계획 비판, 반복 실패 분석, 기억 충돌 해결, 회고처럼 종합 추론이 필요할 때만 쓴다.
- 결과를 현재 코드와 evidence로 다시 검증한다.

## 9. 사용자 명시 요청은 자동 정책보다 강하다

사용자가 “이걸 기억해”, “전에 어떻게 했지?”, “그 기억을 고쳐”, “잊어”라고 말했다면 같은
turn에서 해당 Knowledge operation을 수행해야 한다. 대화 문맥만으로 “기억했다”고 답하지 않는다.
반드시 tool receipt나 명확한 실패 결과가 있어야 한다.

단, 사용자가 “현재 작업해 둔 것을 기억해”라고 말했을 때 모든 것을 Hindsight에 넣지 않는다.

- 현재 진행 단계 → ZZW Registry
- 코드 상태 → Git checkpoint
- 다음 세션 재개 정보 → handoff/session state
- 일반화 가능한 검증된 교훈 → ZZ Knowledge
- 공식 저장소 규칙 → AGENTS.md, ADR, README, runbook

의도를 존중하는 것과 저장 위치를 무분별하게 하나로 만드는 것은 다르다.

## 10. 기존 경험은 opt-in 제어 기능 때문에 망가지면 안 된다

원본 `/goal`과 `/guided-goal`은 upstream의 세션 중심 Goal이다. ZZW 안전 gate를 이 명령에 붙이면
Goal continuation과 승인 대기가 서로 깨우는 반복 흐름이 생긴다. 따라서 제어형 흐름은
`/zzw-goal`, `/zzw-guided-goal`에만 연결한다.

같은 원칙으로 Knowledge가 비활성화돼도 일반 대화와 ZZW는 동작하고, ZZW가 비활성 상태여도
일반 edit/tool 흐름은 upstream 방식으로 유지한다. 기능 경계를 사용자가 명시적으로 선택할 수
있어야 한다.

## 11. UI는 상태 머신의 디버거이기도 하다

상태줄과 slash command 출력은 장식이 아니다. 사용자가 다음을 구분할 수 있어야 한다.

- 모델이 응답 중인지, 입력을 기다리는지
- 원본 Goal인지 ZZW Task인지
- phase, Plan version, approval 상태, active step
- 현재 repository/worktree/branch
- evidence와 unresolved operation 존재 여부
- Knowledge bank, outbox, working set, 최근 provider 호출 상태

명령은 대화 context에 들어가지 않더라도 화면 history에는 남아야 한다. 긴 interview는 한 자리의
modal을 계속 덮어쓰지 않고 대화처럼 아래로 누적되어 사용자가 앞선 답을 검토할 수 있어야 한다.

## 12. 설계 검토 체크리스트

변경안을 리뷰할 때 다음 순서로 묻는다.

1. 이 상태의 authoritative owner는 누구인가?
2. 모델이 틀려도 runtime이 지켜야 하는 불변식은 무엇인가?
3. 실패·중단·재시작 시 중복 side effect를 어떻게 막는가?
4. 승인이 필요한 진짜 권한 확대와 정상 구현 피드백을 구분했는가?
5. 현재 증거가 바뀌었을 때 파생 상태가 stale 처리되는가?
6. Knowledge가 현재 상태처럼 사용되거나 raw transcript를 수집하지 않는가?
7. 일반 대화와 원본 Goal의 동작을 침범하지 않는가?
8. 사용자가 UI와 명령으로 실제 상태를 독립적으로 확인할 수 있는가?
9. Hindsight, Git remote, Docker 같은 외부 요소가 없을 때 degradation이 명확한가?
10. 구현 세부가 아니라 외부 계약을 검증하는 테스트가 있는가?
