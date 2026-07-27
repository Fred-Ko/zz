# ZZ 주요 아키텍처 결정

> **문서 상태: 현재 · 결정 기록**

이 문서는 현재 코드의 방향을 만든 주요 결정을 짧은 ADR 형태로 기록한다. 세부 구현은 각 전문
문서를 따르고, 과거 아이디어 원문은 [initial-concept-archive.md](initial-concept-archive.md)를
참조한다.

상태 의미:

- `채택`: 현재 구현과 새 변경이 따라야 함
- `대체됨`: 아래의 다른 결정으로 교체됨
- `보류`: 현재 구현하지 않으며 필요하면 새 근거로 재검토

## D-001 — upstream fork 위에 ZZ 공개 정체성을 둔다

- 상태: 채택
- 결정: 공개 이름, CLI, 설정 경로, 프로젝트 자산은 `ZZ`, `zz`, `~/.zz`, `.zz/`를 사용한다.
- 근거: 사용자가 fork의 기능과 설정을 upstream OMP와 명확히 구분할 수 있어야 한다.
- 제약: package scope, worker selector, wire protocol 같은 내부 호환 식별자는 변경 비용을 검토한
  뒤에만 바꾼다.

## D-002 — 한국어를 기본 사용자 언어로 한다

- 상태: 채택
- 결정: 사용자가 다른 언어를 지정하지 않으면 대화와 ZZ가 추가한 built-in 메시지는 한국어다.
- 근거: fork의 기본 사용자 경험을 일관되게 한다.
- 제약: 코드 identifier, provider API, upstream protocol field는 번역하지 않는다.

## D-003 — 원본 Goal과 ZZW Goal을 분리한다

- 상태: 채택
- 결정: `/goal`, `/guided-goal`은 upstream 동작을 유지한다. 제어형 Task는 `/zzw-goal`,
  `/zzw-guided-goal`, `/zzw`로만 시작·관리한다.
- 근거: 원본 Goal continuation과 ZZW approval gate를 결합했을 때 `차단 → Goal 재개 → 차단` 반복과
  불필요한 Plan 승인이 발생했다.
- 결과: 사용자가 가벼운 자율 Goal과 강한 제어형 workflow를 명시적으로 선택한다.

## D-004 — ZZW는 별도 daemon이 아니라 `zz`에 내장한다

- 상태: 채택
- 대체한 안: `workflowd`, `zz-workflowd`, 로컬 HTTP coordinator
- 결정: lifecycle, Registry, gate, operation journal은 coding-agent 프로세스에 내장한다.
- 근거: 단일 사용자·로컬 우선 범위에서 별도 프로세스는 설치·재시작·상태 불일치 비용만 키운다.
- 결과: 사용자는 `zz`만 실행한다. 별도 workflow daemon 명령은 없다.

## D-005 — ZZW 관계형 상태는 저장소별 `bun:sqlite`에 둔다

- 상태: 채택
- 대체한 안: PostgreSQL, 전역 단일 `~/.zz/agent/workflow.db`
- 결정: `~/.zz/agent/workflows/<repository-id>/workflow.db`를 사용한다.
- 근거: 외부 RDB 운영 없이 repository isolation, transaction, journal, query가 필요하다.
- 제약: WAL, `busy_timeout`, idempotent migration, transaction 단위 event 기록을 유지한다.

## D-006 — 멀티머신 coordinator를 제품 범위에서 제외한다

- 상태: 보류
- 결정: 여러 머신의 실시간 Task state, lease, operation을 중앙 서비스로 동기화하지 않는다.
- 근거: 현재 목적에 비해 distributed ownership, offline conflict, 보안, 운영 복잡도가 크다.
- 현재 대안: Git checkpoint, handoff, 세션 재개를 사용한다. SQLite DB를 네트워크 파일시스템으로
  공유하지 않는다.
- 재검토 조건: 실제 사용자 시나리오가 Git handoff로 해결되지 않고 명확한 보안·충돌 모델이 마련됨.

## D-007 — Plan은 lineage가 있는 진화형 DAG다

- 상태: 채택
- 결정: Plan은 tree나 고정 Todo 목록이 아니다. `dependsOn`이 실행 순서를 결정하는 DAG이며,
  `parentStepId`는 UI 계층에만 사용한다.
- 근거: 구현 중 발견으로 분기·병합·단계 분해가 필요하고, 과거 결과의 보존/무효화 근거가 남아야
  한다.
- 결과: Plan patch는 버전을 만들고 supersede/invalidated lineage를 보존한다.

## D-008 — 승인 정책은 material change 중심이다

- 상태: 채택
- 결정: 초기 Plan과 material patch는 사용자 승인을 요구한다. 승인 범위 안의 structural patch는
  기본적으로 승인을 상속한다.
- 설정: `zzworkflow.planPatchApproval: material`; 엄격한 환경에서는 `always` 선택 가능.
- 근거: 모든 수정에 승인하면 작업 대신 계획 수정과 승인 요청이 반복된다.

## D-009 — execution feedback과 plan failure를 분리한다

- 상태: 채택
- 결정: 타입·테스트 피드백과 승인된 missing precondition은 같은 step에서 처리한다. assumption,
  dependency, 권한, 성공·검증 계약이 바뀔 때만 Plan을 patch한다.
- 근거: `ECONNREFUSED`, Docker daemon 미기동 같은 문제에 매번 새 Plan을 만들 필요가 없다.
- 결과: plan churn, 승인 폭주, 불필요한 downstream invalidation을 줄인다.

## D-010 — completion은 fresh evidence로만 판정한다

- 상태: 채택
- 결정: tool success나 모델 서술만으로 Task를 완료하지 않는다. 성공 조건과 verification ID가
  현재 workspace snapshot의 trusted evidence에 매핑돼야 한다.
- 근거: 실행 후 파일이 바뀌거나 validator가 다른 명령이면 과거 성공은 현재 완료 근거가 아니다.

## D-011 — upstream legacy memory를 전부 제거한다

- 상태: 채택
- 제거 범위: Mnemopi, transcript auto-retain/auto-recall, `memory://`, `/memory`, legacy memory
  tools와 prompts.
- 근거: 기존 memory의 자동 수집·주입 방식은 현재 사실과 장기 지식을 분리하려는 ZZ 개념을
  방해한다.
- 제약: ZZ Knowledge를 제거된 코드 위에 adapter로 얹지 않는다.

## D-012 — ZZ Knowledge는 독립 policy layer다

- 상태: 채택
- 결정: `packages/coding-agent/src/knowledge/`가 scope, taxonomy, evidence gate, redaction,
  deduplication, outbox, bank routing, curation을 소유한다. Hindsight는 그 뒤의 advisory semantic
  provider다.
- 근거: 모델에 raw retain/recall/delete API를 주면 bank 경계와 provenance를 일관되게 보장하기
  어렵다.
- 결과: 모델은 `knowledge_*` wrapper만 사용한다.

## D-013 — security boundary마다 Global Bank와 Repository Bank를 분리한다

- 상태: 채택
- 결정: `(userId, securityBoundary)`마다 Global Bank 하나, repository마다 Repository Bank 하나를
  둔다.
- 근거: 사용자 장기 선호와 프로젝트 지식을 분리하면서 회사·고객 경계를 넘는 검색을 막는다.
- 표시: Repository Bank는 dashboard에서 찾기 쉬운 사람이 읽을 수 있는 이름을 사용하고 opaque ID는
  안정적으로 유지한다.
- 제약: `maxBanksPerUser`는 실제로 user당 security boundary 수 상한이며, 한 boundary 안의 repository
  bank 수를 제한하지 않는다.

## D-014 — branch는 scope가 아니라 provenance hint다

- 상태: 채택
- 대체한 안: branch별 bank 또는 강한 branch scope
- 결정: 저장 scope는 Global/Repository/Task만 사용한다. branch ID는 metadata/tag로 기록할 수
  있지만 recall의 결정적 필터로 사용하지 않는다.
- 근거: branch는 rename, delete, merge될 수 있어 장기 지식 ownership으로 부적절하다.
- 결과: merge 후 branch tag를 일괄 갱신하지 않아도 되며 현재 코드로 유효성을 재검증한다.

## D-015 — atomic retain과 document retain을 모두 지원한다

- 상태: 채택
- 결정: 짧은 durable fact는 stable `knowledgeKey`로, 출처가 하나의 묶음 의미를 갖는 문서는 stable
  `sourceId`와 `replace|append|immutable-revision` 전략으로 저장한다.
- 근거: 모든 지식을 짧은 fact로 쪼개면 문맥과 유지보수가 깨지고, 모든 것을 document로 넣으면
  중복·정정 단위가 너무 커진다.

## D-016 — 한 사용자 요청의 retain은 같은 group으로 묶는다

- 상태: 채택
- 결정: 동일 user message/request에서 파생된 여러 retain call은 같은 `groupId`를 공유한다.
- 근거: 사용자가 “방금 저장한 것 전부”를 무효화·복구·삭제할 수 있어야 한다.
- 결과: `/knowledge groups`, `invalidate-group`, `restore-group`, `purge-group --confirm`을 제공한다.

## D-017 — retain은 기본적으로 자동 실행하지 않는다

- 상태: 채택
- 결정: completion이나 hook은 후보 review를 만들 수 있지만 검증된 항목을 무조건 Hindsight에
  retain하지 않는다. 사용자 명시 요청은 같은 turn에 실제 retain을 수행한다.
- 근거: progress, raw log, 가설, trivial fact가 장기 기억을 오염시키는 것을 막는다.

## D-018 — Knowledge working set은 누적하지 않고 교체한다

- 상태: 채택
- 결정: recall 결과는 purpose/query/scope/snapshot을 가진 working set으로 관리하며 관련 조건이
  바뀌면 새 결과로 교체한다.
- 근거: 작은 모델 context에서도 과거 recall dump가 계속 쌓이지 않게 한다.

## D-019 — 자동 QA 보고 기능을 제거한다

- 상태: 채택
- 제거 범위: `report_tool_issue`, `xd://report_issue`, grievance DB/push, consent UI, model-driven
  telemetry.
- 근거: 사용자 작업 중 모델이 제품 불만 수집으로 흐름을 전환하는 것은 ZZ의 신뢰·privacy 방향과
  맞지 않는다.
- 제약: 새 telemetry는 목적, 데이터, 보존, 동의, opt-out을 별도 설계하고 명시 승인 없이 추가하지
  않는다.

## D-020 — TUI 상태는 상세 다중 행 projection으로 제공한다

- 상태: 채택
- 결정: model/effort, Goal 또는 ZZW 상태, repository/worktree/branch, session, token/context,
  비용·시간을 좁은 한 줄에 숨기지 않고 가용 폭에 맞춘 다중 행 상태로 표시한다.
- 근거: 장기 agent 작업에서는 “응답 중인가, 어떤 모델인가, 어느 worktree인가, 어떤 Task phase인가”가
  핵심 운영 정보다.
- 제약: TUI renderer는 logger, tab replacement, ANSI-aware truncation, home path 축약 계약을 지킨다.

## 결정 변경 절차

1. 이 문서의 어떤 결정을 바꾸는지 식별한다.
2. 바꾸려는 문제와 fresh evidence를 기록한다.
3. 호환, migration, security/privacy, recovery, UX 영향을 분석한다.
4. 대안과 철회 조건을 제시한다.
5. 코드·테스트·현재 문서를 같은 변경 단위로 갱신한다.
6. 기존 항목을 삭제하지 말고 `대체됨` 상태와 후속 결정 ID를 남긴다.

초기 아이디어 문서의 오래된 제안을 근거 없이 현재 결정으로 되살리지 않는다.
