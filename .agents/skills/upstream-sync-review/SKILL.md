---
name: upstream-sync-review
description: upstream(can1357/oh-my-pi)의 새 커밋을 조사해 ZZ 포크에 반영할지 사용자에게 묻고, 승인된 범위만 통합한다. upstream 동기화, fetch 후 변경 검토, "업스트림 뭐 바뀌었어", 새 릴리스 반영, 포크와 upstream 차이 확인, 제거한 memory 서브시스템의 재유입 점검이 필요할 때 사용한다. 조사 단계는 읽기 전용이고, 사용자 승인 없이 merge/rebase/commit/push하지 않는다.
---

# Upstream Sync Review

upstream `can1357/oh-my-pi`의 변화를 조사해 **분류하고, 사용자에게 반영 여부를 물은 뒤, 승인된 범위만** 통합한다.

이 저장소는 upstream을 단순 추종하지 않는다. ZZ는 upstream 기능 일부를 **의도적으로 제거**했고, 제품 코드 전반에 리브랜딩을 적용했다. 그래서 "upstream 최신으로 맞추기"는 이 저장소에서 항상 틀린 기본값이다. 무엇을 받고 무엇을 거를지가 이 스킬의 전부다.

## 불변 규칙

이 규칙은 사용자가 명시적으로 뒤집지 않는 한 유지한다.

- **조사(1~2단계)는 읽기 전용.** worktree를 바꾸는 명령을 쓰지 않는다.
- **3단계 승인 전에 통합하지 않는다.** merge, rebase, pull, cherry-pick, checkout 모두 승인 이후다.
- `git reset --hard`, `git clean`, broad `git checkout -- .`, `git stash drop`을 쓰지 않는다. 사용자의 dirty worktree는 보존 대상이다.
- **commit / push / PR / 태그 / publish는 사용자가 그 외부 동작을 명시적으로 요청했을 때만** 한다. 통합 승인은 commit 승인이 아니다.
- 권한 상승은 `pkexec`. `sudo`를 쓰지 않는다.
- 실행한 검증과 실행하지 않은 검증을 구분해 보고한다. 기존 환경 실패와 새 실패를 섞지 않는다.

## 사전 전제

원격 이름을 먼저 확인한다. 이 저장소의 규약은 아래이고, 다르면 사용자에게 확인한 뒤 진행한다.

| 원격 | URL | 의미 |
| --- | --- | --- |
| `origin` | `https://github.com/can1357/oh-my-pi.git` | upstream |
| `fork` | `https://github.com/Fred-Ko/zz.git` | ZZ 포크 |

`origin`이 upstream이라는 점이 핵심이다. `upstream`이라는 이름의 원격은 없다.

## 1단계 — 상태 조사 (읽기 전용)

`scripts/survey.sh`가 이 단계를 수행한다. 스크립트는 읽기 전용 git 명령만 실행한다.

```sh
bash .agents/skills/upstream-sync-review/scripts/survey.sh
```

스크립트를 쓰지 않는다면 최소 아래를 직접 확인한다.

```sh
git remote -v
git status --short --branch
git fetch origin --prune --tags
git rev-list --left-right --count origin/main...HEAD
git log --oneline --reverse HEAD..origin/main
git diff --name-only HEAD...origin/main
```

수집할 것:

- upstream 신규 커밋 목록과 각 커밋이 건드린 경로
- 로컬 tracked 변경(`M`/`D`)과 **untracked(`??`)** 목록
- upstream이 건드린 파일과 로컬 변경 파일의 **교집합** — 충돌 예상 지점
- 새 태그/버전 bump 유무

### untracked 파일을 반드시 따로 센다

ZZ Knowledge를 포함한 핵심 신규 코드가 아직 untracked 상태로 존재할 수 있다. `git stash`와 `--autostash`는 **untracked를 범위에 넣지 않는다.** 이걸 놓치면 통합 도중 소실될 수 있다.

```sh
git status --porcelain | awk '$1=="??"{print $2}'
```

untracked 항목이 있으면 3단계 질문에서 그 사실을 먼저 알린다.

## 2단계 — 변화 분류

upstream 커밋을 **경로 기준**으로 4개 버킷에 넣는다. 커밋 제목만 보고 판단하지 않는다. 반드시 변경 경로를 본다.

### 버킷 A — 무관 (기본: 받는다)

ZZ가 건드리지 않은 영역. 예: `packages/ai`, `packages/tui`, `packages/natives`, `crates/`, catalog 모델 갱신, upstream 버그 수정.

### 버킷 B — 제거된 서브시스템 (기본: 받지 않는다)

ZZ가 삭제한 영역을 건드리는 커밋. 받으면 삭제한 기능이 되살아난다.

```text
packages/mnemopi/                          ← 패키지 통째로 삭제됨
packages/coding-agent/src/memory-backend/
packages/coding-agent/src/memories/
packages/coding-agent/src/mnemopi/
packages/coding-agent/src/hindsight/       ← knowledge/hindsight-client.ts로 재작성됨
packages/coding-agent/src/autolearn/
packages/coding-agent/src/tools/memory-*.ts
packages/coding-agent/src/tools/learn.ts
packages/coding-agent/src/internal-urls/memory-protocol.ts
packages/collab-web/src/tool-render/tools/memory-*.tsx
crates/pi-natives/src/vectors.rs
```

CLAUDE.md가 재도입을 금지한 항목도 이 버킷이다 — 자동 QA 리포팅(`report_tool_issue`, `xd://report_issue`, grievance 저장/push, consent UI), OMP Memory / Mnemopi / transcript auto-retain·auto-recall / `memory://` / `/memory` / 레거시 memory 툴.

이 버킷의 커밋은 **파일이 이미 없으므로 merge에서 조용히 되살아날 수 있다.** 통합 후 삭제 상태가 유지됐는지 반드시 재확인한다(4단계 검증 참조).

### 버킷 C — 충돌 예상 (기본: 개별 판단)

ZZ가 수정한 파일을 upstream도 건드린 경우. 대표 지점:

- **리브랜딩** — `omp` → `zz`, `~/.omp` → `~/.zz`, `.omp/` → `.zz/`. upstream이 이 문자열을 다시 넣는다.
- **ZZ Knowledge** — `packages/coding-agent/src/knowledge/`, `src/tools/knowledge-*.ts`, `src/prompts/knowledge/`
- **Controlled Workflow** — `packages/coding-agent/src/workflow/`, `src/goals/`(특히 `task-lifecycle.ts`, `goal-tool.ts`, `guided-setup.ts`)
- **기본 언어** — `src/prompts/system/default-language.md` 및 시스템 프롬프트 조립부
- `sdk.ts`, `session/`, `slash-commands/builtin-registry.ts`, `config/settings-schema.ts` — 양쪽이 모두 자주 건드리는 대형 파일

### 버킷 D — 릴리스/버전

`chore: bump version`, changelog 정리, lockfile. 릴리스 정책과 얽히므로 별도로 묻는다. 이미 릴리스된 changelog 섹션은 immutable이다.

### 보고 형식

사용자에게 버킷별로 **커밋 수 + 대표 커밋 + 왜 그 버킷인지**를 요약한다. 커밋 전량을 나열하지 않는다. 버킷 B와 C는 근거가 되는 경로를 함께 제시한다.

## 3단계 — 사용자에게 묻는다

**여기서 멈춘다.** 조사 결과를 보고하고 승인을 받는다. 최소 두 가지를 묻는다.

1. **범위** — 전량 통합 / 버킷 A만 / 특정 커밋만 cherry-pick / 이번엔 보고만
2. **방식** — merge / rebase / cherry-pick

untracked 신규 코드가 있으면 그 사실과 위험(autostash 미포함)을 질문에 함께 담는다.

버킷 B에 해당하는 커밋이 있으면 **"제거한 기능이 되살아난다"는 점을 명시**하고, 기본 권고는 "받지 않음"으로 제시한다.

사용자가 우려를 듣고도 원래 요청을 반복하면 그 결정을 따르고 진행한다.

## 4단계 — 통합

승인된 범위만 적용한다.

### 방식별

로컬 커밋이 없고 fast-forward 가능:

```sh
git pull --ff-only origin main
```

로컬 커밋이 있고 dirty:

```sh
git pull --rebase --autostash origin main
```

특정 커밋만:

```sh
git cherry-pick <sha>
```

`--autostash`를 쓸 때 주의:

- untracked는 stash되지 않는다. 이미 3단계에서 알렸어야 한다.
- 충돌 시 stash가 남는다. **worktree에 모든 변경이 복원됐는지 검증한 뒤에만** stash를 정리한다. 검증 전 `stash drop` 금지.
- 원래의 staged/unstaged 구분도 복원해야 한다.

### 충돌 해결

```sh
git diff --name-only --diff-filter=U
git ls-files -u
```

원칙:

- 한쪽 파일 전체를 무조건 채택하지 않는다. upstream의 새 API와 ZZ의 의도된 변경을 **둘 다** 이해하고 합친다.
- 독립적인 변경은 함께 보존한다 (예: upstream의 version bump + ZZ의 description 변경).
- 리브랜딩 충돌은 ZZ 쪽을 택하되, **upstream 호환을 위해 유지해야 하는 식별자는 건드리지 않는다** — `@oh-my-pi/*` 패키지 스코프, `__omp_worker_*` 워커 셀렉터, 레거시 환경변수 fallback, wire/protocol 필드명, 이미 릴리스된 changelog의 OMP 표현, upstream issue/PR 링크.
- 일괄 문자열 치환을 하지 않는다. protocol·패키지 해석·릴리스 자동화를 깨뜨린다.
- conflict marker가 남지 않았는지 확인한다: `git diff --check`

### 통합 후 검증

```sh
bun check
```

`tsc`/`npx tsc`를 쓰지 않는다.

영향 범위에 비례해 테스트를 확장한다. 워커/엔트리포인트가 얽혔으면:

```sh
zz --smoke-test
```

**회귀 체크리스트** — upstream 통합이 ZZ의 의도를 되돌리지 않았는지 확인한다.

- 버킷 B 경로가 여전히 삭제 상태인가 (merge가 되살리지 않았는가)
- `zz`가 다시 `omp`로 노출되지 않는가
- default config root가 `.zz`로 유지되는가
- 기본 대화 언어가 한국어인가
- 자동 QA 도구/설정/UI가 재유입되지 않았는가
- Hindsight가 authoritative state처럼 주입되지 않는가 (advisory여야 한다)
- workflow lifecycle과 goals가 upstream type/schema 변경을 흡수했는가
- `gpt-5.6-sol`, `gpt-5.6-terra` catalog/discovery가 유지되는가
- 다중 행 상태줄에 모델명이 계속 표시되는가
- untracked였던 신규 코드가 전부 그대로 있는가

버킷 B 재유입 확인은 경로 존재 여부로 직접 검사한다.

```sh
for p in packages/mnemopi packages/coding-agent/src/memory-backend \
         packages/coding-agent/src/memories packages/coding-agent/src/mnemopi \
         packages/coding-agent/src/hindsight packages/coding-agent/src/autolearn; do
  [ -e "$p" ] && echo "재유입: $p"
done
```

## 5단계 — 보고

- 통합한 커밋과 **거른 커밋**을 각각 밝힌다. 거른 이유를 함께 쓴다.
- 해결한 충돌과 그 판단 근거를 요약한다.
- 실행한 검증과 결과를 그대로 보고한다. 실패했으면 출력과 함께 실패라고 말한다.
- 남은 작업(미해결 충돌, 스킵한 커밋, 미실행 검증)을 명시한다.
- commit/push는 사용자가 요청하지 않았으면 하지 않고, "커밋하지 않았다"고 밝힌다.

## 조사만 요청받은 경우

"업스트림 뭐 바뀌었어" 류의 질문이면 1~2단계만 수행하고 보고한다. 3단계 질문을 억지로 붙이지 않는다. 대신 반영을 원하면 이 스킬로 이어서 진행할 수 있다고 한 줄 덧붙인다.

## 관련 문서

- `develop-guide-docs/upstream-and-release.md` — 동기화·릴리스 정책 원본
- `CLAUDE.md` / `AGENTS.md` — 재도입 금지 항목, 에이전트 운영 규칙
- `develop-guide-docs/knowledge-system.md` — ZZ Knowledge 경계
- `develop-guide-docs/controlled-workflow.md` — workflow/goals 경계
