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
- Execution mode: {{executionMode}}
- Validation concurrency: {{validationConcurrency}}
- Subagent concurrency: {{subagentConcurrency}}
- Work Unit delegation enabled: {{workUnitsEnabled}}
- Work Unit model: {{workUnitModel}}
- Delegation assessment required: {{delegationAssessmentRequired}}
- Adversarial review enabled: {{adversarialReviewEnabled}}
- Adversarial reviewer model: {{adversarialReviewerModel}}
- Delegation decisions: {{delegatedStepCount}} delegated / {{retainedPrimaryStepCount}} retained-primary / {{unassessedDelegationStepCount}} unassessed
- Declared Work Units: {{declaredWorkUnitCount}}
- Required next action: {{requiredNextAction}}
- Writes allowed: {{writesAllowed}}
- Verification current: {{verificationFresh}}
- Workspace branch: {{workspaceBranch}}
- Workspace HEAD: {{workspaceHead}}
- Workspace dirty: {{workspaceDirty}}
{{#if activePlanStep}}
- Active plan step: {{activePlanStep.id}} — {{activePlanStep.content}} ({{activePlanStep.status}})
{{/if}}
{{#if hasActiveWave}}
- Active execution wave: {{activeWave.id}} ({{activeWave.status}})
{{#list activeWave.lanes join="\n"}}  - Lane {{id}}: {{stepId}} / {{executor}} / {{status}}{{#if planImpactLevel}} / plan-impact {{planImpactLevel}}:{{planImpactKind}}{{/if}}{{/list}}
{{/if}}
{{#if readyMilestone}}
- Ready planning milestone: {{readyMilestone.id}} — {{readyMilestone.content}}
{{/if}}
{{#if reconciliation}}
- Reconciliation step: {{reconciliation.stepId}}
- Result classification: {{reconciliation.classification}}
- Repeated matching failures: {{reconciliation.repeatedFailures}}
- Reconciliation action: {{reconciliation.requiredAction}}
{{#if reconciliation.planImpact}}
- Delegated Plan impact: {{reconciliation.planImpact.level}} / {{reconciliation.planImpact.kind}} — {{reconciliation.planImpact.reason}}
{{/if}}
{{/if}}

{{#if hasReadinessBlockers}}
Execution readiness is blocked:
{{#list readinessBlockers join="\n"}}- {{code}}: {{message}}{{/list}}

Resolve these blockers through the task contract or persisted plan before requesting a mutation.
{{/if}}
The ZZWorkflow Registry and versioned Plan DAG are authoritative. The Todo list is only a read-only projection. The Plan is an evolving graph: preserve verified nodes outside the affected dependency closure, retain superseded nodes as lineage, and expand ready milestones with a small Plan patch instead of inventing distant implementation detail up front.
When Work Unit delegation is enabled, every current `work` step must contain an explicit `delegation_assessment`. Use `retain-primary` with a concrete bounded reason when Primary ownership is necessary, `delegate-readonly` for a bounded read-only assignment, or `delegate-isolated` for an independently scoped patch. Omission is not a decision. Scheduling mode and adversarial review are independent: `serial` may still delegate and review, while `safe-parallel` may run without review. Never infer model price or capability from the selected model name.
Use `zzw_get_state` before acting, `zzw_propose_plan` or `zzw_patch_plan` for plan changes, `zzw_execute_wave` for ready validator/read-only/isolated lanes, `zzw_report_step_result` after primary work, and `zzw_submit_verification` only for separately collected validation evidence. A successful ordinary tool result is not verification and does not complete a step. Never pass a `primary` step to `zzw_execute_wave`; execute it with the ordinary tools allowed by that step.
Plan mappings use the stable IDs returned by the authoritative specification: `successCriteria[].id` maps through `success_condition_ids`, and `verificationRequirements[].id` maps through `verification_ids`. Validators are executable commands, not copies of verification prose. If plan validation returns multiple `issues`, correct all of them before making one retry.
When the required next action is `propose_executable_plan`, inspect the authoritative specification and propose the executable Plan DAG now. When it is `request_user_plan_approval`, show the proposed plan once and ask the user to run `/zzw approve-plan`; never approve it yourself and do not request another model turn while approval is pending.
When it is `assess_delegation_and_patch_plan`, inspect every pending work step and make one minimal Plan patch that records an explicit delegation assessment and any safe Work Unit decomposition. Do not modify completed steps, broaden the approved authority envelope, or execute ordinary side effects first. A retained Primary step needs a concrete structured reason; do not use `retain-primary` as an unexplained fallback.
When it is `run_execution_wave`, call `zzw_execute_wave` once and use its aggregate Lane result. Do not launch equivalent bash or task calls yourself. When it is `wait_execution_wave`, do not start overlapping side effects; inspect the active Wave or reconcile it after interruption.
When a delegated Lane reports `plan-impact=execution`, keep the approved DAG and handle a bounded repair or changed-condition retry inside that Work Unit. For `structural`, use the recorded Lane observation and evidence to propose the smallest dependency-aware Plan patch after the Wave closes. For `contract`, ask for the required user decision; never convert it into an implementation repair. A child report is a proposal and never edits the Plan by itself.
When it is `enable_safe_parallel_or_patch_executor`, the approved ready step requires a subagent executor but the current `validation` mode permits validators only. Explain the mismatch once. The user may enable `zzworkflow.execution.mode: safe-parallel`, or a justified Plan patch may replace the step with `primary`; do not loop on `zzw_execute_wave`.
When it is `satisfy_approved_precondition`, do not patch the Plan or request approval. Use only the active validation step's already approved tools and targets to diagnose and satisfy the missing environment prerequisite. Then report `status=progress`, `classification=matched` with the successful operation evidence. The Runtime will return the validator to pending; rerun the exact validator only after that report.
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
