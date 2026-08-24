@AGENTS.md

## An epic, a story and a task carry source-code edits only

An epic, a story or a task specifies an edit to a `.ts` or a `.js` file, or to a
file under `docs/proposal/`. It specifies no edit to any other file.

`docs/proposal/` is the one exception, and it is not a loophole. `AGENTS.md`
makes that tree the source of truth for behaviour, so an epic that changes
behaviour has to change it, and `scripts/lane-check.sh` grants the path to the
software-engineer lane for that reason. A story that edits it names the exact
lines and stays in that one lane.

When the work needs an edit to any other non-source file, do not fold that edit
into an epic, a story or a task. Show the edit to Ulrich as a suggestion, in the
bullet format of the Communication Rules, and let him apply it. Such a file
includes a configuration file, a manifest, a pipeline definition under
`.claude/`, and a plan file under `.agents/plan/`.

A folded edit of one of those deadlocks the cycle, because
`scripts/lane-check.sh` denies the path to every agent lane. That deny list is
the authority: when the script changes, this rule changes with it.
