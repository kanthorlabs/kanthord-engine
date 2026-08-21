@AGENTS.md

## An epic, a story and a task carry source-code edits only

An epic, a story or a task specifies an edit to a `.ts` or a `.js` file. It
specifies no edit to any other file.

When the work needs an edit to a non-source file, do not fold that edit into an
epic, a story or a task. Show the edit to Ulrich as a suggestion, in the bullet
format of the Communication Rules, and let him apply it. A non-source file
includes a document, a configuration file, a pipeline definition under
`.claude/`, a manifest and a plan file.

A folded non-source edit deadlocks the cycle, because `scripts/lane-check.sh`
denies the path to every agent lane.
