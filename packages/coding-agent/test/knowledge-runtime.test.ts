import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createKnowledgeRuntime,
	type KnowledgeBankRef,
	type KnowledgeIdentity,
	type KnowledgeRuntime,
	knowledgeDbPath,
	registerKnowledgeBank,
} from "@oh-my-pi/pi-coding-agent/knowledge";
import { isRecord } from "@oh-my-pi/pi-utils";

interface RecordedRequest {
	method: string;
	path: string;
	body?: unknown;
}

const temporaryDirectories: string[] = [];
const runtimes: KnowledgeRuntime[] = [];
const servers: Bun.Server<unknown>[] = [];

async function createAgentDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zz-knowledge-"));
	temporaryDirectories.push(directory);
	return directory;
}

function identity(overrides: Partial<KnowledgeIdentity> = {}): KnowledgeIdentity {
	return {
		repoId: "repo-1",
		sessionId: "session-1",
		taskId: "task-1",
		branchId: "main",
		commitHash: "abc123",
		...overrides,
	};
}

function queryFrom(body: unknown): string | undefined {
	return isRecord(body) && typeof body.query === "string" ? body.query : undefined;
}

function globalBank(bankId: string, boundary: string): KnowledgeBankRef {
	return {
		kind: "global",
		bankId,
		displayName: `ZZ Global · fred · ${boundary}`,
		nameSource: "generated",
	};
}

function startHindsightStub(requests: RecordedRequest[]): Bun.Server<unknown> {
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
			requests.push({ method: request.method, path: url.pathname, body });
			if (request.method === "PUT" && url.pathname.includes("/banks/")) {
				return Response.json({ id: "bank" });
			}
			if (request.method === "GET" && url.pathname.endsWith("/config")) {
				return Response.json({ config: {}, overrides: {} });
			}
			if (request.method === "PATCH" && url.pathname.endsWith("/config")) {
				return Response.json({ config: {}, overrides: isRecord(body) ? body.updates : {} });
			}
			if (request.method === "POST" && url.pathname.endsWith("/memories/recall")) {
				const query = queryFrom(body);
				if (query === "known convention") {
					return Response.json({
						results: [
							{ id: "knowledge-1", text: "스키마 변경 후 생성 명령을 실행한다.", type: "observation" },
							{ id: "knowledge-duplicate", text: "스키마 변경 후 생성 명령을 실행한다." },
						],
					});
				}
				return Response.json({ results: [] });
			}
			if (request.method === "POST" && url.pathname.endsWith("/memories")) {
				return Response.json({ operation_id: "retain-1" });
			}
			if (request.method === "GET" && url.pathname.endsWith("/mental-models")) {
				return Response.json({
					items: [
						{
							id: "developer-working-preferences",
							name: "developer-working-preferences",
							content: "사용자는 특별한 요청이 없으면 한국어 대화를 선호한다.",
							tags: ["scope:global", "status:active"],
							last_refreshed_at: "2026-07-25T00:00:00.000Z",
						},
					],
				});
			}
			if (request.method === "POST" && url.pathname.endsWith("/mental-models")) {
				return Response.json({ operation_id: "mental-model-create" });
			}
			if (request.method === "POST" && url.pathname.endsWith("/refresh")) {
				return Response.json({ operation_id: "mental-model-refresh" });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	servers.push(server);
	return server;
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const server of servers.splice(0)) server.stop(true);
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("ZZ Knowledge runtime", () => {
	it("stores local policy state in a database isolated by security boundary", async () => {
		const agentDir = await createAgentDir();
		const personal = knowledgeDbPath(agentDir, "developer:fred:personal");
		const company = knowledgeDbPath(agentDir, "developer:fred:company-a");

		expect(personal).not.toBe(company);
		expect(personal.startsWith(path.join(agentDir, "knowledge"))).toBe(true);
		expect(company.startsWith(path.join(agentDir, "knowledge"))).toBe(true);
		expect(personal).not.toContain(`${path.sep}workflows${path.sep}`);
	});

	it("enforces the configured bank limit per user without counting the same boundary twice", async () => {
		const agentDir = await createAgentDir();
		for (const boundary of ["personal", "company-a", "company-b", "customer-a"]) {
			registerKnowledgeBank(agentDir, "fred", boundary, globalBank(`bank-${boundary}`, boundary), 4);
		}
		registerKnowledgeBank(agentDir, "fred", "personal", globalBank("bank-personal", "personal"), 4);
		expect(() =>
			registerKnowledgeBank(agentDir, "fred", "customer-b", globalBank("bank-customer-b", "customer-b"), 4),
		).toThrow("security-boundary limit reached");
		expect(() =>
			registerKnowledgeBank(agentDir, "juno", "customer-b", globalBank("bank-juno-customer-b", "customer-b"), 4),
		).not.toThrow();
	});

	it("does not contact Hindsight or accept retained knowledge while disabled", async () => {
		const requests: RecordedRequest[] = [];
		const server = startHindsightStub(requests);
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": false,
				"knowledge.hindsight.apiUrl": server.url.origin,
			}),
			agentDir: await createAgentDir(),
			repoId: "repo-1",
		});
		runtimes.push(runtime);

		const recalled = await runtime.recall({
			purpose: "implementation",
			query: "known convention",
			scope: { repo: true },
			depth: "normal",
			identity: identity(),
		});
		const retained = await runtime.retain({
			scope: "repo",
			form: "procedure",
			domain: "repository",
			source: "test",
			confidence: "confirmed",
			knowledgeKey: "repository/schema-generation",
			statement: "스키마 변경 후 생성 명령을 실행한다.",
			futureUse: "CI 생성물 누락을 방지한다.",
			sourceRefs: [{ id: "EV-1", type: "test" }],
			identity: identity(),
		});

		expect(recalled.items).toEqual([]);
		expect(recalled.degraded).toBe(false);
		expect(retained).toEqual({ status: "rejected", reason: "knowledge-disabled" });
		expect(requests).toEqual([]);
	});

	it("uses scoped recall, ignores branch provenance, and reuses its working-set cache", async () => {
		const requests: RecordedRequest[] = [];
		const server = startHindsightStub(requests);
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.hindsight.apiUrl": server.url.origin,
			}),
			agentDir: await createAgentDir(),
			repoId: "repo-1",
		});
		runtimes.push(runtime);
		const input = {
			purpose: "implementation" as const,
			query: "known convention",
			scope: { repo: true },
			depth: "normal" as const,
			identity: identity(),
		};

		const first = await runtime.recall(input);
		const second = await runtime.recall(input);
		const afterBranchRename = await runtime.recall({
			...input,
			identity: { ...input.identity, branchId: "renamed-branch" },
		});
		const recallRequests = requests.filter(request => request.path.endsWith("/memories/recall"));
		const recallBody = recallRequests[0]?.body;
		const bankProfileUpdate = requests.find(
			request => request.method === "PATCH" && request.path.endsWith("/config"),
		);

		expect(first.items).toEqual([
			expect.objectContaining({
				id: "knowledge-1",
				text: "스키마 변경 후 생성 명령을 실행한다.",
				type: "observation",
				mentionedAt: undefined,
			}),
		]);
		expect(first.content).toContain('<knowledge-working-set authoritative="false"');
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(afterBranchRename.cached).toBe(true);
		expect(recallRequests).toHaveLength(1);
		expect(recallBody).toMatchObject({
			max_tokens: 4000,
			tag_groups: expect.arrayContaining([
				{ tags: ["schema:zzk-v2", "scope:repo", "repo:repo-1"], match: "all_strict" },
				{ tags: ["status:active"], match: "all_strict" },
			]),
			prefer_observations: true,
		});
		expect(recallBody).not.toHaveProperty("tags");
		expect(recallBody).not.toHaveProperty("tags_match");
		expect(bankProfileUpdate?.body).toMatchObject({
			updates: {
				retain_default_strategy: "durable-fact",
				enable_observations: true,
				enable_auto_consolidation: false,
				mcp_enabled_tools: ["recall", "reflect"],
			},
		});
	});

	it("creates readable Global and Repository banks while routing each scope to its own stable bank", async () => {
		const requests: RecordedRequest[] = [];
		const server = startHindsightStub(requests);
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.userId": "junoko",
				"knowledge.securityBoundary": "personal",
				"knowledge.retain.deduplicateBeforeRetain": false,
				"knowledge.hindsight.apiUrl": server.url.origin,
			}),
			agentDir: await createAgentDir(),
			repoId: "remote-stable-repository-id",
			repositoryDisplayName: "Fred-Ko/zz",
			repositoryNameSource: "remote",
		});
		runtimes.push(runtime);

		await runtime.recall({
			purpose: "implementation",
			query: "project conventions",
			scope: { global: true, repo: true },
			depth: "normal",
			identity: identity({ repoId: "remote-stable-repository-id" }),
		});
		const request = {
			groupId: "retain-mixed-bank-request",
			origin: "user-explicit" as const,
			sourceRequestId: "message-mixed-bank",
			userMessageEntryId: "message-mixed-bank",
		};
		await runtime.retain({
			scope: "global",
			form: "preference",
			domain: "user",
			source: "user",
			confidence: "confirmed",
			knowledgeKey: "user/default-language",
			statement: "기본 대화 언어는 한국어다.",
			futureUse: "모든 저장소에서 대화 언어를 선택한다.",
			sourceRefs: [{ id: "session-entry:message-mixed-bank", type: "user-confirmation" }],
			identity: identity({ repoId: "remote-stable-repository-id" }),
			request,
		});
		await runtime.retain({
			scope: "repo",
			form: "decision",
			domain: "architecture",
			source: "user",
			confidence: "confirmed",
			knowledgeKey: "architecture/database",
			statement: "RDB는 SQLite를 사용한다.",
			futureUse: "저장소의 persistence 설계를 선택한다.",
			sourceRefs: [{ id: "session-entry:message-mixed-bank", type: "user-confirmation" }],
			identity: identity({ repoId: "remote-stable-repository-id" }),
			request,
		});
		await runtime.flushOutbox();

		const status = await runtime.status();
		const bankCreates = requests.filter(request => request.method === "PUT" && request.path.includes("/banks/"));
		const retains = requests.filter(request => request.method === "POST" && request.path.endsWith("/memories"));
		expect(status.globalBank).toMatchObject({
			kind: "global",
			displayName: "ZZ Global · junoko · personal",
			nameSource: "generated",
		});
		expect(status.repositoryBank).toMatchObject({
			kind: "repository",
			displayName: "ZZ Repo · Fred-Ko/zz · personal",
			nameSource: "remote",
			repositoryId: "remote-stable-repository-id",
		});
		expect(status.globalBank?.bankId).toStartWith("zz-global-v1-");
		expect(status.repositoryBank?.bankId).toStartWith("zz-repo-v1-");
		expect(bankCreates.map(request => request.body)).toEqual(
			expect.arrayContaining([
				{ name: "ZZ Global · junoko · personal" },
				{ name: "ZZ Repo · Fred-Ko/zz · personal" },
			]),
		);
		expect(retains).toHaveLength(2);
		expect(retains).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: expect.stringContaining("/banks/zz-global-v1-") }),
				expect.objectContaining({ path: expect.stringContaining("/banks/zz-repo-v1-") }),
			]),
		);
		expect((await runtime.listGroups())[0]?.memberCount).toBe(2);
	});

	it("updates the repository display name without changing its stable bank id", async () => {
		const first = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.repositoryDisplayName": "ZZ Core",
			}),
			agentDir: await createAgentDir(),
			repoId: "stable-repository-id",
			repositoryDisplayName: "Fred-Ko/zz",
			repositoryNameSource: "remote",
		});
		const renamed = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.repositoryDisplayName": "ZZ Platform",
			}),
			agentDir: await createAgentDir(),
			repoId: "stable-repository-id",
			repositoryDisplayName: "Fred-Ko/zz",
			repositoryNameSource: "remote",
		});
		runtimes.push(first, renamed);

		const firstBank = (await first.status()).repositoryBank;
		const renamedBank = (await renamed.status()).repositoryBank;
		expect(firstBank?.displayName).toBe("ZZ Repo · ZZ Core · personal");
		expect(renamedBank?.displayName).toBe("ZZ Repo · ZZ Platform · personal");
		expect(renamedBank?.bankId).toBe(firstBank?.bankId);
		expect(renamedBank?.nameSource).toBe("project-config");
	});

	it("builds a bounded session orientation from one global and four repository mental models", async () => {
		const requests: RecordedRequest[] = [];
		const server = startHindsightStub(requests);
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.hindsight.apiUrl": server.url.origin,
			}),
			agentDir: await createAgentDir(),
			repoId: "repo-1",
		});
		runtimes.push(runtime);

		const workingSet = await runtime.recall({
			purpose: "session-orientation",
			query: "session orientation",
			scope: { global: true, repo: true },
			depth: "normal",
			identity: identity({ taskId: undefined }),
		});
		const mentalModelCreates = requests.filter(
			request => request.method === "POST" && request.path.endsWith("/mental-models"),
		);
		const recallBodies = requests
			.filter(request => request.path.endsWith("/memories/recall"))
			.map(request => request.body);

		expect(workingSet.items[0]).toMatchObject({
			id: "developer-working-preferences",
			type: "mental-model",
			text: "사용자는 특별한 요청이 없으면 한국어 대화를 선호한다.",
		});
		expect(mentalModelCreates).toHaveLength(4);
		expect(mentalModelCreates.map(request => request.body)).toEqual(
			Array.from({ length: 4 }, () =>
				expect.objectContaining({
					trigger: { mode: "full", refresh_after_consolidation: false },
				}),
			),
		);
		expect(recallBodies).toHaveLength(2);
		expect(recallBodies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					max_tokens: 750,
					tag_groups: expect.arrayContaining([
						expect.objectContaining({ tags: ["schema:zzk-v2", "scope:global"] }),
					]),
				}),
				expect.objectContaining({
					max_tokens: 750,
					tag_groups: expect.arrayContaining([
						expect.objectContaining({ tags: ["schema:zzk-v2", "scope:repo", "repo:repo-1"] }),
					]),
				}),
			]),
		);
	});

	it("rejects inferred repo facts and delivers evidenced records through the independent outbox", async () => {
		const requests: RecordedRequest[] = [];
		const server = startHindsightStub(requests);
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.hindsight.apiUrl": server.url.origin,
			}),
			agentDir: await createAgentDir(),
			repoId: "repo-1",
			redact: content => content.replace("secret-token", "[REDACTED]"),
		});
		runtimes.push(runtime);

		const rejected = await runtime.retain({
			scope: "repo",
			form: "fact",
			domain: "implementation",
			source: "agent",
			confidence: "tentative",
			knowledgeKey: "hypothesis/unverified",
			statement: "검증되지 않은 가설",
			futureUse: "다음 구현에서 참고한다.",
			sourceRefs: [{ id: "OBS-1", type: "runtime" }],
			identity: identity(),
		});
		const retained = await runtime.retain({
			scope: "repo",
			form: "procedure",
			domain: "verification",
			source: "test",
			confidence: "confirmed",
			knowledgeKey: "verification/settings-check",
			statement: "secret-token을 포함한 설정 변경 후 bun check를 실행한다.",
			futureUse: "설정 회귀를 조기에 검출한다.",
			sourceRefs: [{ id: "EV-2", type: "test" }],
			refreshMentalModels: ["repo-debugging-validation-playbook"],
			identity: identity(),
		});
		await runtime.flushOutbox();

		const retainRequests = requests.filter(request => request.path.endsWith("/memories"));
		expect(rejected).toEqual({
			status: "rejected",
			reason: "agent-inferred-long-term-knowledge-is-not-allowed",
		});
		expect(retained.status).toBe("queued");
		expect(retainRequests).toHaveLength(1);
		expect(retainRequests[0]?.body).toMatchObject({
			async: false,
			strategy: "durable-fact",
			items: [
				{
					content: "[REDACTED]을 포함한 설정 변경 후 bun check를 실행한다.",
					metadata: expect.objectContaining({
						branch_name_at_discovery: "main",
						branch_head_at_discovery: "abc123",
					}),
					tags: expect.arrayContaining([
						"schema:zzk-v2",
						"scope:repo",
						"repo:repo-1",
						"branch-ref:main",
						"form:procedure",
						"domain:verification",
						"source:test",
						"confidence:confirmed",
						"status:active",
					]),
					observation_scopes: [
						["schema:zzk-v2", "scope:repo", "repo:repo-1", "domain:verification", "status:active"],
					],
				},
			],
		});
		expect(JSON.stringify(retainRequests[0]?.body)).not.toContain("per_tag");
		expect((await runtime.status()).queued).toBe(0);
		expect(
			requests.some(
				request =>
					request.method === "POST" &&
					request.path.includes("/mental-models/repo-debugging-validation-playbook-") &&
					request.path.endsWith("/refresh"),
			),
		).toBe(true);
		expect(
			requests.some(
				request =>
					request.path.endsWith("/memories/recall") &&
					queryFrom(request.body) === "secret-token을 포함한 설정 변경 후 bun check를 실행한다.",
			),
		).toBe(true);
	});

	it("groups every retain from one explicit request and routes source documents through a document strategy", async () => {
		const requests: RecordedRequest[] = [];
		const server = startHindsightStub(requests);
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({
				"knowledge.enabled": true,
				"knowledge.hindsight.apiUrl": server.url.origin,
			}),
			agentDir: await createAgentDir(),
			repoId: "repo-1",
		});
		runtimes.push(runtime);
		const request = {
			groupId: "retain-request-42",
			origin: "user-explicit" as const,
			sourceRequestId: "message-42",
			userMessageEntryId: "message-42",
		};

		const first = await runtime.retain({
			scope: "repo",
			form: "decision",
			domain: "architecture",
			source: "user",
			confidence: "confirmed",
			knowledgeKey: "architecture/knowledge-authority",
			statement: "현재 상태는 Git과 Registry가 권위 있는 원본이다.",
			futureUse: "과거 기억과 현재 상태가 충돌할 때 우선순위를 정한다.",
			sourceRefs: [{ id: "session-entry:message-42", type: "user-confirmation" }],
			identity: identity(),
			request,
		});
		const document = await runtime.retainDocument({
			contentClass: "reference-document",
			scope: "repo",
			domain: "repository",
			source: "document",
			confidence: "confirmed",
			sourceId: "develop-guide-docs/knowledge-system.md",
			title: "ZZ Knowledge 설계",
			content: "현재 상태와 장기 기억을 분리한다.",
			futureUse: "Knowledge 변경 시 설계 원칙을 확인한다.",
			sourceRefs: [{ id: "develop-guide-docs/knowledge-system.md", type: "document" }],
			updateMode: "replace",
			identity: identity(),
			request,
		});
		await runtime.flushOutbox();

		const groups = await runtime.listGroups();
		const retainBodies = requests
			.filter(value => value.method === "POST" && value.path.endsWith("/memories"))
			.map(value => value.body);
		expect(first.groupId).toBe("retain-request-42");
		expect(document.groupId).toBe("retain-request-42");
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			id: "retain-request-42",
			origin: "user-explicit",
			memberCount: 2,
			status: "completed",
		});
		expect(retainBodies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ strategy: "durable-fact" }),
				expect.objectContaining({
					strategy: "reference-document",
					items: [
						expect.objectContaining({
							content: "# ZZ Knowledge 설계\n\n현재 상태와 장기 기억을 분리한다.",
							update_mode: "replace",
						}),
					],
				}),
			]),
		);
	});

	it("persists completion candidates as review receipts without automatically retaining them", async () => {
		const runtime = createKnowledgeRuntime({
			settings: Settings.isolated({ "knowledge.enabled": false }),
			agentDir: await createAgentDir(),
			repoId: "repo-1",
		});
		runtimes.push(runtime);

		await runtime.requestReview({
			id: "review-1",
			taskId: "task-1",
			repoId: "repo-1",
			goal: "안전한 지식 계층을 구현한다.",
			candidates: [
				{
					knowledgeKey: "architecture/hindsight-authority",
					statement: "Hindsight는 현재 상태의 권위 있는 원본이 아니다.",
					form: "decision",
					domain: "architecture",
					source: "user",
					confidence: "confirmed",
					evidenceRefs: [{ id: "EV-3", type: "user-confirmation" }],
				},
			],
			createdAt: "2026-07-25T00:00:00.000Z",
		});

		expect(await runtime.listReviews()).toEqual([
			{
				id: "review-1",
				taskId: "task-1",
				repoId: "repo-1",
				goal: "안전한 지식 계층을 구현한다.",
				candidates: [
					{
						knowledgeKey: "architecture/hindsight-authority",
						statement: "Hindsight는 현재 상태의 권위 있는 원본이 아니다.",
						form: "decision",
						domain: "architecture",
						source: "user",
						confidence: "confirmed",
						evidenceRefs: [{ id: "EV-3", type: "user-confirmation" }],
					},
				],
				createdAt: "2026-07-25T00:00:00.000Z",
			},
		]);
		expect((await runtime.status()).pendingReviews).toBe(1);
		expect((await runtime.status()).queued).toBe(0);
	});
});
