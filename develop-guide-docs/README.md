# ZZ 개발 가이드

이 디렉터리는 ZZ 포크의 정체성, 설계 원칙, 제품 흐름, 내부 아키텍처와 개발 절차를 설명하는
현재 개발 문서 모음이다. 사용자 기능 설명은 `docs/`, 패키지별 공개 설명은 각
`packages/*/README.md`, 에이전트가 항상 따라야 할 규칙은 루트 `AGENTS.md`와 `CLAUDE.md`에 둔다.

문서와 실제 코드가 충돌하면 현재 코드·schema·test를 확인하고 문서를 함께 고친다. 단,
[project-identity.md](project-identity.md), [design-philosophy.md](design-philosophy.md),
[architecture-decisions.md](architecture-decisions.md)의 제품 방향을 바꾸는 변경은 단순 문서 오류로
간주하지 말고 결정 변경 절차를 따른다.

## 현재 문서 지도

| 문서                                                   | 책임                | 먼저 읽어야 하는 상황                                           |
| ------------------------------------------------------ | ------------------- | --------------------------------------------------------------- |
| [project-identity.md](project-identity.md)             | 프로젝트 정체성     | ZZ가 무엇이고 무엇을 하지 않는지 판단할 때                      |
| [design-philosophy.md](design-philosophy.md)           | 설계 철학           | prompt/tool/runtime, 승인, 증거, 기억의 경계를 결정할 때        |
| [product-workflows.md](product-workflows.md)           | 제품 사용 흐름      | 일반 Goal, ZZW, Knowledge의 실제 UX와 명령을 수정할 때          |
| [architecture.md](architecture.md)                     | 시스템 구조         | package 경계, CLI 부팅, 상태 저장 위치를 이해할 때              |
| [architecture-decisions.md](architecture-decisions.md) | 결정 기록           | 채택·폐기된 대안과 변경 이유를 확인할 때                        |
| [controlled-workflow.md](controlled-workflow.md)       | ZZW 구현 계약       | Task/Spec/Plan DAG, 승인, evidence, recovery를 수정할 때        |
| [knowledge-system.md](knowledge-system.md)             | Knowledge 구현 계약 | taxonomy, bank, Hindsight wrapper, outbox, curation을 수정할 때 |
| [engineering-guidelines.md](engineering-guidelines.md) | 구현 품질 기준      | 코드·prompt·TUI·SQLite·test를 설계하고 리뷰할 때                |
| [development-workflow.md](development-workflow.md)     | 실행 절차           | 개발 환경 설치, 구현, 테스트, 빌드, 로컬 설치를 할 때           |
| [upstream-and-release.md](upstream-and-release.md)     | 유지·배포           | upstream을 통합하거나 `Fred-Ko/zz`에 push·release할 때          |

역사 자료:

- [initial-concept-archive.md](initial-concept-archive.md): ZZ 개발을 시작하기 전에 작성한 초기
  아이디어 원문. 현재 명세가 아니며 폐기된 설계도 포함한다.

## 권장 읽기 순서

### 처음 참여하는 개발자

1. [project-identity.md](project-identity.md)
2. [design-philosophy.md](design-philosophy.md)
3. [product-workflows.md](product-workflows.md)
4. [architecture.md](architecture.md)
5. [engineering-guidelines.md](engineering-guidelines.md)
6. [development-workflow.md](development-workflow.md)

### ZZWorkflow를 수정하는 개발자

1. [design-philosophy.md](design-philosophy.md)의 승인·Plan·evidence 원칙
2. [product-workflows.md](product-workflows.md)의 ZZW 사용자 흐름
3. [controlled-workflow.md](controlled-workflow.md)의 상태와 API 계약
4. [engineering-guidelines.md](engineering-guidelines.md)의 schema/persistence/test 규칙

### ZZ Knowledge를 수정하는 개발자

1. [design-philosophy.md](design-philosophy.md)의 현재 사실/장기 지식 분리
2. [product-workflows.md](product-workflows.md)의 explicit retain/recall 흐름
3. [knowledge-system.md](knowledge-system.md)의 taxonomy·bank·outbox 계약
4. [architecture-decisions.md](architecture-decisions.md)의 D-011~D-018

공개·package 세부 문서 중 자주 함께 보는 항목:

- `packages/coding-agent/DEVELOPMENT.md`: coding-agent 소스 지도
- `docs/local-workflow.md`: 내장 로컬 workflow와 Hindsight 사용자 설정
- `docs/knowledge.md`: ZZ Knowledge 사용자 설정과 작동 정책
- `docs/context-files.md`: `.zz`, 규칙, 프롬프트 탐색
- `docs/system-prompt-customization.md`: 시스템 프롬프트 합성
- `docs/custom-tools.md`: 도구 등록과 실행
- `docs/lsp-config.md`: LSP 탐색과 서버 설정
- `docs/settings.md`: 설정 스키마와 저장

## 첫날 체크리스트

1. Bun 버전을 확인한다.

   ```sh
   bun --version
   ```

   루트 `package.json`의 `packageManager`와 각 패키지의 `engines.bun`을 기준으로 한다.

2. 의존성과 네이티브 모듈, 로컬 명령 링크를 준비한다.

   ```sh
   bun run setup
   ```

3. 설치 경로를 확인한다.

   ```sh
   command -v zz
   readlink -f "$(command -v zz)"
   zz --version
   zz --smoke-test
   ```

4. 소스 모드로 실행해 설치된 바이너리와 구분한다.

   ```sh
   bun run dev
   ```

5. 기본 검증을 실행한다.

   ```sh
   bun --cwd=packages/coding-agent run check:types
   bun test path/to/relevant.test.ts
   ```

6. Git 원격을 확인한다.

   ```sh
   git remote -v
   git branch -vv
   ```

   권장 구조는 `origin = can1357/oh-my-pi`, `fork = Fred-Ko/zz`다.

## 저장소의 개발 원칙

- 공개 이름은 ZZ지만 upstream 호환용 `@oh-my-pi/*`, `PI_*`, 일부 `OMP_*`, `__omp_worker_*`는 호환성 검토 없이 일괄 변경하지 않는다.
- 기본 작업 대상은 `packages/coding-agent/`다.
- 일반 대화와 원본 `/goal`, `/guided-goal`은 ZZW opt-in 흐름과 분리한다.
- 프롬프트는 TypeScript 문자열이 아니라 정적 Markdown과 Handlebars로 관리한다.
- 현재 사실은 Git·SQLite Registry·Evidence가 소유한다. 모델 프롬프트나 ZZ Knowledge/Hindsight가 소유하지 않는다.
- 모든 RDB 저장은 `bun:sqlite`를 우선한다.
- upstream OMP Memory를 다시 가져오거나 ZZ Knowledge를 그 위에 구축하지 않는다.
- 로컬 변경이 있는 상태를 정상 상태로 취급한다. 다른 작업자의 변경을 정리 대상으로 보지 않는다.
- 구현 후에는 변경 위험에 맞는 계약 수준 테스트와 타입 검사를 실행한다.

## 문서 유지 규칙

- `AGENTS.md`와 `CLAUDE.md`는 항상 바이트 단위로 동일해야 한다.
- 새 개발 문서는 이 디렉터리에 둔다.
- 기존 동작을 설명하는 공개 문서는 `docs/`에서 갱신한다.
- 명령어는 실제 `package.json` 스크립트와 대조한 뒤 기록한다.
- 이미 릴리스된 changelog 절은 수정하지 않는다.
- 구조가 달라졌다면 코드 변경과 같은 커밋에서 관련 문서 링크를 갱신한다.
- 현재 문서의 파일명에는 `current`, `new`, `custom` 같은 임시 표현을 쓰지 않는다.
- 역사 문서는 문서 상단에 비권위 상태와 현재 대체 문서 링크를 표시한다.
- 같은 규칙을 여러 문서에 복사하기보다 canonical 문서를 링크하고 각 문서는 자기 책임만 상세히 설명한다.
