현재 승인된 Task Specification을 실행 가능한 Plan DAG로 제안합니다.

먼저 `zzw_get_state`를 `detail="spec"`으로 호출하고, 반환된 `successCriteria[].id`와 `verificationRequirements[].id`를 그대로 사용하세요. 성공 조건은 `success_condition_ids`, 검증 요구사항은 `verification_ids`에 연결합니다. 설명 문장을 ID 대신 복사하지 마세요.

`validators`에는 `yarn verify`처럼 Bash에서 그대로 실행할 수 있는 명령만 넣습니다. “저장소 루트에서 yarn verify를 실행하고 종료 코드 0을 확인한다” 같은 검증 설명 문장은 validator가 아닙니다. 각 단계의 의존성, 허용 도구와 대상, 예상 효과, 사후 조건, 재실행 정책을 명시하고, 모든 성공 조건과 명시적 검증 요구사항을 적어도 하나의 validation 또는 acceptance 단계에 연결하세요.

동적 ZZWorkflow context에서 `Work Unit delegation enabled`와 `Delegation assessment required`를 먼저 확인하세요. 위임 판단이 요구되면 모든 현재 `work` 단계에 `execution.delegation_assessment`를 명시해야 합니다. 생략은 Primary 선택이 아닙니다. `retain-primary`는 cross-cutting reasoning, 공유 write surface, 불명확한 범위, exclusive resource, 고위험 side effect 또는 분리할 수 없는 atomic sequence 중 실제 이유를 기록합니다. `delegate-readonly`는 bounded-readonly, `delegate-isolated`는 bounded-isolated-write를 사용하고 선택한 decision과 executor를 일치시키세요.

각 실행 단계에는 `execution` 계약을 명시하세요. 일반 구현을 Primary에 유지하기로 판단했다면 `primary`, 검증 명령은 `validator`, 읽기 전용 조사·리뷰는 `subagent-readonly`, 서로 겹치지 않는 경로를 수정하는 작업은 `subagent-isolated`를 사용합니다. workspace를 바꾸지 않는 validator는 `isolation="none"`과 read claim을 사용하고, coverage·cache·snapshot·generated output처럼 쓸 수 있는 validator는 write/exclusive claim과 `isolation="snapshot"` 또는 `isolation="required"`를 사용하세요. validator의 `integration`은 항상 `none`입니다. `subagent-isolated`는 `isolation="required"`, `integration="patch"`여야 하며 수정 가능한 `allowed_targets`를 비워 두지 마세요. 각 계약은 실제 충돌 가능한 workspace path, lockfile, cache, port, service, database, external API를 `resource_claims`에 read/write/exclusive로 선언해야 합니다. 병렬화가 불확실하면 근거를 명시하고 `primary`와 workspace `.` exclusive를 사용하세요. 병렬 실행을 위해 의존성을 삭제하거나 검증 기준을 약화하지 마세요.

전체 workspace snapshot을 검증하는 validation 단계는 결과를 바꿀 수 있는 모든 primary·isolated-write 단계에 의존해야 합니다. write Lane과 validator를 같은 Wave에 넣어 일찍 얻은 검증 결과는 patch 통합 후 stale이 되므로, 검증을 앞당기기 위해 dependency를 생략하지 마세요.

모델 위임 때문에 Plan의 의미 단위를 파일 수준으로 과분해하지 마세요. 하나의 승인된 subagent Step 아래에서 서로 독립적으로 검증 가능한 작업은 `work_units`에 둡니다. 각 Work Unit에는 닫힌 작업 내용, 기대 효과, 상위 Step 범위 안의 허용 도구·대상, 사후 조건, resource claim, validator와 `mechanical | local-reasoning | system-reasoning` capability를 명시하세요. `mechanical` isolated-write Work Unit은 exact validator가 필수입니다. Work Unit 실행은 사용자 설정으로 꺼질 수 있으므로, Work Unit이 비활성화돼 Step 전체가 한 Lane으로 실행되어도 계약이 성립해야 합니다. Capability는 선택 모델의 가격이나 품질 등급이 아니며 적대 리뷰 활성화 여부를 결정하지 않습니다.

불확실한 먼 미래를 거대한 work 단계로 추측하지 마세요. 현재 결정 가능한 작업까지만 구체화하고, 조사 결과에 따라 나중에 확장할 경계에는 `milestone` 단계를 둡니다. milestone은 직접 실행되지 않으며 `execution`·validator·성공 조건 매핑을 갖지 않습니다. 대신 `allowed_tools`, `allowed_targets`, `risk_class`는 사용자가 미리 승인하는 후속 확장의 권한 상한입니다. 의존성이 충족되면 `zzw_patch_plan`의 expansion으로 그 상한 안의 실제 단계들이 milestone을 supersede해야 합니다. `parent_step_id`, `supersedes`, `assumption_ids`, `consumes_artifacts`, `produces_artifacts`로 계획의 계층·교체·가정·산출물 관계를 명시하세요.

거절 결과의 `issues`에는 발견된 모든 문제가 함께 들어 있습니다. 각 문제를 모두 수정한 뒤 한 번만 다시 제안하세요. 최초 실행 Plan은 항상 사용자의 승인이 필요하며 제안은 승인을 대신하지 않습니다.

이 도구는 다른 실행 도구와 같은 응답에 묶지 말고 단독 호출하세요. 유효한 Plan이 저장되면 현재 agent turn은 사용자 승인 경계에서 즉시 종료되며, `/zzw approve-plan` 전에는 상태 재조회, 실행 시도 또는 승인 요청 반복을 하지 않습니다. 거절된 Plan만 같은 turn에서 `issues` 전체를 수정해 다시 제안합니다.
