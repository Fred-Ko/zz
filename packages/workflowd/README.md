# ZZ Workflow Coordinator

`zz-workflowd` is the authoritative shared task registry used by workflow-managed ZZ sessions.

It stores coordinator state in SQLite at `~/.zz/workflowd.db` by default:

```sh
zz-workflowd
```

Override the database path with `WORKFLOWD_DB_PATH`. The service listens on `127.0.0.1:8890` by default; override this with `WORKFLOWD_HOST` and `WORKFLOWD_PORT`.
