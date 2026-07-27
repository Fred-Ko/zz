검증되고 장기적으로 재사용할 가치가 있는 지식을 ZZ Knowledge System에 제안합니다.

현재 진행 상태, HEAD/diff, raw 로그, secret, trivial source fact와 검증되지 않은 가설은 저장하지 마세요. 미래 용도, 정확한 scope·form·domain·source·confidence, 안정적인 knowledge key와 실제 evidence reference를 제공해야 하며 저장 전 중복 검색과 정책 검사를 거칩니다.

Branch는 scope로 선택하지 않습니다. Branch에서 발견한 장기 지식은 repo 또는 task scope로 저장하며, runtime이 발견 당시 branch를 `branch-ref` provenance로 자동 첨부합니다. Branch에서만 유효한 임시 정보는 Workflow Registry에 두세요.

사용자의 명시적 요청을 처리하면 `request_origin=user-explicit`를 사용하세요. 현재 사용자 메시지가 evidence와 retain group에 자동 연결되므로 한 요청에서 여러 번 호출해도 함께 유지보수할 수 있습니다. 원문 문맥을 보존해야 하는 자료는 `knowledge_retain_document`를 사용하세요.

이 기록으로 기존 요약의 결론이 실제로 달라질 때만 `refresh_mental_models`를 지정하세요. Mental model은 자동 갱신되지 않습니다.
