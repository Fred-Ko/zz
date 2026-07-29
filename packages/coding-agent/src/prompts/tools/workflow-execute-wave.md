승인된 ZZWorkflow Plan에서 현재 dependency-ready인 자동 실행 단계를 하나의 Execution Wave로 실행합니다.

이 도구는 다음 단계만 실행합니다.

- `validator`: 승인된 validator 명령을 독립 Lane으로 병렬 실행
- `subagent-readonly`: 읽기 전용 도구만 가진 서브에이전트 Lane 실행
- `subagent-isolated`: 격리 workspace에서 서브에이전트를 실행하고 범위 검사 후 직렬 통합

`primary` 단계는 메인 에이전트가 기존 edit/bash 도구로 직접 수행해야 하며 이 도구에 전달하지 마세요.
ready 또는 진행 중인 primary 단계가 있으면 먼저 그 단계를 완료하고 결과를 보고하세요.
`step_ids`를 생략하면 현재 자동 실행 가능한 모든 ready 단계를 자원 충돌과 동시성 한도 안에서 선택합니다.
각 Lane과 operation은 실행 전에 저널에 기록되고, validator 성공은 현재 workspace snapshot에 묶인 증거로 저장됩니다.
쓰기 claim 또는 snapshot isolation을 선언한 validator는 disposable 격리 workspace에서 실행되며 그 변경은 Primary에 통합하지 않습니다.
isolated-write와 validator는 같은 Wave에서 실행하지 않습니다. 통합 뒤에도 유효해야 하는 검증은 모든 workspace 쓰기 단계에 의존해야 합니다.
`step` 실패는 독립 Lane을 계속 실행하고, `shared-resource`와 `wave` 실패는 선언된 failure domain의 형제를 취소합니다.
