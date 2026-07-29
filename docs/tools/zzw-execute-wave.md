# zzw_execute_wave

> 승인된 ZZWorkflow Plan의 자동 실행 가능 단계를 resource-safe Execution Wave로 실행합니다.

## 입력

`step_ids`는 선택 사항입니다. 생략하면 현재 dependency-ready인 비-Primary 단계 중 실행 모드와
resource claim이 허용하는 집합을 scheduler가 결정합니다. 지정하면 그 ready step들만 후보로 삼습니다.

## 실행 대상

- `validator`: 정확히 선언된 명령을 bounded parallel Lane으로 실행합니다.
- `subagent-readonly`: 읽기 전용 capability envelope 안에서 조사·리뷰를 수행합니다.
- `subagent-isolated`: disposable workspace에서 수정하고 scoped patch를 순차 통합합니다.

`zzworkflow.execution.workUnits.enabled=true`이면 승인된 subagent Step의 `work_units`를 별도 Lane으로
실행하고 capability별 model selector를 적용합니다. 기본값은 `false`이며 이때 Work Unit 계약은 dormant
상태로 남고 Step 전체가 기존 한 Lane으로 실행됩니다.

`zzworkflow.execution.adversarialReview.enabled=true`인 모든 isolated-write 후보는 새 read-only
reviewer의 `pass`, 후보 patch가 적용된 격리 workspace의 exact validator, scope 검사를 모두 통과해야
통합됩니다. 이 설정은 Work Unit 설정과 독립적이며 끄더라도 validator와 scope 검사는 유지됩니다.

`primary` 단계는 이 도구가 실행하지 않습니다. 메인 에이전트가 승인된 일반 도구로 직접 수행합니다.
기본 `validation` 모드는 validator만 허용합니다. `serial`은 승인된 subagent Lane을 하나씩 실행하고,
`safe-parallel`은 resource가 충돌하지 않는 subagent Lane의 동시 실행을 허용합니다. 실행 방식과 적대 리뷰
여부는 독립적입니다.
ready 또는 진행 중인 `primary` 단계가 있으면 그 단계를 먼저 완료·보고합니다. isolated-write와
validator는 같은 Wave에 넣지 않습니다. patch 통합 직후 validator 증거가 stale이 되는 것을 막기 위한
snapshot freshness 규칙입니다.

## 안전과 증거

Wave, Lane과 operation은 프로세스·subagent를 시작하기 전에 journal과 repository SQLite event store에
기록됩니다. 충돌하는 resource claim은 동시에 실행되지 않습니다. 쓰기 가능 validator는 격리
workspace에서 실행되고 그 변경은 폐기합니다. isolated subagent patch는 실제 touched path가 Plan의
`allowedTargets`와 write claim 안에 있을 때만 Primary에 하나씩 적용합니다.

각 Lane은 독립 상태와 evidence를 남깁니다. 정확한 validator가 exit code 0으로 끝나고 Primary workspace가
base snapshot을 유지한 경우에만 verified evidence가 됩니다. 중단 후 완료 여부가 불명확한 Lane은
자동 재실행하지 않고 `unknown`으로 복구합니다.

상태는 `/zzw status`, `/zzw lanes`, `/zzw operations`, `/zzw evidence`에서 확인할 수 있습니다.
