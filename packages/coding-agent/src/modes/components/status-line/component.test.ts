import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import * as git from "../../../utils/git";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

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
				cost: 0,
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => false,
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
});
