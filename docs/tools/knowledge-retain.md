# `knowledge_retain`

검증됐고 앞으로 다시 사용할 가치가 있는 지식을 Hindsight에 제안·저장합니다.

저장 전 짧은 중복·충돌 검색을 수행하며, 현재 진행률·Git 상태·원시 로그·비밀·검증되지 않은 가설은 거부합니다. scope, form, domain, source, confidence, stable knowledge key, `futureUse`와 증거 참조가 필요합니다.

사용자의 명시적 요청은 같은 session message에서 발생한 모든 retain을 하나의 요청 그룹으로 묶습니다. 원문 문맥을 보존해야 하는 자료에는 `knowledge_retain_document`를 사용합니다.

자세한 정책과 예시는 [ZZ Knowledge](../knowledge.md)를 참고하세요.
