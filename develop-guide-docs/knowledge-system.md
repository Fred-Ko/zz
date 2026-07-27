# ZZ Knowledge System 개발 가이드

> **문서 상태: 현재 · 권위 있는 Knowledge 구현 계약**
>
> 사용자 명시 retain/recall과 운영 명령은 [product-workflows.md](product-workflows.md)를 함께 본다.

## 1. 비호환 경계

ZZ Knowledge는 upstream OMP Memory를 확장하지 않는다. Mnemopi, 기존 memory backend, transcript retain/recall, `memory://`, `/memory`, legacy tool/prompt/setting을 import하거나 compatibility wrapper로 되살리는 변경은 금지한다.

```text
Authoritative current-state plane    Advisory Knowledge plane
Git / workspace                      ZZ Knowledge policy
ZZWorkflow Registry                  Hindsight wrapper
Plan DAG / operation journal         working-set cache
Verification evidence                retain groups / curation
            서로의 저장 계층이 아니며 authority를 공유하지 않음
```

Task lifecycle hook이 planning·resume·completion 경계에서 Knowledge operation을 요청할 수는 있지만,
ZZW state를 Hindsight에 복제하거나 Knowledge 결과로 Registry를 덮어쓰지 않는다.

## 2. 코드 소유권

| 책임                                             | 위치                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| public taxonomy와 runtime 계약                   | `src/knowledge/types.ts`                                                           |
| Global/Repository Bank ID·표시 이름·scope 라우팅 | `src/knowledge/bank-routing.ts`                                                    |
| tag compile/parse 정책                           | `src/knowledge/tag-policy.ts`                                                      |
| managed bank profile                             | `src/knowledge/bank-profile.ts`                                                    |
| 명시적 대화 intent 후보 판정                     | `src/knowledge/conversation-intent.ts`                                             |
| 설정 해석                                        | `src/knowledge/config.ts`                                                          |
| Hindsight HTTP API                               | `src/knowledge/hindsight-client.ts`                                                |
| outbox/group/cache/review SQLite                 | `src/knowledge/store.ts`                                                           |
| policy orchestration                             | `src/knowledge/runtime.ts`                                                         |
| 모델 도구                                        | `src/tools/knowledge-*.ts`                                                         |
| system policy와 상황별 skill                     | `src/prompts/system/knowledge-policy.md`, `src/skills/knowledge-operator/SKILL.md` |

Hindsight URL, bank ID, raw tag, observation scope를 다른 모듈에서 직접 조립하지 않는다. Bank ID와 대시보드 표시 이름은 `bank-routing.ts`를 단일 원본으로 사용한다.

## 3. V2 taxonomy

분류는 서로 다른 질문을 한 tag에 합치지 않는다.

```text
scope       어디까지 유효한가(global/repo/task)
form        어떤 형태의 지식인가
domain      어느 의사결정 분야인가
source      실제 provenance는 무엇인가
confidence  증거가 얼마나 강한가
status      recall 대상으로 유효한가
component   어떤 subsystem에 적용되는가
platform    어떤 환경에 적용되는가
```

`schema:zzk-v2`는 legacy/외부 ingest와 V2 record를 분리한다. 모델은 raw tag를 만들지 않고 typed field만 제공하며 `compileRecordTags()`가 tag를 결정한다.

`knowledge_key`는 논리적 동일성을 나타내고 `document_id`는 Hindsight 물리 문서를 나타낸다. 같은 사실의 revision/correction은 knowledge key를 유지할 수 있지만 document ID는 교체 또는 새 revision이 될 수 있다.

## 4. 요청 그룹

같은 실제 사용자 메시지에서 실행된 모든 retain tool은 다음 ID를 공유한다.

```text
group_id = hash(session_id + user_message_entry_id)
```

fallback tool-call ID는 session entry가 없는 SDK/테스트 호출에만 사용한다.

```text
knowledge_retain_groups
└─ knowledge_retain_group_members
   ├─ bank_id
   ├─ document_id
   ├─ knowledge_key
   ├─ classification_json
   └─ outbox_id
```

group insert, outbox insert, member insert는 하나의 SQLite transaction이다. Hindsight 전송 결과에 따라 member와 group 상태를 재계산한다. 그룹 무효화·복구는 모든 document의 `status:` tag를 갱신하고, purge는 user-only command에서만 호출한다.

## 5. Bank topology와 Managed Profile

보안 경계마다 Global Bank 하나를 두고, 같은 경계 안에서 저장소마다 Repository Bank 하나를 둔다.

```text
global scope                 → zz-global-v1-<stable-hash>
repo / task scope           → zz-repo-v1-<stable-hash>
```

Global Bank ID는 `user ID + security boundary`, Repository Bank ID는 여기에 stable repository ID를 더해 파생한다. branch/task/session마다 Bank를 만들지 않는다. ID는 opaque하고 안정적으로 유지하며 Hindsight `name`에는 사람이 읽을 수 있는 값을 동기화한다.

```text
ZZ Global · junoko · personal
ZZ Repo · Fred-Ko/zz · personal
```

project 표시 이름을 우선하고, 없으면 `fork` remote와 `origin` 순으로 credential을 제거한 repository path를 사용한 뒤 로컬 디렉터리명으로 fallback한다. 로컬 이름에는 짧은 repository hash를 붙인다. fork remote는 대시보드 이름에만 사용하며 stable repository ID는 canonical origin을 계속 사용한다. repository rename이나 표시 이름 override는 Hindsight name만 바꾸고 Bank ID를 바꾸지 않는다.

`createKnowledgeBankProfile()`의 ZZ 소유 설정:

- retain/observation/reflect mission
- named retain strategies:
  - `durable-fact`: concise extraction
  - `canonical-document`: chunks, `retain_chunk_size=1200`
  - `reference-document`: chunks, `retain_chunk_size=1600`
  - `investigation`: verbose extraction
  - `append-document`: chunks, `retain_chunk_size=8000`
- observation enabled, auto consolidation disabled
- skepticism 5, literalism 4, empathy 2의 engineering-oriented disposition
- Hindsight MCP read-only tool allowlist

`merge` mode는 `GET /config`의 overrides와 desired profile을 비교하고 drift면 `PATCH /config { updates }`를 실행한다. `inspect-only`는 drift 상태만 SQLite에 기록한다. credential, provider URL/model 같은 server-only 필드는 profile에 넣지 않는다.

Bank config에 새 필드를 추가할 때 Hindsight 공식 config API에서 per-bank configurable인지 확인한다. profile version을 올리고 실제 PATCH payload를 검증하는 contract test를 갱신한다.

### 최초 초기화 시점

Bank는 설정 파일을 저장하는 순간 무조건 생성하지 않는다. `knowledge.enabled=true`인 session에서
Knowledge runtime이 실제로 필요해지는 첫 동작이 초기화를 촉발한다.

```text
/knowledge status 또는 banks
knowledge_recall / retain / retain_document / reflect
session orientation
ZZW intake·planning·resume의 허용된 recall
```

초기화는 다음 순서로 idempotent하게 수행한다.

1. `userId + securityBoundary`로 boundary local DB와 Global Bank ID를 계산한다.
2. 현재 repository identity와 표시 이름으로 Repository Bank ID/name을 계산한다.
3. `banks.db` catalog에서 security boundary 수 제한과 기존 binding을 확인한다.
4. Hindsight Bank가 없으면 만들고, 있으면 opaque ID는 유지한 채 표시 이름만 동기화한다.
5. managed profile을 조회해 `merge` 또는 `inspect-only` 정책을 적용한다.
6. local runtime/outbox/working-set state를 준비한다.

Hindsight가 꺼져 있거나 HTTP 요청이 실패하면 현재 Git/ZZW state를 손상시키지 않는다. retain은
outbox에 남을 수 있고 recall은 degraded/failed provider 상태를 명시한다.

### 주요 설정

| 설정                                | 기본값     | 의미                                                  |
| ----------------------------------- | ---------- | ----------------------------------------------------- |
| `knowledge.enabled`                 | `false`    | 독립 Knowledge layer와 model tools 활성화             |
| `knowledge.userId`                  | `default`  | 사용자 지식 격리를 위한 안정 identity                 |
| `knowledge.securityBoundary`        | `personal` | personal/company/customer 같은 보안 경계              |
| `knowledge.repositoryDisplayName`   | 없음       | Repository Bank의 사람이 읽는 이름 override           |
| `knowledge.bank.managedConfigMode`  | `merge`    | profile 적용 또는 `inspect-only` drift 보고           |
| `knowledge.bank.maxBanksPerUser`    | `4`        | user당 security boundary 수 상한; repo bank 수가 아님 |
| `knowledge.recall.quickTokens`      | `1000`     | 중복·단일 사실 recall budget                          |
| `knowledge.recall.normalTokens`     | `4000`     | 일반 구현 recall budget                               |
| `knowledge.recall.deepTokens`       | `10000`    | 계획·디버깅·재계획 budget                             |
| `knowledge.recall.forensicTokens`   | `20000`    | 복합 장애·충돌 분석 상한                              |
| `knowledge.mentalModels.maxPerRepo` | `4`        | repository mental model 상한                          |

전체 설정과 timeout은 `docs/settings.md`를 단일 사용자 reference로 사용한다.

## 6. Retain routing

Atomic record:

```text
knowledge_retain
→ evidence/future-use gate
→ quick recall-before-retain
→ taxonomy compile
→ stable record document ID
→ grouped SQLite outbox
→ named concise/investigation strategy
```

runtime은 모델이 Bank를 선택하게 하지 않는다. `global` retain은 Global Bank, `repo`와 `task` retain은 현재 Repository Bank로 결정적으로 라우팅한다. 여러 scope recall/reflect는 각 Bank에 strict scope tag를 붙여 병렬 조회한 뒤 하나의 working set으로 합친다.

Git branch는 Knowledge scope가 아니다. Durable repo/task record가 특정 branch에서 발견되면 `branch-ref:<name>`을 record tag에만 추가하고, 원래 이름과 HEAD는 `branch_name_at_discovery`, `branch_head_at_discovery` metadata로 보존한다. 이 provenance는 observation scope와 recall filter에 포함하지 않으며 rename, merge, 삭제 때 갱신하지 않는다. Branch 전용 진행 상태와 임시 제약은 ZZWorkflow Registry에 둔다.

Document:

```text
knowledge_retain_document
→ stable source_id
→ replace / append / immutable-revision
→ chunks-based canonical/reference/append strategy
→ grouped SQLite outbox
```

`chunks`는 원문을 청크로 보존하고 LLM fact extraction을 피한다. independently correctable knowledge는 document blob에만 묻지 말고 atomic record로도 분리한다.

선택 기준:

| 조건                                        | Atomic retain         | Document retain      |
| ------------------------------------------- | --------------------- | -------------------- |
| 한 문장으로 정정 가능한 규칙·결정·실패 패턴 | 적합                  | 과도함               |
| ADR·runbook·운영 매뉴얼 원문                | 핵심 결론만 병행 가능 | 적합                 |
| source 전체를 새 버전으로 교체              | 부적합                | `replace`            |
| 시간순 로그·release note를 이어 붙임        | 일부 교훈만 가능      | `append`             |
| 과거 버전을 불변 이력으로 보존              | revision fact 가능    | `immutable-revision` |
| section/chunk 단위 검색 필요                | 부적합                | 적합                 |

Document retain의 `sourceId`는 파일 경로·공식 문서 ID처럼 버전이 바뀌어도 같은 논리 출처를
가리켜야 한다. Atomic retain의 `knowledgeKey`도 문장 hash가 아니라 논리적 의미를 나타내는 안정
key여야 한다.

Observation scope는 `schema + exact scope + domain + status`를 기본으로 하고 component별 scope를 추가한다. `retain-group`, `source`, `confidence`, `form`을 observation scope에 넣으면 observation이 과도하게 분절되므로 금지한다. `"per_tag"`도 금지한다.

## 7. Recall

scope는 `tags + all_strict`, form/domain/component는 recursive `tag_groups`로 전달한다. 목적별 기본 taxonomy filter는 `PURPOSE_FILTERS`에서만 관리한다.

```text
quick       duplicate / one fact
normal      implementation / convention
deep        planning / debugging / replanning
forensic    incident / conflict / recovery
```

기본적으로 world + experience + observation을 조회하고 `prefer_observations=true`를 사용한다. source facts와 chunks는 caller가 명시한 경우만 포함한다. working-set cache key에 taxonomy와 include option을 빠뜨리면 서로 다른 recall이 같은 캐시를 공유하므로 주의한다.

## 8. 명시적 대화 intent

`conversation-intent.ts`는 deterministic candidate detector다. 의미를 최종 결정하거나 자동 retain하지 않는다.

```text
user text
→ retain / recall / correct / forget 후보 탐지
→ 숨은 static prompt notice
→ model이 typed tool 호출
→ runtime policy + receipt
```

prompt는 반드시 `.md`에 둔다. false positive를 줄이기 위해 단순히 “memory/Knowledge를 설명해” 같은 문장은 매칭하지 않는다. 새 표현을 지원하면 네 intent를 구분하는 contract test를 추가한다.

명시적 요청에서는 `request_origin=user-explicit`을 유지한다. 같은 user message에서 여러 tool call이
발생하면 `user_message_entry_id` 기반 group을 재사용한다. agent가 대화만 보고 “저장했다”거나
“기억이 없다”고 결론내리지 않고 실제 receipt/provider 결과를 사용자에게 보여 줘야 한다.

## 9. Curation

- invalidate: active → invalidated
- restore: invalidated → active
- correct: 기존 document를 superseded로 만들고 fresh evidence로 replacement retain
- group invalidate/restore: 모든 member document에 동일 상태 전이
- purge: user-only, `--confirm` 필수

Correction은 기존 scope/form/domain/knowledge key를 보존하고 source/confidence는 새 증거를 반영한다. raw Hindsight delete tool을 모델에 노출하지 않는다.

## 10. 로컬 DB migration

경로:

```text
~/.zz/agent/knowledge/boundary-<hash>/knowledge.db
~/.zz/agent/knowledge/banks.db
```

첫 DB는 boundary별 outbox/group/cache/review를, `banks.db`의 `knowledge_bank_catalog_v2`는 raw 사용자 값을 저장하지 않는 Global/Repository Bank hash catalog, 표시 이름 provenance와 security-boundary 수 제한을 담당한다. 기존 단일-Bank catalog와 `zz-knowledge-v1-*` Bank는 새 라우팅에서 사용하지 않으며 자동 삭제하지 않는다. 기존 DB에는 group member의 `bank_id`가 없을 수 있으므로 `PRAGMA table_info` 뒤 `ALTER TABLE ADD COLUMN`과 기존 group Bank backfill을 사용한다. destructive migration이나 ZZWorkflow DB 병합은 하지 않는다. WAL, foreign keys, busy timeout을 유지한다.

사용자가 비어 있는 legacy `zz-knowledge-v1-*` Bank를 정리하고 싶더라도 runtime이 이름 prefix만 보고
자동 삭제하지 않는다. 영구 삭제는 정확한 target과 Hindsight 상태를 확인한 사용자 명시 작업으로
다룬다.

## 11. 검증

```sh
bun test \
  packages/coding-agent/test/knowledge-runtime.test.ts \
  packages/coding-agent/test/knowledge-conversation-intent.test.ts \
  packages/coding-agent/test/managed-skills-discovery.test.ts

bun --cwd=packages/coding-agent run check:types
```

필수 계약:

- disabled network silence
- security-boundary DB 분리
- Global/Repository Bank scope 라우팅과 사람이 읽을 수 있는 Hindsight name
- managed bank config payload
- strict V2 scope + purpose tag groups
- explicit observation scopes, no `per_tag`
- working-set replacement/cache
- evidence gate, redaction, recall-before-retain
- one request → one group, multiple independently addressable members
- document strategy/update mode
- explicit conversation intent routing
- no automatic completion retain
- model cannot permanently purge
