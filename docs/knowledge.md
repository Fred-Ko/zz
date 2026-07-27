# ZZ Knowledge System

ZZ Knowledge는 제거한 upstream memory와 코드·설정·DB·도구가 완전히 분리된 장기 지식 계층이다. 제거된 local memory, Mnemopi, transcript auto-retain/auto-recall, `memory://`, `/memory`와 기존 memory tool을 사용하거나 호환 계층으로 되살리지 않는다.

Hindsight는 ZZ가 정책을 적용해 사용하는 advisory semantic store다. 현재 HEAD, diff, Task, Plan, operation, lease와 검증 결과의 원본은 Git 및 Workflow Registry다.

## 활성화

Hindsight를 `127.0.0.1:8888`에서 실행한 뒤 설정한다.

```yaml
knowledge:
  enabled: true
  userId: stable-user-id
  securityBoundary: personal
  # repositoryDisplayName: ZZ Core
  bank:
    managedConfigMode: merge
    maxBanksPerUser: 4
  hindsight:
    apiUrl: http://127.0.0.1:8888
```

`ZZ_KNOWLEDGE_API_URL`과 `ZZ_KNOWLEDGE_API_TOKEN`이 설정 파일보다 우선한다.

## 사용자의 명시적 요청

다음 표현은 일반 대화가 아니라 Knowledge operation으로 처리한다.

```text
이 규칙 기억해 둬.
내가 전에 뭘 선호한다고 했지?
그 기억은 틀렸어. 정정해.
방금 기억한 내용은 잊어.
```

ZZ는 해당 turn에만 명시적 요청 지침을 주입한다. 모델은 `request_origin=user-explicit`로 recall/retain/curation 도구를 호출해야 하며, tool receipt 없이 저장·수정·삭제됐다고 말할 수 없다.

한 사용자 메시지에서 여러 항목을 저장하면 동일한 `retain_group_id`로 묶인다. 각 항목은 독립적인 `document_id`와 `knowledge_key`를 유지하므로 개별 교정도 가능하고 요청 전체의 무효화·복구·삭제도 가능하다.

## 자동 동작

- 세션 시작: 전역 사용자 선호와 현재 저장소의 작은 orientation working set을 조회한다.
- Goal intake/planning: Goal과 scope 기준으로 `deep` 조회한다.
- Goal recovery: 현재 Registry/Git을 먼저 확인한 뒤 `forensic` 조회한다.
- compaction 이후: 현재 목적에 맞게 working set을 다시 만들며 이전 덤프를 누적하지 않는다.
- Goal 완료: 자동 Retain 대신 로컬 review 후보만 만든다.

Retain은 자동이 아니다. 명시적인 사용자 요청 또는 에이전트가 검증된 장기 지식이라고 판단한 도구 호출이 있어야 한다.

## Bank topology와 표시 이름

`userId + securityBoundary` 조합마다 Global Bank 하나를 유지하고, 해당 경계 안에서 stable repository ID마다 Repository Bank 하나를 유지한다. branch, Task, session은 별도 Bank가 아니라 Repository Bank 안의 strict tag/metadata다.

```text
Global Bank       ZZ Global · stable-user-id · personal
Repository Bank   ZZ Repo · Fred-Ko/zz · personal
```

Hindsight의 opaque `bank_id`는 remote나 저장소 이름이 바뀌어도 유지된다. 대시보드용 `name`만 현재 repository 이름으로 동기화한다. repository 이름은 project override, credential을 제거한 `fork` remote, canonical `origin`, 루트 디렉터리명 순으로 결정한다. fork remote는 표시 이름에만 쓰고 stable ID는 canonical origin에서 계속 파생한다. `knowledge.repositoryDisplayName`을 설정하면 project별 표시 이름을 직접 지정할 수 있다.

scope 라우팅은 runtime이 강제한다.

```text
global                    → Global Bank
repo / task               → 현재 Repository Bank
global + repo recall      → 두 Bank를 조회해 하나의 working set으로 병합
```

모든 Bank에는 같은 managed profile을 적용한다.

ZZ가 `zz-engineering@2` 프로필을 관리한다.

- 일반 사실: 선택적인 `durable-fact`/`concise`
- canonical/reference/append 문서: 원문 chunk를 보존하는 document 전략
- 조사 기록: 더 상세한 `investigation` 전략
- observation 자동 consolidation: 비활성화
- Hindsight MCP 노출: recall/reflect만 허용
- retain/observation/reflect mission과 skeptical disposition 적용

`managedConfigMode: merge`는 ZZ 소유 필드를 bank override로 맞춘다. `inspect-only`는 변경하지 않고 drift만 상태에 표시한다.

## Tag 정책

모든 V2 record는 다음 직교 축을 갖는다.

```text
schema:zzk-v2
scope:<global|repo|task>
repo:<stable-repository-id>
branch-ref:<branch-name-at-discovery>
task:<task-id>
form:<preference|fact|decision|constraint|procedure|failure|pitfall|lesson>
domain:<user|repository|architecture|product|implementation|debugging|verification|workflow|operations>
source:<user|document|test|runtime|external|agent>
confidence:<confirmed|probable|tentative>
status:<active|contested|superseded|invalidated>
component:<subsystem>
platform:<platform>
retain-group:<request-group-id>
```

`branch-ref`는 현재 Branch 상태나 recall 범위가 아니라 발견 당시 provenance다. `branch_name_at_discovery`, `branch_head_at_discovery`, `session_id`, `episode_id`, `attempt_id`, commit, spec/plan version, evidence ID, logical `knowledge_key`, source request와 validity 기간은 metadata다. Branch rename, merge, 삭제 때 과거 record를 갱신하지 않으며 Branch 전용 임시 상태는 Workflow Registry에 둔다.

Recall은 scope tag를 엄격하게 AND하고, 목적별 form/domain은 Hindsight `tag_groups`로 조합한다. observation scope에는 group·source·confidence처럼 고유도가 높거나 변하는 tag를 넣지 않는다. 기본 observation scope는 schema + scope + domain + active이고, component가 있으면 component별 scope를 추가한다. `per_tag`는 사용하지 않는다.

## Atomic Retain과 Document Retain

`knowledge_retain`은 독립적으로 교정·중복 제거할 수 있는 짧은 사실, 결정, 절차, 실패 패턴에 사용한다. 안정적인 `knowledge_key`가 필수다.

`knowledge_retain_document`는 원문과 주변 문맥이 필요한 자료에 사용한다.

```text
canonical-document → ADR, 저장소 규칙, 공식 runbook
reference-document → 외부 명세, 긴 참고 문서
investigation      → 구조화된 원인 조사 기록
append-document    → 동일 source ID에 이어지는 journal형 기록
```

update mode:

- `replace`: canonical source를 같은 document ID로 교체
- `append`: 같은 source에 내용을 추가
- `immutable-revision`: content/version hash가 붙은 새 revision

현재 진행률, 현재 Git 상태, raw transcript/log, secret, trivial source fact와 검증되지 않은 가설은 저장하지 않는다.

## Recall

기본 budget:

```text
quick       1,000
normal      4,000
deep       10,000
forensic   20,000
```

목적에 따라 기본 form/domain filter가 달라진다. source facts와 raw chunks는 고위험 근거 확인이나 문서 문맥이 필요할 때만 요청한다. observation을 우선하고 필요하면 source fact ID로 추적한다.

query, purpose, depth, scope, taxonomy filter, repo/task, spec/plan/commit과 include 옵션이 같은 요청은 TTL 동안 working-set cache를 재사용한다. Branch 이름은 recall 범위나 cache key에 참여하지 않는다.

## 로컬 영속 상태

```text
~/.zz/agent/knowledge/boundary-<hash>/knowledge.db
├─ knowledge_outbox
├─ knowledge_retain_groups
├─ knowledge_retain_group_members
├─ knowledge_bank_profiles
├─ knowledge_working_sets
└─ knowledge_reviews

~/.zz/agent/knowledge/banks.db
└─ Global/Repository Bank ID, 표시 이름 provenance와 security-boundary 제한용 hash catalog
```

Retain은 Hindsight 호출 전에 SQLite outbox와 group member를 한 transaction으로 기록한다. 전달 실패는 재시도하며 요청 그룹은 `queued`, `partial`, `completed`, `failed`, `invalidated`, `purged` 상태를 가진다.

## 명령과 도구

사용자 명령:

```text
/knowledge status
/knowledge banks
/knowledge reviews
/knowledge groups
/knowledge invalidate-group <group-id>
/knowledge restore-group <group-id>
/knowledge purge-group <group-id> --confirm
/knowledge flush
```

`purge-group`은 복구할 수 없는 사용자 전용 동작이다. 모델은 영구 삭제 권한이 없다.

모델 도구:

```text
knowledge_recall
knowledge_retain
knowledge_retain_document
knowledge_reflect
knowledge_curate
knowledge_group
```

모델은 bank ID와 raw tag를 지정하지 못한다. `knowledge_group`은 목록·무효화·복구만 제공한다.

## Mental Model

전역 사용자 선호 1개와 repo당 최대 4개만 관리한다.

```text
developer-working-preferences
repo-operating-manual
repo-architecture-decisions
repo-known-pitfalls
repo-debugging-validation-playbook
```

자동 refresh는 하지 않는다. 검증된 새 기록이 요약의 결론을 바꿀 때만 허용 목록에서 refresh 대상을 명시한다.
