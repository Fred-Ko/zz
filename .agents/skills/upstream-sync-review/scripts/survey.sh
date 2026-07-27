#!/usr/bin/env bash
# Upstream sync survey — READ ONLY.
# Remote-tracking refs are updated narrowly; the worktree and index are not changed.

set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-origin}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
FORK_REMOTE="${FORK_REMOTE:-fork}"
FORK_BRANCH="${FORK_BRANCH:-main}"
MAX_COMMITS="${MAX_COMMITS:-80}"
UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
FORK_REF="${FORK_REMOTE}/${FORK_BRANCH}"

cd "$(git rev-parse --show-toplevel)" || exit 1

hr() { printf '\n══ %s\n' "$1"; }

show_bounded_log() {
	local range="$1"
	local count
	count=$(git rev-list --count "$range")
	printf '총 %s개\n' "$count"
	if [ "$count" -eq 0 ]; then
		return
	fi
	if [ "$count" -le "$MAX_COMMITS" ]; then
		git log --oneline --reverse "$range"
		return
	fi
	local half=$((MAX_COMMITS / 2))
	git log --oneline --reverse "$range" | head -n "$half"
	printf '... %s개 생략 ...\n' "$((count - MAX_COMMITS))"
	git log --oneline "$range" | head -n "$half" | tac
}

hr "원격"
git remote -v

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
	printf '\n오류: upstream 원격 %s가 없습니다.\n' "$UPSTREAM_REMOTE" >&2
	exit 1
fi
if ! git remote get-url "$FORK_REMOTE" >/dev/null 2>&1; then
	printf '\n오류: fork 원격 %s가 없습니다.\n' "$FORK_REMOTE" >&2
	exit 1
fi

hr "현재 브랜치 / worktree 상태"
git status --short --branch | head -1
git worktree list

hr "로컬 변경 집계"
status=$(git status --porcelain)
if [ -z "$status" ]; then
	echo "없음"
else
	printf '%s\n' "$status" | cut -c1-2 | sort | uniq -c
fi

hr "untracked (stash/autostash 범위 밖)"
untracked=$(printf '%s\n' "$status" | awk '$1=="??"{print $2}')
if [ -z "$untracked" ]; then
	echo "없음"
else
	printf '%s\n' "$untracked"
	printf '\n총 %s 항목 — 통합 전 사용자에게 반드시 알린다.\n' "$(printf '%s\n' "$untracked" | wc -l | tr -d ' ')"
fi

if [ "${NO_FETCH:-0}" != "1" ]; then
	hr "원격 main refs 갱신"
	git fetch "$UPSTREAM_REMOTE" "+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/${UPSTREAM_REF}" --prune --tags --quiet || exit 1
	git fetch "$FORK_REMOTE" "+refs/heads/${FORK_BRANCH}:refs/remotes/${FORK_REF}" --quiet || exit 1
	echo "${UPSTREAM_REF}, ${FORK_REF} 갱신 완료"
fi

for ref in "$UPSTREAM_REF" "$FORK_REF"; do
	if ! git rev-parse --verify --quiet "$ref" >/dev/null; then
		printf '\n오류: %s를 찾을 수 없습니다. 원격/branch 설정을 확인하세요.\n' "$ref" >&2
		exit 1
	fi
done

hr "분기 상태"
printf '%-32s %s\n' "${UPSTREAM_REF}...HEAD (좌/우)" "$(git rev-list --left-right --count "${UPSTREAM_REF}...HEAD")"
if git rev-parse --verify --quiet main >/dev/null; then
	printf '%-32s %s\n' "${FORK_REF}...main (좌/우)" "$(git rev-list --left-right --count "${FORK_REF}...main")"
fi

hr "upstream 신규 커밋 (오래된 것부터)"
count=$(git rev-list --count "HEAD..${UPSTREAM_REF}")
show_bounded_log "HEAD..${UPSTREAM_REF}"

hr "ZZ 고유 커밋"
show_bounded_log "${UPSTREAM_REF}..HEAD"

hr "새 태그 (upstream 최신 5개)"
git tag --sort=-creatordate --merged "$UPSTREAM_REF" | head -5

if [ "$count" -eq 0 ]; then
	printf '\nupstream 신규 커밋 없음. 조사 종료.\n'
	exit 0
fi

merge_base=$(git merge-base HEAD "$UPSTREAM_REF")
hr "공통 merge-base"
git show --no-patch --oneline "$merge_base"

hr "upstream이 건드린 경로 — 디렉토리별 집계"
git diff --name-only "${merge_base}..${UPSTREAM_REF}" |
	awk -F/ '{ if ($1=="packages" || $1=="crates") print $1"/"$2; else if (NF>1) print $1; else print "(root) "$0 }' |
	sort | uniq -c | sort -rn

hr "버킷 B 후보 — 제거된 서브시스템 재유입 위험"
bucket_b=$(git diff --name-only "${merge_base}..${UPSTREAM_REF}" | rg \
	-e '^packages/mnemopi/' \
	-e '^packages/coding-agent/src/(memory-backend|memories|mnemopi|hindsight|autolearn)/' \
	-e '^packages/coding-agent/src/tools/(memory-.*|learn)\.ts$' \
	-e '^packages/coding-agent/src/internal-urls/memory-protocol\.ts$' \
	-e '^packages/collab-web/src/tool-render/tools/memory-.*\.tsx$' \
	-e '^crates/pi-natives/src/vectors\.rs$' || true)
[ -n "$bucket_b" ] && printf '%s\n' "$bucket_b" || echo "없음"

hr "버킷 C 후보 — commit된 ZZ 변경과 upstream 변경의 경로 교집합"
committed_overlap=$(
	comm -12 \
		<(git diff --name-only "${merge_base}..HEAD" | sort -u) \
		<(git diff --name-only "${merge_base}..${UPSTREAM_REF}" | sort -u)
)
if [ -z "$committed_overlap" ]; then
	echo "없음"
else
	printf '%s\n' "$committed_overlap"
	printf '\n총 %s 파일\n' "$(printf '%s\n' "$committed_overlap" | wc -l | tr -d ' ')"
fi

hr "현재 dirty tracked 파일과 upstream 변경의 교집합"
dirty_overlap=$(
	comm -12 \
		<(git diff --name-only "${merge_base}..${UPSTREAM_REF}" | sort -u) \
		<(printf '%s\n' "$status" | awk '$1!="??"{print $NF}' | sort -u)
)
[ -n "$dirty_overlap" ] && printf '%s\n' "$dirty_overlap" || echo "없음"

hr "리브랜딩 회귀 후보 — upstream 추가 행의 이전 공개 식별자"
# 제외: package/wire/runner 호환 식별자와 이미 릴리스된 changelog의 역사적 표현.
brand_hits=$(git diff "${merge_base}..${UPSTREAM_REF}" -- README.md docs scripts packages/coding-agent/src packages/utils/src .github 2>/dev/null |
	rg '^\+' | rg '\bomp\b|\.omp/|~/\.omp|link-omp|scripts/omp' |
	rg -v '@oh-my-pi/|__omp_worker_|omp-stats|omp-kata|CHANGELOG|my\.omp\.sh|application/x-omp|omp-tool-view' |
	head -40 || true)
[ -n "$brand_hits" ] && printf '%s\n' "$brand_hits" || echo "없음"

hr "버킷 D — 버전/changelog/lockfile"
bucket_d=$(git diff --name-only "${merge_base}..${UPSTREAM_REF}" | rg 'CHANGELOG\.md$|package\.json$|bun\.lock$' | head -40 || true)
[ -n "$bucket_d" ] && printf '%s\n' "$bucket_d" || echo "없음"

printf '\n══ 조사 완료. 범위와 방식을 승인받은 뒤 전용 integration worktree에서 통합하세요.\n'
