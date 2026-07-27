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
```

SQLite uses WAL, foreign keys, a busy timeout, short write transactions, and idempotent event keys. A workspace lease prevents two ZZ processes on the same machine from writing the same workspace concurrently. After an abnormal exit, a later process waits for lease expiry and reconciles unfinished operations before continuing.

## Evolving Plan DAG

The initial executable Plan always requires `/zzw approve-plan`. During execution,
ZZ can expand ready planning milestones or repair contradicted steps without
discarding unrelated completed work. Structural patches retain the existing
approval by default; authority expansion, high-risk work, weakened validation, or
invalidation of completed work is material and requires another approval.

Use `/zzw plan`, `/zzw history`, `/zzw diff [version]`, and
`/zzw why <step-id>` to inspect the current graph, version changes, and evidence
lineage. Failed operations first enter RECONCILING. A retry requires a concrete
changed condition. Compile, lint, or test feedback that can be corrected inside
the active work step and approved missing prerequisites continue without a Plan
patch or another approval. Operation fingerprints include the workspace
pre-state, so a real code correction differs from an unchanged retry; a repeated
matching failure forces Plan repair.

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
