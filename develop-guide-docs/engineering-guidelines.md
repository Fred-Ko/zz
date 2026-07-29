# ZZ 엔지니어링 가이드라인

> **문서 상태: 현재 · 구현 판단 가이드**

루트 `AGENTS.md`와 `CLAUDE.md`가 에이전트가 반드시 따라야 하는 canonical rule이다. 이 문서는
그 규칙을 대체하지 않고, ZZ의 구조 안에서 실제 변경을 어떻게 설계·구현·검증하는지 설명한다.
명령 중심의 절차는 [development-workflow.md](development-workflow.md)를 함께 본다.

## 1. 변경 전에 책임 경계를 찾는다

사용자 요청을 바로 파일명으로 번역하지 말고 먼저 어떤 계층이 책임지는지 정한다.

| 변경 종류                                     | 주된 위치                               |
| --------------------------------------------- | --------------------------------------- |
| provider 요청, streaming, auth                | `packages/ai`                           |
| model catalog 값·분류·descriptor              | `packages/catalog`                      |
| agent turn, tool call, core state             | `packages/agent`                        |
| CLI, session, TUI mode, tools, ZZW, Knowledge | `packages/coding-agent`                 |
| terminal layout/component/rendering           | `packages/tui`                          |
| native grep/text/image                        | `packages/natives`, `crates/pi-natives` |
| shared logging/path/process/env               | `packages/utils`                        |
| wire contract                                 | `packages/wire`                         |
| user reference                                | `docs/`                                 |
| developer architecture and policy             | `develop-guide-docs/`                   |

기존 helper를 먼저 검색한다.

```sh
rg "하려는 동작의 이름|비슷한 API" packages/coding-agent/src packages/utils/src packages/tui/src
rg --files packages/coding-agent/src | rg "관련-영역"
```

Git·jj 실행, 경로 표시, truncate, stream, clipboard, temp file, process lifecycle을 callsite에서 새로
구현하지 않는다. 중앙 helper가 부족하면 중앙 helper를 확장한다.

## 2. public identity와 upstream compatibility를 함께 유지한다

새 사용자-facing 문자열, 문서, 명령, 기본 경로는 ZZ 이름을 사용한다. 그러나 다음은 자동 rename
대상이 아니다.

- `@oh-my-pi/*` package scope
- `__omp_worker_*` selector
- provider가 기대하는 protocol field
- migration에서 읽어야 하는 legacy setting/env key
- upstream merge 호환에 중요한 내부 module 이름

rename 전에 사용자 혼란 감소와 호환·merge 비용을 비교한다. legacy 입력을 계속 읽더라도 새 출력과
문서는 ZZ 이름만 보여 주는 migration 전략을 선호한다.

## 3. TypeScript 계약

- `any`는 다른 방법이 없을 때만 사용하고 경계를 좁힌다.
- `ReturnType<>` 대신 실제 타입 이름을 사용한다.
- inline/dynamic import를 사용하지 않는다. 값과 타입 모두 top-level import를 사용한다.
- 외부 API 타입은 `node_modules`의 실제 선언을 확인하고 추측하지 않는다.
- pure barrel의 export는 `export * from "./module"`을 우선한다.
- class 내부 비공개 상태는 `#private`을 사용한다. constructor parameter property 외에는 접근
  modifier를 붙이지 않는다.
- 수동 resolver Promise는 `Promise.withResolvers()`를 사용한다.
- state union은 impossible state를 표현하기 어렵게 설계한다.
- schema와 runtime validator가 있다면 타입만 고치고 validator를 빠뜨리지 않는다.

새 tool input이나 persisted schema를 바꾸면 다음을 함께 검토한다.

1. type/schema
2. parser와 migration
3. runtime transition
4. tool description/prompt
5. TUI renderer와 transcript rebuild
6. 저장·재시작 round trip 테스트

## 4. Bun 우선 원칙

파일은 `Bun.file()`과 `Bun.write()`, SQLite는 `bun:sqlite`, 단순 명령은 Bun Shell을 우선한다.
directory API나 Bun이 제공하지 않는 기능만 `node:*`를 사용한다. `node:fs`, `node:path`,
`node:os`는 namespace import를 사용한다.

프로세스 실행 선택:

- 짧고 단순한 명령: Bun Shell
- 장기 실행, streaming, signal/process control: `Bun.spawn`
- Git/jj: 직접 spawn하지 말고 중앙 `src/utils/git.ts`, `src/utils/jj.ts`
- 파일·directory 조작: 적절한 API 사용; shell `mkdir`, `cp`, `rm`으로 우회하지 않음

높은 권한이 필요한 경우 `sudo`가 아니라 `pkexec`를 사용한다. 대상 경로와 작업 범위를 먼저
읽기 전용으로 확인한다.

## 5. 프롬프트는 소스 코드가 아니다

prompt 내용을 TypeScript inline string, template literal, concatenation으로 만들지 않는다.

```ts
import content from "./prompt.md" with { type: "text" };
```

동적 값은 Handlebars context로 전달한다. Prompt를 바꿀 때는 다음을 구분한다.

- 항상 필요한 짧은 원칙 → system/append prompt
- 긴 세션에서 반복할 규칙 → rule
- 특정 상황의 상세 절차 → skill
- 현재 phase/task/plan 상태 → runtime-generated context
- 모델이 선택할 구조화 행위 → tool
- 위반 불가능해야 할 조건 → runtime gate

Prompt 테스트는 “문자열이 존재한다”를 검사하지 않는다. prompt가 유도해야 하는 tool 선택,
권한 경계, 상태 전이 같은 관찰 가능한 계약을 검증한다.

## 6. ZZW 변경 규칙

ZZW를 수정할 때 다음 소유권을 유지한다.

- Task/Spec/Plan/episode/operation/evidence: workflow store와 lifecycle
- Goal continuation: goals runtime과 ZZW controller integration
- Todo: Plan의 projection; ZZW active 중 직접 mutation 금지
- 승인: 사용자 slash command만 수행
- active step tool gating: runtime policy
- 완료: fresh verification evidence gate

Plan schema 변경 시 반드시 확인한다.

1. old snapshot migration/recovery
2. stable `SC-*`, `V-*` mapping
3. DAG cycle와 dependency validation
4. partial patch의 omitted-vs-empty semantics
5. contract hash와 evidence preservation
6. structural/material classification
7. TUI plan/history/diff/why projection
8. approve 후 continuation

승인 대기 상태 전이는 provider loop 종료까지 하나의 계약이다. 유효한 최초 Plan 또는 material patch
뒤에는 같은 prompt cycle의 provider 호출이 정확히 끝나고, 후속 tool call과 Todo/Goal maintenance가
실행되지 않는지 session-level test로 검증한다. 반대로 invalid Plan과 승인 유지 structural patch는 모델이
같은 turn에서 복구·계속할 수 있어야 한다. 안전 gate에 일부러 부수효과를 시도하게 한 뒤 차단되는 것을
정상 제어 흐름으로 사용하지 않는다.

작은 execution feedback을 Plan patch로 우회하지 않는다. 실패 분류를 추가한다면 실제 사용자 경험이
어떤 승인·재시도 동작으로 이어지는지 contract test로 고정한다.

delegated Lane 계약을 변경할 때는 Work Unit과 reviewer의 strict output schema, persisted Lane 필드,
Observation/evidence 귀속, candidate integration gate, bounded repair, Wave settlement와 restart projection을
같이 확인한다. child의 자연어 summary를 파싱해 Plan 변경 여부를 추론하지 말고 구조화된 `plan_impact`를
Runtime에서 판정한다. child가 Plan을 직접 patch하거나 승인하게 만들지 않는다.

## 7. ZZ Knowledge 변경 규칙

Knowledge 코드는 `packages/coding-agent/src/knowledge/`와 `knowledge_*` wrapper를 통해서만
Hindsight를 사용한다. 다른 module에서 provider HTTP API를 직접 부르지 않는다.

새 taxonomy 값이나 retain 전략을 추가할 때 확인한다.

- scope/security boundary가 기존 bank routing을 우회하지 않는가?
- tag가 stable vocabulary인가, provenance metadata여야 하는 것은 아닌가?
- `knowledgeKey` 또는 document `sourceId`가 수정·중복·삭제에 안정적인가?
- user explicit request에서 같은 request group이 유지되는가?
- redaction과 source evidence gate를 통과하는가?
- provider 실패 때 durable outbox에 남는가?
- recall working set cache key와 invalidation 조건이 충분한가?
- invalidated/superseded knowledge가 검색에서 제외되는가?
- Hindsight 결과가 authoritative context로 잘못 표시되지 않는가?

현재 진행률, 현재 HEAD, 현재 테스트 상태를 Knowledge에 저장하는 API를 추가하지 않는다.

## 8. SQLite와 persistence

이 fork가 추가하는 관계형 persistence는 `bun:sqlite`를 사용한다. 새 DB는 목적별 소유자를 분명히
하고 전역 단일 파일에 unrelated repository 상태를 섞지 않는다.

필수 원칙:

- schema migration은 idempotent하고 중간 version에서 재시작 가능
- 관련 state mutation과 event append는 한 transaction
- WAL과 `busy_timeout`으로 same-machine 동시 접근 대비
- stable ID와 unique/idempotency key 설계
- 오래된 global path migration은 원본 보존과 active lease 확인
- persistence 오류가 user source file을 손상시키지 않음
- DB를 직접 읽지 않아도 slash command로 핵심 상태를 관찰 가능

테스트는 in-memory 구현만 검증하지 말고 실제 SQLite reopen, migration, concurrency, crash boundary를
필요한 수준으로 포함한다.

## 9. TUI와 logging

`packages/coding-agent`에서 `console.log/error/warn`을 사용하지 않는다. 중앙 logger는
`~/.zz/logs/zz.YYYY-MM-DD.PID.log`에 기록하고 TUI 화면과 분리한다.

모든 renderer 경로에서:

- tab을 `replaceTabs()`로 치환
- ANSI-aware `truncateToWidth()`/`ui.truncate()` 사용
- home path를 `shortenPath()`로 축약
- `PREVIEW_LIMITS`, `TRUNCATE_LENGTHS` 사용
- success뿐 아니라 error/diff/streaming partial output도 sanitize

streamed tool preview는 live event, final merged result, transcript rebuild가 서로 다른 경로를 가질 수
있다. `__partialJson` 같은 preview-only data를 하나의 경로에서만 전달하면 실시간 화면과 재구축된
history가 달라진다.

TUI 변경은 최소한 다음을 직접 확인한다.

1. 좁고 넓은 terminal
2. 한글·emoji·ANSI·긴 path
3. tool arguments streaming 중
4. tool result 결합 후
5. session transcript reload 후
6. slash command의 화면 history
7. modal/interview 종료 후 상태줄 복구

## 10. Worker와 compiled binary

worker는 별도 compile entry를 추가하지 않고 CLI entrypoint에 재진입한다.

새 worker kind를 추가할 때:

1. `src/cli.ts` hidden `__omp_worker_*` selector dispatch 추가
2. spawn site에서 `workerHostEntry()` 사용
3. CLI host 밖의 test/SDK를 위한 direct-module fallback 유지
4. `zz --smoke-test` 또는 다른 module graph라면 sibling smoke 추가
5. source link, compiled binary, tarball install에서 검증

worker file path를 raw asset처럼 복사하거나 build script entry 목록에 수동으로 중복 등록하지 않는다.

## 11. Model catalog

`packages/catalog/src/models.json`은 생성 파일이므로 직접 수정하지 않는다.

- resolver/ID override → `provider-models/openai-compat.ts` 등 실제 resolver
- provider descriptor/default/discovery → `provider-models/descriptors.ts`
- generator fixup → `scripts/generate-models.ts`
- thinking/classification policy → `model-thinking.ts`, `identity/classify.ts`

변경 후 `bun run gen:models`로 생성하고 source와 generated output을 함께 반영한다. 테스트는 generated
JSON 문자열 grep이 아니라 resolver/descriptor의 관찰 가능한 결과를 검증한다.

## 12. 테스트 철학

테스트 하나마다 보호하는 외부 계약을 한 문장으로 말할 수 있어야 한다.

좋은 대상:

- 사용자 명령의 출력·state transition
- schema validation error shape
- approve 후 continuation
- stale evidence 판정
- crash 후 operation reconciliation
- user-explicit retain의 group ID 공유
- bank boundary와 repository routing
- provider failure의 outbox 보존
- live/rebuilt TUI render 일치

피할 대상:

- `expect(true).toBe(true)` 같은 placeholder
- 단순 field assignment와 private helper wiring
- 구현 `.ts` 파일을 읽어 특정 문자열 존재 여부 검사
- file-wide global mutation으로 다른 test를 오염시키는 mock
- `mock.module()`
- 이미 integration test가 증명한 계약을 더 약한 mock unit test로 중복

실패 경로는 error class를 직접 만들지 말고 실제 경계를 통과시켜 surfaced contract를 확인한다.
각 test 뒤에는 spy와 임시 state를 복구하고 전체 suite에서도 안전하게 만든다.

## 13. 검증 강도 선택

| 변경                 | 최소 검증                                                    |
| -------------------- | ------------------------------------------------------------ |
| Markdown만 변경      | link/path/명령 대조, formatter 또는 문서 lint가 있으면 실행  |
| 순수 TS helper       | 관련 test + package `check:types`                            |
| TUI renderer         | 관련 test + type check + 수동 폭/stream/rebuild 확인         |
| ZZW/Knowledge schema | 관련 unit/integration + SQLite reopen/migration + type check |
| worker/build/install | `zz --smoke-test` + install-method test                      |
| native/Rust          | pinned nightly + 관련 cargo nextest/check/clippy             |
| catalog              | resolver test + `bun run gen:models` + generated diff 검토   |

루트 전체 검증은 비용이 크다. iteration 중에는 좁게 실행하고 handoff 전 변경 위험에 비례해
확장한다. 환경 의존 실패는 새 회귀와 분리해 명령·오류·무관 근거를 보고한다.

## 14. 문서와 changelog

- 개발 개념·내부 구조 → `develop-guide-docs/`
- 사용자 설정·명령 → `docs/`
- package 공개 API·사용법 → `packages/*/README.md`
- 항상 적용되는 agent rule → byte-identical `AGENTS.md`, `CLAUDE.md`
- package 사용자-visible 변경 → 해당 `CHANGELOG.md`의 `[Unreleased]`

현재 문서와 역사 문서를 섞지 않는다. 폐기된 설계는
`initial-concept-archive.md`에 보존하되 README의 현재 문서 흐름에서 권위 자료로 취급하지 않는다.

## 15. 변경 완료 체크리스트

- [ ] 관련 guide와 실제 코드를 먼저 읽었다.
- [ ] unrelated dirty change와 nested repository를 보존했다.
- [ ] 올바른 package와 중앙 helper를 사용했다.
- [ ] public ZZ 이름과 upstream compatibility 경계를 확인했다.
- [ ] prompt/tool/runtime/state owner를 구분했다.
- [ ] persistence migration·recovery·concurrency를 고려했다.
- [ ] 사용자-facing 한국어·TUI sanitization을 확인했다.
- [ ] 외부 계약을 보호하는 focused test를 실행했다.
- [ ] 필요한 공개 문서·개발 문서·changelog를 함께 갱신했다.
- [ ] 실제 실행한 검증과 남은 환경 제한을 구분해 보고했다.
