import * as path from "node:path";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import * as git from "../utils/git";

export interface RepositoryIdentity {
	repositoryId: string;
	canonicalRemote?: string;
	displayName: string;
	source: "project-config" | "canonical-remote" | "local-path";
}

interface ProjectIdentityConfig {
	repositoryId?: string;
	canonicalRemote?: string;
	displayName?: string;
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
	const displayName =
		typeof value.displayName === "string" && value.displayName.trim() ? value.displayName.trim() : undefined;
	if (!repositoryId && !canonicalRemote && !displayName) return undefined;
	return { repositoryId, canonicalRemote, displayName };
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

export function repositoryNameFromCanonicalRemote(canonicalRemote: string): string | undefined {
	const segments = canonicalRemote.split("/").filter(Boolean);
	if (segments.length < 2) return undefined;
	const repositoryPath = segments.slice(1).join("/").trim();
	return repositoryPath || undefined;
}

export async function resolveRepositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
	const resolvedCwd = path.resolve(cwd);
	const repoRoot = await git.repo.root(resolvedCwd);
	if (!repoRoot) {
		return {
			repositoryId: `local-${stableId(resolvedCwd)}`,
			displayName: path.basename(resolvedCwd),
			source: "local-path",
		};
	}

	const configured = await loadProjectIdentity(repoRoot);
	if (configured?.repositoryId) {
		const displayName =
			configured.displayName ??
			(configured.canonicalRemote ? repositoryNameFromCanonicalRemote(configured.canonicalRemote) : undefined) ??
			path.basename(repoRoot);
		return {
			repositoryId: configured.repositoryId,
			canonicalRemote: configured.canonicalRemote,
			displayName,
			source: "project-config",
		};
	}

	const remoteUrl = configured?.canonicalRemote ?? (await git.remote.url(repoRoot, "origin"));
	if (remoteUrl) {
		const canonicalRemote = normalizeGitRemoteUrl(remoteUrl);
		const dashboardRemote = configured
			? canonicalRemote
			: normalizeGitRemoteUrl((await git.remote.url(repoRoot, "fork")) ?? remoteUrl);
		return {
			repositoryId: `remote-${stableId(canonicalRemote)}`,
			canonicalRemote,
			displayName:
				configured?.displayName ?? repositoryNameFromCanonicalRemote(dashboardRemote) ?? path.basename(repoRoot),
			source: configured ? "project-config" : "canonical-remote",
		};
	}

	return {
		repositoryId: `local-${stableId(repoRoot)}`,
		displayName: configured?.displayName ?? path.basename(repoRoot),
		source: "local-path",
	};
}
