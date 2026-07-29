# zzw_patch_plan

> 실패나 반증된 가정에 대응해 현재 ZZWorkflow Plan DAG의 최소 패치를 제안합니다.

## 입력

현재 Plan 버전, 추가·수정·제거할 단계, 보존할 완료 단계, 반증된 가정, 실패 단계와 패치 근거를 전달합니다. `observation_ids`와 `evidence_ids`로 원인을 연결하고 `change_kind`를 `patch`, `expansion`, `repair` 중 하나로 지정할 수 있습니다. 단계의 Specification 연결은 `success_condition_ids`와 `verification_ids`로 유지하거나 수정합니다. `validators`에는 실행 가능한 명령만 넣습니다.

## 결과와 승인

Runtime이 실패 단계, observation의 step·assumption·artifact 연결과 DAG edge에서 영향받는 dependency closure를 계산합니다. 해당 closure의 완료 결과와 evidence만 원인별 stale로 전환하고, 영향 밖 완료 단계는 자동 보존합니다. `preserve_step_ids`에 명시한 완료 단계도 현재 증거와 의존성이 유효할 때만 보존됩니다.

완료 단계를 직접 수정할 수 없습니다. 새 ID의 대체 단계를 추가하고 `supersedes`로 연결해야 하며, Runtime이 옛 단계를 자동으로 비활성화합니다. 같은 ID를 `remove_step_ids`에 중복 지정할 필요가 없고 옛 단계는 삭제되지 않은 채 lineage에 남습니다. 활성 단계는 superseded·invalidated 단계에 의존할 수 없습니다. 빈 patch는 retry 우회로 간주해 거부합니다.

구조적 serial 변경은 기본 설정에서 기존 승인을 유지하고 바로 실행을 계속합니다. 실패한 validator를 동일 exact command·executor·tool/target/risk envelope로 교체하거나 승인된 검증 환경 준비 단계를 추가하는 것도 structural입니다. 도구 권한 확대, high-risk 작업, 성공·검증 기준 약화, 완료 결과 무효화, 기존 execution 계약 변경, 승인 경계에 없던 validator/subagent executor 추가 또는 exact validator 명령 변경은 material 변경으로 `/zzw approve-plan` 재실행이 필요합니다. 성공한 patch 결과는 현재 Registry에서 다시 생성한 Mermaid 실행 DAG를 표시합니다. material patch가 저장되면 단계 요약과 승인 명령을 표시한 뒤 현재 agent turn이 즉시 끝납니다. `zzworkflow.planPatchApproval: always`이면 모든 patch가 재승인 대상입니다.

전체 계획을 다시 쓰는 용도가 아니라 확인된 원인을 제거하는 최소 변경에 사용합니다.

Work Unit의 추가·삭제, capability·scope·resource·validator 변경도 execution 계약 변경이다. Work Unit은
상위 Step의 tool/target 승인 범위를 넓힐 수 없으며 mechanical isolated-write Work Unit에는 exact
validator가 필요하다. Work Unit이 활성화된 상태에서 pending work 단계를 추가·대체하거나 execution
계약을 바꾸면 위임 또는 Primary 유지 판단도 함께 기록해야 한다.

컴파일·린트·테스트가 현재 work 단계에서 수정할 코드 결함을 보여 준 경우, 승인된 DB·Kafka·Docker 등 실행 전제를 준비해야 하는 경우, 같은 단계 안에서 진단·수정·재검사를 반복하는 경우에는 Plan patch를 만들지 않습니다. `zzw_report_step_result`의 `implementation-feedback` 또는 `missing-precondition`으로 같은 단계를 계속합니다.

패치가 유효하지 않으면 `INVALID_PLAN_MAPPING`의 `issues` 배열에 발견된 모든 문제가 함께 반환됩니다. 현재 Specification과 Plan의 ID를 다시 조회해 전체 오류를 한 번에 수정합니다.

`zzw_patch_plan`은 배타 도구다. 승인 대기를 만드는 material patch만 후속 모델 호출·실행·Todo reminder·Goal continuation을 중단하며, 승인 유지 structural patch와 거절된 patch는 같은 turn을 계속할 수 있습니다.
