Judge whether the task criterion is met, respecting the default standard. Task {{task_id}}: {{criterion}}
{{#if prior_rationale}}
Previous judgement: {{prior_rationale}}. Judge whether the task criterion is met now.
{{/if}}
End with exactly:
{{marker}} {"criterion_met": true, "rationale": "Explain your judgement"}
