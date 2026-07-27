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

## 결과와 승인

검증된 새 Plan 버전을 `draft`로 저장하고 ZZWorkflow를 사용자 승인 대기 상태로 전환합니다. 제안 자체는 승인이 아니며, 사용자는 `/zzw approve-plan`으로 승인해야 합니다. 승인 전까지 부작용 도구는 차단됩니다.

모든 성공 조건은 validation 또는 acceptance 단계에, 모든 명시적 검증 요구사항은 실행 명령이 있는 validation 단계에 연결되어야 합니다. Plan DAG에는 순환이 없어야 합니다.

milestone은 직접 실행되지 않으며 validator와 성공·검증 매핑을 가질 수 없습니다. `allowed_tools`, `allowed_targets`, `risk_class`는 후속 expansion의 승인 상한으로만 사용됩니다. 의존성이 충족되면 그 상한 안의 `zzw_patch_plan` expansion으로 concrete step이 milestone을 supersede해야 합니다. 상한을 넘으면 사용자 재승인이 필요합니다.

잘못된 Plan은 `INVALID_PLAN_MAPPING`과 함께 발견된 오류를 `issues` 배열 하나로 반환합니다. 모델은 누락된 ID, 잘못된 의존성, validator 누락 등을 모두 고친 뒤 한 번만 다시 제안해야 합니다. 설명 문자열의 정확한 문구 일치는 Plan 연결 기준으로 사용하지 않습니다.
