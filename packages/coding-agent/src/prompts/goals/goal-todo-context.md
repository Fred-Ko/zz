<todo_context>
Current ZZWorkflow Plan DAG projection follows. This Todo view is not authoritative and is read-only while a controlled task is active.
Before continuing substantial work, compare your next action with the active ZZWorkflow step. Never mutate this list directly. Propose a plan with `zzw_propose_plan`, patch it with `zzw_patch_plan`, and report step outcomes through the ZZW tools.

Overall: {{closed}}/{{total}} done, {{open}} open.
{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}
{{/each}}
{{/each}}
</todo_context>
