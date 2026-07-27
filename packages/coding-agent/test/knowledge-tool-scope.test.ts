import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { KnowledgeRecallTool } from "@oh-my-pi/pi-coding-agent/tools/knowledge-recall";
import { KnowledgeReflectTool } from "@oh-my-pi/pi-coding-agent/tools/knowledge-reflect";
import { KnowledgeRetainTool } from "@oh-my-pi/pi-coding-agent/tools/knowledge-retain";
import { KnowledgeRetainDocumentTool } from "@oh-my-pi/pi-coding-agent/tools/knowledge-retain-document";
import { type } from "arktype";

const session = {} as ToolSession;

describe("ZZ Knowledge branch provenance", () => {
	it("accepts durable retain scopes and rejects branch as a scope", () => {
		const retain = new KnowledgeRetainTool(session);
		const validRetain = {
			scope: "repo" as const,
			form: "fact" as const,
			domain: "repository" as const,
			source: "document" as const,
			confidence: "confirmed" as const,
			knowledge_key: "repository/build-command",
			statement: "Build with bun run build.",
			future_use: "Use the supported build command.",
			request_origin: "agent-initiated" as const,
		};
		expect(retain.parameters(validRetain) instanceof type.errors).toBe(false);
		expect(retain.parameters({ ...validRetain, scope: "branch" }) instanceof type.errors).toBe(true);

		const retainDocument = new KnowledgeRetainDocumentTool(session);
		const validDocument = {
			content_class: "canonical-document" as const,
			scope: "task" as const,
			domain: "architecture" as const,
			source: "document" as const,
			confidence: "confirmed" as const,
			source_id: "docs/architecture.md",
			title: "Architecture",
			content: "Repository architecture reference.",
			future_use: "Consult before architectural changes.",
			update_mode: "replace" as const,
			request_origin: "agent-initiated" as const,
		};
		expect(retainDocument.parameters(validDocument) instanceof type.errors).toBe(false);
		expect(retainDocument.parameters({ ...validDocument, scope: "branch" }) instanceof type.errors).toBe(true);
	});

	it("rejects branch selectors from recall and reflect requests", () => {
		const recall = new KnowledgeRecallTool(session);
		const validRecall = {
			purpose: "implementation" as const,
			query: "repository conventions",
			depth: "normal" as const,
			repo: true,
		};
		expect(recall.parameters(validRecall) instanceof type.errors).toBe(false);
		expect(recall.parameters({ ...validRecall, branch: true }) instanceof type.errors).toBe(true);

		const reflect = new KnowledgeReflectTool(session);
		const validReflect = {
			purpose: "plan-critique" as const,
			question: "Does this conflict with prior decisions?",
			repo: true,
		};
		expect(reflect.parameters(validReflect) instanceof type.errors).toBe(false);
		expect(reflect.parameters({ ...validReflect, branch: true }) instanceof type.errors).toBe(true);
	});
});
