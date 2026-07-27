#!/usr/bin/env bash
# Upstream sync survey — READ ONLY.
#
# upstream(origin/main)과 현재 worktree의 차이를 조사해 버킷 분류 재료를 출력한다.
# worktree를 변경하는 명령은 실행하지 않는다. fetch는 원격 추적 ref만 갱신한다.
#
# 사용법:
#   bash .agents/skills/upstream-sync-review/scripts/survey.sh
#   NO_FETCH=1 bash .../survey.sh     # fetch 없이 캐시된 origin/main 사용

set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-origin}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"

cd "$(git rev-parse --show-toplevel)" || exit 1

hr() { printf '\n══ %s\n' "$1"; }

hr "원격"
git remote -v

hr "현재 브랜치 / worktree 상태"
git status --short --branch | head -1
git worktree list

hr "로컬 변경 집계"
git status --porcelain | cut -c1-2 | sort | uniq -c

hr "untracked (?? — stash/autostash 범위 밖. 소실 위험)"
untracked=$(git status --porcelain | awk '$1=="??"{print $2}')
if [ -z "$untracked" ]; then
	echo "없음"
else
	printf '%s\n' "$untracked"
	printf '\n총 %s 항목 — 통합 전 사용자에게 반드시 알린다.\n' "$(printf '%s\n' "$untracked" | wc -l | tr -d ' ')"
fi

if [ "${NO_FETCH:-0}" != "1" ]; then
	hr "fetch ${UPSTREAM_REMOTE} (원격 추적 ref만 갱신)"
	git fetch "$UPSTREAM_REMOTE" --prune --tags 2>&1 | tail -20
fi

if ! git rev-parse --verify --quiet "$REF" >/dev/null; then
	printf '\n오류: %s 를 찾을 수 없다. UPSTREAM_REMOTE/UPSTREAM_BRANCH 를 확인하라.\n' "$REF"
	exit 1
fi

hr "분기 상태 (좌: ${REF} 에만 / 우: HEAD 에만)"
git rev-list --left-right --count "${REF}...HEAD"

hr "upstream 신규 커밋 (오래된 것부터)"
count=$(git rev-list --count "HEAD..${REF}")
echo "총 ${count}개"
[ "$count" -gt 0 ] && git log --oneline --reverse "HEAD..${REF}"

hr "포크 고유 커밋 (HEAD 에만)"
git log --oneline "${REF}..HEAD"

hr "새 태그 (upstream 최신 5개)"
git tag --sort=-creatordate --merged "$REF" | head -5

if [ "$count" -eq 0 ]; then
	printf '\nupstream 신규 커밋 없음. 조사 종료.\n'
	exit 0
fi

hr "upstream이 건드린 경로 — 디렉토리별 집계"
git diff --name-only "HEAD...${REF}" |
	awk -F/ '{ if ($1=="packages" || $1=="crates") print $1"/"$2; else if (NF>1) print $1; else print "(root) "$0 }' |
	sort | uniq -c | sort -rn

hr "버킷 B 후보 — 제거된 서브시스템을 upstream이 건드림 (되살아날 위험)"
git diff --name-only "HEAD...${REF}" | grep -E \
	-e '^packages/mnemopi/' \
	-e '^packages/coding-agent/src/(memory-backend|memories|mnemopi|hindsight|autolearn)/' \
	-e '^packages/coding-agent/src/tools/(memory-.*|learn)\.ts$' \
	-e '^packages/coding-agent/src/internal-urls/memory-protocol\.ts$' \
	-e '^packages/collab-web/src/tool-render/tools/memory-.*\.tsx$' \
	-e '^crates/pi-natives/src/vectors\.rs$' \
	|| echo "없음"

hr "버킷 C 후보 — 로컬 변경과 upstream 변경의 교집합 (충돌 예상)"
git diff --name-only "HEAD...${REF}" | sort -u >/tmp/.us_upstream.$$
git status --porcelain | awk '$1!="??"{print $NF}' | sort -u >/tmp/.us_local.$$
inter=$(comm -12 /tmp/.us_upstream.$$ /tmp/.us_local.$$)
rm -f /tmp/.us_upstream.$$ /tmp/.us_local.$$
if [ -z "$inter" ]; then
	echo "없음 (tracked 기준)"
else
	printf '%s\n' "$inter"
	printf '\n총 %s 파일\n' "$(printf '%s\n' "$inter" | wc -l | tr -d ' ')"
fi

hr "리브랜딩 회귀 후보 — upstream diff에 omp 문자열 재유입"
# 제외: 유지해야 하는 upstream 호환 식별자(@oh-my-pi/*, __omp_worker_*, omp-stats),
#       CI 인프라 호스트명(omp-kata), 이미 릴리스된 changelog의 역사적 표현.
git diff "HEAD...${REF}" -- . |
	grep -E '^\+' | grep -E '\bomp\b|\.omp/|~/\.omp|link-omp|scripts/omp' |
	grep -vE '@oh-my-pi/|__omp_worker_|omp-stats|omp-kata|CHANGELOG' | head -20 || echo "없음"

hr "버킷 D — 버전/changelog/lockfile"
git diff --name-only "HEAD...${REF}" |
	grep -E 'CHANGELOG\.md$|package\.json$|bun\.lock$' | head -20 || echo "없음"

printf '\n══ 조사 완료. 버킷 분류 후 사용자 승인을 받고 통합하라. 통합은 승인 이후다.\n'
