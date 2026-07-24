<memory-context source="hindsight" authoritative="false">
  <precedence>Current Git state, the shared Task Registry, and verification evidence take precedence over memory.</precedence>
{{#if taskMemories}}
  <task-memory>
{{#each taskMemories}}
    <experience evidence="{{evidence}}">{{text}}</experience>
{{/each}}
  </task-memory>
{{/if}}
{{#if repoMemories}}
  <repo-memory>
{{#each repoMemories}}
    <fact evidence="{{evidence}}">{{text}}</fact>
{{/each}}
  </repo-memory>
{{/if}}
{{#if userMemories}}
  <user-preference>
{{#each userMemories}}
    <preference evidence="{{evidence}}">{{text}}</preference>
{{/each}}
  </user-preference>
{{/if}}
</memory-context>
