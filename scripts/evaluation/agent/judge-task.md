Read the files in your workspace and diagnose the agent run.

Files in your workspace:

- `transcript.md` — the agent session transcript (role and text per message)
- `task.md` — the task the agent received
- `diff.patch` — the diff the agent produced (absent if the agent wrote no diff)
- `check.txt` — the output of the check script (absent if the check did not run)
- `check.json` — the check record (aspects A1–A4, pass, breach)
- `backend.md` or `frontend.md` — the kind binding (present at stage 2)

Write your findings as a JSON object. Follow the output format in your system prompt.
