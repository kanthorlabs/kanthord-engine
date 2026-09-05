# The `docs/proposal/database/` SQL fences are stale, and one test pins them that way

**The obligation.** `docs/proposal/database/README.md:7` — `CREATE TABLE` states that every table
file holds the question the table answers, its `CREATE TABLE` with a comment per column, and the
rules that column set implies. The fence is therefore the current schema of that table, not a
snapshot of the migration that last asserted it.

**Three fences do not satisfy it. Measured 2026-09-04.**

| file                                | behind                    | what is missing                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/proposal/database/run.md`     | migration `12`            | the whole table was rebuilt: `parent_run_id`, `lease_fence` and `kind IN ('objective','task')` still read, and `fence`, `judged_oid`, `graph_revision`, `agents_json`, `max_lifetime_at` and the three-value `kind` do not |
| `docs/proposal/database/node.md`    | migration `11`            | `deliverable`, `verify_json` and `assignment`, and the four CHECKs migration `11` added                                                                                                                                    |
| `docs/proposal/database/attempt.md` | migration `16` (EPIC 054) | `termination`, `caller`, `subject` and the two named CHECKs                                                                                                                                                                |

**The mechanism that keeps `attempt.md` stale.**
`src/services/storage/migration-0007-external-execution.test.ts:1159` — `proposalStatements` asserts
that migration `7`'s own `CREATE TABLE attempt` statement text equals the fence. Repairing the fence
turns that shipped assertion red on the same commit, so the fence cannot move without moving the
assertion. `docs/proposal/database/run.md` is stale for the mirror-image reason: migration `12`
rebuilt `run` and carries **no test at all**, so nothing noticed.

**The repair, and it is the shipped pattern.** Move the parity claim from the migration that wrote a
table to the **live schema**, the way EPIC 051's one-branch migration already does:
`src/services/storage/migration-0009-one-branch.test.ts:271` — `proposalStatements` compares
`normalize(tableSql(storage, "repository"))` — read from `sqlite_master` on a fully migrated
database — against `proposalStatements("repository")`. A live-schema assertion is correct after every
future migration of that table and needs no further move.

Three consequences the repair has to take:

1. **The `attempt` arm of `migration-0007-external-execution.test.ts:1155` leaves that file.** Its
   `run` and `lease` arms have the same problem for the same reason and leave with it.
2. **A live-schema fence must match SQLite's own rendering.** `ALTER TABLE ADD COLUMN` appends the
   column text before the table-level constraint list, so the `attempt` fence reads
   `... ended_at INTEGER, caller TEXT, subject TEXT, termination TEXT CONSTRAINT ..., UNIQUE (run_id,
attempt_no), CHECK ...`. `test/helpers/schema.ts:5` — `tableDdl` and
   `test/helpers/proposal.ts:20` — `split` both normalize whitespace, so the comment-per-column form
   the README requires survives, but the **order** does not: a hand-written fence that groups the
   three new columns beside `outcome` fails.
3. **`node.md:42` — `attempt counter` stays true and is not part of this.** `ambiguous_used` counts
   ambiguous terminations; the attempt counter is still `MAX(attempt_no)` of the run.

**Not this epic's, and stated so in three places.**
`.agents/plan/stories/054-attempt-classification-and-the-supervisor/01-migration-16.md` `## Constraints`
defers the `attempt` fence and says why, its Story 10 edits the **prose** of `attempt.md` only —
`test/helpers/proposal.ts:15` — `sqlFence` reads the fence alone, so prose is outside the pin — and
`.agents/plan/stories/054-attempt-classification-and-the-supervisor/index.md` records the debt under
its facts. EPIC 054 could not take the repair: three fences and one test file is a change of its own,
and folding it in would put a documentation rewrite inside a migration epic.

**The owner.** Ulrich picks the epic. It is one story: three fences, one live-schema assertion per
table, and the removal of three arms from one shipped test.

**The trigger.** Any epic that next touches `docs/proposal/database/`, or the next epic that migrates
`run`, `node` or `attempt`. EPIC 057 migrates `attempt` at version `18` —
`.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` — `migration-0018-enforce.ts`
— and it rebuilds the table to make two columns `NOT NULL`, so it is the natural candidate: a rebuild
already rewrites the DDL that the fence must state.

**What breaks if the answer arrives late.** Nothing goes red. A reader consulting
`docs/proposal/database/attempt.md` for the current shape of the table gets migration `7`'s columns
and learns nothing about `termination`, `caller` or `subject`; the same reader consulting `run.md`
gets a table that has not existed since migration `12`. The cost is a wrong answer to "what does this
table hold", which is the one question the file exists to answer.
