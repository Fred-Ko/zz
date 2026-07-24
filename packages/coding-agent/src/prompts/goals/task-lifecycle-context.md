<task_lifecycle authoritative="true" context_version="{{contextVersion}}" state_digest="{{stateDigest}}">
Persistent task identity:
- Task: {{taskId}}
- Attempt: {{attemptId}}
- Session: {{sessionId}}
- Episode: {{episodeId}}
- Workspace: {{workspaceId}}
- Specification version: {{specVersion}}
- Plan version: {{planVersion}}
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

{{#if hasReadinessBlockers}}
Execution readiness is blocked:
{{#list readinessBlockers join="\n"}}- {{code}}: {{message}}{{/list}}

Resolve these blockers through the task contract or persisted plan before requesting a mutation.
{{/if}}
{{#if stalePlan}}
The workspace or specification changed after the current plan was validated. Re-observe the repository, update the plan, and re-run affected verification before claiming completion.
{{/if}}
{{#if hasPendingOperations}}
Recovery is required. The process stopped after these operations were prepared but before their outcomes were durably recorded:
{{#list pendingOperations join="\n"}}- {{id}}: {{toolName}}{{#if target}} ({{target}}){{/if}}{{/list}}

Inspect actual state before deciding whether each operation committed, failed, or was compensated. Do not repeat a possibly non-idempotent operation. Record the decision with the `goal` tool's `recover` operation before starting another mutation.
{{/if}}
</task_lifecycle>
{{#if memoryContext}}
{{memoryContext}}
{{/if}}
