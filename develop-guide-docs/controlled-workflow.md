# ZZWorkflow(ZZW) 개발 가이드

## 1. 목적

ZZWorkflow(약어 ZZW)는 모델의 대화 기억에만 의존하지 않고 코딩 Task를 여러 세션에서 안전하게 이어가기 위한 `zz` 내장 계층이다. 별도 daemon이나 HTTP coordinator는 사용하지 않는다. 현재 상태는 로컬 SQLite registry, Git, operation journal, verification evidence에서 결정하며 Hindsight는 과거 경험을 보조한다.

원본 OMP의 `/goal`과 `/guided-goal`은 ZZW와 독립적으로 동작한다. 이 두 명령에는 Task Contract, Plan DAG, operation journal, 승인 gate 또는 ZZW 모델 도구를 연결하지 않는다. 제어형 작업은 `/zzw-goal` 또는 `/zzw-guided-goal`로만 시작하고 `/zzw`로 관리한다.

핵심 원칙:

> 모델이 기억해야 하는 절차는 prompt/skill로 제공하고, 모델이 선택하는 행위는 구조화된 tool로 만들며, 반드시 지켜야 하는 상태 전이는 runtime과 저장소에서 강제한다.

## 2. 개념 모델

```text
Task
├─ Spec v1..N
├─ Attempt 1..N
│  ├─ Plan DAG v1..N
│  ├─ Episode 1..N
│  ├─ Operation journal
│  ├─ Verification evidence
│  └─ Local checkpoint
└─ Completion / Abandonment
```

- Task: 지속되는 사용자 목표
- Spec: 목표·범위·제약·성공 조건의 버전
- Attempt: 하나의 구현 전략과 workspace 계열
- Plan DAG: dependency와 validation을 가진 실행 계획
- Episode: 한 세션에서의 실행 구간
- Operation: side effect의 prepared/running/observed/reconciled 기록
- Evidence: 특정 workspace snapshot에 묶인 검증 결과

## 3. 주요 코드

| 영역                  | 위치                                                |
| --------------------- | --------------------------------------------------- |
| Task lifecycle        | `packages/coding-agent/src/goals/task-lifecycle.ts` |
| Goal runtime 연동     | `packages/coding-agent/src/goals/runtime.ts`        |
| 로컬 ZZWorkflow 통합  | `packages/coding-agent/src/workflow/integration.ts` |
| SQLite registry/store | `packages/coding-agent/src/workflow/store.ts`       |
| 설정                  | `packages/coding-agent/src/workflow/config.ts`      |
| ZZ Knowledge 통합     | `packages/coding-agent/src/knowledge/`              |
| 정적 ZZWorkflow prompt | `packages/coding-agent/src/prompts/goals/`          |
| 모델용 ZZWorkflow 도구 | `packages/coding-agent/src/tools/workflow-control.ts` |

## 4. Authority 순서

충돌할 때:

1. runtime policy와 tool permission
2. 승인된 Task Spec
3. 로컬 authoritative ZZWorkflow registry
4. 현재 Git/workspace/verification evidence
5. repository rules
6. 현재 사용자 메시지
7. skill/procedural guidance
8. Hindsight memory

Hindsight는 가장 아래의 advisory context다. 과거에 맞았던 기억이 현재 HEAD에서 틀릴 수 있다.

## 5. Side effect 프로토콜

쓰기 전:

1. active task/attempt/episode/step 확인
2. phase와 readiness 확인
3. 같은 머신의 workspace lease 확인
4. unresolved operation 부재 확인
5. expected effect와 operation fingerprint 기록
6. journal flush

쓰기 후:

1. 실제 workspace 관찰
2. operation 결과와 artifact/evidence 연결
3. postcondition 실행
4. active step 상태 전이
5. 예상 밖 변경을 observation으로 기록

`prepared`나 `running` 상태에서 프로세스가 끊겼다면 같은 명령을 자동 재실행하지 않는다. Git과 실제 workspace를 조사해 `not applied`, `applied but unrecorded`, `partially applied`, `unknown`으로 분류한다.

## 6. 진화하는 Plan DAG

Plan DAG는 OMP Todo에서 가져오지 않는다. `zzw_propose_plan` 또는 `zzw_patch_plan`이 만든 Registry 상태가 권위 있으며, Todo는 현재 Plan을 TUI에 보여 주는 읽기 전용 projection이다. ZZWorkflow가 활성화된 동안에만 Todo mutation은 거부된다. 원본 Goal의 Todo는 기존 동작을 유지한다.

최초 실행 Plan은 항상 `draft`이며 모델은 자신의 제안을 승인할 수 없다. 사용자가 `/zzw approve-plan`을 실행한 뒤에만 side effect가 허용된다. 이후 Plan은 실행 중 발견에 따라 버전이 증가하며, 각 step에는 최초 버전, 최근 계약 변경 버전, 계약 hash, parent, supersedes/supersededBy, assumption, 입력·출력 artifact가 남는다. 교체·무효화된 노드는 삭제하지 않고 lineage로 보존한다.

Plan은 tree가 아니라 DAG다. `parentStepId`는 화면의 계층을 표현하고, 실제 실행 순서는 `dependsOn` edge가 결정한다. 여러 선행 단계가 하나의 후속 단계로 합쳐지거나 한 단계가 여러 후속 단계로 갈라질 수 있다.

먼 미래가 불확실하면 `milestone`으로 planning horizon을 표시한다. milestone은 직접 실행되지 않고 validator나 성공·검증 매핑을 갖지 않는다. milestone의 `allowedTools`, `allowedTargets`, `riskClass`는 향후 구체화할 단계에 대해 사용자가 미리 승인한 권한 상한이다. dependency-ready가 되면 그 상한 안의 expansion patch가 concrete step으로 supersede하며, 상한을 넘으면 material patch로 재승인을 요구한다. 따라서 구현이 진행되면서 Plan은 커지거나 분해되고, 잘못된 경로는 lineage를 남긴 채 교체된다.

Plan patch는 위험도에 따라 승인 경계가 다르다.

- `structural`: 기존 권한·성공 기준 안에서 단계 분해, 추가, dependency 재연결, milestone 확장. 기본 설정에서는 기존 승인을 이어받아 즉시 계속한다.
- `material`: 도구 권한 확대, high-risk 단계, 성공·검증 기준 약화, 완료 결과 무효화. 반드시 다시 `/zzw approve-plan`을 실행한다.

모든 patch를 재승인하려면 `zzworkflow.planPatchApproval: always`로 설정한다. 기본값은 `material`이다. 승인 대기 중에는 ZZW 자동 continuation을 예약하지 않으므로 Goal continuation과 안전 gate가 서로 반복되지 않는다.

사용자는 다음 명령으로 실제 Registry 상태와 변경 근거를 확인한다.

- `/zzw status`: phase, active step, reconciliation, 다음 동작
- `/zzw plan`: 계층·dependency·lineage를 포함한 현재 DAG
- `/zzw history`: Plan 버전별 변경 요약
- `/zzw diff [version]`: 추가·수정·교체·무효화·보존 ID와 원인
- `/zzw why <step-id>`: 특정 step의 계약, 증거, 관찰, 변경 이유
- `/zzw evidence`, `/zzw operations`: 증거와 operation journal

사용자 설정 namespace도 `zzworkflow`를 사용한다. 이전 `workflow.heartbeatIntervalSeconds`와 `workflow.workspaceLeaseSeconds`는 로드 시 아래 키로 자동 이전한다.

```yaml
zzworkflow:
  heartbeatIntervalSeconds: 15
  workspaceLeaseSeconds: 90
  planPatchApproval: material
```

각 step은 최소한 다음을 가진다.

- preconditions
- dependencies
- expected effects
- affected files/systems
- output artifacts
- postconditions
- validation
- rerun policy
- risk class

Specification은 성공 조건에 `SC-*`, 명시적 검증 요구사항에 `V-*` 안정 ID를 부여한다. Plan은 설명 문구를 다시 복사하지 않고 `successConditionIds`와 `verificationIds`로 이를 연결한다. `validators`는 `yarn verify`처럼 실행 가능한 명령만 담는다. 따라서 “저장소 루트에서 yarn verify를 실행하고 종료 코드 0을 확인한다”라는 계약 설명과 `yarn verify` 명령이 문구상 달라도 같은 `V-*` 요구사항에 연결할 수 있다.

모든 성공 조건은 하나 이상의 validation 또는 acceptance step과 연결되고, 명시적 검증 요구사항은 validator가 있는 validation step과 연결되어야 한다. 잘못된 제안은 fail-fast하지 않고 ID 누락, 잘못된 의존성, 순환, validator 누락을 구조화된 `issues` 배열 하나로 반환한다. 모델은 전체 issue를 고친 뒤 한 번만 재제안한다. 불확실성이 큰 단계 뒤에는 짧은 planning horizon을 사용한다.

명령 실패와 계획 실패를 구분한다. 컴파일·린트·테스트가 현재 work 단계에서 수정할 코드 결함을 드러낸 `implementation-feedback`과, 승인 범위 안의 DB·Kafka·Docker daemon·생성 파일 같은 `missing-precondition`은 같은 단계를 계속하며 Plan 버전이나 승인을 바꾸지 않는다. 목표·전략·권한·dependency·acceptance 계약이 실제로 달라질 때만 계획 실패다. 계획 실패 시에도 전체 계획을 다시 쓰지 않는다. Runtime은 patch의 observation, evidence, failed step, contradicted assumption, artifact 소비 관계에서 직접 영향 root를 계산한 뒤 downstream dependency closure만 무효화한다. 영향 밖의 완료 step과 계약 hash가 같은 evidence는 자동 보존한다.

`zzw_patch_plan.update_steps`는 부분 갱신 계약이다. 생략한 scalar와 배열 필드는 기존 값을 보존하며, 빈 배열을 명시한 경우에만 해당 목록을 비운다. Plan 승인 전에는 필수 표시 필드와 dependency/mapping 구조를 다시 검증한다. 과거 버그로 손상된 부분 패치 snapshot은 직전의 유효한 snapshot과 병합해 복구하고, 그래도 복구할 수 없는 Todo projection은 안내 문자열로 안전하게 렌더링한다.

1. 같은 단계에서 코드 수정이나 승인된 전제 준비로 해결되는지 먼저 판정한다.
2. 해당하면 `implementation-feedback` 또는 `missing-precondition`으로 보고하고 Plan patch 없이 계속한다.
3. 그렇지 않으면 최초로 모순된 assumption/artifact를 찾는다.
4. 실행 실패, 사전조건·가정 반증, 예상 밖 효과, 독립 검증 실패, 환경 변화로 결과를 분류한다.
5. dependency closure를 계산한다.
6. invalidated/superseded step과 stale artifact를 표시한다.
7. evidence가 유효한 완료 step은 보존한다.
8. 실제 계약 변경만 최소 plan patch로 만든다.

operation 실패는 즉시 전체 Plan을 stale로 만들지 않고 `RECONCILING`으로 전환한다. 순수 실행 실패는 실제 조건이 달라졌음을 `changed_condition`으로 보고한 경우에만 제한적으로 재시도할 수 있다. 첫 실행 실패에 달라진 조건이 없다면 `retry-with-changed-condition`을 유지하고 Plan patch를 거부하므로 모델이 실패를 계획 변경으로 우회할 수 없다. Runtime은 tool, target, 정규화된 args와 실행 직전 workspace hash를 fingerprint로 기록한다. 코드가 실제로 수정된 뒤 같은 검사를 실행하면 새 조건으로 구분하지만, 같은 workspace에서 동일 명령이 두 번 실패하면 repair patch를 강제한다. 빈 patch로 retry gate를 우회할 수 없다.

workspace fingerprint가 side effect 직전에 바뀌거나 contradiction observation이 보고되면 Runtime이 `RECONCILING`에서 추가 쓰기를 차단한다. `/zzw approve-plan`을 반복해 reconciliation을 우회할 수도 없다.

모델이 사용하는 구조화 도구:

- `zzw_get_state`: authoritative state, plan, evidence, operation 조회
- `zzw_propose_plan`: 현재 Spec 버전에 대한 새 Plan DAG 제안
- `zzw_patch_plan`: 실패 원인과 보존 단계를 명시한 최소 패치 제안
- `zzw_report_observation`: Evidence와 모델 해석을 분리해 기록
- `zzw_report_step_result`: work step의 완료·실패·부분 결과 보고
- `zzw_submit_verification`: 정확한 validator 실행에서 나온 trusted evidence 제출

## 7. Verification과 Completion

도구 호출 성공은 Task 성공이 아니다. 검증은 다음 tuple에 묶인다.

```text
task/spec/plan version
workspace HEAD
dirty fingerprint
validator identity
verification requirement IDs
result
timestamp/freshness
```

검증 후 workspace가 달라지면 evidence는 stale이다. completion은 모든 성공 조건이 최신 evidence에 매핑될 때만 가능하다.

verification phase에서는 구현 파일을 수정하지 않는다. 실패를 고치려면 executing/replanning으로 상태를 되돌린다.

일반 tool result는 `raw` evidence다. 검증 단계의 `validators`에 선언된 bash command와 정규화 후 정확히 일치하고, exit code가 0이며, 현재 Spec/Plan/step/workspace snapshot에 연결된 경우에만 `verified` evidence가 된다. 검증 단계 자체는 `zzw_submit_verification`이 이 증거를 확인한 뒤에만 완료된다. 과거 버전에서 provenance 없이 저장한 verification은 `legacy-untrusted`로 취급한다.

Plan 버전이 증가해도 step contract hash, upstream dependency, Specification과 workspace가 같으면 해당 evidence는 유지할 수 있다. stale evidence에는 `step-contract-changed`, `dependency-invalidated`, `workspace-changed`, `spec-changed`, `superseded` 원인을 남겨 필요한 validation closure만 다시 실행한다.

내장 스킬 `zzw-plan-evolution`, `zzw-reconciliation`, `zzw-verification`은 이 절차를 모델에 상황별로 제공한다. 강제 규칙은 스킬이 아니라 Runtime에 남는다.

## 8. 내장 로컬 SQLite Registry

`zz`는 필요할 때 현재 저장소 전용 `~/.zz/agent/workflows/<repository-id>/workflow.db`를 직접 열고 schema를 초기화한다. 사용자가 별도 프로세스를 시작할 필요가 없다. 예전 전역 DB에 현재 저장소의 활성 lease가 남아 있으면 실행 중인 구버전 프로세스와 충돌하지 않도록 기존 DB를 계속 사용하며, lease가 끝난 다음 실행에서 Task·event·lease·heartbeat를 저장소별 DB로 이전한다. 이미 켜져 있던 구버전 프로세스가 이전 후 전역 DB에 후속 event를 기록하는 전환 경계에 대비해, 다음 시작에서도 더 최신인 legacy Task/event를 idempotent하게 재병합한다.

핵심 계약:

- SQLite는 `bun:sqlite`로 연다.
- WAL, foreign key, `busy_timeout`을 적용한다.
- task 갱신과 event 추가는 하나의 transaction으로 처리한다.
- event write는 idempotency key를 가진다.
- task version은 로컬 event 순서에 따라 단조 증가한다.
- repository identity마다 별도 DB를 사용하고 다른 저장소의 Task를 섞지 않는다.
- 실행 중 `git init` 또는 repository 경계 변경을 감지하면 ZZWorkflow Store와 Repository Knowledge runtime을 새 repository identity에 재바인딩한다.
- workspace lease는 같은 머신의 경쟁 `zz` 프로세스만 조정한다.
- lease owner episode만 heartbeat와 release를 수행한다.
- 만료 전 경쟁 lease는 차단하고 만료 뒤 takeover를 허용한다.
- recovery 조회는 최신 checkpoint와 episode를 결정적으로 반환한다.
- schema init과 과거 coordinator 설정 제거는 반복 실행 가능해야 한다.

이 DB는 로컬 사실 저장소다. 네트워크 파일시스템에 두거나 여러 머신에서 공유하는 계약은 없다.

## 9. 같은 머신의 동시 실행과 복구

별도 서버가 없으므로 coordinator outbox, HTTP 재전송, degraded network mode도 없다.

- 각 `zz` 프로세스는 같은 SQLite DB를 직접 연다.
- 짧은 write transaction과 WAL로 동시 접근을 직렬화한다.
- workspace lease와 heartbeat로 동일 workspace의 동시 쓰기를 막는다.
- 비정상 종료 뒤에는 lease 만료와 operation journal reconciliation을 거쳐 재개한다.
- Hindsight retain 실패는 ZZWorkflow DB가 아니라 별도 Knowledge DB의 durable outbox에서 다시 시도한다.
- 프로세스가 끊긴 operation의 완료 여부가 불명확하면 자동 재실행하지 않는다.

## 10. 로컬 Git Checkpoint

checkpoint는 사용자의 worktree를 바꾸지 않으면서 현재 추적 파일 상태를 복구 단서로 남긴다.

- dirty tracked file은 unattached stash commit/tree 방식으로 캡처한다.
- plan update, pause, handoff, completion 경계에서 로컬 checkpoint를 기록한다.
- remote ref를 만들거나 push하지 않는다.
- untracked file은 비변경 checkpoint에 포함되지 않으므로 checkpoint metadata에 그 존재를 기록한다.
- resume 시 Registry, Git HEAD, dirty state, operation journal을 먼저 대조한다.

Git 접근은 `packages/coding-agent/src/utils/git.ts`를 확장해 사용한다. 임의로 Git subprocess wrapper를 만들지 않는다.

## 11. ZZ Knowledge 연동

설정 예:

```yaml
knowledge:
  enabled: true
  userId: stable-user-id
  securityBoundary: personal
  hindsight:
    apiUrl: http://127.0.0.1:8888
```

이 계층에서는:

- upstream OMP Memory와 임의 transcript auto-retain을 사용하지 않는다.
- intake/planning/replanning/recovery 경계에서 목적별 recall을 한다.
- 일반 세션 시작에는 작은 orientation working set만 자동 조회한다.
- 모델에 raw bank/tag 선택권과 raw retain/delete 권한을 주지 않는다.
- 검증된 repo fact, decision, recipe, failed approach, preference만 제안받아 저장한다.
- evidence ID와 commit/spec/session/episode provenance를 붙인다.
- secret redaction과 `~/.zz/agent/knowledge/boundary-<hash>/knowledge.db`의 durable outbox를 통과한다.
- mutable summary는 최신 문서가 이전 문서를 대체한다.
- Goal 완료는 자동 저장이 아니라 review receipt만 생성한다.
- 전역 1개와 저장소 최대 4개의 mental model은 자동 갱신하지 않는다.

## 12. 필수 테스트

```sh
bun test \
  packages/coding-agent/test/goals/task-lifecycle.test.ts \
  packages/coding-agent/test/workflow-store.test.ts \
  packages/coding-agent/test/workflow-identity.test.ts \
  packages/coding-agent/test/workflow-checkpoint.test.ts \
  packages/coding-agent/test/knowledge-runtime.test.ts
```

새 상태 전이를 추가하면 최소한 정상 전이, 거부 전이, crash/recovery 전이 중 관련 계약을 추가한다.

Task lifecycle schema v1 snapshot은 시작 시 v2의 lineage·artifact·change-history 필드로 자동 정규화된다. 기존 repository DB를 삭제할 필요가 없다.
