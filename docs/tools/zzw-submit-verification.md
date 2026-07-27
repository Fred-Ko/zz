# zzw_submit_verification

> ZZWorkflow 검증 단계에 최신 성공 증거를 제출합니다.

## 입력

검증 단계 ID와 해당 단계에 선언된 validator 실행에서 생성된 Evidence ID를 전달합니다.

## 결과

증거가 현재 workspace snapshot, 변경되지 않은 step contract와 정확한 validator에 연결됐는지 확인한 뒤 검증 단계를 완료합니다. 일반 도구 성공, 다른 명령의 결과, stale contract나 오래된 workspace의 증거는 인정되지 않습니다. Plan 버전만 증가했더라도 step contract hash와 dependency evidence가 그대로라면 기존 trusted evidence를 선택적으로 유지할 수 있습니다.

Task 완료는 모든 성공 조건에 현재 검증 증거가 연결된 뒤에만 가능합니다.
