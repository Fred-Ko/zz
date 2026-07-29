import type { Settings } from "../config/settings";

export interface ZZWorkflowConfig {
	heartbeatIntervalMs: number;
	workspaceLeaseMs: number;
	planPatchApproval: "material" | "always";
	execution: {
		mode: "serial" | "validation" | "safe-parallel";
		validationConcurrency: number;
		subagentConcurrency: number;
		isolationMode: "auto";
		preserveFailedLanes: boolean;
		rollingEpoch: boolean;
		workUnits: {
			enabled: boolean;
			model: string;
		};
		adversarialReview: {
			enabled: boolean;
			model: string;
			maxRepairAttempts: number;
		};
	};
}

export function loadZZWorkflowConfig(settings: Settings): ZZWorkflowConfig {
	return {
		heartbeatIntervalMs: settings.get("zzworkflow.heartbeatIntervalSeconds") * 1_000,
		workspaceLeaseMs: settings.get("zzworkflow.workspaceLeaseSeconds") * 1_000,
		planPatchApproval: settings.get("zzworkflow.planPatchApproval"),
		execution: {
			mode: settings.get("zzworkflow.execution.mode"),
			validationConcurrency: Math.max(1, Math.trunc(settings.get("zzworkflow.execution.validationConcurrency"))),
			subagentConcurrency: Math.max(1, Math.trunc(settings.get("zzworkflow.execution.subagentConcurrency"))),
			isolationMode: "auto",
			preserveFailedLanes: settings.get("zzworkflow.execution.preserveFailedLanes"),
			rollingEpoch: settings.get("zzworkflow.execution.rollingEpoch"),
			workUnits: {
				enabled: settings.get("zzworkflow.execution.workUnits.enabled"),
				model: settings.get("zzworkflow.execution.workUnits.model")?.trim() || "*",
			},
			adversarialReview: {
				enabled: settings.get("zzworkflow.execution.adversarialReview.enabled"),
				model: settings.get("zzworkflow.execution.adversarialReview.model")?.trim() || "*",
				maxRepairAttempts: Math.max(
					0,
					Math.min(3, Math.trunc(settings.get("zzworkflow.execution.adversarialReview.maxRepairAttempts"))),
				),
			},
		},
	};
}
