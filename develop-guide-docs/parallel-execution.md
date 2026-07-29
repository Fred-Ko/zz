# ZZWorkflow 병렬 실행 계약

> **문서 상태: 현재 · 권위 있는 ZZW 병렬 실행 구현 계약**
>
> Task·Plan·승인·Evidence의 기본 계약은 [controlled-workflow.md](controlled-workflow.md)를 먼저 본다.

## 1. 목적

ZZWorkflow(ZZW)는 Plan DAG가 표현하는 독립성을 실제 실행 시간 단축으로 연결한다. 병렬화는 기존
tool-call fan-out이나 `task` 서브에이전트를 그대로 노출하는 기능이 아니다. ZZW가 ready step,
resource claim, 실행 snapshot, operation journal, evidence와 복구를 소유하고 기존 실행기는 그 아래의
프로세스·서브에이전트 실행 수단으로만 사용한다.

핵심 불변식은 다음과 같다.

- 승인된 Plan step만 실행한다.
- 모든 실행은 `waveId`, `laneId`, `stepId`에 귀속한다.
- 실행 전에 Wave, Lane, resource reservation과 operation을 영속화한다.
- 충돌하는 자원은 동시에 사용하지 않는다. 알 수 없는 자원은 충돌하는 것으로 취급한다.
- Primary workspace 쓰기와 isolated result 통합은 항상 직렬화한다.
- 서브에이전트 결과는 후보 증거다. 격리 validator의 성공은 Primary가 동일 base snapshot을 유지한
  경우에만 verified evidence가 되며 최종 통합 이후에는 다시 freshness 검사를 받는다.
- 완료 여부가 불명확한 operation은 자동 재실행하거나 중복 적용하지 않는다.
- 한 Lane의 일반 실패는 독립 Lane과 그 증거를 무효화하지 않는다.
- 원본 Goal, 일반 `task`, ZZ Knowledge/Hindsight의 권한과 저장소를 병렬 실행 장부에 섞지 않는다.

## 2. Plan DAG, Resource Graph, Execution Wave

세 구조의 책임을 분리한다.

```text
Plan DAG       의미적 선행 조건과 결과의 dependency
Resource Graph 같은 시간에 사용할 수 없는 경로·서비스·포트·Git 자원
Execution Wave 현재 snapshot에서 실제로 함께 실행하기로 예약한 Lane 집합
```

Resource 충돌 때문에 Plan DAG에 가짜 dependency를 추가하지 않는다. Plan 변경은 의미적 계약이
달라질 때만 수행하고 일시적인 실행 직렬화는 scheduler가 담당한다.

## 3. 실행 종류

### Primary serial

현재 workspace를 직접 변경한다. 격리가 불가능하거나 resource 범위가 불명확한 작업, Git metadata,
lockfile, 운영·외부 mutation, high-risk 작업은 이 방식으로만 실행한다.

### Validation

승인된 Plan의 exact validator를 모델이 아닌 runtime이 실행한다. workspace를 수정하지 않는 validator는
frozen primary snapshot에서, cache·coverage·generated output을 만들 수 있는 validator는 동일 콘텐츠의
격리 snapshot에서 실행한다. 독립 validator는 bounded `all-settled` wave로 실행한다.

### Read-only subagent

독립 조사·분석·리뷰를 수행한다. read-only tool set과 step scope를 runtime에서 강제한다. 결과는
observation 후보이며 Plan 변경과 승인은 부모만 수행한다.

### Isolated write subagent

동일 base snapshot의 격리 workspace에서 코드를 변경한다. ZZW 실행에서는 일반 task 설정의 자동 patch
적용을 사용하지 않는다. Lane은 patch/commit artifact와 구조화된 결과를 반환하고 Primary workspace의
integration queue가 범위·충돌을 검사한 뒤 순차 적용한다.

초기 구현에서는 ZZW child가 다시 `task`를 호출하는 중첩 delegation을 허용하지 않는다.

모든 delegated Lane은 구현 결과와 별도로 `plan_impact`를 제출한다. child는 Plan을 읽기·수정하는
controller가 아니며, 고정된 Spec/Plan version, step contract hash와 base snapshot에 대해 발견한 영향을
구조화해 보고할 뿐이다. Runtime은 모델 설명이 아니라 이 결과와 실제 patch/evidence를 장부에 귀속한다.

```text
none       구현 세부만 달라짐                         → 기존 gate 계속
execution  같은 Work Unit의 bounded repair로 해결     → Plan 유지
structural step/dependency/resource/validator가 틀림  → 최소 Plan patch
contract   목표·범위·공개 계약·보안·위험 판단 필요    → 사용자 결정
```

실패 자체는 Plan 영향이 아니다. 현재 Work Unit의 허용 target/tool/resource/risk 안에서 고칠 수 있으면
`execution`이며 Plan version을 만들지 않는다.

## 4. Step 실행 계약과 Resource Claim

기존 Plan은 실행 계약이 없으면 안전한 `primary` 직렬 단계로 해석한다.

```ts
interface StepExecutionContract {
  executor: "primary" | "validator" | "subagent-readonly" | "subagent-isolated";
  delegationAssessment?: DelegationAssessment;
  resourceClaims: ResourceClaim[];
  isolation: "none" | "snapshot" | "required";
  integration: "none" | "patch";
  failureDomain: "step" | "wave" | "shared-resource";
  maxRuntimeMs?: number;
  agent?: string;
  capability?: "mechanical" | "local-reasoning" | "system-reasoning";
  workUnits?: WorkUnitContract[];
}

interface DelegationAssessment {
  decision: "retain-primary" | "delegate-readonly" | "delegate-isolated";
  reasonCode:
    | "cross-cutting-reasoning"
    | "shared-write-surface"
    | "unbounded-scope"
    | "exclusive-resource"
    | "high-risk-side-effect"
    | "atomic-sequence"
    | "bounded-readonly"
    | "bounded-isolated-write";
  rationale: string;
}

interface WorkUnitContract {
  id: string;
  content: string;
  expectedEffects: string[];
  allowedTools: string[];
  allowedTargets: string[];
  postconditions: string[];
  resourceClaims: ResourceClaim[];
  validators: string[];
  capability: "mechanical" | "local-reasoning" | "system-reasoning";
  maxRuntimeMs?: number;
}

interface ResourceClaim {
  kind:
    | "workspace-path"
    | "git-metadata"
    | "lockfile"
    | "cache"
    | "port"
    | "service"
    | "database"
    | "external-api"
    | "cpu"
    | "memory";
  key: string;
  access: "read" | "write" | "exclusive";
}
```

`read/read`만 기본 호환이다. 동일하거나 포함 관계인 key에서 `write`가 하나라도 있거나 어느 한쪽이
`exclusive`이면 충돌한다. 동적 bash 효과처럼 resource 범위를 정적으로 확정하지 못하는 단계는 병렬
executor 계약을 승인하지 않고 `primary`의 저장소 루트 exclusive 단계로 계획해야 한다. 모델의 병렬
가능 주장만으로 runtime 판정을 우회할 수 없다.

특별 자원 정책:

- package manifest와 lockfile, Git index/ref/worktree metadata는 기본 exclusive다.
- 같은 port, DB/schema, Docker project, Kafka topic/consumer group은 exclusive다.
- coverage, snapshot update, generated output, 전역 cache는 write claim을 요구한다.
- 외부 API mutation과 운영 데이터는 병렬 실행하지 않으며 별도 사용자 승인 경계를 유지한다.
- CPU·memory claim은 현재 진단용 메타데이터이며 충돌 key로 사용하지 않는다. 실제 동시 실행 수는
  executor별 concurrency 설정이 통제한다.

## 5. Scheduler

Scheduler는 dependency가 완료된 모든 pending concrete step을 ready set으로 계산한다. 승인, contract
hash, resource claim, executor, capacity를 검사한 뒤 충돌하지 않는 집합을 선택한다. 선택 순서는
critical path, Plan 위상 순서, 안정적인 step ID 순서로 결정해 같은 입력에서 같은 Wave를 만든다.

상한은 ZZW validator/subagent 설정, 일반 task executor semaphore, provider rate limit과 ready step 수에
의해 단계적으로 제한된다. 일반 `task.maxConcurrency`의 큰 기본값을 ZZW가 그대로 사용하지 않는다.
validator와 subagent는 각자 독립 semaphore를 사용하므로 한쪽의 남는 슬롯이 다른 쪽의 승인된 상한을
늘리지 않는다.

```yaml
zzworkflow:
  execution:
    mode: validation # serial | validation | safe-parallel
    validationConcurrency: 4
    subagentConcurrency: 3
    preserveFailedLanes: true
    rollingEpoch: true
    workUnits:
      enabled: false
      model: "*:medium"
    adversarialReview:
      enabled: true
      model: "openai-codex/gpt-5.6-sol:high"
      maxRepairAttempts: 1
```

기본값은 `validation`이다. 이 모드에서는 validator만 자동 병렬화한다. `serial`은 validator와 subagent를
포함한 자동 실행 Lane을 하나씩 실행하고, `safe-parallel`은 resource-safe subagent 동시 실행도 허용한다.
이 실행 방식은 scheduling만 결정하며 Work Unit 분해와 적대 리뷰 설정은 바꾸지 않는다. 따라서 Work
Unit을 순차 실행하면서 리뷰하거나, Work Unit을 병렬 실행하면서 리뷰를 끄는 조합이 모두 가능하다.
Primary 통합 동시성은 설정이 아니라 runtime 불변식으로 항상 1이다.

ZZW 격리 backend는 사용자 설정이 아니다. runtime이 항상 native PAL의 `auto` resolver를 사용해 현재 OS와
filesystem에서 가용한 backend를 선택하고, 실제 선택과 fallback 이유를 Lane 장부에 기록한다.

Work Unit 분해는 기본적으로 꺼져 있다. `workUnits.enabled=false`이면 Plan에 Work Unit 계약이 있더라도
기존처럼 Step당 하나의 Lane을 실행한다. 적대 리뷰 설정은
독립적으로 켜고 끌 수 있다. 활성화하면 capability와 관계없이 모든 isolated-write 후보가 독립 reviewer
gate를 통과해야 한다. 리뷰를 끄더라도 exact validator와 patch scope 검사는 생략되지 않는다.

Work Unit 분해가 활성화되면 현재 Plan의 모든 실행 가능한 `work` 단계는 `delegationAssessment`를 가져야
한다. Runtime은 누락을 Primary 기본값으로 해석하지 않고 Plan 제안을 거절한다. `retain-primary`도 명시적
판단이며 공유 write surface, cross-cutting reasoning, exclusive resource처럼 구조화된 이유와 설명을
남긴다. `delegate-readonly`와 `delegate-isolated`는 각각 executor와 일치해야 한다. 현재 실행 설정과 판단
요약은 동적 workflow context, `zzw_get_state`, `/zzw status`, `/zzw plan`에 노출한다.

## 6. Wave와 Lane 수명주기

```text
Wave: prepared → running → draining → settled
                         ↘ interrupted / reconciling

Lane: prepared → running → awaiting-review → awaiting-validation → awaiting-integration → integrated
                         ↘ awaiting-reconciliation
                         ↘ succeeded / failed / cancelled / interrupted / unknown / rejected / superseded
```

Wave 시작 전 session journal에 Wave, 모든 Lane, resource claim, 최초 operation과 Task state를 기록하고
flush한다. 같은 payload는 repository별 SQLite event store에도 idempotent event로 동기화한다. 두 저장소를
가로지르는 분산 transaction은 아니므로 crash recovery는 journal, SQLite event와 workspace를 대조한다.
flush가 끝난 뒤에만 실제 프로세스나 subagent를 시작한다. 현재의
`pendingOperationIds.length > 0` 전역 차단은 같은 Wave의 호환 Lane을 허용하되, 미해결 operation과
resource가 충돌하거나 Primary workspace를 수정할 때는 계속 차단한다.

## 7. Workspace와 통합

Lane base snapshot은 현재 ZZW workspace fingerprint와 Plan step contract hash를 고정한다. 격리 실행은
기존 task isolation PAL이 만드는 copy-on-write/복제 workspace와 baseline capture를 재사용한다. 격리
구성이 실패하면 Primary 실행으로 조용히 내리지 않고 해당 Lane을 실패 처리한다.

isolated Lane은 Primary workspace, Git ref, 공유 cache를 직접 바꾸지 않는다. 결과 통합은 다음 순서다.

1. patch hash와 실제 touched path를 계산한다.
2. allowed target과 resource claim 안인지 검사한다.
3. nested repository patch는 자동 통합하지 않고 거부한다.
4. 현재 Primary에 forward apply 가능한지와 이미 적용된 patch인지 읽기 전용으로 확인한다.
5. integration operation을 준비·flush하고 running으로 기록한다.
6. Primary workspace에 Plan 순서대로 한 Lane씩 적용한다.
7. post-state와 evidence를 기록한다.

충돌하면 Primary를 부분 수정하지 않고 artifact를 보존한다. 승인 envelope 안의 conflict-repair는
structural patch로 만들 수 있고 범위·도구·위험이 커지면 material 재승인을 요구한다.

## 8. Evidence와 완료

Evidence, Lane, operation을 함께 보면 task/spec/plan version, step contract hash, wave/lane/operation,
base/Primary workspace hash, validator fingerprint, resource claim, output digest, artifact, exit code와 시각을
결정적으로 역추적할 수 있다. 모든 필드를 Evidence 한 row에 중복 저장하지 않는다.

```text
subagent 설명                      raw
isolated workspace의 자체 테스트  candidate
source가 연결된 read-only 조사     observed
정확한 validator와 snapshot        verified
최종 통합 snapshot의 최신 검증     completion-eligible
```

Task completion gate는 최종 통합 snapshot의 completion-eligible evidence만 받아들인다.
따라서 전체 workspace를 판정하는 validation 단계는 결과를 바꿀 수 있는 모든 primary·isolated-write
단계에 의존해야 한다. Runtime도 ready primary를 먼저 실행하고 isolated-write와 validator를 서로 다른
Wave로 분리해, 같은 Wave의 통합 때문에 방금 생성한 검증 증거가 즉시 stale이 되는 실행을 막는다.

## 9. 실패·Plan 변경·사용자 개입

모든 Lane 결과와 증거는 개별 보존한다. 현재 모델이 처리할 reconciliation 포인터는 가장 먼저 조치할
실패 하나를 가리키지만 `/zzw lanes`와 operation journal에는 나머지 실패도 사라지지 않는다. 한 Lane의
`step` 실패는 독립 Lane을 기본적으로 끝까지 실행한다. `wave` 실패는 아직 시작하지 않은 Lane과 실행 중
형제를 취소하고, `shared-resource` 실패는 같은 resource key를 공유하는 형제만 취소한다. 부모 모델에는
Lane별 중간 실패를 연속 전달하지 않고 Wave 집계 결과를 한 번 전달해 Plan churn을 막는다.

### Delegated Plan Impact Protocol

Work Unit과 적대 리뷰는 다음 구조를 공통으로 반환한다.

```ts
interface PlanImpact {
  level: "none" | "execution" | "structural" | "contract";
  kind:
    | "none"
    | "implementation-feedback"
    | "missing-precondition"
    | "execution-failure"
    | "contradicted-precondition"
    | "contradicted-assumption"
    | "unexpected-effect"
    | "missing-step"
    | "dependency-change"
    | "resource-change"
    | "validation-change"
    | "scope-change"
    | "risk-change"
    | "contract-decision";
  reason: string;
  evidence: string[];
  affectedStepIds: string[];
  contradictedAssumptionIds: string[];
  proposedChanges: string[];
}
```

Runtime은 level과 kind의 허용 조합을 검사한다. 존재하지 않는 Step/assumption ID는 권위 있는 영향
참조로 받아들이지 않으며 현재 Lane step은 항상 영향 root에 포함한다. non-none 결과는 Lane operation
evidence에 연결된 Observation을 만들고 `/zzw lanes`, `zzw_get_state`, 동적 workflow context에서 조회할 수
있다. `proposedChanges`는 Plan patch 입력 후보이지 자동 실행 명령이 아니다.

`execution`은 isolated candidate를 Primary에 통합하지 않고 같은 selector·scope의 제한 repair Lane으로
보낸다. repair 상한을 소진하면 현재 Plan을 stale로 만들지 않은 채 reconciliation에서 실행 결과를
분류한다. `structural`과 `contract`은 후보 patch를 artifact로 보존하지만 통합하지 않으며 새 Lane
admission을 닫는다. 이미 시작된 독립 Lane은 failure-domain 규칙에 따라 끝까지 기록한 다음 epoch를
settle한다. Runtime은 structural이면 `REPLANNING/patch-plan`, contract이면
`AWAITING_USER/request-user`를 직접 설정하므로 부모가 자연어 observation을 보고 추측하지 않는다.

적대 리뷰의 구현 verdict와 Plan impact는 독립이다. 후보 코드가 맞아 `pass`여도 승인된 계약으로 그
구현을 사용할 수 없으면 structural/contract gate가 통합을 막는다. 반대로 `reject + execution`은 Plan을
고치지 않고 후보만 repair한다. reviewer는 Plan을 직접 변경하거나 후보를 수정할 수 없다.

Lane은 시작 시 spec/plan version, step contract hash와 base snapshot을 고정한다. active Wave 또는 미해결
operation이 존재하는 동안 Plan 교체·패치·승인을 차단한다. 따라서 실행 도중 계약이 바뀌는 race를
허용하지 않고 Wave가 settle/reconcile된 다음 Plan version을 진화시킨다. 기존 단계의 execution 계약을
바꾸거나 새로운 validator/subagent 병렬 단계를 추가하는 patch는 material로 분류해 다시 승인받는다.

pause나 사용자 interrupt는 공통 AbortSignal로 새 Lane 시작을 막고 실행기 고유의 프로세스·세션 abort를
호출한 뒤 terminal Lane 상태와 registry를 flush한다. 종료 여부가 확정되지 않으면 재시작 시 `unknown`으로
분류한다. 사용자 메시지를 child에 자동 broadcast하지 않는다.

## 10. 복구

재시작 시 prepared/running/unknown Wave와 Lane, Primary workspace, output/patch artifact와 operation
pre/post hash를 대조한다. PID만으로 완료를 판정하지 않는다. 현재 실행 중이던 process/subagent를
재접속하지 않으며 `running` operation과 Lane은 `unknown`으로 바꿔 명시적 reconciliation을 요구한다.
각 operation은 snapshot 역참조에 의존하지 않고 `waveId`와 `laneId`를 직접 보존한다. 모든 Lane 성공,
evidence와 workspace hash까지 이미 기록됐지만 단계 완료 기록 직전에 종료된 경우에는 재실행 없이 그
단계 완료를 복원한다. patch 생성 후 integration operation 준비 전에 종료된 isolated Lane은
`interrupted`로 바꾸고 보존된 patch를 명시적으로 reconciliation하게 한다.

```text
not-started
running-interrupted
completed-unrecorded
partially-produced
integrated-unrecorded
unknown
```

safe validator는 동일 snapshot을 확인한 뒤 재실행할 수 있다. isolated write와 integration의 unknown
상태는 자동 재실행하거나 patch를 재적용하지 않는다. 격리 workspace 자체는 실행기 정리 계약에 따라
제거되므로, 복구에는 장부와 보존된 output/patch artifact를 사용한다.

## 11. 사용자 가시성

상태줄은 Wave 요약만 표시하고 상세 정보는 `/zzw lanes`에서 제공한다.

```text
ZZW EXECUTING · Wave W12 · 3 running / 2 queued / 1 failed
```

`/zzw plan`은 step별 executor/resource 계약을, `/zzw why <step-id>`는 dependency와 실행 계약을,
`/zzw operations`는 wave/lane 귀속을, `/zzw lanes`는 최근 Lane의 상태·resource·validator·오류를 표시한다.
실행 중 취소는 TUI의 기존 interrupt/Esc 경로를 사용한다. 별도 `/zzw cancel`, `/zzw retry`, `/zzw cleanup`
명령은 아직 제공하지 않으며 문서만 앞서 정의해서는 안 된다.

## 12. 단계적 활성화

1. 기존 Plan을 serial contract로 이전한다.
2. ready set, resource scheduler와 durable Wave/Lane을 구현한다.
3. Validation Wave를 기본 병렬화한다.
4. read-only subagent Wave를 추가한다.
5. isolated write와 sequential integration을 opt-in으로 제공한다.
6. crash recovery, Plan 변경 차단, cancel과 TUI를 검증한다.
7. 현재 기본은 `validation`이며 충분한 실사용 검증 전에는 `safe-parallel`을 기본으로 바꾸지 않는다.

각 단계는 serial mode 회귀가 없어야 다음 단계로 간다. timing에만 의존하는 flaky test 대신 fake executor,
barrier와 crash injection으로 실제 동시 실행, durable prepare, all-settled, 중복 적용 방지를 검증한다.

## 13. Rolling Execution Epoch

> **상태: 구현됨.** 현재 runtime은 동일 승인·Plan version·snapshot 계보 안에서 동적 Lane을 같은
> epoch 장부에 durable admission한다. isolated patch 통합처럼 snapshot이 변하면 admission을 닫고 다음
> epoch로 넘긴다.

깊고 실행 시간이 비대칭인 DAG에서는 고정된 all-settled Wave가 불필요한 barrier가 될 수 있다. 빠른
Lane이 완료되어 후속 step이 dependency-ready가 되어도 같은 Wave의 느린 형제를 기다리기 때문이다.
따라서 Wave를 "동시에 시작한 고정 배치"에서 다음 계약을 공유하는 rolling execution epoch로 발전시킨다.

- 같은 승인된 spec/plan version과 execution policy
- 같은 Primary snapshot 계보
- 같은 resource scheduler와 concurrency budget
- 같은 취소·복구·집계 경계

열린 epoch에서는 완료된 admission cohort가 Step 완료를 만들 때마다 DAG ready frontier를 다시 계산한다.
빈 executor 슬롯과 호환 resource가 있으면 후속 Lane을 실행 전에 journal과 SQLite에 추가·flush한 뒤
같은 epoch에서 시작한다. 전체 DAG의 깊이나 위상 level을 미리 Wave로 고정하지 않는다. 현재 executor는
한 번에 admission된 cohort 안에서는 all-settled를 유지한다. 따라서 느린 형제 하나가 같은 cohort의 빠른
형제 후속 admission을 지연할 수 있으며, Lane completion event 단위 admission은 후속 최적화 항목이다.

다음 사건은 epoch barrier다.

- Primary workspace mutation 또는 isolated patch integration으로 snapshot이 바뀜
- Plan/spec version, 승인 envelope 또는 execution contract가 바뀜
- unknown operation, recovery 또는 사용자 중단으로 reconciliation이 필요함
- 전역 검증처럼 고정 snapshot 전체를 판정해야 함

Rolling 전환 후에도 Lane별 all-settled 결과 보존, resource lock, integration 직렬화와 unknown operation
자동 재실행 금지는 유지한다. scheduler 구현은 completion event 기반 admission, 동적 Lane durable prepare,
epoch draining과 crash injection을 검증해야 한다. 현재 계약 테스트는 cohort 종료 뒤 ready descendant가 같은
epoch에 durable admission되는 동작을 보호한다. 느린 형제와 무관한 Lane completion event 단위 admission과
starvation 방지는 다음 executor 최적화에서 별도 계약 테스트로 고정한다.

## 14. Capability 분류와 실행 단위 분해

> **상태: 구현됨 · 기본 비활성화.** capability 분류와 Step 하위 Work Unit 계약은 제공되지만
> `zzworkflow.execution.workUnits.enabled` 기본값은 `false`다.

Plan DAG를 특정 모델의 가격이나 추정 능력에 맞춰 파일 단위로 과도하게 쪼개지 않는다. Plan Step은 사용자
승인, dependency와 성공 증거가 의미를 갖는 **독립 결과 단위**로 유지하고, 실행 시 Step 아래에
**독립 검증 가능 Work Unit**을 만든다.

```text
Plan Step       의미·승인·dependency·완료 증거의 단위
└─ Work Unit    모델 위임·resource claim·재시도·승격의 단위
   └─ Operation 실제 tool/process/patch 실행 장부
```

모델에 위임할 수 있는 Work Unit은 다음 조건을 모두 만족해야 한다.

- 하나의 명확한 의도와 예상 결과가 있다.
- 입력, allowed target, 금지 범위와 출력 schema가 닫혀 있다.
- 새 아키텍처·API·보안·동시성·데이터 계약 결정을 요구하지 않는다.
- 다른 미완료 Work Unit의 추론 결과나 같은 파일 수정에 의존하지 않는다.
- 실패를 결정적으로 판정할 validator 또는 구조화된 관찰 기준이 있다.
- patch가 작고 되돌릴 수 있으며 Primary 통합 전에 독립 검사가 가능하다.
- 필요한 repository context가 선택한 모델의 context 범위 안에 들어가고 숨은 전역 상태가 없다.

파일 수나 토큰 수는 보조 guardrail일 뿐 난이도의 대리값으로 사용하지 않는다. 한 줄의 인증·트랜잭션
변경은 시스템 수준 판단이 필요할 수 있고, 여러 파일의 기계적 rename은 `mechanical`로 분류할 수 있다.

권장 capability class는 실제 provider/model ID가 아닌 의미 등급으로 Plan/Work Unit에 기록한다.

| 등급               | 적합한 작업                                                              | 제외할 작업                                              |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `mechanical`       | 목록화, 정형 변환, 명확한 테스트 추가, exact validator가 있는 제한 patch | 요구사항 해석, 설계 선택, 원인 불명 장애                 |
| `local-reasoning`  | 한 subsystem 안의 알려진 패턴 구현·진단                                  | cross-cutting 계약, 복합 migration, concurrency/security |
| `system-reasoning` | Plan 작성·수정, 아키텍처, 충돌 해결, 복합 원인 분석, completion 판단     | 없음; 사용자가 지정한 selector로 실행                    |

capability class는 모델 가격·성능 등급이나 model routing key가 아니다. runtime은 모든 Work Unit과 제한
repair에 하나의 사용자 선택 모델을 사용하고, capability는 분해 가능성·리뷰·위험 판정 메타데이터로만
사용한다. 설정 UI에는 현재 세션의 `/model`과 동일하게 로그인·인증 및 `enabledModels` 범위를 통과한
concrete `provider/model`만 노출하고, 각 모델 아래에는 그 모델이 실제 지원하는 effort와 기본 effort만
제시한다.
기본값 `*`은 일반 wildcard나 role alias가 아니라 **실행 시점의 현재 세션 모델**이라는 ZZW 전용
선택값이고 `*:high`처럼 현재 모델의 지원 effort를 함께 고를 수 있다. Wave 준비 시 이를 exact
`provider/model[:effort]` selector로 해석해 Lane 계약에 기록하며, 명시한 모델이나 effort가 더 이상 선택
가능하지 않으면 다른 값으로 조용히 fallback하지 않고 Wave 준비를 차단한다. runtime은 selector의
가격·속도·성능 순위를 추론하지 않는다. 결과가 output schema 위반, unexpected path,
validator 실패, 낮은 근거, contradicted assumption 중 하나를 보이면 같은 prompt를 무한 반복하지 않는다.
동일 scope·resource·risk envelope 안에서는 Work Unit selector로 제한 재처리할 수 있고,
scope나 부수효과가 커지면 Plan patch와 기존 material 승인 규칙을 적용한다.

과분해도 피한다. 같은 파일·resource·validator를 공유하거나 결과가 함께 있어야만 검증되는 작업,
강하게 순차적인 작업은 하나의 Work Unit으로 묶는다. 목표는 가장 작은 작업이 아니라 **가장 작은 독립
검증 가능 작업**이다. fan-out은 모델 가격이 아니라 실제 독립성, 병렬 처리 이점, context 복제·통합·검증·
복구 overhead를 기준으로 선택한다.

### 격리 write 후보의 적대적 리뷰 게이트

설정상 eligible인 격리 write 결과는 Primary 통합 전에 작성자와 다른 새 read-only subagent의 적대적
리뷰를 통과해야 한다. reviewer의 목적은 patch를 대신 완성하거나 작성자의 결론을 확인하는 것이 아니라
계약 위반과 반례를 적극적으로 찾는 것이다. implementer와 reviewer 모델은 독립 선택값이며 어느 쪽도
더 저렴하거나 더 강하다고 가정하지 않는다.

```text
selected implementer
  → isolated candidate patch
  → independent adversarial reviewer
  → exact validator
  → sequential Primary integration
```

reviewer는 작성자의 숨은 reasoning이나 대화 요약을 이어받지 않는다. 고정된 base snapshot, Work Unit
계약, candidate diff, allowed target과 검증 명령만 새 context로 받는다. 필요할 때만 작성자 rationale을
두 번째 자료로 조회해 첫 판단의 anchoring을 줄인다. reviewer는 read-only이며 patch를 고치거나 Plan을
바꾸거나 승인할 수 없다.

리뷰 결과는 구조화한다.

```text
verdict: pass | reject | escalate
findings: string[]
residual_risks: string[]
plan_impact: PlanImpact
```

각 finding 문자열에는 가능한 경우 심각도, 위반한 계약 조항, 파일·줄 또는 evidence 참조, 구체적 반례와
필요한 검증을 함께 기록한다.

`pass`는 verified evidence가 아니며 exact validator를 대체하지 않는다. `reject`는 승인 envelope 안에서
설정된 횟수만큼 제한 repair Work Unit을 만들고 새로운 reviewer가 다시 검사한다. 동일 prompt를 무한
반복하거나 원 reviewer에게 자기 판단을 철회시키지 않는다. repair는 Work Unit 모델·effort selector를
그대로 사용하며 이를 능력의 자동 승격으로 해석하지 않는다. 반복 실패, critical finding,
reviewer 간 결론 충돌은 reconciliation으로 전환한다. scope·resource·위험이 커지면 Plan patch와 material
재승인을 요구한다.

reviewer 모델은 implementer와 별도로 선택한다. 같은 concrete model을 선택해도 새 agent/session과 새
context를 사용하므로 실행 독립성은 유지되지만, 서로 다른 모델을 사용할지는 사용자 정책이다. Work Unit별
구현과 그 리뷰는 dependency 관계라 동시에 실행하지 않지만, 서로 독립인 여러 Work Unit의 리뷰 Lane은
resource가 충돌하지 않으면 병렬 실행할 수 있다.

runtime은 implementer와 reviewer의 서로 다른 agent/session ID, base/patch hash, verdict, finding,
validator evidence와 최종 integration operation을 같은 Work Unit lineage에 기록한다. 모델 가격은
scheduler나 review gate의 입력이 아니며, 사용자가 선택한 selector를 그대로 해석한다.

적대 리뷰는 `zzworkflow.execution.adversarialReview.enabled`로 독립 제어한다. 기본값은 `true`지만 Work
Unit delegation이 꺼져 있으면 일반 Step 실행을 임의로 분해하지 않는다. 리뷰를 끄면 isolated-write
후보는 리뷰 Lane을 만들지 않고 후보 validator로 이동한다. 리뷰가 `reject`이면 설정된 횟수만큼 별도 선택된
repair Lane을 새로 만들고 이전 후보를 `superseded`로 보존한다. `escalate`, 반복 거절 또는 리뷰 실행
실패는 후보를 통합하지 않고 reconciliation으로 넘긴다.
