/**
 * Regression test for #2935 and #4845: the plugins/marketplace docs advertise
 * `zz list` / `zz remove` / `zz marketplace <sub>` / `zz uninstall …` etc.
 * as top-level commands, but only `zz install` is registered. Before the fix,
 * `resolveCliArgv(["list"])` rewrote the bare verb to `["launch", "list"]`, so
 * `zz list` silently started an interactive agent session with "list" as the
 * initial LLM prompt instead of managing plugins (the real command is
 * `zz plugin list`). #4845 extended the same footgun to the multi-word
 * documented grammar: `zz marketplace add xyz` leaked the whole argv to the
 * model as a prompt.
 *
 * These tests pin the chosen bugfix: a documented plugin/marketplace verb that
 * is bare, or that follows the documented grammar (a marketplace sub-action or a
 * `name@marketplace` plugin id), yields a helpful hint pointing at the real
 * `zz plugin <action>` command rather than leaking to the model — while
 * genuine prose prompts that merely begin with one of these words still fall
 * through to `launch`.
 *
 * Imported via a relative path (not the `@oh-my-pi/pi-coding-agent` alias) so the
 * assertions exercise this checkout's `cli-commands.ts` directly.
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "../src/cli-commands";

describe("documented-but-unregistered plugin verbs do not leak to launch (#2935)", () => {
	test("bare `zz list` hints at `zz plugin list` instead of launching with 'list' as the prompt", () => {
		const result = resolveCliArgv(["list"]);
		// Must NOT be the old silent-launch behavior.
		expect(result).not.toEqual({ argv: ["launch", "list"] });
		expect(result).not.toHaveProperty("argv");
		// Must point at the real command.
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("zz plugin list");
	});

	test("bare `zz remove` hints at `zz plugin uninstall` instead of launching with 'remove' as the prompt", () => {
		const result = resolveCliArgv(["remove"]);
		expect(result).not.toEqual({ argv: ["launch", "remove"] });
		expect(result).not.toHaveProperty("argv");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("zz plugin uninstall");
	});

	test("genuine multi-word prompts beginning with these verbs still route to launch", () => {
		// A real prompt that happens to start with `list`/`remove` must not be hijacked.
		expect(resolveCliArgv(["list", "all", "my", "files"])).toEqual({
			argv: ["launch", "list", "all", "my", "files"],
		});
		expect(resolveCliArgv(["remove", "the", "unused", "import"])).toEqual({
			argv: ["launch", "remove", "the", "unused", "import"],
		});
	});

	test("the hint path does not pretend these are real subcommands", () => {
		// We surface guidance; we do not invent new top-level commands.
		expect(isSubcommand("list")).toBe(false);
		expect(isSubcommand("remove")).toBe(false);
	});

	test("multi-word `zz marketplace add xyz` hints at `zz plugin marketplace` instead of leaking to the prompt (#4845)", () => {
		const result = resolveCliArgv(["marketplace", "add", "xyz"]);
		expect(result).not.toEqual({ argv: ["launch", "marketplace", "add", "xyz"] });
		expect(result).not.toHaveProperty("argv");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("zz plugin marketplace");
	});

	test("bare marketplace-family verbs hint at their `zz plugin` command (#4845)", () => {
		for (const [verb, hint] of [
			["marketplace", "zz plugin marketplace"],
			["discover", "zz plugin discover"],
			["upgrade", "zz plugin upgrade"],
			["uninstall", "zz plugin uninstall"],
			["enable", "zz plugin enable"],
			["disable", "zz plugin disable"],
		] as const) {
			const result = resolveCliArgv([verb]);
			expect(result).not.toHaveProperty("argv");
			expect("error" in result && result.error).toContain(hint);
		}
	});

	test("`name@marketplace` plugin ids hint instead of launching (#4845)", () => {
		for (const verb of ["uninstall", "upgrade", "enable", "disable"] as const) {
			const result = resolveCliArgv([verb, "code-review@claude-plugins-official"]);
			expect(result).not.toHaveProperty("argv");
			expect(result).toHaveProperty("error");
		}
	});

	test("plugin ids after documented flags hint instead of leaking to launch", () => {
		for (const verb of ["uninstall", "upgrade", "enable", "disable"] as const) {
			const result = resolveCliArgv([verb, "--scope", "project", "code-review@claude-plugins-official"]);
			expect(result).not.toHaveProperty("argv");
			expect(result).toHaveProperty("error");
		}
	});

	test("prose prompts beginning with the new verbs still route to launch (#4845)", () => {
		expect(resolveCliArgv(["upgrade", "the", "deps"])).toEqual({
			argv: ["launch", "upgrade", "the", "deps"],
		});
		// `marketplace` followed by a non-subcommand word is a genuine prompt.
		expect(resolveCliArgv(["marketplace", "research", "for", "me"])).toEqual({
			argv: ["launch", "marketplace", "research", "for", "me"],
		});
	});
});
