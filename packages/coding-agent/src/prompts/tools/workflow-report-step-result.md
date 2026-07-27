현재 Plan DAG 단계의 실제 실행 결과를 보고합니다. 실행 전 기대와 실제 결과를 비교해 `classification`을 명시하세요.

- 예상 효과와 일치한 중간 진전은 `status=progress`, `classification=matched`로 보고합니다.
- 완료는 `status=completed`, `classification=matched`, 현재 단계 계약에 연결된 성공 증거가 필요합니다.
- 컴파일·린트·테스트 실패가 현재 work 단계에서 고쳐야 할 코드 결함을 드러냈지만 목표·전략·권한·dependency가 그대로라면 `status=progress`, `classification=implementation-feedback`입니다. Runtime은 같은 단계를 다시 열며 Plan patch나 사용자 재승인을 요구하지 않습니다.
- DB·Kafka·Docker daemon·생성 파일처럼 현재 단계의 승인 범위 안에서 충족할 수 있는 실행 전제가 빠졌다면 `status=progress`, `classification=missing-precondition`입니다. 전제를 준비하고 같은 단계를 재시도하며 Plan을 수정하지 않습니다.
- 도구 자체의 일시 실패는 `execution-failure`입니다. 다시 시도하려면 이전과 달라진 조건을 `changed_condition`에 구체적으로 기록해야 합니다. 아직 조건이 달라지지 않았다면 Runtime은 Plan을 stale로 만들지 않고 `retry-with-changed-condition`에 머물며 Plan patch도 거부합니다. 같은 fingerprint 실패가 반복되면 Runtime이 재시도를 거부합니다.
- 기존 방식으로 충족할 수 없는 사전조건, 반증된 가정, 예상 밖 부작용, 독립 validation 단계의 검증 실패, workspace 정체성 변경처럼 단계 계약 자체가 틀린 경우에만 해당 classification과 evidence를 기록하고 최소 repair patch를 제안합니다.

실패한 명령이 있다는 사실만으로 Plan을 수정하지 마세요. 먼저 “같은 단계에서 원인을 처리해도 계약이 그대로인가?”를 판단하세요. 그렇다면 `implementation-feedback` 또는 `missing-precondition`입니다. 외부 동작이 현재 승인 권한 밖이면 그 동작만 사용자에게 확인하고, 작업 전략까지 달라지지 않는 한 Plan을 바꾸지 않습니다. Runtime이 실제 Plan 변경 시에만 영향받는 의존성 폐쇄와 증거 신선도를 계산합니다. validation 단계의 성공 완료는 이 도구가 아니라 `zzw_submit_verification`을 사용합니다.
