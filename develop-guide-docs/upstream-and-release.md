# Upstream 동기화와 릴리스

## 1. 원격 구조

권장 원격:

```text
origin  https://github.com/can1357/oh-my-pi.git  # upstream
fork    https://github.com/Fred-Ko/zz.git        # ZZ 포크
```

확인:

```sh
git remote -v
git branch -vv
```

로컬 `main`은 upstream 변경을 쉽게 받도록 `origin/main`을 추적한다. 포크에는 명시적으로 push한다.

```sh
git branch --set-upstream-to=origin/main main
git push fork main
```

## 2. 동기화 전

```sh
git status --short --branch
git fetch origin --prune --tags
git log --oneline --decorate --graph --max-count=20 --all
```

확인할 것:

- tracked/untracked 변경
- staged 변경 유무
- 현재 branch
- origin과 fork URL
- upstream이 건드린 파일과 로컬 변경의 교집합

사용자 변경을 임의로 버리지 않는다. `git reset --hard`, broad checkout, clean을 사용하지 않는다.

## 3. 깨끗한 worktree

로컬 commit이 없고 fast-forward 가능한 경우:

```sh
git pull --ff-only origin main
```

로컬 commit이 있다면 merge/rebase 정책을 먼저 정한다. 공개된 포크 commit을 임의 rebase/force-push하지 않는다.

## 4. dirty worktree

일반 pull을 먼저 시도하면 Git이 겹치는 파일을 알려준다. 로컬 변경을 보존해 통합할 때:

```sh
git pull --rebase --autostash origin main
```

주의:

- autostash 적용 충돌 시 stash는 자동으로 남는다.
- untracked 파일은 autostash 범위가 아닐 수 있다.
- 충돌 해결 후 원래 staged/unstaged 상태도 복원해야 한다.
- 자동 stash를 삭제하기 전 worktree에 모든 변경이 복원됐는지 검증한다.

충돌 파일:

```sh
git diff --name-only --diff-filter=U
git ls-files -u
```

충돌 해결 원칙:

- upstream의 새 버전/API와 ZZ의 의도된 변경을 둘 다 이해한다.
- 한쪽 파일 전체를 무조건 선택하지 않는다.
- package version bump와 로컬 description 변경처럼 독립적인 변경은 함께 보존한다.
- conflict marker가 없는지 확인한다.
- 타입 검사와 관련 테스트를 다시 실행한다.

## 5. Fork push

push 전:

```sh
git diff --check
git status --short
git log -1 --format=fuller
```

제품 코드와 무관한 demo, local DB, 개인 설정, 작업 입력 문서는 제외한다. secret/token/private key가 새 diff에 추가되지 않았는지 확인한다.

사용자가 commit/push를 요청했을 때만:

```sh
git push fork main
```

검증:

```sh
git ls-remote fork refs/heads/main
gh api repos/Fred-Ko/zz/commits/main --jq '{sha: .sha, message: .commit.message, html_url: .html_url}'
```

## 6. Upstream 호환성

ZZ는 공개 브랜드를 바꾸지만 upstream 변경을 계속 흡수한다.

유지할 수 있는 항목:

- npm package scope `@oh-my-pi/*`
- upstream issue/PR 링크
- wire/protocol의 기존 이름
- hidden worker selector
- legacy environment variable fallback
- 이미 릴리스된 changelog의 역사적 OMP 표현

새 사용자-facing 항목:

- 명령 `zz`
- 설정 루트 `~/.zz`
- 프로젝트 설정 `.zz/`
- fork 링크 `Fred-Ko/zz`
- 새 문서와 오류 메시지의 ZZ 표현

일괄 문자열 치환은 protocol, package resolution, release automation을 깨뜨릴 수 있다. 변경은 소비자와 테스트를 함께 추적한다.

## 7. 릴리스 준비

릴리스 전:

1. 영향받은 각 패키지 `CHANGELOG.md`의 `[Unreleased]` 확인
2. package version과 workspace catalog 정합성 확인
3. `bun install` 후 lockfile 확인
4. 타입·lint·테스트·smoke 실행
5. compiled `dist/zz` 확인
6. 설치 방식 smoke 확인
7. 원격과 GitHub 인증 계정 확인

릴리스 명령:

```sh
bun run release
```

이 명령은 버전, changelog, commit, tag, publish를 변경하는 고위험 작업이다. 사용자가 명시적으로 릴리스를 요청한 경우에만 실행한다.

## 8. 현재 포크에서 특히 확인할 회귀

- upstream 업데이트가 `zz`를 다시 `omp`로 노출하지 않는가
- default config root가 `.zz`로 유지되는가
- `gpt-5.6-sol`, `gpt-5.6-terra` catalog/discovery가 유지되는가
- 다중 행 상태줄에 모델명이 계속 표시되는가
- 기본 대화 언어가 한국어인가
- 자동 QA 도구/설정/UI가 재유입되지 않았는가
- workflow lifecycle과 coordinator가 type/schema 변경을 흡수했는가
- Hindsight가 authoritative state처럼 주입되지 않는가
- `zz --smoke-test`가 worker와 tiny subprocess를 통과하는가
