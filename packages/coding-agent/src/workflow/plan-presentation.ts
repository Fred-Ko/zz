import type { TaskPlan, TaskPlanStep, TaskPlanStepKind, TaskPlanStepStatus } from "../goals/task-lifecycle";
import { previewLine, TRUNCATE_LENGTHS } from "../tools/render-utils";

const INACTIVE_STATUSES = new Set<TaskPlanStepStatus>(["invalidated", "superseded", "abandoned"]);

const STATUS_SYMBOLS: Record<TaskPlanStepStatus, string> = {
	pending: "○",
	in_progress: "▶",
	completed: "✓",
	blocked: "!",
	invalidated: "×",
	superseded: "↺",
	abandoned: "—",
};

const KIND_LABELS: Record<TaskPlanStepKind, string> = {
	work: "작업",
	validation: "검증",
	acceptance: "인수",
	milestone: "마일스톤",
};

/** A deterministic Markdown projection of the authoritative Plan DAG. */
export interface ZZWorkflowPlanDiagram {
	source: string;
	markdown: string;
	visibleStepIds: string[];
	hiddenStepIds: string[];
}

function mermaidLabel(value: string): string {
	const safe = value
		.replace(/[[\]{}()<>"`|&\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return previewLine(safe || "내용 없음", TRUNCATE_LENGTHS.SHORT);
}

function nodeDefinition(nodeId: string, step: TaskPlanStep): string {
	const kind = step.kind ?? "work";
	const content = typeof step.content === "string" ? step.content : "복구가 필요한 단계";
	const label = mermaidLabel(`${STATUS_SYMBOLS[step.status]} ${step.id} · ${KIND_LABELS[kind]} · ${content}`);
	switch (kind) {
		case "validation":
			return `${nodeId}{{${label}}}`;
		case "acceptance":
			return `${nodeId}([${label}])`;
		case "milestone":
			return `${nodeId}[[${label}]]`;
		default:
			return `${nodeId}[${label}]`;
	}
}

/**
 * Project the current executable graph into Mermaid. Historical inactive nodes
 * remain in the Registry and textual lineage, but are left out of the execution
 * graph so replaced paths cannot be mistaken for runnable dependencies.
 */
export function buildZZWorkflowPlanDiagram(plan: TaskPlan): ZZWorkflowPlanDiagram | null {
	const visibleSteps = plan.steps.filter(step => !INACTIVE_STATUSES.has(step.status));
	if (visibleSteps.length === 0) return null;

	const nodes = new Map(visibleSteps.map((step, index) => [step.id, `n${index}`]));
	const lines = ["flowchart TD"];
	for (const step of visibleSteps) {
		lines.push(`  ${nodeDefinition(nodes.get(step.id)!, step)}`);
	}
	for (const step of visibleSteps) {
		const target = nodes.get(step.id)!;
		for (const dependencyId of step.dependsOn) {
			const source = nodes.get(dependencyId);
			if (source) lines.push(`  ${source} --> ${target}`);
		}
	}

	const source = lines.join("\n");
	return {
		source,
		markdown: `\`\`\`mermaid\n${source}\n\`\`\``,
		visibleStepIds: visibleSteps.map(step => step.id),
		hiddenStepIds: plan.steps.filter(step => INACTIVE_STATUSES.has(step.status)).map(step => step.id),
	};
}
