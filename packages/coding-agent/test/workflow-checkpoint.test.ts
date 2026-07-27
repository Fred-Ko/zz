import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { captureTaskWorkspace } from "../src/goals/task-lifecycle";
import * as git from "../src/utils/git";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow Git checkpoints", () => {
	it("creates a local tracked-change checkpoint without modifying the worktree", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-checkpoint-"));
		dirs.push(dir);
		await $`git init --initial-branch=main`.cwd(dir).quiet();
		await $`git config user.email tester@example.com`.cwd(dir).quiet();
		await $`git config user.name Tester`.cwd(dir).quiet();
		await Bun.write(path.join(dir, "tracked.txt"), "baseline\n");
		await $`git add tracked.txt && git commit -m baseline`.cwd(dir).quiet();

		const clean = await captureTaskWorkspace(dir);
		expect(clean.dirtyTreeHash).toBeNull();

		await Bun.write(path.join(dir, "tracked.txt"), "changed\n");
		const checkpoint = await git.stash.create(dir, "workflow checkpoint");

		expect(checkpoint).not.toBeNull();
		expect(await Bun.file(path.join(dir, "tracked.txt")).text()).toBe("changed\n");
		expect(await git.ref.resolve(dir, checkpoint ?? "")).toBe(checkpoint);
		expect((await git.status.summary(dir))?.unstaged).toBe(1);
	});
});
