# zzw_propose_plan

> 승인된 Task Specification을 실행 가능한 Plan DAG로 제안합니다.

## 입력

- `based_on_spec_version`: 계획의 기준이 된 Specification 버전
- `steps`: 단계 ID, 의존성, 허용 도구와 대상, 예상 효과, 사후 조건, Specification 참조 ID, validator, 재실행 정책 및 위험 등급을 포함한 단계 목록
  - `success_condition_ids`: `zzw_get_state(detail="spec")`의 `successCriteria[].id`
  - `verification_ids`: 같은 응답의 `verificationRequirements[].id`
  - `validators`: Bash에서 그대로 실행할 수 있는 명령. 검증 요구사항의 설명 문장이 아니다.
  - `kind`: `work`, `validation`, `acceptance`, 또는 불확실한 후속 planning horizon인 `milestone`
  - milestone의 `allowed_tools`, `allowed_targets`, `risk_class`: 후속 expansion에 미리 승인하는 권한 상한
  - `parent_step_id`, `supersedes`: 화면 계층과 step 교체 lineage
  - `assumption_ids`, `consumes_artifacts`, `produces_artifacts`: 영향 범위 계산에 사용하는 가정·dataflow
  - `execution`: executor, resource claim, isolation, integration, failure domain과 선택적 runtime/agent 제한
    - `delegation_assessment`: `retain-primary`, `delegate-readonly`, `delegate-isolated` 중 하나와 구조화된 reason code·근거
    - `capability`: `mechanical`, `local-reasoning`, `system-reasoning` 의미 등급
    - `work_units`: Step보다 작은 독립 검증 가능 위임 단위. 상위 Step의 tool/target 권한을 넘을 수 없다.

`execution.executor`는 `primary`, `validator`, `subagent-readonly`, `subagent-isolated` 중 하나입니다.
workspace path, Git metadata, lockfile, cache, port, service, database, external API를 실제 효과에 맞춰
`read`, `write`, `exclusive` claim으로 선언합니다. 범위를 증명할 수 없으면 `primary`와 저장소 루트
exclusive를 사용합니다. 쓰기 validator는 snapshot 격리가 필요하고 isolated subagent는 patch 통합만
허용됩니다. 전체 workspace 검증은 결과를 바꿀 수 있는 모든 쓰기 단계에 의존해야 합니다.

Work Unit은 모델 가격 때문에 Plan DAG의 의미 단위를 잘게 나누지 않기 위한 선택 계약이다. 각 Work
Unit은 닫힌 content, expected effect, allowed tool/target, postcondition, resource claim, validator와
capability를 가져야 한다. 특히 `mechanical` isolated-write Work Unit은 exact validator가 필수다. 실제
분해 실행 여부는 `zzworkflow.execution.workUnits.enabled` 설정이 결정하며 기본값은 `false`다.
설정값이 `true`이면 모든 현재 work 단계에 위임 판단이 필수다. 누락은 Primary 선택으로 취급되지 않으며
Runtime이 `DELEGATION_ASSESSMENT_MISSING`으로 거절한다. 현재 정책은 `zzw_get_state` 응답의
`executionPolicy`와 동적 workflow context에서 확인한다.

## 결과와 승인

검증된 새 Plan 버전을 `draft`로 저장하고 ZZWorkflow를 사용자 승인 대기 상태로 전환합니다. 제안 자체는 승인이 아니며, 사용자는 `/zzw approve-plan`으로 승인해야 합니다. 성공한 도구 결과에는 Registry의 `dependsOn`에서 생성한 Mermaid DAG, Plan 단계 요약과 승인 명령이 표시되고 현재 agent turn은 즉시 끝납니다. TUI는 이 Mermaid를 현재 터미널 폭에 맞는 ASCII/유니코드 그래프로 표시합니다. 승인 전까지 추가 모델 호출, 실행 시도, Todo reminder와 Goal continuation이 발생하지 않습니다.

모든 성공 조건은 validation 또는 acceptance 단계에, 모든 명시적 검증 요구사항은 실행 명령이 있는 validation 단계에 연결되어야 합니다. Plan DAG에는 순환이 없어야 합니다.

milestone은 직접 실행되지 않으며 execution 계약, validator와 성공·검증 매핑을 가질 수 없습니다. `allowed_tools`, `allowed_targets`, `risk_class`는 후속 expansion의 승인 상한으로만 사용됩니다. 의존성이 충족되면 그 상한 안의 `zzw_patch_plan` expansion으로 concrete step이 milestone을 supersede해야 합니다. 상한을 넘으면 사용자 재승인이 필요합니다.

잘못된 Plan은 `INVALID_PLAN_MAPPING`과 함께 발견된 오류를 `issues` 배열 하나로 반환합니다. 모델은 누락된 ID, 잘못된 의존성, validator 누락 등을 모두 고친 뒤 한 번만 다시 제안해야 합니다. 설명 문자열의 정확한 문구 일치는 Plan 연결 기준으로 사용하지 않습니다.

`zzw_propose_plan`은 배타 도구이므로 다른 tool call과 같은 batch에서 병렬 실행되지 않습니다. 유효한 제안만 승인 대기 종료 경계를 만들고, 거절된 제안은 모델이 같은 turn에서 수정할 수 있습니다.
