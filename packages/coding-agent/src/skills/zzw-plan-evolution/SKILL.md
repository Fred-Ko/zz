---
name: zzw-plan-evolution
description: Use when an active ZZWorkflow Plan contract must grow, split, repair, or replace steps after discovery; when a milestone becomes dependency-ready; or when confirmed evidence changes strategy, scope, authority, dependencies, or acceptance criteria. Do not use for routine code/test feedback or satisfiable prerequisites inside the current approved step.
---

# ZZW Plan Evolution

Treat the approved Plan as a versioned, evolving DAG. Preserve valid history and
verified work; do not rewrite the plan as a fresh narrative.

## Procedure

1. Call `zzw_get_state` with `detail="full"`.
2. First apply the no-patch test: if the same active step can fix the code,
   prepare an approved prerequisite, or rerun a focused check without changing
   strategy, scope, authority, dependencies, or acceptance criteria, return to
   `$zzw-reconciliation` and continue that step instead.
3. Identify the change trigger:
   - ready milestone or newly resolved uncertainty → `expansion`
   - contract-invalidating failure, contradicted assumption, or invalid artifact → `repair`
   - dependency, hierarchy, or wording correction → `patch`
4. Link the patch to current observation, evidence, failed-step, and assumption
   IDs. Never invent IDs that are absent from authoritative state.
5. Find the earliest changed step or artifact. Inspect its downstream dependency
   closure before deciding what can remain valid.
6. Keep completed nodes outside that closure. Put them in `preserve_step_ids`.
   Do not preserve a completed node whose input contract changed.
7. Never edit a completed step. Add a new stable-ID replacement and list the old
   ID in `supersedes`. Rewire active downstream dependencies to the replacement.
8. Use `parent_step_id` for hierarchy and artifact fields for dataflow. A ready
   `milestone` must be superseded by concrete work; it is never executed itself.
   Its tools, targets, and risk class are the pre-approved expansion ceiling.
9. Submit one minimal `zzw_patch_plan` call. Fix all returned validation issues in
   one pass if it is rejected.

## Approval Boundary

Inspect the tool result instead of assuming every patch needs approval.

- Structural: safe step decomposition, new detail within the relevant branch's authority,
  dependency rewiring, or milestone expansion. Existing approval may continue.
- Material: new authority or high risk, weaker success or verification gates,
  or invalidation of a completed result. Stop and ask for `/zzw approve-plan`.

Do not call `/zzw approve-plan` on the user's behalf.

## Invariants

- Keep all success-condition and verification IDs mapped by active validation or
  acceptance nodes.
- Active nodes never depend on superseded, invalidated, or abandoned nodes.
- Validators are executable commands, not prose.
- An empty patch is invalid. A guarded retry belongs in
  `zzw_report_step_result.changed_condition`.
- Prefer a short reliable planning horizon over speculative distant steps.
