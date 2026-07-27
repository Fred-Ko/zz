#!/usr/bin/env bash
# ZZ upstream integration boundary verifier. Read-only except for transient
# process state created by Bun while importing repository modules.

set -uo pipefail

mode="${1:---boundaries}"
case "$mode" in
	--boundaries | --pre-commit | --post-commit) ;;
	*)
		printf '사용법: %s [--boundaries|--pre-commit|--post-commit]\n' "$0" >&2
		exit 2
		;;
esac

cd "$(git rev-parse --show-toplevel)" || exit 1

failures=0

pass() {
	printf '통과: %s\n' "$1"
}

fail() {
	printf '실패: %s\n' "$1" >&2
	failures=$((failures + 1))
}

if [ -z "$(git diff --name-only --diff-filter=U)" ]; then
	pass "미해결 충돌 없음"
else
	fail "미해결 충돌 파일이 존재함"
	git diff --name-only --diff-filter=U >&2
fi

if git diff --check >/dev/null && git diff --cached --check >/dev/null; then
	pass "working tree와 index diff 형식 정상"
else
	fail "diff whitespace/conflict marker 검사 실패"
	git diff --check >&2 || true
	git diff --cached --check >&2 || true
fi

if cmp -s AGENTS.md CLAUDE.md; then
	pass "AGENTS.md와 CLAUDE.md mirror 일치"
else
	fail "AGENTS.md와 CLAUDE.md가 다름"
fi

removed_paths=(
	packages/mnemopi
	packages/coding-agent/src/memory-backend
	packages/coding-agent/src/memories
	packages/coding-agent/src/mnemopi
	packages/coding-agent/src/hindsight
	packages/coding-agent/src/autolearn
	packages/coding-agent/src/tools/learn.ts
	packages/coding-agent/src/internal-urls/memory-protocol.ts
	crates/pi-natives/src/vectors.rs
)

reintroduced=()
for target in "${removed_paths[@]}"; do
	[ -e "$target" ] && reintroduced+=("$target")
done
while IFS= read -r target; do
	[ -n "$target" ] && reintroduced+=("$target")
done < <(
	find packages/coding-agent/src/tools packages/collab-web/src/tool-render/tools \
		-maxdepth 1 -type f -name 'memory-*' -print 2>/dev/null
)

if [ "${#reintroduced[@]}" -eq 0 ]; then
	pass "제거된 memory 서브시스템 재유입 없음"
else
	fail "제거된 memory 서브시스템 경로가 재유입됨"
	printf '  %s\n' "${reintroduced[@]}" >&2
fi

qa_hits=$(rg -n 'report_tool_issue|xd://report_issue' packages/coding-agent/src packages/collab-web/src \
	--glob '!**/CHANGELOG.md' --glob '!**/*.test.ts' 2>/dev/null || true)
grievance_hits=$(rg -n 'grievance' packages/coding-agent/src packages/collab-web/src \
	--glob '!**/CHANGELOG.md' --glob '!**/*.test.ts' 2>/dev/null |
	rg -v 'cli-commands\.ts:.*제거되었습니다' || true)
if [ -z "$qa_hits" ] && [ -z "$grievance_hits" ]; then
	pass "자동 QA/telemetry 재유입 없음"
else
	fail "자동 QA/telemetry 후보가 존재함"
	[ -n "$qa_hits" ] && printf '%s\n' "$qa_hits" >&2
	[ -n "$grievance_hits" ] && printf '%s\n' "$grievance_hits" >&2
fi

if bun -e '
import {
  APP_NAME,
  CONFIG_DIR_NAME,
  getPluginsLockfileAtRoot,
} from "./packages/utils/src/dirs.ts";
if (APP_NAME !== "zz") throw new Error(`APP_NAME=${APP_NAME}`);
if (CONFIG_DIR_NAME !== ".zz") throw new Error(`CONFIG_DIR_NAME=${CONFIG_DIR_NAME}`);
if (!getPluginsLockfileAtRoot("/tmp/zz-audit").endsWith("/zz-plugins.lock.json")) {
  throw new Error("plugin lock filename is not canonical ZZ");
}
' >/dev/null; then
	pass "ZZ 실행명·설정 루트·신규 plugin lock 이름 정상"
else
	fail "ZZ 공개 경로 runtime 검사 실패"
fi

if [ -d packages/coding-agent/src/knowledge ] && [ -d packages/coding-agent/src/workflow ]; then
	pass "ZZ Knowledge와 ZZWorkflow 독립 구현 존재"
else
	fail "ZZ Knowledge 또는 ZZWorkflow 구현이 없음"
fi

if [ "$mode" = "--pre-commit" ]; then
	if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
		pass "no-commit merge 상태 확인"
	else
		fail "MERGE_HEAD가 없어 검증 대상이 no-commit merge가 아님"
	fi
	if git diff --cached --quiet; then
		fail "index에 통합 변경이 없음"
	else
		pass "통합 변경이 index에 존재"
	fi
	if [ -z "$(git diff --name-only)" ] && [ -z "$(git status --porcelain | awk '$1=="??"{print}')" ]; then
		pass "통합 worktree에 unstaged/untracked 항목 없음"
	else
		fail "통합 worktree에 unstaged 또는 untracked 항목이 남음"
	fi
fi

if [ "$mode" = "--post-commit" ]; then
	if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
		fail "commit 후에도 MERGE_HEAD가 남아 있음"
	else
		pass "merge commit 완료 상태 확인"
	fi
	parent_count=$(git show --no-patch --format='%P' HEAD | awk '{print NF}')
	if [ "$parent_count" -ge 2 ]; then
		pass "HEAD가 merge commit임"
	else
		fail "HEAD가 merge commit이 아님"
	fi
	if git rev-parse --verify --quiet origin/main >/dev/null && git merge-base --is-ancestor origin/main HEAD; then
		pass "현재 origin/main이 HEAD에 포함됨"
	else
		fail "현재 origin/main이 HEAD의 조상이 아님"
	fi
	if [ -z "$(git status --porcelain)" ]; then
		pass "통합 worktree clean"
	else
		fail "통합 worktree가 clean하지 않음"
	fi
fi

if [ "$failures" -gt 0 ]; then
	printf '\n총 %d개 경계 검사가 실패했습니다.\n' "$failures" >&2
	exit 1
fi

printf '\nZZ upstream 통합 경계 검사 완료.\n'
