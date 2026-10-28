Revise the task work to satisfy its criterion and verifications. When a verification or an affected test needs a file that the requirement forbids, make the smallest change to that file. {{rationale}}
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
