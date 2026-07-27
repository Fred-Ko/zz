현재 승인된 Task Specification을 실행 가능한 Plan DAG로 제안합니다.

먼저 `zzw_get_state`를 `detail="spec"`으로 호출하고, 반환된 `successCriteria[].id`와 `verificationRequirements[].id`를 그대로 사용하세요. 성공 조건은 `success_condition_ids`, 검증 요구사항은 `verification_ids`에 연결합니다. 설명 문장을 ID 대신 복사하지 마세요.

`validators`에는 `yarn verify`처럼 Bash에서 그대로 실행할 수 있는 명령만 넣습니다. “저장소 루트에서 yarn verify를 실행하고 종료 코드 0을 확인한다” 같은 검증 설명 문장은 validator가 아닙니다. 각 단계의 의존성, 허용 도구와 대상, 예상 효과, 사후 조건, 재실행 정책을 명시하고, 모든 성공 조건과 명시적 검증 요구사항을 적어도 하나의 validation 또는 acceptance 단계에 연결하세요.

불확실한 먼 미래를 거대한 work 단계로 추측하지 마세요. 현재 결정 가능한 작업까지만 구체화하고, 조사 결과에 따라 나중에 확장할 경계에는 `milestone` 단계를 둡니다. milestone은 직접 실행되지 않으며 validator·성공 조건 매핑을 갖지 않습니다. 대신 `allowed_tools`, `allowed_targets`, `risk_class`는 사용자가 미리 승인하는 후속 확장의 권한 상한입니다. 의존성이 충족되면 `zzw_patch_plan`의 expansion으로 그 상한 안의 실제 단계들이 milestone을 supersede해야 합니다. `parent_step_id`, `supersedes`, `assumption_ids`, `consumes_artifacts`, `produces_artifacts`로 계획의 계층·교체·가정·산출물 관계를 명시하세요.

거절 결과의 `issues`에는 발견된 모든 문제가 함께 들어 있습니다. 각 문제를 모두 수정한 뒤 한 번만 다시 제안하세요. 최초 실행 Plan은 항상 사용자의 승인이 필요하며 제안은 승인을 대신하지 않습니다.
