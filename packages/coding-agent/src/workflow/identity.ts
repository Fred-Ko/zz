import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import * as git from "../utils/git";

export interface RepositoryIdentity {
	repositoryId: string;
	canonicalRemote?: string;
	source: "project-config" | "canonical-remote" | "local-path";
}

interface ProjectIdentityConfig {
	repositoryId?: string;
	canonicalRemote?: string;
}

function stableId(value: string): string {
	return Bun.hash(value).toString(16).padStart(16, "0");
}

function projectIdentityConfig(value: unknown): ProjectIdentityConfig | undefined {
	if (!isRecord(value)) return undefined;
	const repositoryId =
		typeof value.repositoryId === "string" && value.repositoryId.trim() ? value.repositoryId.trim() : undefined;
	const canonicalRemote =
		typeof value.canonicalRemote === "string" && value.canonicalRemote.trim()
			? normalizeGitRemoteUrl(value.canonicalRemote)
			: undefined;
	if (!repositoryId && !canonicalRemote) return undefined;
	return { repositoryId, canonicalRemote };
}

async function loadProjectIdentity(repoRoot: string): Promise<ProjectIdentityConfig | undefined> {
	for (const directory of [".zz-agent", ".omp-agent"]) {
		const file = Bun.file(path.join(repoRoot, directory, "project.yml"));
		try {
			return projectIdentityConfig(YAML.parse(await file.text()));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return undefined;
}

export function normalizeGitRemoteUrl(remoteUrl: string): string {
	const value = remoteUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	if (!value) return value;

	const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
	if (scpLike && !value.includes("://")) {
		return `${scpLike[1]?.toLowerCase()}/${scpLike[2]?.replace(/^\/+/, "")}`;
	}

	try {
		const parsed = new URL(value);
		const pathname = parsed.pathname.replace(/^\/+/, "");
		return `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}/${pathname}`;
	} catch {
		return value.toLowerCase();
	}
}

export async function resolveRepositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
	const resolvedCwd = path.resolve(cwd);
	const repoRoot = await git.repo.root(resolvedCwd);
	if (!repoRoot) {
		return {
			repositoryId: `local-${stableId(resolvedCwd)}`,
			source: "local-path",
		};
	}

	const configured = await loadProjectIdentity(repoRoot);
	if (configured?.repositoryId) {
		return {
			repositoryId: configured.repositoryId,
			canonicalRemote: configured.canonicalRemote,
			source: "project-config",
		};
	}

	const remoteUrl = configured?.canonicalRemote ?? (await git.remote.url(repoRoot, "origin"));
	if (remoteUrl) {
		const canonicalRemote = normalizeGitRemoteUrl(remoteUrl);
		return {
			repositoryId: `remote-${stableId(canonicalRemote)}`,
			canonicalRemote,
			source: configured ? "project-config" : "canonical-remote",
		};
	}

	return {
		repositoryId: `local-${stableId(repoRoot)}`,
		source: "local-path",
	};
}

export async function loadOrCreateMachineId(filePath = path.join(getConfigRootDir(), "machine-id")): Promise<string> {
	const file = Bun.file(filePath);
	try {
		const existing = (await file.text()).trim();
		if (existing) return existing;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const created = crypto.randomUUID();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	try {
		await fs.writeFile(filePath, `${created}\n`, { flag: "wx", mode: 0o600 });
		return created;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const winner = (await Bun.file(filePath).text()).trim();
		if (!winner) throw new Error(`workflow machine id at ${filePath} is empty`);
		return winner;
	}
}
