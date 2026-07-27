# Knowledge tools

`knowledge.enabled: true`일 때 다음 ZZ 전용 도구를 등록한다.

## `knowledge_recall`

목적·scope·depth와 선택적인 form/domain/component filter로 과거 지식을 조회한다. 사용자의 직접 질문은 `request_origin=user-explicit`로 표시한다. source facts와 raw chunks는 필요한 경우만 포함한다.

## `knowledge_retain`

독립적으로 중복 제거·교정할 durable record를 저장한다. scope, form, domain, source, confidence, stable knowledge key, future use와 evidence를 요구한다. 같은 사용자 요청의 여러 호출은 동일 group으로 묶인다.

## `knowledge_retain_document`

ADR, guide, runbook, 외부 reference, investigation처럼 원문 문맥이 중요한 source를 저장한다. `replace`, `append`, `immutable-revision` update mode를 지원한다.

## `knowledge_reflect`

단순 조회로 해결되지 않는 계획 비판, 과거 접근 비교, 반복 장애, 충돌, 회고를 종합한다. 결과는 현재 코드와 증거로 다시 검증한다.

## `knowledge_curate`

한 document를 교정·무효화·복구한다. correction은 기존 문서를 superseded로 남기고 fresh evidence가 붙은 replacement를 만든다.

## `knowledge_group`

한 retain 요청으로 만들어진 모든 member를 조회·무효화·복구한다. 영구 purge는 제공하지 않는다. 사용자가 `/knowledge purge-group <id> --confirm`을 직접 실행해야 한다.

모델은 bank ID, arbitrary tag, Hindsight raw retain/delete API를 선택할 수 없다.
