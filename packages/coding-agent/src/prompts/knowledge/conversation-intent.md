<explicit_knowledge_request intent="{{intent}}">
The user explicitly requested a long-term knowledge operation in this turn.

Treat this as an operation request, not as casual wording.

- For `recall`, call `knowledge_recall` with `request_origin=user-explicit` before answering.
- For `retain`, classify each durable item, then call `knowledge_retain` or
  `knowledge_retain_document` with `request_origin=user-explicit`. Multiple calls
  from this request will share one retain group automatically.
- For `correct` or `forget`, identify the target with recall/group listing, then
  use curation or group invalidation. Do not claim that memory changed without a
  tool receipt.
- If the request mixes current task state and durable knowledge, route current
  state to Workflow/Git and retain only the durable part.
- Permanent purge is user-only. Explain the explicit `/knowledge purge-group
  &lt;id&gt; --confirm` command when permanent deletion is requested.

User request:
{{request}}
</explicit_knowledge_request>
