# `knowledge_retain_document`

원문 표현과 주변 문맥이 중요한 ADR, guide, runbook, 외부 reference와 investigation을 Hindsight document로 저장합니다.

- `replace`: canonical source 교체
- `append`: 동일 source에 내용 추가
- `immutable-revision`: 이전 revision을 유지한 새 문서

원문 chunk 보존이 필요 없는 독립 사실은 `knowledge_retain`을 사용합니다. 자세한 내용은 [ZZ Knowledge](../knowledge.md)를 참고하세요.
