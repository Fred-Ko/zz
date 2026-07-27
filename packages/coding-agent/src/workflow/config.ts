import type { Settings } from "../config/settings";

export interface ZZWorkflowConfig {
	heartbeatIntervalMs: number;
	workspaceLeaseMs: number;
	planPatchApproval: "material" | "always";
}

export function loadZZWorkflowConfig(settings: Settings): ZZWorkflowConfig {
	return {
		heartbeatIntervalMs: settings.get("zzworkflow.heartbeatIntervalSeconds") * 1_000,
		workspaceLeaseMs: settings.get("zzworkflow.workspaceLeaseSeconds") * 1_000,
		planPatchApproval: settings.get("zzworkflow.planPatchApproval"),
	};
}
