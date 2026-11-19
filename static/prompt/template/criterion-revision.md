Revise the task work to meet its criterion.{{#if rationale}} Previous judgement: {{rationale}}{{/if}}
{{#if findings}}

Resolve each finding below. Change only what each finding needs, because the next review reads only the change since the latest review that gave success, a new finding or a proposal. In your final reply, answer each finding id with FIXED or OPEN and the reason. A finding answer is no blocker of your finding list.
{{#each findings}}
- {{id}} ({{label}}, round {{round}}) {{name}}: {{description}} fix: {{fix}} why: {{why}}
{{/each}}
{{/if}}
{{#if earlier_verdicts}}

Earlier attempts gave these verdicts. A change that an earlier verdict accepted stays accepted.
{{earlier_verdicts}}
{{/if}}
{{#if unblock_reason}}

A person unblocked this node and gave this reason: {{unblock_reason}}
The reason outranks the previous judgement. In your final reply, answer the unblock reason with FIXED or OPEN and the reason. The answer is no blocker of your finding list.
{{/if}}
