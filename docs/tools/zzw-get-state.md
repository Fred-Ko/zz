# zzw_get_state

> 활성 ZZWorkflow의 권위 있는 상태를 읽습니다.

## 사용 시점

ZZWorkflow에서 계획을 제안하거나 실행을 시작하기 전에 호출합니다. Todo는 Plan DAG의 화면용 투영일 뿐이므로 현재 Task, Plan, 증거, 작업 상태의 근거로 사용하지 않습니다.

## 입력

`detail`에 `summary`, `spec`, `plan`, `evidence`, `operations`, `full` 중 하나를 지정합니다.

## 결과

선택한 상세 수준에 맞는 Task Specification, Plan DAG, Evidence, Observation 또는 Operation 상태를 반환합니다. summary에는 required next action, reconciliation과 최근 Plan change도 포함됩니다. Plan에는 step lineage와 버전별 structured change가 들어 있습니다. 이 도구는 읽기 전용이며 상태를 변경하지 않습니다.

## 제한

`/zzw-goal` 또는 `/zzw-guided-goal`로 시작한 활성 ZZWorkflow에서만 사용할 수 있습니다. 원본 `/goal`과 `/guided-goal`에는 노출되지 않습니다.
