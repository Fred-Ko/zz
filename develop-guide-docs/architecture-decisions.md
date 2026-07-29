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
- 경계: 실패한 validator를 동일 exact command와 기존 executor/tool/target/risk envelope로 교체하거나
  승인된 검증 전제를 준비하는 단계는 structural이다. validator 명령, executor 권한, 위험 또는 외부
  부수효과 범위가 바뀔 때만 material이다.
- 설정: `zzworkflow.planPatchApproval: material`; 엄격한 환경에서는 `always` 선택 가능.
- 근거: 모든 수정에 승인하면 작업 대신 계획 수정과 승인 요청이 반복된다.

## D-009 — execution feedback과 plan failure를 분리한다

- 상태: 채택
- 결정: 타입·테스트 피드백과 승인된 missing precondition은 같은 step에서 처리한다. assumption,
  dependency, 권한, 성공·검증 계약이 바뀔 때만 Plan을 patch한다.
- 근거: `ECONNREFUSED`, Docker daemon 미기동 같은 문제에 매번 새 Plan을 만들 필요가 없다.
- 결과: plan churn, 승인 폭주, 불필요한 downstream invalidation을 줄인다.
- 실행: validation의 첫 실패는 `classify-result`로 남긴다. `missing-precondition`이면 같은 단계의 승인된
  범위에서 준비 operation을 수행하고 성공 evidence를 보고한 뒤 exact validator를 재실행한다.

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

## D-021 — ZZW가 병렬 실행과 통합을 소유한다

- 상태: 채택
- 대체한 안: 모델이 여러 bash/tool call을 내도록 유도, 일반 `task` batch를 ZZW operation 하나로 실행
- 결정: Plan DAG의 ready set에서 resource conflict graph와 Execution Wave를 runtime이 만들고, 모든
  실행을 Wave/Lane/Step에 귀속한다. 기존 tool fan-out, subagent, isolation은 하위 executor로만 쓴다.
- 근거: 모델 호출 형태나 바깥 `task` operation 하나에 의존하면 child별 evidence, crash recovery,
  cancellation, Plan lineage와 resource 충돌을 결정적으로 기록할 수 없다.
- 제약: Primary workspace 통합은 직렬이며 최종 completion은 통합 snapshot의 fresh evidence만 사용한다.
- 기본 활성화: validator만 병렬화하는 `validation`; 격리 subagent는 승인된 execution 계약과
  `safe-parallel` 설정이 모두 있어야 한다.
- 상세 계약: [parallel-execution.md](parallel-execution.md)

## D-022 — 고정 Wave를 Rolling Execution Epoch로 발전시킨다

- 상태: 채택 · cohort 단위 구현
- 현재 동작: 같은 승인·snapshot 계보의 ready frontier를 다시 계산해 같은 epoch에 동적 Lane을 추가한다.
  한 번에 admission된 cohort 안은 아직 all-settled이며 Lane completion event 단위 최적화는 남아 있다.
- 결정: Lane completion마다 ready frontier를 다시 계산하고, 같은 승인·snapshot 계보·resource policy 안의
  후속 Lane을 열린 execution epoch에 durable admission한다.
- 근거: 깊고 비대칭인 DAG에서 느린 형제가 이미 ready인 descendant를 막는 batch barrier를 제거한다.
- barrier: Primary snapshot, Plan/spec/승인 envelope가 바뀌거나 recovery·전역 검증 경계가 생기면 새
  epoch를 연다.
- 보존할 불변식: 실행 전 journal flush, resource lock, Lane별 evidence, integration 직렬화, unknown
  operation 자동 재실행 금지.
- 상세 로드맵: [parallel-execution.md](parallel-execution.md#13-로드맵-rolling-execution-epoch)

## D-023 — Plan 의미 단위와 모델 위임 단위를 분리한다

- 상태: 채택 · 기본 비활성화
- 결정: Plan Step은 승인·dependency·성공 증거가 의미 있는 독립 결과 단위로 유지한다. 특정 모델의
  가격이나 성능을 전제로 DAG를 파일 단위로 쪼개지 않고 Step 아래에 독립 검증 가능한 Work Unit을 둔다.
- 모델 선택: `mechanical`, `local-reasoning`, `system-reasoning` capability class는 분해 가능성·위험
  판정용으로 기록한다. 모든 Work Unit과 제한 repair는 하나의 사용자 선택 모델·effort를 공유하며
  runtime은 selector의 가격·속도·성능 순위를 추론하지 않는다.
- Work Unit 조건: 닫힌 scope와 출력 schema, 독립 resource, 결정적 validator, 되돌릴 수 있는 결과와
  제한된 context를 요구한다.
- 재처리: 결과가 계약이나 검증을 통과하지 못하면 동일 prompt를 무한 반복하지 않고 Work Unit selector로
  제한 repair를 수행하거나 reconciliation으로 전환한다. 동일 승인 envelope를 벗어나는 변경은 Plan
  patch와 material 재승인이 필요하다.
- 근거: Plan의 의미 구조를 모델 제품·가격·추정 성능과 분리하면서 과분해의 context 복제·통합·검증
  overhead를 통제한다.
- 상세 로드맵: [parallel-execution.md](parallel-execution.md#14-capability-분류와-실행-단위-분해)

## D-024 — 격리 write 결과는 선택적으로 독립 적대 리뷰를 거친다

- 상태: 채택 · 설정으로 선택 가능
- 결정: 설정상 eligible인 격리 workspace candidate patch는 작성자와 다른 새 read-only subagent의
  적대적 리뷰와 exact validator를 모두 통과해야 Primary integration queue에 들어간다. implementer와
  reviewer 모델은 사용자가 각각 선택하며 runtime은 어느 쪽이 더 비싸거나 강하다고 가정하지 않는다.
- 독립성: reviewer는 작성자 reasoning을 상속하지 않고 base snapshot, Work Unit 계약, diff, 허용 범위와
  validator만 새 context로 받는다. 작성자와 reviewer의 agent/session identity를 장부에 분리한다.
- 권한: reviewer는 결함과 반례를 구조화해 보고할 뿐 patch 수정, Plan 변경, 승인과 통합을 할 수 없다.
- 실패 처리: 설정된 횟수의 scoped repair 후 새 reviewer가 재검사한다. repair는 Work Unit selector를
  재사용하며 반복 실패, critical finding 또는 reviewer 충돌은 reconciliation으로 전환한다. 승인
  envelope가 바뀌면 material 재승인을 요구한다.
- 증거: review pass는 advisory/observed evidence이며 verified evidence가 아니다. 결정적 validator와 최종
  integration snapshot 검증을 대체하지 않는다.
- 선택 정책: 모델 가격과 무관하게 사용자가 켠 Work Unit·review 정책과 capability 계약만 적용한다.
- 설정: `zzworkflow.execution.workUnits.enabled`와
  `zzworkflow.execution.adversarialReview.enabled`는 서로 독립이다. 전자는 기본 `false`, 후자는 기본
  `true`이며 적대 리뷰는 capability와 관계없이 isolated-write candidate가 있을 때 실행된다.
- 상세 로드맵:
  [parallel-execution.md](parallel-execution.md#격리-write-후보의-적대적-리뷰-게이트)

## D-025 — ZZW 격리 backend는 runtime이 자동 선택한다

- 상태: 채택
- 결정: ZZW는 filesystem별 격리 backend를 사용자 설정으로 노출하지 않고 native PAL의 `auto` resolver를
  항상 사용한다.
- 근거: backend는 사용자가 결정할 workflow 정책이 아니라 OS·filesystem capability에 따른 구현
  세부사항이다. 잘못된 강제 선택은 성능 저하보다 실행 실패와 복구 복잡성을 먼저 만든다.
- 관찰성: 선택된 backend와 fallback 여부·이유는 Lane 장부에 기록해 진단 가능성을 유지한다.
- 범위: 일반 task subagent의 저수준 격리 설정은 upstream 호환 기능이므로 이 결정의 대상이 아니다.

## D-026 — ZZW 모델 계약은 현재 인증된 concrete 모델만 허용한다

- 상태: 채택
- 결정: Work Unit implementer·repair는 하나의 모델 설정을 공유하고 적대 reviewer는 별도 모델 설정을
  사용한다. 두 설정 모두 현재 세션의 `/model`에 노출되는 인증·허용 모델과 해당 모델이 실제 지원하는
  effort만 선택할 수 있다. 자유 문자열, fuzzy pattern과 role alias는 받지 않는다.
- 현재 모델: 기본값 `*`은 ZZW 내부에서만 “현재 세션 모델의 기본 effort”를 뜻하며 `*:high`처럼 지원
  effort를 붙일 수 있다. Wave 준비 시 exact `provider/model[:effort]`로 고정해 Lane 장부에 기록한다.
- 실패 정책: 저장된 explicit 모델이 로그아웃, provider 비활성화, catalog 변경 또는 `enabledModels`
  scope 변경으로 선택 불가능해지면 Wave를 만들기 전에 차단한다. 다른 모델이나 부모 모델로 자동
  fallback하지 않는다.
- 근거: 승인·evidence가 특정 실행 Lane에 귀속되는 시스템에서 실제 실행 모델이 설정과 달라지면 비용
  문제가 아니라 재현성·감사 가능성·사용자 선택권이 깨진다.
- 비범위: 모델 간 가격·속도·성능 순위를 추론하거나 capability class에 특정 제품군을 자동 배정하지
  않는다.

## D-027 — delegated agent는 Plan 영향만 보고하고 Plan은 Runtime 경계에서 진화한다

- 상태: 채택
- 문제: Work Unit이 새 사실을 발견해도 자연어 observation만으로는 같은 단위의 구현 피드백인지 Plan
  구조·Contract 변경인지 부모가 안정적으로 구분할 수 없다.
- 결정: implementer와 독립 reviewer는 strict `plan_impact`를 `none`, `execution`, `structural`,
  `contract` 중 하나로 제출한다. child는 Plan patch, 승인, integration 권한을 갖지 않는다.
- Runtime: execution은 bounded repair로 흡수하고 Plan을 유지한다. structural·contract 후보는 patch
  artifact를 보존하되 Primary에 통합하지 않고 새 epoch admission을 닫는다. 독립 Lane이 settle된 뒤
  structural은 `patch-plan`, contract은 `request-user` reconciliation을 만든다.
- 근거: delegation의 병렬 이점을 유지하면서도 Plan 변경 판단, evidence 귀속과 사용자 승인 경계를
  자연어 추측이나 child 권한에 맡기지 않기 위함이다.
- 상세 계약: [parallel-execution.md](parallel-execution.md#delegated-plan-impact-protocol)

## D-028 — Plan 승인 대기는 host-owned terminal turn boundary다

- 상태: 채택
- 문제: Plan을 `draft`로 저장하고 write gate만 닫으면 같은 provider/tool loop는 계속 살아 있다. Goal은
  작업을 계속하라고 지시하므로 모델이 상태를 재조회하거나 실행을 시도하고, 안전 차단·Todo reminder·승인
  안내가 같은 turn에서 반복된다.
- 결정: 유효한 `zzw_propose_plan`과 승인 대기를 만드는 material `zzw_patch_plan`은 배타 도구로
  실행한다. 결과가 기록되고 Registry가 `AWAITING_USER`/`draft`임을 확인한 host는 현재 provider loop를
  terminal tool-result 사유로 정상 종료하고 post-turn 자동 maintenance도 중단한다.
- 복구 가능성: invalid Plan은 종료하지 않아 모델이 구조화된 issue를 같은 turn에서 고친다. 승인을
  유지하는 structural patch도 종료하지 않는다. 다음 명시적 사용자 prompt는 terminal 상태를 지우고 새
  cycle을 시작하며 `/zzw approve-plan` 성공 시 기존 continuation 계약이 실행을 재개한다.
- 근거: approval은 모델이 우회할 수 없는 사용자 권한 경계이면서 동시에 명확한 대화 turn 경계다. 안전
  gate는 경합과 결함의 최후 방어선이어야 하며 정상 흐름에서 반복적으로 발동하는 제어 장치가 아니다.
- 검증: session-level mock provider test가 유효한 제안 뒤 provider call 1회, 후속 실행 0회와 invalid
  제안의 동일-turn 복구 가능성을 고정한다.

## D-029 — Work Unit 활성화 시 위임 판단은 Plan의 필수 계약이다

- 상태: 채택
- 문제: `work_units`를 선택 필드와 프롬프트 권고로만 두면 모델이 위임을 검토해 Primary를 선택한 것인지,
  기능을 인식하지 못해 기본 Primary로 흘렀는지 장부에서 구분할 수 없다.
- 결정: Work Unit이 활성화된 Plan의 모든 현재 work 단계는 `retain-primary`, `delegate-readonly`,
  `delegate-isolated` 중 하나와 구조화된 reason code·근거를 기록한다. 누락은 Primary 기본값이 아니라
  `DELEGATION_ASSESSMENT_MISSING` Plan 오류다.
- 동적 인지: 현재 실행 방식, Work Unit과 적대 리뷰 활성화, model selector, 판단·Work Unit 개수는
  workflow context와 `zzw_get_state`에 주입한다.
- 독립성: 위임 판단은 누가 실행하는지를 정하고, execution mode는 Lane 동시성을 정하며, 적대 리뷰
  설정은 isolated-write candidate의 review gate를 정한다. 세 결정은 서로 대신하지 않는다.
- 관찰성: `/zzw status`와 `/zzw plan`은 위임, Primary 유지, 미평가와 이유를 표시한다.
- 호환: Work Unit이 비활성인 기존 Plan은 계속 Primary-safe 기본 동작을 유지한다. 정책 활성화 전에
  저장된 draft Plan은 `/zzw approve-plan`에서 기존 executor와 권한 envelope를 보존하는 판단
  메타데이터만 정규화한 뒤 승인한다. 새 Plan 제안의 누락은 계속 거절한다. 이미 실행 중인 승인 Plan은
  현재 단계를 취소하지 않고 settle 뒤 최소 Plan patch로 남은 pending 단계 판단을 보완한다.

## 결정 변경 절차

1. 이 문서의 어떤 결정을 바꾸는지 식별한다.
2. 바꾸려는 문제와 fresh evidence를 기록한다.
3. 호환, migration, security/privacy, recovery, UX 영향을 분석한다.
4. 대안과 철회 조건을 제시한다.
5. 코드·테스트·현재 문서를 같은 변경 단위로 갱신한다.
6. 기존 항목을 삭제하지 말고 `대체됨` 상태와 후속 결정 ID를 남긴다.

초기 아이디어 문서의 오래된 제안을 근거 없이 현재 결정으로 되살리지 않는다.
