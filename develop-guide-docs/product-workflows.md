# ZZ 제품 사용 흐름

> **문서 상태: 현재 · 사용자 경험과 명령의 개발 기준**

이 문서는 사용자가 ZZ로 실제 개발 작업을 어떻게 시작하고, 진행 상황을 확인하고, 중단·재개하며,
장기 지식을 다루는지 설명한다. 사용자-facing 문서와 TUI를 변경할 때 이 흐름이 깨지지 않는지
확인한다.

## 1. 먼저 작업 모드를 선택한다

| 상황                                     | 권장 시작                       | 특징                                    |
| ---------------------------------------- | ------------------------------- | --------------------------------------- |
| 질문, 작은 수정, 빠른 조사               | 자연어로 바로 요청              | 별도 Task/Plan 승인 없음                |
| 세션 안에서 자율 목표를 계속 수행        | `/goal`, `/guided-goal`         | upstream 원본 Goal 동작                 |
| 오래 걸리고 감사·복구·검증이 중요한 작업 | `/zzw-goal`, `/zzw-guided-goal` | ZZW Task Contract와 Plan DAG 사용       |
| 과거 지식 조회·저장·정정·삭제            | 자연어 요청 + `/knowledge`      | ZZ Knowledge가 tool receipt와 상태 제공 |

ZZW가 “더 고급”이라는 이유로 모든 작업에 자동 적용하지 않는다. 짧은 수정에 contract interview와
승인이 붙으면 비용만 커진다. 반대로 여러 세션에 걸친 migration이나 대규모 refactor를 일반 대화로
진행하면 완료 기준과 복구 지점이 흐려진다.

## 2. 일반 작업

그냥 요청하면 upstream 기반의 일반 coding-agent 흐름으로 처리한다.

```text
> 이 함수의 race condition 원인을 조사하고 고쳐줘.
```

이 모드에서는 ZZW Registry가 새 Task를 만들지 않고 Plan approval gate도 활성화하지 않는다.
Knowledge가 켜져 있고 관련 과거 지식이 현재 결정에 중요하면 agent가 목적별 recall을 할 수 있지만,
그 결과는 advisory다.

## 3. 원본 Goal

기존 Goal은 그대로 유지한다.

```text
/guided-goal 결제 모듈의 flaky test를 안정화해줘
/goal show
/goal pause
/goal resume
/goal drop
```

이 흐름은 세션 중심 자율 목표이며 ZZW의 Task Contract, Plan DAG, operation journal, approval gate를
사용하지 않는다. 원본 Goal에 ZZW tool gating이 걸리면 안 된다.

## 4. ZZWorkflow로 작업 시작

### 4.1 요구사항이 거친 상태라면

```text
/zzw-guided-goal MikroORM 전환과 트랜잭션 경계 정리를 진행해줘
```

예상 흐름:

```text
rough objective
  → guided interview
  → Task Specification 확정
  → read-only repository discovery
  → Plan DAG 제안
  → 사용자 승인 대기
  → /zzw approve-plan
  → 첫 dependency-ready step 자동 continuation
  → 실행 / 관찰 / 증거 / 검증
```

인터뷰는 저장소에서 답을 찾을 수 있는 질문을 사용자에게 떠넘기면 안 된다. 예를 들어 정확한 test
script나 기존 ORM 식별자는 먼저 `package.json`과 코드를 조사한다. 사용자에게는 제품 동작,
scope, 복구 곤란한 선택, 완료 기준처럼 실제 결정을 바꾸는 질문만 한다.

`/guided-goal`과 `/zzw-guided-goal`의 인터뷰는 별도 modal이나 숨은 side session이 아니라 일반 대화
history에서 한 질문씩 진행한다. 전자는 원본 Goal을 만들고, 후자는 같은 인터뷰 UX를 사용하되 마지막에
`controller=zzworkflow`로 Task Contract를 정확히 한 번 생성한다. 인터뷰 중에는 Plan 제안이나
side effect를 시작하지 않는다.

### 4.2 목표와 기준이 이미 명확하다면

```text
/zzw-goal set auth refresh race를 공개 API 변경 없이 수정하고 bun test로 검증
```

인자가 없는 `/zzw-goal`은 현재 UI 규칙에 따라 목표 입력·관리 흐름을 열 수 있다. 다음 관리
명령을 제공한다.

```text
/zzw-goal show
/zzw-goal pause
/zzw-goal resume
/zzw-goal budget 200000
/zzw-goal budget off
/zzw-goal drop
```

## 5. Plan 검토와 승인

Plan이 만들어지면 사용자는 다음을 확인한다.

```text
/zzw plan
/zzw why <step-id>
/zzw diff
/zzw history
```

Plan 제안 카드와 `/zzw plan`은 `dependsOn`을 기준으로 분기와 합류가 보이는 터미널 그래프를 먼저
표시하고 단계별 execution·delegation·resource·lineage 상세를 뒤에 표시한다. 그래프는 모델의 요약이
아니라 현재 Registry에서 생성한 읽기 전용 projection이다. 교체·무효화·포기된 과거 node는 실행
그래프에서 제외되지만 상세와 변경 이력에는 남는다.

초기 Plan은 `draft`이며 실행하려면 다음을 입력한다.

```text
/zzw approve-plan
```

정상 UI에서는 Plan 제안 도구 카드 하나에 단계 요약과 승인 명령이 표시된 뒤 agent가 입력 대기 상태가
된다. 승인 전 agent가 다시 상태를 조회하거나 실행을 시도해 안전 차단을 받고, 같은 승인 안내와 Todo를
반복하는 것은 회귀다. 유효한 Plan 제안 또는 material patch는 현재 모델 turn을 끝내며 다음 모델 요청은
`/zzw approve-plan` 같은 새 사용자 입력이 있어야만 시작한다. 잘못된 Plan 제안은 예외로, 구조화된 오류를
모두 고치기 위해 같은 turn을 계속한다.

승인 명령은 단지 DB 필드만 바꾸고 끝나면 안 된다. 승인 성공 후 Goal continuation을 요청해 첫
dependency-ready step을 자동으로 실행해야 한다. 실행이 시작되지 않으면 먼저 `/zzw status`에서
다음을 확인한다.

- Goal이 `active`인지 `paused`인지
- Plan이 `approved · current`인지
- `다음 동작`과 active step이 무엇인지
- reconciliation 또는 unresolved operation이 있는지
- readiness blocker가 남았는지

Goal이 일시 중지 상태라면 `/zzw-goal resume`이 먼저 필요하다. Plan이 이미 승인된 상태에서
`/zzw approve-plan`을 반복하는 것은 resume 명령을 대신하지 않는다.

## 6. 실행 중 Plan 변화

작업하면서 Plan은 바뀔 수 있다.

- 타입 오류, test feedback, 승인된 로컬 인프라 기동: 같은 step에서 처리
- 승인 범위 안의 step 분해·milestone 구체화·동일 validator 교체·검증 환경 준비: structural patch, 기본적으로 승인 유지
- 새로운 위험 작업, 권한 확대, 성공 조건 약화, 새 executor 권한 또는 validator 명령 변경: material patch, 사용자 재승인

따라서 Plan version 증가 자체는 이상이 아니다. 그러나 작은 오류마다 material patch와 승인을
요청하면 잘못된 UX다. `/zzw diff <version>`과 `/zzw why <step-id>`는 왜 변경이 필요했는지,
무엇이 보존됐는지를 보여 줘야 한다.

검증 실패가 DB·Kafka·Docker 같은 승인된 환경 전제 때문이면 Plan을 새 버전으로 만들지 않는다.
`missing-precondition`으로 분류한 뒤 같은 validation 단계에서 준비 명령을 실행하고, 성공 evidence를
보고한 다음 exact validator를 재시도한다. 이 흐름은 승인 요청 없이 계속되며 준비 명령의 결과를
검증 통과 증거로 오인하지 않는다.

## 7. 상태·증거·operation 확인

```text
/zzw status
/zzw plan
/zzw evidence
/zzw operations
/zzw lanes
```

각 명령의 역할:

| 명령                  | 답해야 하는 질문                                              |
| --------------------- | ------------------------------------------------------------- |
| `/zzw status`         | 지금 어떤 phase이고 다음에 무엇을 해야 하는가?                |
| `/zzw plan`           | 어떤 step이 완료·대기·무효화됐고 dependency는 무엇인가?       |
| `/zzw history`        | Plan version마다 무엇이 바뀌었는가?                           |
| `/zzw diff [version]` | 특정 patch가 추가·수정·보존·무효화한 항목은 무엇인가?         |
| `/zzw why <step-id>`  | 이 step이 왜 존재하고 어떤 evidence·observation과 연결되는가? |
| `/zzw evidence`       | 검증 근거는 trusted/fresh한가?                                |
| `/zzw operations`     | 중단되거나 미해결인 side effect가 있는가?                     |
| `/zzw lanes`          | 어떤 validator/subagent가 어느 Wave·자원에서 어떤 상태인가?   |

상태줄은 이 정보를 압축한 projection이다. 상세 판단은 slash command와 Registry 내용을 우선한다.

Plan에 동시에 ready인 단계가 여러 개 있어도 ZZW가 모두 병렬 실행하는 것은 아니다. 기본
`zzworkflow.execution.mode=validation`에서는 독립 validator 명령만 bounded Wave로 실행한다.
`safe-parallel`을 선택하면 resource claim이 충돌하지 않는 read-only/isolated-write subagent도 실행하며,
Primary workspace patch 통합은 항상 하나씩 수행한다. 자세한 계약은
[parallel-execution.md](parallel-execution.md)를 따른다.

실행 방식, Work Unit 분해와 적대 리뷰는 서로 독립된 선택이다. `serial`에서도 Work Unit과 reviewer를
하나씩 실행할 수 있고, `safe-parallel`에서도 적대 리뷰를 끌 수 있다. model selector는 사용자 선택값이며
runtime은 선택된 모델의 가격이나 상대적 능력을 추정해 정책을 바꾸지 않는다.

Work Unit 설정이 활성화되면 `/zzw plan`과 `/zzw status`에는 각 work 단계의 위임 또는 Primary 유지 판단이
표시된다. 판단이 누락된 Plan은 승인할 수 없다. 위임 대상이 0개여도 “후보가 없었다”로 숨기지 않고 각
단계의 `retain-primary` 이유를 확인할 수 있어야 한다.

설정을 켜기 전에 이미 저장해 둔 draft Plan은 예외적으로 다시 만들 필요가 없다. `/zzw approve-plan`이
기존 executor와 권한을 그대로 보존하는 판단 메타데이터만 채워 승인한다. 새 Plan을 현재 정책 아래에서
제안할 때 판단이 빠진 경우에는 이 호환 경로를 적용하지 않고 제안 단계에서 거절한다.

기존 승인 Plan이 판단 계약 없이 만들어진 뒤 Work Unit을 켠 경우, 현재 in-progress Primary 단계는 중간에
취소하지 않는다. 그 단계가 settle된 다음 `assess_delegation_and_patch_plan`으로 전환하고 남은 pending
work 단계의 판단을 한 번의 최소 patch로 보완한다. 이 경계 전에는 새 ordinary mutation을 허용하지 않는다.

위임 중 새 사실이 나오더라도 child가 Plan을 바꾸지는 않는다. `/zzw lanes`의 `plan-impact`는
`execution`이면 같은 Work Unit repair, `structural`이면 Plan 부분 패치, `contract`이면 사용자 결정이
필요하다는 뜻이다. structural·contract 후보 patch는 Primary에 적용되지 않은 채 artifact로 보존된다.

## 8. Pause, 종료, 재개

```text
/zzw-goal pause
# zz 종료 후 같은 저장소에서 다시 실행
/zzw-goal resume
```

재개 시 기대 동작:

1. 현재 cwd에서 repository identity를 다시 계산한다.
2. `~/.zz/agent/workflows/<repository-id>/workflow.db`를 연다.
3. active Task, Plan, episode, lease, operation journal을 읽는다.
4. Git/workspace fingerprint와 기대 상태를 비교한다.
5. 미해결 operation이 있으면 먼저 reconciliation한다.
6. stale evidence를 판정한 뒤 안전한 active step에서 계속한다.

Git이 없던 디렉터리에서 `git init`을 실행하거나 `/move`로 repository boundary가 바뀌면 runtime은
다음 prompt 경계에서 identity와 저장소 binding을 다시 확인한다. 상태가 의심스러우면
`/zzw status`로 repository별 Task가 올바르게 선택됐는지 확인한다.

ZZ는 여러 머신의 실시간 Task 상태 동기화를 제공하지 않는다. 다른 머신으로 옮길 때는 Git
checkpoint와 명시적 handoff를 사용하고, 각 머신의 ZZW SQLite를 공유 디스크로 복제하지 않는다.

## 9. Knowledge 활성화와 상태 확인

Knowledge는 기본적으로 비활성화돼 있다. 사용자 또는 프로젝트 설정에서 다음을 정한다.

```json
{
  "knowledge.enabled": true,
  "knowledge.userId": "stable-user-id",
  "knowledge.securityBoundary": "personal"
}
```

Hindsight endpoint 기본값은 `http://127.0.0.1:8888`이다. 필요하면 설정 또는 환경 변수
`ZZ_KNOWLEDGE_API_URL`, `ZZ_KNOWLEDGE_API_TOKEN`을 사용한다.

```text
/knowledge status
/knowledge banks
```

최초 status, recall, retain처럼 Knowledge runtime이 필요한 작업에서 local policy DB와 Global /
Repository bank binding을 준비하고 managed profile을 확인한다. `merge` 모드에서는 ZZ가 소유한
profile 필드를 맞추고, `inspect-only`는 drift만 보고한다.

## 10. 사용자가 직접 기억을 요청하는 예

### 10.1 Retain

```text
> 이 저장소에서는 schema를 바꾼 뒤 bun run gen:models를 실행해야 한다는 것을 기억해 둬.
```

agent는 같은 turn에 다음을 수행해야 한다.

1. 이 내용이 current progress가 아니라 durable knowledge인지 분류
2. repository scope와 적절한 form/domain/source/confidence 결정
3. quick recall로 중복·충돌 확인
4. `knowledge_retain` 또는 문서라면 `knowledge_retain_document` 호출
5. queued/duplicate/rejected receipt를 사용자에게 설명

“알겠습니다, 기억하겠습니다”만 답하는 것은 실패다.

한 메시지에서 여러 항목을 저장하면 같은 request group ID를 사용한다.

```text
/knowledge groups
/knowledge invalidate-group <group-id>
/knowledge restore-group <group-id>
/knowledge purge-group <group-id> --confirm
```

invalidate는 recall에서 제외하지만 이력을 보존하고, purge는 명시적 확인이 필요한 영구 삭제다.

### 10.2 Recall

```text
> 전에 이 저장소에서 schema generation 때문에 실패한 적이 있었는지 기억을 찾아봐.
```

agent는 `request_origin=user-explicit`로 recall한 뒤 결과와 현재 repository evidence를 구분해 답한다.
기억이 없거나 Hindsight가 실패했다면 대화 문맥으로 결과를 꾸며내지 않는다.

### 10.3 정정과 삭제

```text
> bun run old-build를 쓴다는 기억은 틀렸어. 지금은 bun run build야. 관련 기억을 정정해.
> 방금 한 요청으로 저장한 기억을 전부 무효화해.
```

정정은 기존 document ID와 evidence를 연결해 curation하고, 요청 단위 일괄 관리는 group command를
사용한다.

## 11. 자동 Knowledge 동작의 범위

`knowledge.enabled=true`가 “모든 대화를 자동 저장한다”는 뜻은 아니다.

자동으로 허용되는 것:

- session start의 작은 mental-model orientation
- Task intake/planning/replanning/resume에 필요한 목적별 recall
- retain 전에 quick duplicate/conflict recall
- Task completion 때 durable knowledge 후보 review 생성
- 실패한 provider 전송의 로컬 outbox 보존과 명시적 flush

자동으로 하지 않는 것:

- transcript 전체 retain
- 현재 수정 파일, active step, test progress retain
- 매 turn deep recall/reflect
- completion 후보의 무조건 retain
- 다른 security boundary나 unrelated Repository Bank 검색

## 12. Document retain을 선택하는 경우

짧은 독립 사실은 atomic retain이 적합하다. 다음은 document retain이 적합하다.

- ADR, runbook, 저장소 운영 규칙처럼 하나의 출처가 묶음 의미를 가짐
- 긴 조사 결과에서 section·chunk 검색이 필요함
- 동일 source를 replace/append/immutable revision으로 관리해야 함
- 원문 provenance와 문서 version을 보존해야 함

공식 문서를 Hindsight만의 사본으로 만들지 않는다. 공식 원본은 Git의 문서이며 Knowledge에는
그 문서와 핵심 적용 맥락을 검색 가능하게 retain한다.

## 13. 정상 동작 확인 시나리오

### ZZW smoke

1. 작은 테스트 저장소에서 `/zzw-guided-goal`로 파일 한 개 수정 목표를 시작한다.
2. interview 후 `/zzw plan`이 draft DAG를 표시하는지 확인한다.
3. 승인 전 edit/bash write가 차단되는지 확인한다.
4. `/zzw approve-plan` 후 추가 입력 없이 첫 step이 시작되는지 확인한다.
5. `/zzw evidence`에 validator 결과가 workspace snapshot과 연결되는지 확인한다.
6. `zz`를 종료·재실행한 뒤 `/zzw status`와 resume이 같은 Task를 찾는지 확인한다.

### Knowledge smoke

1. `/knowledge status`에서 Global/Repository bank와 최근 provider 상태를 확인한다.
2. 고유한 사실 하나를 명시적으로 기억해 달라고 요청한다.
3. `/knowledge groups`에서 새 group과 member 수를 확인한다.
4. 새 세션에서 그 사실을 명시적으로 recall한다.
5. group을 invalidate하고 같은 질문에서 결과가 제외되는지 확인한다.
6. restore 후 다시 조회되는지 확인한다.

## 14. UX 회귀로 간주할 증상

- `/guided-goal`에 ZZW approval gate가 개입함
- `/zzw approve-plan` 성공 후 active Goal인데 continuation이 시작되지 않음
- 타입 오류나 인프라 미기동마다 material Plan patch를 만들어 승인을 반복함
- slash command가 화면 history에서 사라짐
- guided interview가 같은 화면 영역을 덮어써 이전 질문·답을 볼 수 없음
- 모델 응답 중 상태가 사라지거나 상태줄에서 모델·repository/worktree·phase를 구분할 수 없음
- `knowledge.enabled=true`만으로 transcript가 자동 retain됨
- Knowledge recall 결과를 현재 Git 상태처럼 단정함
- 같은 사용자 retain 요청의 항목들이 서로 다른 group으로 저장됨

이 증상은 표현상의 취향이 아니라 제품 계층과 상태 프로토콜이 깨졌다는 신호다.
