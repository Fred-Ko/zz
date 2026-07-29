# Local task workflow

Goal mode keeps one task coherent across ZZ sessions with stores that have distinct authority:

- `~/.zz/agent/workflows/<repository-id>/workflow.db`: repository-isolated task/spec/attempt/episode state, plan versions, operations, leases, heartbeats, checkpoints, and verification events.
- `~/.zz/agent/knowledge/boundary-<hash>/knowledge.db`: security-boundary Knowledge outbox, working-set cache, and completion review receipts.
- Git: tracked code, commits, branches, and local checkpoint objects.
- Verification evidence: results tied to a specific workspace snapshot.
- Hindsight: advisory long-term repository knowledge, decisions, preferences, and experience.

Hindsight is never the current task registry. Recalled facts do not override Git, workflow registry state, or verification evidence.

## No separate service

Start ZZ normally:

```sh
zz
```

ZZ opens the local SQLite registry and initializes its schema automatically. There is no `zz-workflowd` command, coordinator URL, HTTP service, machine identity, or network degraded mode.

Each repository identity gets a separate Workflow database. When the legacy global `~/.zz/agent/workflow.db` exists, ZZ imports only the current repository's tasks, events, leases, and heartbeats. Migration waits while that repository still has an active legacy lease, so a running older ZZ process continues using the global database until it exits. Later launches idempotently merge newer legacy task versions and events in case an already-running older process wrote more state after the first import. The legacy file is retained as a recovery backup.

Optional local concurrency and Plan approval policy:

```yaml
zzworkflow:
  heartbeatIntervalSeconds: 15
  workspaceLeaseSeconds: 90
  planPatchApproval: material # material | always
  execution:
    mode: validation # serial | validation | safe-parallel
    validationConcurrency: 4
    subagentConcurrency: 3
    preserveFailedLanes: true
```

SQLite uses WAL, foreign keys, a busy timeout, short write transactions, and idempotent event keys. A workspace lease prevents two ZZ processes on the same machine from writing the same workspace concurrently. After an abnormal exit, a later process waits for lease expiry and reconciles unfinished operations before continuing.

## Evolving Plan DAG

The initial executable Plan always requires `/zzw approve-plan`. During execution,
ZZ can expand ready planning milestones or repair contradicted steps without
discarding unrelated completed work. Structural serial patches retain the existing
approval by default; authority expansion, high-risk work, weakened validation,
invalidation of completed work, or a validator/subagent execution-contract change
is material and requires another approval.

Use `/zzw plan`, `/zzw history`, `/zzw diff [version]`, and
`/zzw why <step-id>` to inspect the current graph, version changes, and evidence
lineage. Failed operations first enter RECONCILING. A retry requires a concrete
changed condition. Compile, lint, or test feedback that can be corrected inside
the active work step and approved missing prerequisites continue without a Plan
patch or another approval. Operation fingerprints include the workspace
pre-state, so a real code correction differs from an unchanged retry; a repeated
matching failure forces Plan repair.

## Execution Waves

The default `validation` mode runs independent validator commands in bounded parallel
Lanes. `safe-parallel` also enables concurrent explicitly approved read-only and
isolated-write subagent steps, while `serial` may run those same approved steps one
Lane at a time. Execution mode controls scheduling only; Work Unit decomposition and
adversarial review are independent settings. Isolated writes run from one base
snapshot, return patch artifacts, and enter the Primary workspace through a serial
integration queue. ZZWorkflow always lets the native PAL auto-select its isolation
backend instead of exposing filesystem-specific implementation choices here.

Every Plan step without an explicit execution contract remains a safe Primary serial
step. A ready or in-progress Primary step runs before an automatic Wave. Validator
and isolated-write steps never share a Wave because integration would immediately
stale evidence tied to the pre-integration workspace snapshot.

Inspect execution with:

```text
/zzw status
/zzw plan
/zzw lanes
/zzw operations
/zzw evidence
```

Wave, Lane, resource claim, operation, artifact, and evidence attribution is written
before execution. Restarted `running` work becomes `unknown`; ZZW never silently
reruns an operation or reapplies an isolated patch whose completion is uncertain.
See [zzw_execute_wave](tools/zzw-execute-wave.md) for the model tool contract.

Work Unit delegation is optional and defaults to off. When enabled, every bounded
Work Unit and repair uses one model+effort selector chosen from the same authenticated,
`enabledModels`-scoped set shown by `/model`. Capability remains planning and risk
metadata; it does not select one of several models. `*` means the current session
model with default effort, while values such as `*:high` select one of that model's
supported efforts. The selector is resolved to exact `provider/model[:effort]` when
the Wave is prepared. A saved model or effort that is no longer available blocks Wave
preparation instead of silently falling back. Adversarial review is a separate switch: when enabled,
all isolated-write candidates are reviewed by a fresh read-only agent and run their
candidate validators before serial integration. Disabling review never disables
scope checks, validators, or final evidence freshness checks.

When Work Unit delegation is enabled, every current work step must record an explicit
delegation assessment. The plan must either delegate the step or retain it on Primary with
a structured reason. Missing assessments are rejected instead of silently falling back to
Primary. The live policy and decision counts are visible through `zzw_get_state`, `/zzw status`,
and `/zzw plan`.

A draft Plan saved before this policy was enabled does not need to be recreated. On
`/zzw approve-plan`, ZZW preserves its existing executor and authority envelope and fills only
the missing compatibility assessment before validating the whole Plan. This does not relax
validation for new Plan proposals. Approval failures are rendered as command diagnostics rather
than escaping the TUI as unhandled promise rejections.

Delegated Work Units and reviewers report Plan impact separately from implementation
success. Inspect it with `/zzw lanes`:

- `none`: continue the existing candidate gates.
- `execution`: keep the approved Plan and perform a bounded Work Unit repair.
- `structural`: preserve the candidate artifact, block integration, and propose the
  smallest Plan DAG patch after the current Wave settles.
- `contract`: preserve the candidate without integration and request the user's scope,
  API, security, or risk decision.

Child agents never patch or approve the Plan themselves. Existing independent Lanes
are allowed to settle, but structural and contract findings close admission of new
Lanes. The resulting Observation, evidence, affected Step IDs, and proposal remain in
the ZZW Registry rather than being inferred from a prose subagent summary.

```yaml
zzworkflow:
  execution:
    workUnits:
      enabled: false
      model: "*:medium"
    adversarialReview:
      enabled: true
      model: "*"
      maxRepairAttempts: 1
```

## Local checkpoint

Plan update, pause, handoff, and completion boundaries record a local checkpoint without changing the worktree. Dirty tracked files can be represented by an unattached Git stash commit. Untracked files are not inserted into that checkpoint, so their presence is recorded for recovery warnings.

Checkpoints are not pushed to a remote. Moving or resuming a workflow on another machine is outside this feature's contract.

## Repository identity

Remote URLs are normalized so repository-scoped Hindsight memory remains stable across equivalent SSH and HTTPS remotes. For a stable explicit ID, commit:

```yaml
# .zz-agent/project.yml
repositoryId: 01J4ZB8T56KME3Q1D1R6QPGM51
canonicalRemote: github.com/example/project
```

## ZZ Knowledge

```yaml
knowledge:
  enabled: true
  userId: stable-user-id
  securityBoundary: personal
  hindsight:
    apiUrl: http://127.0.0.1:8888
```

ZZ에는 legacy Memory mode가 없다. Session orientation과 intake/planning/replanning/recovery 경계에서만 목적별 recall이 실행된다. `knowledge_retain`은 evidence, future use, strict scope, redaction과 별도 durable outbox를 요구하며 Task 완료는 자동 저장 대신 review receipt만 만든다. 자세한 내용은 [knowledge.md](knowledge.md)를 참조한다.
