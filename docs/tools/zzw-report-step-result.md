# zzw_report_step_result

> 현재 ZZWorkflow Plan 단계의 실제 실행 결과를 보고합니다.

## 입력

단계 ID, `completed`·`failed`·`partial`·`progress`·`blocked` 중 하나의 상태, Evidence ID와 실제·예상하지 못한 효과를 전달합니다. 결과는 다음 중 하나로 분류합니다.

- `matched`
- `implementation-feedback`
- `missing-precondition`
- `execution-failure`
- `contradicted-precondition`
- `contradicted-assumption`
- `unexpected-effect`
- `verification-failure`
- `environment-changed`

현재 work 단계의 컴파일·린트·테스트 피드백은 `implementation-feedback`, 승인 범위 안에서 준비할 수 있는 DB·Kafka·Docker 등의 전제 누락은 `missing-precondition`으로 분류합니다. 이 두 경우에는 Plan 버전과 승인을 유지하고 같은 단계를 계속합니다.

일시적인 실행 실패를 재시도하려면 이전과 실제로 달라진 조건을 `changed_condition`에 기록합니다. 조건이 아직 바뀌지 않았다면 `retry-with-changed-condition` 상태를 유지하고 Plan patch를 거부합니다. operation fingerprint에는 workspace pre-state가 포함되므로 코드가 바뀐 뒤의 재실행과 무변경 반복을 구분합니다. 동일 fingerprint가 반복 실패하거나 rerun policy가 `never`이면 재시도할 수 없습니다.

## 결과

Registry의 단계 상태를 갱신합니다. 첫 operation 실패는 전체 계획을 즉시 폐기하지 않고 `RECONCILING`에서 분류를 요구합니다. `implementation-feedback`과 `missing-precondition` 결과는 `planPatchRequired: false`, `approvalRequired: false`와 같은 단계의 다음 동작을 반환합니다. Plan 입력이 실제로 반증되거나 무변경 실패가 반복될 때만 `zzw_patch_plan`이 필요합니다. 일치한 중간 진전은 `progress/matched`로 같은 단계를 계속할 수 있습니다.

자유 텍스트 완료 선언만으로는 단계가 완료되지 않습니다. 현재 Plan과 workspace snapshot에 연결된 증거가 필요합니다.
