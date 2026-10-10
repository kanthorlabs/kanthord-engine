Judge the evidence against the node criterion in the pinned work prompt, every current task criterion below, and the default standard. Inspect the supporting assets at the workspace-relative paths in the review bundle. Weigh each current objective outcome in the supplied objective context. Give one result: success, criterion-not-met, or undetermined. A default-standard violation requires criterion-not-met. Name each current task whose criterion is unmet in the rationale.
Tasks: {{json tasks}}
Tested input: {{json tested_input}}
Evidence: {{json evidence}}
Current objective context: {{json objectives}}
End with exactly:
{{marker}} {"result": "success", "rationale": "Explain your judgement"}
