import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export interface WorkflowConfig {
	coordinatorUrl: string | null;
	machineIdFile: string;
	requestTimeoutMs: number;
	heartbeatIntervalMs: number;
	staleAfterMs: number;
	workspaceLeaseMs: number;
	degradedAllowExecution: boolean;
	checkpointRemote: string | null;
}

function optionalString(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function expandHome(value: string): string {
	if (value === "~") return process.env.HOME ?? value;
	if (!value.startsWith("~/")) return value;
	return path.join(process.env.HOME ?? "~", value.slice(2));
}

export function loadWorkflowConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): WorkflowConfig {
	const coordinatorUrl =
		optionalString(env.ZZ_WORKFLOW_COORDINATOR_URL) ??
		optionalString(env.OMP_WORKFLOW_COORDINATOR_URL) ??
		optionalString(settings.get("workflow.coordinatorUrl"));
	const machineIdFile =
		optionalString(env.ZZ_WORKFLOW_MACHINE_ID_FILE) ??
		optionalString(env.OMP_WORKFLOW_MACHINE_ID_FILE) ??
		optionalString(settings.get("workflow.machineIdFile")) ??
		path.join(getConfigRootDir(), "machine-id");
	return {
		coordinatorUrl,
		machineIdFile: expandHome(machineIdFile),
		requestTimeoutMs: settings.get("workflow.requestTimeoutMs"),
		heartbeatIntervalMs: settings.get("workflow.heartbeatIntervalSeconds") * 1_000,
		staleAfterMs: settings.get("workflow.staleAfterSeconds") * 1_000,
		workspaceLeaseMs: settings.get("workflow.workspaceLeaseSeconds") * 1_000,
		degradedAllowExecution: settings.get("workflow.degradedAllowExecution"),
		checkpointRemote: optionalString(settings.get("workflow.checkpointRemote")),
	};
}

export function isWorkflowConfigured(config: WorkflowConfig): config is WorkflowConfig & { coordinatorUrl: string } {
	return config.coordinatorUrl !== null;
}
