<zzworkflow authoritative="true" context_version="{{contextVersion}}" state_digest="{{stateDigest}}">
Persistent task identity:
- Task: {{taskId}}
- Attempt: {{attemptId}}
- Session: {{sessionId}}
- Episode: {{episodeId}}
- Workspace: {{workspaceId}}
- Specification version: {{specVersion}}
- Plan version: {{planVersion}}
- Plan approval: {{planApproval}}
- Checkpoint: {{checkpointId}}
- Phase: {{phase}}
- Required next action: {{requiredNextAction}}
- Writes allowed: {{writesAllowed}}
- Verification current: {{verificationFresh}}
- Workspace branch: {{workspaceBranch}}
- Workspace HEAD: {{workspaceHead}}
- Workspace dirty: {{workspaceDirty}}
{{#if activePlanStep}}
- Active plan step: {{activePlanStep.id}} — {{activePlanStep.content}} ({{activePlanStep.status}})
{{/if}}
{{#if readyMilestone}}
- Ready planning milestone: {{readyMilestone.id}} — {{readyMilestone.content}}
{{/if}}
{{#if reconciliation}}
- Reconciliation step: {{reconciliation.stepId}}
- Result classification: {{reconciliation.classification}}
- Repeated matching failures: {{reconciliation.repeatedFailures}}
- Reconciliation action: {{reconciliation.requiredAction}}
{{/if}}

{{#if hasReadinessBlockers}}
Execution readiness is blocked:
{{#list readinessBlockers join="\n"}}- {{code}}: {{message}}{{/list}}

Resolve these blockers through the task contract or persisted plan before requesting a mutation.
{{/if}}
The ZZWorkflow Registry and versioned Plan DAG are authoritative. The Todo list is only a read-only projection. The Plan is an evolving graph: preserve verified nodes outside the affected dependency closure, retain superseded nodes as lineage, and expand ready milestones with a small Plan patch instead of inventing distant implementation detail up front.
Use `zzw_get_state` before acting, `zzw_propose_plan` or `zzw_patch_plan` for plan changes, `zzw_report_step_result` after work, and `zzw_submit_verification` for validation evidence. A successful ordinary tool result is not verification and does not complete a step.
Plan mappings use the stable IDs returned by the authoritative specification: `successCriteria[].id` maps through `success_condition_ids`, and `verificationRequirements[].id` maps through `verification_ids`. Validators are executable commands, not copies of verification prose. If plan validation returns multiple `issues`, correct all of them before making one retry.
When the required next action is `propose_executable_plan`, inspect the authoritative specification and propose the executable Plan DAG now. When it is `request_user_plan_approval`, show the proposed plan once and ask the user to run `/zzw approve-plan`; never approve it yourself and do not request another model turn while approval is pending.
When the required next action is `expand_ready_milestone`, inspect current evidence and replace that milestone with dependency-aware concrete steps using an expansion patch. When it is `classify_observation_and_reconcile_plan`, compare expected and observed effects before changing the Plan. A failing compile, lint, or test that exposes code to fix inside the active work step is `implementation-feedback`; an unstarted dependency or other satisfiable prerequisite inside approved scope is `missing-precondition`. Report either classification and continue the same step without a Plan patch or approval. Use a repair patch only when the step's strategy, dependency graph, scope, authority, or acceptance contract is actually invalid. Do not execute another side effect while reconciliation is active.
{{#if stalePlan}}
The workspace, a dependency, or an assumption invalidated part of the current plan. Re-observe the repository and propose the smallest sufficient Plan patch. Structural patches may retain existing approval; material patches require user approval. Re-run only verification whose step contract or dependency evidence became stale.
{{/if}}
{{#if hasPendingOperations}}
Recovery is required. The process stopped after these operations were prepared but before their outcomes were durably recorded:
{{#list pendingOperations join="\n"}}- {{id}}: {{toolName}}{{#if target}} ({{target}}){{/if}}{{/list}}

Inspect actual state before deciding whether each operation committed, failed, or was compensated. Do not repeat a possibly non-idempotent operation. Record the decision with the `goal` tool's `recover` operation before starting another mutation.
{{/if}}
</zzworkflow>
{{#if knowledgeWorkingSet}}
{{knowledgeWorkingSet}}
{{/if}}
