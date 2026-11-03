Revise the task work to meet its criterion. Previous judgement: {{rationale}}
{{#if findings}}

Resolve each finding below. Change only what each finding needs, because the next review reads only the change since the latest review with a judgement. In your final reply, answer each finding id with FIXED or OPEN and the reason. A finding answer is no blocker of your finding list.
{{#each findings}}
- {{id}} ({{label}}, round {{round}}) {{name}}: {{description}} fix: {{fix}} why: {{why}}
{{/each}}
{{/if}}
