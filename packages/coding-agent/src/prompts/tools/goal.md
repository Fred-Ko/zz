Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`; optional `token_budget` must be positive. Use only when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `revise` updates the current unfinished goal in place after a user requirement change. Requires `objective`; optional `token_budget` must be positive. This increments the task specification and plan versions and invalidates affected evidence.
- `recover` records the inspected outcome of a prepared operation left by an interruption. Requires `operation_id` and `resolution` (`committed`, `failed`, or `compensated`).
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

For persistent coding work, prefer an objective with `## Objective`, `## Success criteria`, `## Verification`, `## Boundaries`, and `## Stop conditions`. An unstructured objective remains non-executable until the persisted plan includes a concrete validation step.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
