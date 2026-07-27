Retain a durable source document through ZZ Knowledge.

Use this instead of `knowledge_retain` when the original wording or surrounding
document context matters: an ADR, repository guide, runbook, external reference,
or a structured investigation record. Choose `replace` for a canonical mutable
source, `append` for a stable journal-like source, and `immutable-revision` when
history must remain addressable. Set `request_origin` to `user-explicit` when the
user directly asked to remember this material. One user request is automatically
grouped with every other retain call made for that same request.

Do not use this for current progress, raw sessions, secrets, disposable logs, or
facts that should be stored as small independent records.

A Git branch is provenance, not a Knowledge scope. The runtime records the branch
at discovery automatically; branch-only working material belongs in the Workflow
Registry rather than this durable document store.
