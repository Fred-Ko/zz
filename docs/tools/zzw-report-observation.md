# zzw_report_observation

> 도구의 원시 증거와 에이전트의 해석을 분리해 ZZWorkflow Registry에 기록합니다.

## 입력

관찰 종류(`fact`, `hypothesis`, `contradiction`, `risk`, `workspace-change`), 설명, 관련 Evidence ID, 신뢰도와 영향을 받는 Specification·가정·단계·산출물·검증 항목을 전달합니다.

## 결과

고유 ID가 있는 Observation을 현재 Task에 연결합니다. 가설은 사실이나 완료 증거가 아닙니다. `contradiction` 또는 `workspace-change`가 step이나 assumption에 연결되면 Runtime은 즉시 `RECONCILING`으로 전환하고 다음 side effect를 차단합니다.

신뢰도는 0 이상 1 이하이어야 합니다.
