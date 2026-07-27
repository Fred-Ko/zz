import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import * as core from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runGuidedGoalTurn } from "@oh-my-pi/pi-coding-agent/goals/guided-setup";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession as RealAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const planModel = { provider: "test", id: "plan" } as unknown as Model<Api>;
const slowModel = { provider: "test", id: "slow" } as unknown as Model<Api>;
const currentModel = { provider: "test", id: "current" } as unknown as Model<Api>;

function createSession(options?: {
	plan?: boolean;
	slow?: boolean;
	current?: boolean;
	thinkingLevel?: ThinkingLevel;
}): AgentSession {
	const plan = options?.plan ?? true;
	const slow = options?.slow ?? true;
	const current = options?.current ?? false;
	return {
		resolveRoleModelWithThinking(role: string) {
			if (role === "plan" && plan) return { model: planModel, explicitThinkingLevel: false };
			if (role === "slow" && slow) return { model: slowModel, explicitThinkingLevel: false };
			return { model: undefined, explicitThinkingLevel: false };
		},
		modelRegistry: {
			getAvailable: () => [currentModel],
			getApiKey: async () => "test-key",
			resolver: (model: typeof planModel) => `${model.provider}/${model.id}:key`,
		},
		settings: {
			getModelRole: () => undefined,
		},
		model: current ? currentModel : undefined,
		thinkingLevel: options?.thinkingLevel,
		sessionId: "session-1",
		preferWebsockets: true,
		providerSessionState: new Map(),
		agent: { telemetry: undefined },
	} as unknown as AgentSession;
}

function mockResponse(args: unknown) {
	return {
		stopReason: "tool_use",
		content: [{ type: "toolCall", name: "respond", arguments: args }],
	};
}

function createToolSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

async function createInteractiveGoalHarness(): Promise<{
	mode: InteractiveMode;
	session: RealAgentSession;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
}> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const initialTools = await createTools(createToolSession(tempDir.path(), settings), ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new RealAgentSession({
		agent: new core.Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();
	return {
		mode,
		session,
		modelRegistry,
		authStorage,
		tempDir,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
			resetSettingsForTest();
		},
	};
}

async function submitGuidedGoalAnswer(mode: InteractiveMode, answer: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (mode.submitGuidedGoalInput(answer)) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for guided goal input");
}

describe("guided goal setup", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		(core.instrumentedCompleteSimple as { mockRestore?: () => void }).mockRestore?.();
	});

	it("prefers the plan model", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);

		const result = await runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] });

		expect(result).toEqual({ kind: "question", question: "What is done?" });
		expect(complete.mock.calls[0]?.[0]).toBe(planModel);
		expect(complete.mock.calls[0]?.[1]?.systemPrompt?.join("\n\n")).toContain(
			"The default user-facing language is Korean.",
		);
	});

	it("routes the guided-goal request through the session provider transport", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);
		const session = createSession();

		await runGuidedGoalTurn(session, { messages: [{ role: "user", content: "Ship it" }] });

		// Regression (#5304): without a websocket-capable provider session, Codex
		// falls back to SSE and rejects websocket-only models (gpt-5.6-luna) with
		// "Model not found". The oneshot must inherit the session transport and use
		// an isolated session id so it never pollutes the main conversation state.
		const requestOptions = complete.mock.calls[0]?.[2];
		expect(requestOptions?.preferWebsockets).toBe(true);
		expect(requestOptions?.providerSessionState).toBe(session.providerSessionState);
		expect(requestOptions?.promptCacheKey).toBe("session-1");
		expect(requestOptions?.sessionId).toStartWith("session-1:guided-goal:");
		expect(requestOptions?.sessionId).not.toBe("session-1");
	});

	it("reuses a supplied side session id across interview turns", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);
		const session = createSession();
		const sideSessionId = "session-1:guided-goal:fixed";

		// Regression (#5471 review): a multi-question interview must share one Codex
		// side session so it does not leak a websocket-only socket per turn and trip
		// websocket_connection_limit_reached (which drops back to the rejected SSE path).
		await runGuidedGoalTurn(session, { messages: [{ role: "user", content: "Ship it" }], sideSessionId });
		await runGuidedGoalTurn(session, { messages: [{ role: "user", content: "More" }], sideSessionId });

		expect(complete.mock.calls[0]?.[2]?.sessionId).toBe(sideSessionId);
		expect(complete.mock.calls[1]?.[2]?.sessionId).toBe(sideSessionId);
	});

	it("falls back to slow when plan is unavailable", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver the confirmed feature." }) as never,
		);

		const result = await runGuidedGoalTurn(createSession({ plan: false, slow: true }), {
			messages: [{ role: "user", content: "Ship it" }],
		});

		expect(result).toEqual({ kind: "ready", objective: "Deliver the confirmed feature." });
		expect(complete.mock.calls[0]?.[0]).toBe(slowModel);
	});

	it("throws when no guided-goal fallback model resolves", async () => {
		await expect(
			runGuidedGoalTurn(createSession({ plan: false, slow: false }), {
				messages: [{ role: "user", content: "Ship it" }],
			}),
		).rejects.toThrow("No plan, slow, or current session model is available for /guided-goal.");
	});

	it("falls back to the current session model when plan and slow roles are unresolved", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver with the active model." }) as never,
		);

		const result = await runGuidedGoalTurn(
			createSession({ plan: false, slow: false, current: true, thinkingLevel: ThinkingLevel.High }),
			{ messages: [{ role: "user", content: "Ship it" }] },
		);

		expect(result).toEqual({ kind: "ready", objective: "Deliver with the active model." });
		expect(complete.mock.calls[0]?.[0]).toBe(currentModel);
		expect((complete.mock.calls[0]?.[2] as { reasoning?: ThinkingLevel } | undefined)?.reasoning).toBe(
			ThinkingLevel.High,
		);
	});

	it("preserves disabled reasoning when falling back to the current session model", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver without reasoning." }) as never,
		);

		await runGuidedGoalTurn(
			createSession({ plan: false, slow: false, current: true, thinkingLevel: ThinkingLevel.Off }),
			{ messages: [{ role: "user", content: "Ship it" }] },
		);

		expect((complete.mock.calls[0]?.[2] as { disableReasoning?: boolean } | undefined)?.disableReasoning).toBe(true);
	});

	it("rejects malformed structured responses", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(mockResponse({ kind: "ready" }) as never);

		await expect(
			runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] }),
		).rejects.toThrow("guided goal returned an invalid response");
	});

	it("captures a draft objective alongside a question", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?", objective: "Ship the feature." }) as never,
		);

		const result = await runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] });

		expect(result).toEqual({ kind: "question", question: "What is done?", objective: "Ship the feature." });
	});

	it("returns structured choices for the rich guided-goal question dialog", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({
				kind: "question",
				header: "저장 위치",
				question: "프로젝트를 어디에 만들까요?",
				options: [
					{ label: "현재 폴더", description: "현재 작업 디렉터리에 생성합니다." },
					{ label: "새 하위 폴더", description: "별도 하위 디렉터리에 생성합니다.", preview: "demo/" },
				],
				recommended: 1,
				multi: false,
				objective: "NestJS MSA 예제를 구성한다.",
			}) as never,
		);

		const result = await runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] });

		expect(result).toEqual({
			kind: "question",
			header: "저장 위치",
			question: "프로젝트를 어디에 만들까요?",
			options: [
				{ label: "현재 폴더", description: "현재 작업 디렉터리에 생성합니다." },
				{ label: "새 하위 폴더", description: "별도 하위 디렉터리에 생성합니다.", preview: "demo/" },
			],
			recommended: 1,
			multi: false,
			objective: "NestJS MSA 예제를 구성한다.",
		});
	});

	it("uses the rich ask dialog and records only the answered exchange in the transcript", async () => {
		const harness = await createInteractiveGoalHarness();
		try {
			const model = harness.session.model;
			if (!model) throw new Error("expected session model");
			spyOn(harness.session, "resolveRoleModelWithThinking").mockReturnValue({
				model,
				explicitThinkingLevel: false,
			} as never);
			spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue("test-key");
			const complete = spyOn(core, "instrumentedCompleteSimple");
			complete
				.mockResolvedValueOnce(
					mockResponse({
						kind: "question",
						header: "저장 위치",
						question: "프로젝트를 어디에 만들까요?",
						options: [
							{ label: "현재 폴더", description: "현재 작업 디렉터리에 생성합니다." },
							{ label: "새 하위 폴더", description: "demo 하위에 생성합니다." },
						],
						recommended: 1,
						objective: "NestJS MSA 예제를 구성한다.",
					}) as never,
				)
				.mockResolvedValueOnce(
					mockResponse({ kind: "ready", objective: "demo에 NestJS MSA 예제를 구성한다." }) as never,
				);
			const askDialog = vi.fn(async () => ({
				kind: "submit" as const,
				results: [
					{
						id: "guided-goal-1",
						question: "프로젝트를 어디에 만들까요?",
						options: ["현재 폴더", "새 하위 폴더"],
						multi: false,
						selectedOptions: ["새 하위 폴더"],
					},
				],
			}));
			vi.spyOn(harness.mode, "getToolUIContext").mockReturnValue({ askDialog } as never);

			const interview = harness.mode.handleGuidedGoalCommand("NestJS MSA 예제를 만들어줘");
			await submitGuidedGoalAnswer(harness.mode, "demo에 NestJS MSA 예제를 구성한다.");
			await interview;

			expect(askDialog).toHaveBeenCalledWith([
				{
					id: "guided-goal-1",
					question: "프로젝트를 어디에 만들까요?",
					header: "1/6 · 저장 위치",
					options: [
						{ label: "현재 폴더", description: "현재 작업 디렉터리에 생성합니다." },
						{ label: "새 하위 폴더", description: "demo 하위에 생성합니다." },
					],
					recommended: 1,
				},
			]);
			const transcript = harness.mode.chatContainer.render(120).join("\n");
			expect(transcript).toContain("프로젝트를 어디에 만들까요?");
			expect(transcript).toContain("새 하위 폴더");
			expect(transcript).toContain("demo 하위에 생성합니다.");
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("demo에 NestJS MSA 예제를 구성한다.");
			expect(harness.session.getGoalModeState()?.controller).toBe("goal");
			expect(harness.session.taskLifecycle.state).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("starts ZZWorkflow only through the dedicated guided command", async () => {
		const harness = await createInteractiveGoalHarness();
		try {
			const model = harness.session.model;
			if (!model) throw new Error("expected session model");
			spyOn(harness.session, "resolveRoleModelWithThinking").mockReturnValue({
				model,
				explicitThinkingLevel: false,
			} as never);
			spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue("test-key");
			spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
				mockResponse({ kind: "ready", objective: "승인된 Plan DAG로 작업한다." }) as never,
			);

			const interview = harness.mode.handleZZWorkflowGuidedGoalCommand("제어형 작업을 시작해줘");
			await submitGuidedGoalAnswer(harness.mode, "승인된 Plan DAG로 작업한다.");
			await interview;

			expect(harness.session.getGoalModeState()?.controller).toBe("zzworkflow");
			expect(harness.session.taskLifecycle.state?.phase).toBe("AWAITING_USER");
		} finally {
			await harness.cleanup();
		}
	});

	it("obfuscates secrets in the transcript before the request and deobfuscates the echoed objective", async () => {
		const obfuscator = {
			hasSecrets: () => true,
			obfuscate: (text: string) => text.replaceAll("SECRET123", "#S0#"),
			deobfuscate: (text: string) => text.replaceAll("#S0#", "SECRET123"),
		};
		const session = { ...createSession(), obfuscator } as unknown as AgentSession;
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			// The model echoes the obfuscated placeholder back inside its objective.
			mockResponse({ kind: "ready", objective: "Rotate the key #S0# and redeploy." }) as never,
		);

		const result = await runGuidedGoalTurn(session, {
			messages: [{ role: "user", content: "my api key is SECRET123, automate rotation" }],
		});

		// The provider never sees the raw secret — only the placeholder.
		const sentContext = complete.mock.calls[0]?.[1] as { messages: Array<{ content: Array<{ text: string }> }> };
		const sentText = sentContext.messages[0]!.content[0]!.text;
		expect(sentText).not.toContain("SECRET123");
		expect(sentText).toContain("#S0#");

		// The objective is restored to the real secret before the goal starts.
		expect(result).toEqual({ kind: "ready", objective: "Rotate the key SECRET123 and redeploy." });
	});

	it("salvages the latest guided objective when the turn cap ends on a question without one", async () => {
		const harness = await createInteractiveGoalHarness();
		try {
			const model = harness.session.model;
			if (!model) throw new Error("expected session model");
			spyOn(harness.session, "resolveRoleModelWithThinking").mockReturnValue({
				model,
				explicitThinkingLevel: false,
			} as never);
			spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue("test-key");
			const complete = spyOn(core, "instrumentedCompleteSimple");
			complete
				.mockResolvedValueOnce(
					mockResponse({
						kind: "question",
						question: "Who is the user?",
						objective: "Draft one.",
					}) as never,
				)
				.mockResolvedValueOnce(
					mockResponse({
						kind: "question",
						question: "What is success?",
						objective: "Draft two is the latest usable objective.",
					}) as never,
				)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Constraint?" }) as never)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Timeline?" }) as never)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Risk?" }) as never)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Anything else?" }) as never);
			const editor = vi.spyOn(harness.mode, "showHookEditor");
			const workingMessage = vi.spyOn(harness.mode, "setWorkingMessage");
			const warning = vi.spyOn(harness.mode, "showWarning");

			const interview = harness.mode.handleGuidedGoalCommand("Initial goal");
			await submitGuidedGoalAnswer(harness.mode, "answer 1");
			await submitGuidedGoalAnswer(harness.mode, "answer 2");
			await submitGuidedGoalAnswer(harness.mode, "answer 3");
			await submitGuidedGoalAnswer(harness.mode, "answer 4");
			await submitGuidedGoalAnswer(harness.mode, "answer 5");
			await submitGuidedGoalAnswer(harness.mode, "answer 6");
			await submitGuidedGoalAnswer(harness.mode, "Confirmed objective.");
			await interview;

			expect(editor).not.toHaveBeenCalled();
			expect(harness.mode.ensureLoadingAnimation).toHaveBeenCalledTimes(6);
			expect(workingMessage).toHaveBeenCalledWith("목표 인터뷰 응답을 생성하는 중…");
			const transcript = harness.mode.chatContainer.render(120).join("\n");
			expect(transcript).toContain("Who is the user?");
			expect(transcript).toContain("answer 1");
			expect(transcript).toContain("Draft two is the latest usable objective.");
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("Confirmed objective.");
			expect(warning).not.toHaveBeenCalledWith(
				"목표를 확정하려면 정보가 더 필요합니다. 범위를 좁혀 /guided-goal을 다시 실행하세요.",
			);
		} finally {
			await harness.cleanup();
		}
	});
});
