---
name: zzw-reconciliation
description: Use when ZZWorkflow enters RECONCILING or RECOVERING, an operation fails or has unknown completion, observed effects differ from a step contract, a precondition or assumption is contradicted, or the workspace changed unexpectedly.
---

# ZZW Reconciliation

Reconciliation is observation and classification before another side effect. The
Registry, Git, workspace fingerprint, operation journal, and fresh evidence are
authoritative; recalled knowledge is advisory only.

## Procedure

1. Call `zzw_get_state` with `detail="full"` and inspect the relevant operation
   and evidence.
2. Compare the step's expected effects, postconditions, assumptions, consumed
   artifacts, and rerun policy with the actual result.
3. Report newly interpreted facts or contradictions with
   `zzw_report_observation`, linked to evidence and affected IDs.
4. Classify the step result with `zzw_report_step_result`:
   - `matched`: expected progress or completion
   - `implementation-feedback`: a compile, lint, or test result identifies code
     to correct inside the current work step; the Plan contract remains valid
   - `missing-precondition`: an approved dependency or environment prerequisite
     must be prepared before the same step can continue
   - `execution-failure`: the plan remains valid but the tool or environment
     failed to execute it
   - `contradicted-precondition` or `contradicted-assumption`: a plan input is
     false
   - `unexpected-effect`: the operation changed more or less than promised
   - `verification-failure`: an independent validator failed
   - `environment-changed`: the workspace fingerprint no longer matches
5. Continue only according to the returned required action.

## Retry Rule

Do not patch the Plan for ordinary development feedback. Report
`implementation-feedback`, correct the code in the same work step, and rerun the
focused check. Report `missing-precondition`, satisfy it within approved
authority, and retry the same step. If satisfying it needs authority not already
approved, ask only for that action; do not rewrite the Plan unless scope or
strategy also changes.

Retry an `execution-failure` only when a concrete condition changed. State that
condition in `changed_condition`; “try again” is not a changed condition. Respect
the step's rerun policy. Until then the Runtime keeps reconciliation at
`retry-with-changed-condition` and rejects Plan patches. Never repeat an operation
with unknown completion.

The Runtime fingerprints operations with their workspace pre-state. A code
correction therefore creates a new condition; an unchanged retry does not. A
second matching failure cannot be cleared by another retry claim and requires a
Plan repair.

## Repair Rule

Use `$zzw-plan-evolution` only when a contradicted plan input, independent final
verification failure, repeated unchanged failure, or unexpected effect changes
the step contract. Do not use it merely to add the next diagnostic or setup
command inside the same approved step. Do not mark all downstream work invalid by
intuition; let the Runtime compute evidence invalidation from the submitted cause
and graph.
