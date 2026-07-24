# Shared task workflow

Goal mode can keep one task coherent across ZZ sessions and machines by combining four stores with distinct authority:

- SQLite `zz-workflowd`: task/spec/attempt/episode state, plan versions, leases, heartbeats, checkpoints, and verification events.
- Git: code and shared commit state.
- Local session journal and `workflow.db`: in-flight operations plus coordinator and Hindsight outboxes.
- Hindsight: advisory long-term repository knowledge, decisions, preferences, and experience.

Hindsight is never used as the current task registry. Recalled facts do not override Git, workflow registry state, or verification evidence.

## Coordinator

Start the service. It creates `~/.zz/workflowd.db` automatically:

```sh
WORKFLOWD_DB_PATH=~/.zz/workflowd.db \
WORKFLOWD_HOST=127.0.0.1 \
WORKFLOWD_PORT=8890 \
zz-workflowd
```

Run one authoritative service and route `127.0.0.1:8890` to it from every machine. The SQLite file stays private to that service and must not be opened independently by several machines over a network filesystem. Then configure ZZ:

```yaml
workflow:
  coordinatorUrl: http://127.0.0.1:8890
  heartbeatIntervalSeconds: 15
  staleAfterSeconds: 60
  workspaceLeaseSeconds: 90
  degradedAllowExecution: true
  checkpointRemote: agent-state
```

The client writes each event to its local outbox before sending it. Coordinator writes use an idempotency key and optimistic `expectedVersion`; workspace lease conflicts always block a mutation. A network outage may enter degraded local mode when `degradedAllowExecution` is enabled.

When `checkpointRemote` is set, plan, pause, handoff, and completion boundaries push a checkpoint commit to `refs/heads/agent/<task-id>/<attempt-id>`. Dirty tracked files are captured in an unattached stash commit without changing the worktree. Git cannot include untracked files in that non-mutating checkpoint; the coordinator record marks `unsharedLocalChanges` so recovery can warn before another machine continues.

## Repository identity

Remote URLs are normalized so SSH and HTTPS checkouts resolve to the same repository ID. For a stable explicit ID, commit:

```yaml
# .zz-agent/project.yml
repositoryId: 01J4ZB8T56KME3Q1D1R6QPGM51
canonicalRemote: github.com/example/project
```

Each machine also receives a persistent ID in `~/.zz/machine-id` unless `workflow.machineIdFile` overrides it.

## Workflow-managed Hindsight

```yaml
memory:
  backend: hindsight

hindsight:
  apiUrl: http://127.0.0.1:8888
  integrationMode: workflow-managed
  exposeModelTools: false
  userId: stable-user-id
```

This mode disables legacy transcript auto-recall, transcript auto-retain, mental-model injection, and model-driven `retain`/`recall`/`reflect` tools. Recall happens at intake, planning, replanning, and recovery boundaries. Only curated verified task memory is retained, with strict task/repository tags, machine/session/episode provenance, redaction, and a durable retry outbox.
