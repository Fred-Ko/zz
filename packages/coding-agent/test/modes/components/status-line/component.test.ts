import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "../../../../src/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "../../../../src/modes/theme/theme";
import type { AgentSession } from "../../../../src/session/agent-session";
import * as git from "../../../../src/utils/git";

interface StatusTestModel {
	contextWindow: number;
	provider?: string;
	id?: string;
	name?: string;
}

function makeSessionWithLastMessage(
	lastMessage: unknown,
	prewalkArmed: boolean = false,
	model: StatusTestModel = { contextWindow: 128000 },
	{
		cost = 0,
		advisorCost = 0,
		usingSubscription = false,
	}: { cost?: number; advisorCost?: number; usingSubscription?: boolean } = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model,
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => usingSubscription,
		},
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);
		statusLine.updateSettings({
			preset: "custom",
			layout: "single",
			leftSegments: ["cost"],
			rightSegments: [],
			separator: "none",
			transparent: true,
		});

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("Prewalk");
	});

	it("keeps model, workspace, and context visible on separate detailed rows", () => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			contextWindow: 128000,
		};
		const session = makeSessionWithLastMessage(null, false, model) as unknown as AgentSession;

		const statusLine = new StatusLineComponent(session);
		statusLine.updateSettings({
			preset: "custom",
			layout: "detailed",
			leftSegments: ["mode", "path", "git", "context_pct", "context_total"],
			rightSegments: ["model"],
			separator: "none",
			transparent: true,
			segmentOptions: {
				model: { showProvider: true, showThinkingLevel: true },
			},
		});

		const border = statusLine.getTopBorder(100);
		const rows = [border.content, ...(border.rows ?? []).map(row => row.content)];
		const rendered = rows.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(rendered[0]).toContain("openai-codex/gpt-5.6-sol");
		expect(rendered.some(row => row.includes("oh-my-pi"))).toBe(true);
		expect(rendered.some(row => row.includes("128K"))).toBe(true);
		expect(rows.length).toBeGreaterThanOrEqual(3);
	});

	it("renders a labeled detailed dashboard with live ZZW step and non-duplicated totals", () => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			contextWindow: 128000,
		};
		const session = {
			...makeSessionWithLastMessage(null, false, model),
			isStreaming: true,
			settings: { get: () => false },
			getGoalModeState: () => ({
				controller: "zzworkflow",
				goal: { status: "active", tokensUsed: 0 },
			}),
			taskLifecycle: {
				state: {
					phase: "EXECUTING",
					planVersion: 3,
					reconciliation: undefined,
					execution: {
						activeWaveId: "wave-7",
						waves: [{ id: "wave-7", status: "running", laneIds: ["lane-1", "lane-2", "lane-3"] }],
						lanes: [
							{ id: "lane-1", status: "running" },
							{ id: "lane-2", status: "prepared" },
							{ id: "lane-3", status: "succeeded" },
						],
					},
					plan: {
						approval: "approved",
						steps: [
							{
								id: "survey",
								phase: "discovery",
								content: "현재 영속성 구조 조사",
								status: "completed",
								dependsOn: [],
							},
							{
								id: "runtime-config",
								phase: "implementation",
								content: "MikroORM 런타임 구성 전환",
								status: "in_progress",
								dependsOn: ["survey"],
							},
							{
								id: "verification",
								phase: "verification",
								content: "전체 검증",
								status: "pending",
								dependsOn: ["runtime-config"],
							},
						],
					},
				},
			},
			sessionManager: {
				getSessionName: () => "MikroORM 전환",
				getSessionId: () => "019fa39d-dead-beef",
				getUsageStatistics: () => ({
					input: 26_000_000,
					output: 83_000,
					cacheRead: 13_000_000,
					cacheWrite: 0,
					totalTokens: 26_083_000,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 140.39,
					tokensPerSecond: null,
				}),
			},
		} as unknown as AgentSession;

		const statusLine = new StatusLineComponent(session);
		statusLine.setGoalModeStatus({ enabled: true, paused: false });
		statusLine.updateSettings({
			preset: "custom",
			layout: "detailed",
			leftSegments: [
				"mode",
				"model",
				"path",
				"git",
				"context_pct",
				"context_total",
				"token_in",
				"token_out",
				"token_total",
				"cache_read",
				"cost",
				"session",
			],
			rightSegments: ["session_name"],
			separator: "none",
			transparent: true,
			segmentOptions: { model: { showProvider: true } },
		});

		const border = statusLine.getTopBorder(140);
		const rows = [border.content, ...(border.rows ?? []).map(row => row.content)].map(row =>
			row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(),
		);
		const rowFor = (label: string) => rows.find(row => row.trimStart().startsWith(label));

		expect(rowFor("상태")).toContain("ZZW EXECUTING P3:approved W:1↑/1…/0×");
		expect(rowFor("작업")).toContain("MikroORM 전환");
		expect(rowFor("현재 단계")).toContain("Step 2/3 · runtime-config · MikroORM 런타임 구성 전환");
		expect(rowFor("실행 Wave")).toContain(
			"Wave wave-7 · running · 1 실행 · 1 대기 · 0 리뷰 · 0 후보검증 · 0 통합 · 1 완료 · 0 실패",
		);
		expect(rowFor("활동")).toContain("에이전트 작업 중");
		expect(rowFor("모델")).toContain("openai-codex/gpt-5.6-sol");
		expect(rowFor("작업공간")).toContain("경로");
		expect(rowFor("컨텍스트")?.match(/128K/g)?.length).toBe(1);
		expect(rowFor("토큰")).toContain("입력");
		expect(rowFor("토큰")).toContain("출력");
		expect(rowFor("토큰")).toContain("캐시 읽기");
		expect(rowFor("토큰")).not.toContain("합계");
		expect(rowFor("세션")).toContain("ID");

		const narrowBorder = statusLine.getTopBorder(48);
		const narrowRows = [narrowBorder.content, ...(narrowBorder.rows ?? []).map(row => row.content)];
		expect(narrowRows.every(row => visibleWidth(row) <= 48)).toBe(true);
		expect(narrowRows.map(row => row.replace(/\x1b\[[0-9;]*m/g, "")).join("\n")).toContain("현재 단계");
	});

	it("shows the active linked worktree independently from its branch", () => {
		spyOn(git.repo, "linkedWorktreeSync").mockReturnValue({
			root: "/tmp/zz-worktrees/feature-knowledge",
			primaryRoot: "/tmp/zz",
		});

		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
		statusLine.updateSettings({
			preset: "custom",
			layout: "detailed",
			leftSegments: ["worktree"],
			rightSegments: [],
			separator: "none",
			transparent: true,
		});

		const border = statusLine.getTopBorder(100);
		const rendered = [border.content, ...(border.rows ?? []).map(row => row.content)]
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");

		expect(rendered).toContain("feature-knowledge");
	});

	it("keeps detailed status visible when a dialog replaces the editor", () => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			contextWindow: 128000,
		};
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, model) as unknown as AgentSession,
		);
		statusLine.updateSettings({
			preset: "custom",
			layout: "detailed",
			leftSegments: ["path", "context_pct"],
			rightSegments: ["model"],
			separator: "none",
			transparent: true,
			segmentOptions: {
				model: { showProvider: true },
			},
		});

		expect(statusLine.render(100)).toEqual([]);

		statusLine.setStandaloneMainStatus(true);
		const rendered = statusLine.render(100).map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(rendered.some(row => row.includes("openai-codex/gpt-5.6-sol"))).toBe(true);
		expect(rendered.some(row => row.includes("oh-my-pi"))).toBe(true);
		expect(rendered.length).toBeGreaterThanOrEqual(2);

		statusLine.setStandaloneMainStatus(false);
		expect(statusLine.render(100)).toEqual([]);
	});

	it("renders primary and advisor costs separately", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, undefined, {
				cost: 2.67,
				advisorCost: 0.41,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);
		statusLine.updateSettings({
			preset: "custom",
			layout: "single",
			leftSegments: ["cost"],
			rightSegments: [],
			separator: "none",
			transparent: true,
		});

		const border = statusLine.getTopBorder(120);
		const stripped = [border.content, ...(border.rows ?? []).map(row => row.content)]
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 (sub) + $0.41 (adv)");
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, undefined, {
				cost: 2.67,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const border = statusLine.getTopBorder(120);
		const stripped = [border.content, ...(border.rows ?? []).map(row => row.content)]
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 (sub)");
		expect(stripped).not.toContain("(adv)");
	});
});
