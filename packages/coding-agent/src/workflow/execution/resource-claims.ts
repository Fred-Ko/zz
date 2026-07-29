import * as path from "node:path";
import type { ZZWResourceClaim } from "./types";

const CAPACITY_KINDS = new Set(["cpu", "memory"]);

function normalizePathKey(key: string): string {
	const normalized = key
		.replaceAll("\\", "/")
		.replace(/^\.\//, "")
		.replace(/\/\*\*?$/u, "");
	if (!normalized || normalized === ".") return ".";
	return path.posix.normalize(normalized).replace(/^\.\//, "").replace(/\/$/u, "");
}

function normalizeOpaqueKey(key: string): string {
	return key.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function normalizeResourceClaim(claim: ZZWResourceClaim): ZZWResourceClaim {
	return {
		kind: claim.kind,
		key: claim.kind === "workspace-path" ? normalizePathKey(claim.key) : normalizeOpaqueKey(claim.key),
		access: claim.access,
	};
}

function pathKeysOverlap(left: string, right: string): boolean {
	if (left === "." || right === ".") return true;
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function resourceKeysOverlap(left: ZZWResourceClaim, right: ZZWResourceClaim): boolean {
	if (left.kind !== right.kind) return false;
	if (CAPACITY_KINDS.has(left.kind)) return false;
	const normalizedLeft = normalizeResourceClaim(left);
	const normalizedRight = normalizeResourceClaim(right);
	return left.kind === "workspace-path"
		? pathKeysOverlap(normalizedLeft.key, normalizedRight.key)
		: normalizedLeft.key === normalizedRight.key;
}

export function resourceClaimsConflict(left: ZZWResourceClaim, right: ZZWResourceClaim): boolean {
	if (!resourceKeysOverlap(left, right)) return false;
	return left.access !== "read" || right.access !== "read";
}

export function resourceClaimSetsConflict(
	left: readonly ZZWResourceClaim[],
	right: readonly ZZWResourceClaim[],
): boolean {
	return left.some(leftClaim => right.some(rightClaim => resourceClaimsConflict(leftClaim, rightClaim)));
}

interface ActiveClaimLease {
	claims: readonly ZZWResourceClaim[];
	done: Promise<void>;
	release(): void;
}

/**
 * In-process admission lock for one durable Execution Wave. Durable conflict
 * decisions are made by the scheduler; this lock preserves the same resource
 * contract while asynchronously launched Lane promises move from queued to
 * running.
 */
export class ZZWResourceClaimLock {
	readonly #active = new Map<string, ActiveClaimLease>();

	async run<T>(laneId: string, claims: readonly ZZWResourceClaim[], execute: () => Promise<T>): Promise<T> {
		while (true) {
			const blockers = [...this.#active.values()].filter(active => resourceClaimSetsConflict(claims, active.claims));
			if (blockers.length === 0) break;
			await Promise.race(blockers.map(blocker => blocker.done));
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#active.set(laneId, { claims: claims.map(claim => ({ ...claim })), done: promise, release: resolve });
		try {
			return await execute();
		} finally {
			const active = this.#active.get(laneId);
			this.#active.delete(laneId);
			active?.release();
		}
	}
}
