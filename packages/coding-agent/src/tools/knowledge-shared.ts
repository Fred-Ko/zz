import type {
	KnowledgeEvidenceReference,
	KnowledgeIdentity,
	KnowledgeRequestContext,
	KnowledgeRequestOrigin,
	KnowledgeRuntime,
} from "../knowledge";
import { resolveRepositoryIdentity } from "../workflow/identity";
import type { ToolSession } from ".";

export async function requireKnowledgeRuntime(session: ToolSession): Promise<KnowledgeRuntime> {
	const runtime = await session.getKnowledgeRuntime?.();
	if (!runtime) throw new Error("ZZ Knowledge System이 이 세션에 초기화되지 않았습니다.");
	const status = await runtime.status();
	if (!status.enabled) throw new Error("ZZ Knowledge System이 꺼져 있습니다. knowledge.enabled를 활성화하세요.");
	return runtime;
}

export async function knowledgeIdentity(session: ToolSession): Promise<KnowledgeIdentity> {
	const state = session.getTaskLifecycleState?.();
	if (state) {
		return {
			repoId: state.workspace.repoId,
			taskId: state.taskId,
			branchId: state.workspace.branch ?? undefined,
			attemptId: state.attemptId,
			sessionId: state.sessionId,
			episodeId: state.episodeId,
			commitHash: state.workspace.headCommit ?? undefined,
			specVersion: state.specVersion,
			planVersion: state.planVersion,
		};
	}
	const repository = await resolveRepositoryIdentity(session.cwd);
	return {
		repoId: repository.repositoryId,
		sessionId: session.getSessionId?.() ?? "unknown",
	};
}

function latestUserEntry(session: ToolSession): { id: string } | undefined {
	const entries = session.sessionManager?.getBranch() ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "user") continue;
		if (entry.message.synthetic || entry.message.attribution === "agent") continue;
		return { id: entry.id };
	}
	return undefined;
}

export function knowledgeRequestContext(
	session: ToolSession,
	origin: KnowledgeRequestOrigin,
	fallbackId: string,
): KnowledgeRequestContext {
	const entry = latestUserEntry(session);
	const sourceRequestId = entry?.id ?? fallbackId;
	const sessionId = session.getSessionId?.() ?? "unknown";
	return {
		groupId: `retain-${Bun.hash(`${sessionId}:${sourceRequestId}`).toString(16).padStart(16, "0")}`,
		origin,
		sourceRequestId,
		userMessageEntryId: entry?.id,
	};
}

export function withUserRequestEvidence(
	references: KnowledgeEvidenceReference[] | undefined,
	request: KnowledgeRequestContext,
): KnowledgeEvidenceReference[] {
	const resolved = [...(references ?? [])];
	if (
		request.origin === "user-explicit" &&
		request.userMessageEntryId &&
		!resolved.some(value => value.id === `session-entry:${request.userMessageEntryId}`)
	) {
		resolved.push({
			id: `session-entry:${request.userMessageEntryId}`,
			type: "user-confirmation",
		});
	}
	return resolved;
}
