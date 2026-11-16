Review the draft plan below against the request. Verify each fact, each step and each input of the draft with your read tools. Do not trust the draft.
Write each finding in this format: `<B1/S1> - status:<FIXED/OPEN> - action:<YES/NO> - <name> - <description> - fix:<recommended change> - why:<reason>`. `B` is a blocker and `S` is a suggestion, numbered. `status:FIXED` when your plan holds the change, `status:OPEN` when it still needs it. `action:YES` when the change applies, `action:NO` when it is a no-op or a won't-do.
Apply every `action:YES` finding to the plan. Answer the complete aligned plan in the output contract of your agent prompt. Write the `## Review` section last, with your findings.
Request: {{request}}
The actor `yumi` applies a step with one of these mutations. `actor:yumi` is valid only for such a mutation. Each mutation has its guard class:
{{#each mutations}}
- {{operation_id}} - guard:{{guard_class}}
{{/each}}
Draft plan:
{{draft}}
