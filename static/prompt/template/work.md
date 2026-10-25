{{#if node~}}

# {{node.name}}

## Requirement

{{node.requirement}}

## Criterion

{{node.criterion}}

{{/if~}}

# {{name}}

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
