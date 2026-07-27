import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import type { KnowledgeTagGroup } from "./tag-policy";

export interface HindsightKnowledgeClientOptions {
	baseUrl: string;
	apiKey?: string;
	requestTimeoutMs: number;
	reflectTimeoutMs: number;
	recallTimeoutMs: number;
	retainTimeoutMs: number;
}

export interface HindsightKnowledgeRecallResult {
	id?: string;
	text: string;
	type?: string | null;
	context?: string | null;
	metadata?: Record<string, string> | null;
	tags?: string[] | null;
	entities?: string[] | null;
	mentioned_at?: string | null;
	occurred_start?: string | null;
	occurred_end?: string | null;
	document_id?: string | null;
	chunk_id?: string | null;
	source_fact_ids?: string[] | null;
}

export interface HindsightKnowledgeRecallResponse {
	results: HindsightKnowledgeRecallResult[];
	source_facts?: Record<string, HindsightKnowledgeRecallResult> | null;
	chunks?: Record<string, { id: string; text: string; chunk_index: number; truncated: boolean }> | null;
}

export interface HindsightKnowledgeMentalModel {
	id: string;
	name: string;
	content?: string | null;
	tags?: string[];
	last_refreshed_at?: string | null;
}

export interface HindsightBankConfigResponse {
	config?: Record<string, unknown>;
	overrides?: Record<string, unknown>;
}

interface RequestOptions {
	body?: Record<string, unknown>;
	query?: Record<string, string | number | undefined>;
	allow404?: boolean;
	timeoutMs?: number;
}

function compoundTagMatch(
	match: "any" | "all" | "any_strict" | "all_strict" | "exact" | undefined,
): "any_strict" | "all_strict" | "exact" {
	if (match === "any" || match === "any_strict") return "any_strict";
	if (match === "exact") return "exact";
	return "all_strict";
}

export class KnowledgeProviderError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "KnowledgeProviderError";
	}
}

export class HindsightKnowledgeClient {
	readonly #baseUrl: string;
	readonly #headers: Record<string, string>;
	readonly #requestTimeoutMs: number;
	readonly #reflectTimeoutMs: number;
	readonly #recallTimeoutMs: number;
	readonly #retainTimeoutMs: number;

	constructor(options: HindsightKnowledgeClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#headers = {
			"Content-Type": "application/json",
			"User-Agent": "zz-knowledge-system",
		};
		if (options.apiKey) this.#headers.Authorization = `Bearer ${options.apiKey}`;
		this.#requestTimeoutMs = options.requestTimeoutMs;
		this.#reflectTimeoutMs = options.reflectTimeoutMs;
		this.#recallTimeoutMs = options.recallTimeoutMs;
		this.#retainTimeoutMs = options.retainTimeoutMs;
	}

	createBank(bankId: string, name: string): Promise<Record<string, unknown>> {
		return this.#request("PUT", `/v1/default/banks/${encodeURIComponent(bankId)}`, "create bank", {
			body: { name },
		});
	}

	getBankConfig(bankId: string): Promise<HindsightBankConfigResponse> {
		return this.#request("GET", `/v1/default/banks/${encodeURIComponent(bankId)}/config`, "get bank configuration");
	}

	updateBankConfig(bankId: string, updates: Record<string, unknown>): Promise<HindsightBankConfigResponse> {
		return this.#request(
			"PATCH",
			`/v1/default/banks/${encodeURIComponent(bankId)}/config`,
			"update bank configuration",
			{ body: { updates } },
		);
	}

	recall(
		bankId: string,
		query: string,
		options: {
			maxTokens: number;
			tags?: string[];
			tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact";
			tagGroups?: KnowledgeTagGroup[];
			types?: Array<"world" | "experience" | "observation">;
			preferObservations?: boolean;
			includeSourceFacts?: boolean;
			includeChunks?: boolean;
		},
	): Promise<HindsightKnowledgeRecallResponse> {
		const tagGroups = options.tagGroups ? [...options.tagGroups] : [];
		if (options.tags && options.tags.length > 0 && tagGroups.length > 0) {
			tagGroups.unshift({ tags: options.tags, match: compoundTagMatch(options.tagsMatch) });
		}
		const usesCompoundTags = tagGroups.length > 0;
		return this.#request("POST", `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`, "recall", {
			body: {
				query,
				max_tokens: options.maxTokens,
				budget: "mid",
				tags: usesCompoundTags ? undefined : options.tags,
				tags_match: usesCompoundTags ? undefined : options.tagsMatch,
				tag_groups: usesCompoundTags ? tagGroups : undefined,
				types: options.types,
				prefer_observations: options.preferObservations,
				include: {
					entities: null,
					source_facts: options.includeSourceFacts ? {} : null,
					chunks: options.includeChunks ? {} : null,
				},
			},
			timeoutMs: this.#recallTimeoutMs,
		});
	}

	retain(
		bankId: string,
		input: {
			content: string;
			context: string;
			metadata: Record<string, string>;
			documentId: string;
			tags: string[];
			occurredAt?: string;
			updateMode: "append" | "replace";
			strategy: string;
			observationScopes: string[][];
			async?: boolean;
		},
	): Promise<Record<string, unknown>> {
		return this.#request("POST", `/v1/default/banks/${encodeURIComponent(bankId)}/memories`, "retain", {
			body: {
				items: [
					{
						content: input.content,
						context: input.context,
						metadata: input.metadata,
						document_id: input.documentId,
						tags: input.tags,
						timestamp: input.occurredAt,
						update_mode: input.updateMode,
						observation_scopes: input.observationScopes,
					},
				],
				strategy: input.strategy,
				async: input.async ?? true,
			},
			timeoutMs: this.#retainTimeoutMs,
		});
	}

	reflect(
		bankId: string,
		question: string,
		options: {
			context: string;
			tags?: string[];
			tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact";
			tagGroups?: KnowledgeTagGroup[];
		},
	): Promise<{ text?: string }> {
		const tagGroups = options.tagGroups ? [...options.tagGroups] : [];
		if (options.tags && options.tags.length > 0 && tagGroups.length > 0) {
			tagGroups.unshift({ tags: options.tags, match: compoundTagMatch(options.tagsMatch) });
		}
		const usesCompoundTags = tagGroups.length > 0;
		return this.#request("POST", `/v1/default/banks/${encodeURIComponent(bankId)}/reflect`, "reflect", {
			body: {
				query: question,
				context: options.context,
				budget: "mid",
				tags: usesCompoundTags ? undefined : options.tags,
				tags_match: usesCompoundTags ? undefined : options.tagsMatch,
				tag_groups: usesCompoundTags ? tagGroups : undefined,
			},
			timeoutMs: this.#reflectTimeoutMs,
		});
	}

	getDocument(bankId: string, documentId: string): Promise<Record<string, unknown> | null> {
		return this.#request(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"get document",
			{ allow404: true },
		);
	}

	updateDocument(bankId: string, documentId: string, tags: string[]): Promise<Record<string, unknown>> {
		return this.#request(
			"PATCH",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"update document",
			{ body: { tags } },
		);
	}

	deleteDocument(bankId: string, documentId: string): Promise<Record<string, unknown>> {
		return this.#request(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"delete document",
		);
	}

	listMentalModels(
		bankId: string,
		detail: "metadata" | "content" = "content",
	): Promise<{ items: HindsightKnowledgeMentalModel[] }> {
		return this.#request(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`,
			"list mental models",
			{ query: { detail } },
		);
	}

	createMentalModel(
		bankId: string,
		input: {
			id: string;
			name: string;
			sourceQuery: string;
			tags: string[];
			maxTokens: number;
		},
	): Promise<Record<string, unknown>> {
		return this.#request(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`,
			"create mental model",
			{
				body: {
					id: input.id,
					name: input.name,
					source_query: input.sourceQuery,
					tags: input.tags,
					max_tokens: input.maxTokens,
					trigger: {
						mode: "full",
						refresh_after_consolidation: false,
					},
				},
			},
		);
	}

	refreshMentalModel(bankId: string, mentalModelId: string): Promise<Record<string, unknown>> {
		return this.#request(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}/refresh`,
			"refresh mental model",
		);
	}

	async #request<T>(method: string, requestPath: string, operation: string, options: RequestOptions = {}): Promise<T> {
		const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
		let response: Response;
		const url = new URL(`${this.#baseUrl}${requestPath}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		try {
			response = await fetch(url, {
				method,
				headers: this.#headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: withTimeoutSignal(timeoutMs),
			});
		} catch (error) {
			const detail = isTimeoutError(error)
				? `${operation} timed out after ${Math.round(timeoutMs / 1_000)}s`
				: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`;
			throw new KnowledgeProviderError(detail, undefined, error);
		}
		if (options.allow404 && response.status === 404) return null as T;
		const text = await response.text();
		let parsed: unknown = {};
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		if (!response.ok) {
			throw new KnowledgeProviderError(`${operation} failed with HTTP ${response.status}`, response.status, parsed);
		}
		return parsed as T;
	}
}
