import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt default language", () => {
	it("keeps Korean as the user-facing default with either the built-in or a custom system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-system-prompt-language-");
		for (const resolvedCustomPrompt of [undefined, "Custom system prompt"]) {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: tempDir.path(),
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: [],
				workspaceTree: { ...EMPTY_TREE, rootPath: tempDir.path() },
				resolvedCustomPrompt,
			});
			const rendered = systemPrompt.join("\n\n");
			expect(rendered).toContain("The default user-facing language is Korean.");
			expect(rendered).toContain("Unless the user explicitly requests another language");
		}
	});
});
