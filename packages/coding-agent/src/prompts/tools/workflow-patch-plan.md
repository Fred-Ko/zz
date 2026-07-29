새로운 발견, 준비된 milestone의 구체화, 반증된 가정 또는 실제 단계 계약 변경 뒤에 현재 Plan DAG를 진화시킵니다. 컴파일·린트·테스트가 현재 코드 결함을 드러낸 경우, 승인 범위 안의 DB·Kafka·Docker·생성 전제가 빠진 경우, 같은 단계 안에서 명령 순서만 보완하는 경우에는 이 도구를 호출하지 마세요. 각각 `implementation-feedback` 또는 `missing-precondition`으로 보고하고 같은 단계를 계속합니다. 첫 `execution-failure`가 아직 `retry-with-changed-condition`이면 Plan 변경 근거가 아니며 Runtime도 patch를 거부합니다. 먼저 `zzw_get_state`에서 현재 Specification, Plan, reconciliation을 읽고, `successCriteria[].id`와 `verificationRequirements[].id`를 각각 `success_condition_ids`, `verification_ids`에 사용하세요. `validators`에는 Bash에서 그대로 실행할 수 있는 명령만 넣고 검증 설명 문장을 복사하지 마세요. milestone을 확장하는 단계의 도구·대상·위험도는 그 milestone에 기록된 승인 상한을 넘지 않아야 하며, 넘으면 material patch로 사용자 재승인을 받아야 합니다.

원인 observation·evidence·실패 단계·반증된 assumption을 연결하고, `change_kind`를 patch·expansion·repair 중에서 선택하세요. 완료 단계는 직접 수정하지 않습니다. 계약이 바뀌었다면 새 ID의 대체 단계를 추가하고 `supersedes`로 옛 단계를 연결하세요. `supersedes`는 이전 활성 노드를 자동으로 비활성화하므로 같은 노드를 `remove_step_ids`에 중복 지정하지 마세요. 옛 단계는 삭제되지 않고 lineage로 남습니다.

유효한 완료 단계는 `preserve_step_ids`에 적되, Runtime이 실제 영향받는 의존성 폐쇄를 계산합니다. 바뀐 입력에 의존하는 완료 결과와 증거는 보존할 수 없습니다. 영향을 받지 않은 완료 단계와 증거는 자동 보존됩니다. 후속 활성 단계가 superseded·invalidated 단계에 계속 의존하지 않도록 새 단계로 의존성을 다시 연결하세요.

권한 확대, 고위험 작업, 성공·검증 기준 약화, 완료 결과 폐기와 기존 단계의 `execution` 계약 변경은 material 변경으로 사용자 재승인이 필요합니다. 승인된 경계에 없던 validator/subagent executor를 추가하거나 exact validator 명령을 바꾸는 것도 material입니다. 반면 실패한 validator를 동일 명령·동일 executor·동일 tool/target/risk envelope로 교체하거나, 그 validator의 승인 범위 안에서 환경 준비 단계를 직렬로 넣는 것은 structural이며 기존 승인을 이어받습니다. 도구 결과의 approval 상태를 확인하고, 승인 유지 시 작업을 계속하세요.

병렬 실행 계약을 바꿀 때는 dependency DAG와 resource claim을 별개로 검토하세요. 독립 단계로 분해하더라도 같은 파일·lockfile·port·service·database를 write/exclusive로 공유하면 같은 Wave에 들어갈 수 없습니다. 이미 실행 중인 Lane은 시작 당시 step contract hash에 고정되며, 해당 단계의 실행 계약이나 권한을 바꾸는 patch는 다음 Wave부터 적용됩니다.

Work Unit을 추가·삭제하거나 capability, model-independent scope, validator를 바꾸는 것은 execution 계약 변경입니다. Work Unit 위임이 활성화됐다면 추가·대체·현재 pending work 단계에는 `delegation_assessment`가 필요합니다. 기존 실행 계약을 바꿀 때도 위임 또는 Primary 유지 결정을 다시 기록하세요. Work Unit은 상위 Step의 allowed tool/target과 resource envelope를 넓힐 수 없고, `mechanical` isolated-write Work Unit은 exact validator를 유지해야 합니다. Capability는 모델 가격이나 적대 리뷰 여부를 뜻하지 않습니다. 단순히 특정 모델을 쓰기 위해 Plan dependency를 바꾸거나 검증을 약화하지 마세요.

`update_steps`는 부분 수정입니다. 바꿀 필드만 보내고, 생략한 필드는 현재 단계의 값이 그대로 유지됩니다. 배열을 명시적으로 비우려는 경우에만 빈 배열을 보내세요.

이 도구는 다른 실행 도구와 같은 응답에 묶지 말고 단독 호출하세요. material patch가 승인 대기 상태를 만들면 현재 agent turn은 즉시 종료되며 `/zzw approve-plan` 전에는 후속 실행을 시도하지 않습니다. 승인을 유지하는 structural patch만 현재 turn에서 실행을 계속할 수 있습니다.
