# @oh-my-pi/pi-coding-agent

Core implementation package for the `zz` coding agent in the `oh-my-pi` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## ZZ Knowledge

ZZ Knowledge is an independent, opt-in long-term knowledge layer backed by
[Hindsight](https://hindsight.vectorize.io). It is not an OMP Memory backend:
the legacy local memory, Mnemopi, transcript auto-retain/auto-recall, `/memory`,
`memory://`, and old model tools are not part of the runtime.

Enable it in `~/.zz/agent/config.yml`:

```yaml
knowledge:
  enabled: true
  userId: local
  securityBoundary: personal
  hindsight:
    apiUrl: http://localhost:8888
```

Use `/knowledge status` to inspect the connection and current Global/Repository Banks,
`/knowledge banks` to see their dashboard names and stable IDs,
`/knowledge reviews` to inspect durable retain candidates, and
`/knowledge groups` to maintain one-request retain groups. `/knowledge flush`
retries the local outbox. The model-facing operations are `knowledge_recall`,
`knowledge_retain`, `knowledge_retain_document`, `knowledge_reflect`,
`knowledge_curate`, and `knowledge_group`.

Current Git, ZZWorkflow task, operation, and verification state never goes into
Hindsight. ZZ stores only durable, future-useful knowledge backed by evidence,
performs a scoped duplicate/conflict recall before retain, and keeps its local
outbox and working-set cache under
`~/.zz/agent/knowledge/boundary-<id>/knowledge.db`.

See [ZZ Knowledge](../../docs/knowledge.md) for the complete operating model.
