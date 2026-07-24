import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { loadOrCreateMachineId, normalizeGitRemoteUrl, resolveRepositoryIdentity } from "../src/workflow/identity";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow identity", () => {
	it("normalizes SSH and HTTPS remotes to one canonical repository identity", () => {
		expect(normalizeGitRemoteUrl("git@github.com:Example/Project.git")).toBe("github.com/Example/Project");
		expect(normalizeGitRemoteUrl("https://github.com/Example/Project.git")).toBe("github.com/Example/Project");
	});

	it("derives the same repository id from the same remote in different checkouts", async () => {
		const first = await tempDir("omp-workflow-repo-a-");
		const second = await tempDir("omp-workflow-repo-b-");
		for (const dir of [first, second]) {
			await $`git init --initial-branch=main`.cwd(dir).quiet();
			await $`git remote add origin git@github.com:example/project.git`.cwd(dir).quiet();
		}

		const firstIdentity = await resolveRepositoryIdentity(first);
		const secondIdentity = await resolveRepositoryIdentity(second);

		expect(firstIdentity).toEqual(secondIdentity);
		expect(firstIdentity.source).toBe("canonical-remote");
	});

	it("uses the repository UUID from project config ahead of local path or remote", async () => {
		const dir = await tempDir("omp-workflow-project-id-");
		await $`git init --initial-branch=main`.cwd(dir).quiet();
		await fs.mkdir(path.join(dir, ".omp-agent"), { recursive: true });
		await Bun.write(
			path.join(dir, ".omp-agent", "project.yml"),
			"repositoryId: 01J4ZB8T56KME3Q1D1R6QPGM51\ncanonicalRemote: https://github.com/example/project.git\n",
		);

		expect(await resolveRepositoryIdentity(dir)).toEqual({
			repositoryId: "01J4ZB8T56KME3Q1D1R6QPGM51",
			canonicalRemote: "github.com/example/project",
			source: "project-config",
		});
	});

	it("persists one stable machine id", async () => {
		const dir = await tempDir("omp-workflow-machine-");
		const file = path.join(dir, "machine-id");

		const first = await loadOrCreateMachineId(file);
		const second = await loadOrCreateMachineId(file);

		expect(second).toBe(first);
		expect((await Bun.file(file).text()).trim()).toBe(first);
	});
});
