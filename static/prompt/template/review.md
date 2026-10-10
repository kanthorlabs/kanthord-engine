Review the change of task {{task_id}} against its criterion, every item of the node criterion that the task touches, and the default standard. The node review applies the same standard to the whole node.
Task criterion: {{criterion}}
Node criterion: {{node_criterion}}
The diff below is the change. Read the workspace files when the diff does not give enough context.
Report every finding that stands now. Keep the id of an earlier finding that still stands. Drop an earlier finding when the change fixes it or when the reply of the engineer refutes it. A change that widens the task is no finding.
Earlier findings: {{json findings}}
Reply of the engineer to the earlier findings: {{#if replies}}{{replies}}{{else}}none{{/if}}
Diff:
{{diff}}
{{#if diff_truncated}}
[The diff ends at {{diff_max_characters}} characters. Read the workspace files for the rest.]
{{/if}}
End with exactly one line:
{{marker}} {"findings": [{"id": "B1", "kind": "blocker", "name": "Short name", "description": "The defect", "fix": "The recommended change", "why": "The violated criterion or standard"}]}
Write {{marker}} {"findings": []} when no finding stands.
