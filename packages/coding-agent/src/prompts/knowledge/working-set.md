<knowledge-working-set authoritative="false" purpose="{{purpose}}" working-set-id="{{id}}">
  <precedence>현재 Git, Workflow Registry, 작업 명세와 최신 검증 증거가 이 과거 지식보다 우선합니다.</precedence>
{{#each items}}
  <knowledge evidence="{{id}}">{{text}}</knowledge>
{{/each}}
</knowledge-working-set>
