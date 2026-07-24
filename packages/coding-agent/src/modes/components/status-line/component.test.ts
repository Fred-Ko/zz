import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
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
});
