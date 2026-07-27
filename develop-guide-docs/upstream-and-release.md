# Upstream 동기화와 릴리스

> **문서 상태: 현재 · fork 유지와 배포 절차**

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
bash .agents/skills/upstream-sync-review/scripts/survey.sh
```

확인할 것:

- tracked/untracked 변경
- staged 변경 유무
- 현재 branch
- origin과 fork URL
- 공통 merge-base 이후 upstream 변경과 ZZ 고유 commit 변경의 교집합
- upstream 변경과 현재 dirty tracked 파일의 교집합

사용자 변경을 임의로 버리지 않는다. `git reset --hard`, broad checkout, clean을 사용하지 않는다.

## 3. 전용 integration worktree

공개된 ZZ 이력은 rebase/force-push하지 않는다. 기본 통합은 로컬 `main`에서 별도 worktree를 만들고 upstream을 no-commit merge하는 방식이다.

```sh
git rev-list --left-right --count fork/main...main
git worktree add -b integration/upstream-v<version> .worktrees/upstream-v<version> main
cd .worktrees/upstream-v<version>
git merge --no-commit --no-ff origin/main
```

이 방식은 dirty `main`과 untracked 프로젝트를 보존하고, 검증 전 commit을 막으며, 최종 merge commit에 upstream parent를 남겨 다음 동기화의 diff를 줄인다. `fork/main`에만 commit이 있으면 원격 변경을 먼저 조사한다. 기존 integration branch/worktree는 임의 삭제하지 않는다.

## 4. 충돌 해결과 검증

충돌 파일:

```sh
git diff --name-only --diff-filter=U
git ls-files -u
```

통합 경계 검사:

```sh
bash .agents/skills/upstream-sync-review/scripts/verify.sh --pre-commit
bun run check:ts
env -u RUSTUP_TOOLCHAIN bun check
ZZ_TEST_CONCURRENCY=4 bun run test:ts
```

충돌 해결 원칙:

- upstream의 새 버전/API와 ZZ의 의도된 변경을 둘 다 이해한다.
- 한쪽 파일 전체를 무조건 선택하지 않는다.
- package version bump와 로컬 description 변경처럼 독립적인 변경은 함께 보존한다.
- conflict marker가 없는지 확인한다.
- 타입 검사와 관련 테스트를 다시 실행한다.
- upstream Goal/Todo와 ZZW lifecycle, upstream memory와 ZZ Knowledge를 하나로 섞지 않는다.
- build/worker/설치 경로가 바뀌면 `bun run build`, native build, `zz --smoke-test`를 추가한다.

## 5. Fork push

통합 승인, commit 승인, push 승인은 별도다. 검증된 no-commit merge를 먼저 보고하고 commit 승인을 받는다.

```sh
git commit -m "Merge upstream v<version> into ZZ"
git show --no-patch --format='%H%n%P%n%s' HEAD
bash .agents/skills/upstream-sync-review/scripts/verify.sh --post-commit
```

제품 코드와 무관한 demo, local DB, 개인 설정, 작업 입력 문서는 제외한다. secret/token/private key가 새 diff에 추가되지 않았는지 확인한다.

사용자가 commit/push를 요청했을 때만:

```sh
git fetch fork '+refs/heads/main:refs/remotes/fork/main'
git merge-base --is-ancestor fork/main HEAD
git push fork HEAD:main
```

검증:

```sh
git ls-remote fork refs/heads/main
gh api repos/Fred-Ko/zz/commits/main --jq '{sha: .sha, message: .commit.message, html_url: .html_url}'
```

기본 worktree의 local `main`은 tracked 변경이 없고 untracked 경로 충돌이 없을 때만 `git merge --ff-only <merge-commit>`으로 맞춘다. 통합 worktree와 branch는 자동 삭제하지 않는다.

## 6. Upstream 호환성

ZZ는 공개 브랜드를 바꾸지만 upstream 변경을 계속 흡수한다.

유지할 수 있는 항목:

- npm package scope `@oh-my-pi/*`
- upstream issue/PR 링크
- wire/protocol의 기존 이름
- hidden worker selector
- legacy environment variable fallback
- 이미 릴리스된 changelog의 역사적 upstream 제품 표현

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

- upstream 업데이트가 `zz`를 레거시 실행 이름으로 다시 노출하지 않는가
- default config root가 `.zz`로 유지되는가
- `gpt-5.6-sol`, `gpt-5.6-terra` catalog/discovery가 유지되는가
- 다중 행 상태줄에 모델명이 계속 표시되는가
- 기본 대화 언어가 한국어인가
- 자동 QA 도구/설정/UI가 재유입되지 않았는가
- 원본 `/goal`, `/guided-goal`에 ZZW gate가 다시 결합되지 않았는가
- 내장 ZZW lifecycle/SQLite store가 upstream type·schema 변경을 흡수했는가
- 별도 `workflowd`나 coordinator 의존성이 다시 생기지 않았는가
- 제거한 upstream memory, Mnemopi, `memory://`, transcript auto-retain이 재유입되지 않았는가
- ZZ Knowledge가 독립 wrapper와 Global/Repository Bank 경계를 유지하는가
- Hindsight가 authoritative state처럼 주입되지 않는가
- `zz --smoke-test`가 worker와 tiny subprocess를 통과하는가
