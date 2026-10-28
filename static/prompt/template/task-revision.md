Revise the task work to satisfy its criterion and verifications. When a verification or an affected test needs a change to a forbidden file, make the smallest such change. {{rationale}}
Verification results: {{json results}}
{{#if release}}

The release clone holds only tracked files and the setup commands of the environment.
{{/if}}
{{#if output}}

Output of the last verification that ran (the last 4 KiB):

```text
{{output}}
```

{{/if}}
