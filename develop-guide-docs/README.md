# ZZ 개발 가이드

이 디렉터리는 ZZ 포크를 지속적으로 개발하기 위한 내부 개발 문서 모음이다. 사용자 기능 설명은 `docs/`, 패키지별 공개 설명은 각 `packages/*/README.md`, 에이전트가 항상 따라야 할 규칙은 루트 `AGENTS.md`와 `CLAUDE.md`에 둔다.

## 문서 지도

| 문서                                               | 먼저 읽어야 하는 상황                                  |
| -------------------------------------------------- | ------------------------------------------------------ |
| [architecture.md](architecture.md)                 | 패키지 경계, CLI 부팅 과정, 상태 저장 위치를 이해할 때 |
| [development-workflow.md](development-workflow.md) | 개발 환경 설치, 구현, 테스트, 빌드, 로컬 설치를 할 때  |
| [controlled-workflow.md](controlled-workflow.md)   | ZZWorkflow(ZZW), Plan DAG, 로컬 SQLite 복구, Hindsight를 수정할 때 |
| [knowledge-system.md](knowledge-system.md)         | ZZ Knowledge 정책, Hindsight wrapper, outbox와 mental model을 수정할 때 |
| [upstream-and-release.md](upstream-and-release.md) | upstream을 당기거나 `Fred-Ko/zz`에 push·release할 때   |

기존 세부 문서 중 자주 함께 보는 항목:

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
- 프롬프트는 TypeScript 문자열이 아니라 정적 Markdown과 Handlebars로 관리한다.
- 현재 사실은 Git·SQLite Registry·Evidence가 소유한다. 모델 프롬프트나 ZZ Knowledge/Hindsight가 소유하지 않는다.
- 모든 RDB 저장은 `bun:sqlite`를 우선한다.
- 로컬 변경이 있는 상태를 정상 상태로 취급한다. 다른 작업자의 변경을 정리 대상으로 보지 않는다.
- 구현 후에는 변경 위험에 맞는 계약 수준 테스트와 타입 검사를 실행한다.

## 문서 유지 규칙

- `AGENTS.md`와 `CLAUDE.md`는 항상 바이트 단위로 동일해야 한다.
- 새 개발 문서는 이 디렉터리에 둔다.
- 기존 동작을 설명하는 공개 문서는 `docs/`에서 갱신한다.
- 명령어는 실제 `package.json` 스크립트와 대조한 뒤 기록한다.
- 이미 릴리스된 changelog 절은 수정하지 않는다.
- 구조가 달라졌다면 코드 변경과 같은 커밋에서 관련 문서 링크를 갱신한다.
