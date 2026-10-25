{{#if node~}}

# Node {{node.name}}

## Requirement

{{node.requirement}}

## Criterion

{{node.criterion}}

Do only the task below. The node part above is context.

# Task {{name}}

{{else~}}

# {{name}}

{{/if~}}

## Requirement

{{requirement}}

## Criterion

{{criterion}}

## Verifications

{{#each verifications}}
{{number}}. {{command}}
{{/each}}
{{#if tasks}}

## Tasks

{{#each tasks}}
{{number}}. {{name}} (`{{id}}`). Criterion: {{criterion}}
{{/each}}
{{/if}}
{{#if repositories}}

## Repositories

{{#each repositories}}
Repository {{name}}: directory `{{directory}}`, base branch `{{base_branch}}`
{{/each}}
{{/if}}
