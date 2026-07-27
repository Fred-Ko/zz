# ZZ 개발 워크플로

## 1. 환경 준비

필수 도구:

- Bun: 루트 `package.json`의 고정 버전 기준
- Git
- Rust toolchain: 네이티브 패키지를 수정할 때
- Python/ruff/pytest: `python/` 패키지를 수정할 때
- `pkexec`: 시스템 권한이 필요한 설치 작업

전체 초기화:

```sh
bun run setup
```

이 명령은 의존성 설치, 네이티브 빌드, coding-agent link와 `zz` 실행 링크를 구성한다. ZZWorkflow registry는 `zz`에 내장되어 별도 daemon을 설치하거나 실행하지 않는다.

의존성만 맞출 때:

```sh
bun install
```

## 2. 실행 방식

소스에서 직접 실행:

```sh
bun run dev
```

인자를 넘길 때:

```sh
bun --cwd=packages/coding-agent src/cli.ts --help
bun --cwd=packages/coding-agent src/cli.ts --smoke-test
```

빌드:

```sh
bun --cwd=packages/coding-agent run build
```

결과 바이너리:

```text
packages/coding-agent/dist/zz
```

현재 사용자 설치 확인:

```sh
command -v zz
readlink -f "$(command -v zz)"
zz --smoke-test
```

`zz`를 실행하면 현재 저장소 전용 `~/.zz/agent/workflows/<repository-id>/workflow.db`가 필요할 때 자동 생성된다. 이 경로는 기존 설치와의 데이터 호환성을 위해 유지하는 ZZWorkflow 저장 경로다. 예전 전역 `~/.zz/agent/workflow.db`가 있으면 활성 lease가 없을 때 현재 저장소 데이터만 자동 이전한다.

## 3. 변경 전 조사

코드를 쓰기 전에:

1. `rg`와 `rg --files`로 기존 구현·유틸리티·테스트를 찾는다.
2. 관련 package README/DEVELOPMENT와 `docs/` 문서를 읽는다.
3. 외부 API 타입은 `node_modules`의 실제 선언을 확인한다.
4. 생성 파일인지 확인한다.
5. 현재 `git status --short --branch`를 확인해 사용자 변경과 경계를 파악한다.

중앙 유틸리티 우선 탐색 위치:

- `packages/coding-agent/src/utils/`
- `packages/utils`
- `packages/tui`
- 호출부 주변의 domain helper

Git/JJ 호출, 스트림, temp 파일, 이미지, 경로 축약, 문자열 폭, 렌더링 truncate를 새로 복제하지 않는다.

## 4. 구현 규칙

TypeScript:

- `any`를 피하고 실제 타입 이름을 사용한다.
- `ReturnType<>`를 사용하지 않는다.
- 동적 import와 inline type import를 사용하지 않는다.
- class 내부 비공개 상태는 `#field`를 사용한다.
- 새 Promise 제어가 필요하면 `Promise.withResolvers()`를 사용한다.
- index barrel은 가능한 `export * from "./module"`을 사용한다.

Bun:

- 파일은 `Bun.file`, `Bun.write`
- 단순 명령은 Bun Shell
- 장기 실행·streaming·signal 제어는 `Bun.spawn`
- sleep은 `Bun.sleep`
- SQLite는 `bun:sqlite`
- JSON5/JSONL/string width/wrap은 Bun 내장 API 우선

프롬프트:

- `.md` 정적 자산으로 작성한다.
- 동적 필드는 Handlebars를 사용한다.
- 프롬프트 추가 시 실제 행동 계약을 검증하는 테스트를 쓴다. 파일에 문자열이 존재한다는 테스트는 쓰지 않는다.

TUI:

- `console.*`를 사용하지 않는다.
- raw text를 그대로 렌더링하지 않는다.
- live streaming과 transcript rebuild 두 경로를 모두 확인한다.
- 상세 상태줄은 모델, workspace, context/usage 행이 좁은 터미널에서도 의미를 유지해야 한다.

## 5. 생성 파일

직접 수정 금지:

- `packages/catalog/src/models.json`
- tool renderer에서 생성되는 `packages/coding-agent/src/export/html/tool-views.generated.js`
- embed/reset 스크립트가 관리하는 binary/text asset

대표 재생성 명령:

```sh
bun run gen:models
bun run gen:tool-views
bun --cwd=packages/coding-agent run gen:bundle
```

모델 카탈로그 변경은 resolver/descriptor/policy 원본을 먼저 수정한 뒤 생성한다.

## 6. 테스트 전략

가장 좁은 유효 검증부터 시작한다.

```sh
bun test path/to/changed-feature.test.ts
bun --cwd=packages/coding-agent run check:types
```

패키지 검사:

```sh
bun --cwd=packages/coding-agent run check
bun --cwd=packages/collab-web run check
```

루트 검사:

```sh
bun run check:ts
bun run check:rs
bun run test
```

바이너리/worker 계약:

```sh
bun run ci:test:smoke
zz --smoke-test
```

테스트는 관찰 가능한 계약을 방어해야 한다.

- 상태 전이
- 출력/오류 shape
- 실제 failure mapping
- parsing boundary
- workspace snapshot과 evidence freshness
- lease/idempotency/version 충돌

금지:

- `expect(true).toBe(true)`
- 구현 파일을 읽고 특정 소스 문자열을 찾는 테스트
- 전역 module registry를 오염시키는 `mock.module()`
- 다른 테스트까지 남는 `process.env`/`Bun.*` mutation
- 같은 계약을 여러 계층에서 중복 검증

## 7. 변경 유형별 최소 검증

| 변경                  | 최소 검증                                             |
| --------------------- | ----------------------------------------------------- |
| 설정 스키마/migration | settings manager 관련 테스트 + coding-agent types     |
| 프롬프트 합성         | 행동/출력 계약 테스트 + coding-agent types            |
| TUI renderer/status   | component 테스트 + 좁은/넓은 width 사례               |
| tool 등록/삭제        | registry/gallery 테스트 + generated tool views 재생성 |
| worker/빌드           | package build + `zz --smoke-test`                     |
| ZZWorkflow lifecycle  | lifecycle/store 테스트 + recovery 사례                |
| ZZWorkflow SQLite     | transaction/idempotency/local lease 테스트            |
| Hindsight             | strict tag, redaction, outbox, authority 경계 테스트  |
| Rust/native           | 관련 Rust 테스트 + native build                       |
| 설치/alias            | link/profile alias 테스트 + 실제 `command -v zz`      |

## 8. Changelog

사용자에게 보이는 패키지 변경은 해당 `packages/*/CHANGELOG.md`의 `## [Unreleased]` 아래에 기록한다.

절 순서:

1. Breaking Changes
2. Added
3. Changed
4. Fixed
5. Removed

이미 릴리스된 버전 절은 수정하지 않는다.

## 9. 완료 보고

개발 완료 시 다음을 명시한다.

- 무엇이 바뀌었는가
- 사용자 동작이 어떻게 달라지는가
- 어떤 파일/패키지가 핵심인가
- 실행한 테스트·타입 검사·빌드
- 실행하지 못한 검증과 이유
- 기존 환경 의존 실패인지 새 회귀인지
- 커밋/push 여부
