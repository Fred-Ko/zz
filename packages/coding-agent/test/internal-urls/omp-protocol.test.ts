import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

describe("ZzProtocolHandler", () => {
	it("treats zz://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("zz://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("zz://tools/read.md");
		const prefixed = await router.resolve("zz://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("keeps omp:// as a compatibility alias", async () => {
		const router = InternalUrlRouter.instance();
		const canonical = await router.resolve("zz://tools/read.md");
		const legacy = await router.resolve("omp://tools/read.md");

		expect(legacy.content).toBe(canonical.content);
	});
});
