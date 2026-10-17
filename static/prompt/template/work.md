# {{name}}

## Requirement

{{requirement}}

## Criterion

{{criterion}}

## Verifications

{{#each verifications}}
{{number}}. {{command}}
{{/each}}
{{#if repositories}}

## Repositories

{{#each repositories}}
Repository {{name}}: directory `{{directory}}`, base branch `{{base_branch}}`
{{/each}}
{{/if}}
