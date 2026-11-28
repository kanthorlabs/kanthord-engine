Diagnose the run of `swe@1` that the files of your workspace record.

The workspace holds these files:

- `task.md`: the task text that the agent got.
- `transcript.md`: the session of the agent. Each entry has a heading with its entry id, its role and its text. Each tool result is cut to 4,000 characters.
- `diff.patch`: the diff of the agent against the base commit. A file of 0 bytes is a run with no change. The file is absent when the diff steps failed.
- `check.txt`: the output of the hidden checks, each part after a line with the mode and its exit code. The file is absent when the grading did not run.
- `check.json`: the check line of the run, with the scripted results `a1`, `a2`, `a3` and `a4`, and `pass`.
- `backend.md` or `frontend.md`: the kind prompt that the agent got as context. The file is present only in stage 2.

Read each file. Then write the JSON object of the output form of your system prompt as the final answer.
