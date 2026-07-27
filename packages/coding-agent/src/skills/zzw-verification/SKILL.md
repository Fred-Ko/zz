---
name: zzw-verification
description: Use when executing a ZZWorkflow validation step, deciding whether a step or task is complete, reviewing stale evidence after a Plan patch, or preparing a completion proposal against the approved Task Contract.
---

# ZZW Verification

Verification proves a current workspace snapshot against stable success and
verification IDs. A successful ordinary tool call is only operation evidence.

## Procedure

1. Call `zzw_get_state` and identify the dependency-ready validation step.
2. Run only its exact declared validators. Do not modify implementation code in
   VERIFYING; return to execution or Plan repair first.
3. Confirm each evidence item is passed, trusted, attached to the validation
   step, and matches the current workspace and unchanged step contract.
4. Submit those evidence IDs through `zzw_submit_verification`.
5. Before completion, confirm:
   - no active work, milestone, blocked, or invalidated step remains
   - no unresolved operation or reconciliation remains
   - every success condition and explicit verification requirement has current
     evidence
   - the live workspace fingerprint still matches

## Selective Revalidation

After a Plan patch, do not rerun every validator automatically. Evidence remains
usable when its step contract, upstream dependencies, specification, and workspace
snapshot are unchanged. Evidence marked stale includes a reason such as
`step-contract-changed`, `dependency-invalidated`, `workspace-changed`, or
`spec-changed`; rerun only the affected validation closure.

If validation fails, report `verification-failure` through
`zzw_report_step_result` and use `$zzw-reconciliation`. Never claim completion
from memory, a prior Plan version with a changed contract, or stale evidence.
