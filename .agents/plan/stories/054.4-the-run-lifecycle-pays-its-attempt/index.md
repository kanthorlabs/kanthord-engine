# EPIC 054.4 — The run lifecycle pays its attempt — stories

Epic: `.agents/plan/epics/054.4-the-run-lifecycle-pays-its-attempt.md`
Prereq: EPIC 054.3 (sequence order). Every story reads EPIC 054's migration `16` for `attempt.termination` and `node.ambiguous_used`, EPIC 054's `src/domain/termination.ts` for the evidence union, and EPIC 054.1's `endAttempt` for the command it calls. Stories 1 to 4 also read EPIC 054.2 Story 1 (`01-the-unreachable-candidate-pays-its-attempt`) for the `attempt.end` projection in `test/helpers/sequence-conformance.ts`, and EPIC 051.5 Story 10 (`10-the-conformance-harness-admits-an-incremental-supersession`) for the per-diagram supersession each of them relies on to retire its predecessor. Story 2 reads EPIC 051.6 Story 2 (`02-the-release-reaps`); Stories 3 and 4 read EPIC 050.5 Stories 1 and 2 for the moved file, the renamed exports and the case suite they extend.

Every remaining way an attempt ends charges the class the daemon observed, and `execution.closeAttempt` is left with exactly one production caller.

## One story, one path

Four stories carry one diagram each, and every one supersedes a diagram an earlier epic drew, so no story draws a `baseline-` diagram. Two stories carry none.

| story | diagram                     | supersedes                        |
| ----- | --------------------------- | --------------------------------- |
| 1     | `expiry-pass-one-due-paid`  | EPIC 050.1 `expiry-pass-one-due`  |
| 2     | `release-reap-paid`         | EPIC 051.6 `release-reap`         |
| 3     | `sweep-external-runs-paid`  | EPIC 050.5 `sweep-external-runs`  |
| 4     | `recovery-verdict-run-paid` | EPIC 050.5 `recovery-verdict-run` |

Stories 2, 3 and 4 each declare `Seams: <id>: -execution.closeAttempt:A, +attempt.end:A`, and for those three **the one substituted token is the whole change of the trace**: the close moves from the seam to the nested command at the position it already held, and no read, write, event or reap moves with it. **Story 1 is the exception.** It declares `Seams: expiry-pass-one-due-paid: +execution.attemptsOfRun:R, +attempt.end:A` — two additions and no removal — because `expireRuns` closes no attempt today and reads none, so there is nothing to subtract and the attempt read has to be added.

Two undrawn arms change beside them, each stated in prose with the source line of every call it adds: the objective release cascade at `src/commands/node/release-node.ts:262` — `closeAttempt`, in Story 2, and the sweep's cascade at `src/commands/startup/recover-expired-leases.ts:196` — `closeAttempt`, in Story 3. Both repeat their calls per child with no projection to separate them, which `.agents/plan/stories/050.4-the-node-lease-removal/05-the-release-drops-the-lease.md:11` — `lease.read` already ruled undrawable.

This epic holds no story `00`. Every path its stories edit is allowed to one TDD engineer, checked with `scripts/lane-check.sh` against both roles: `scripts/epic-sequence-range.ts` and `docs/proposal/phase-2/attempts-and-classification.md` are both the software-engineer lane, so no locked path exists and no groundwork story is manufactured.

## Dispatch order

**1, 2, 3, 4, 5, 6.** The order is forced at both ends, and no story depends on a later one.

- **Story 1 first, by the range edit.** It inserts `"054.4"` into `scripts/epic-sequence-range.ts:1` — `authoredEpics` and into the pinned literal at `test/sequence/conformance.test.ts:255` — `assert.deepEqual(authoredEpics`. Until that entry exists, EPIC 051.5 Story 10's rule supersedes nothing, so no story of this epic may retire its predecessor's scenario and every one of them lands red.
- **Stories 2, 3 and 4 in any order after Story 1.** They edit three different commands, they share no file, and none reads another's output. The listed order is the epic's.
- **Story 5 after Stories 1 to 4.** Its caller iteration asserts a set of one, which is false while any of the four still calls the seam.
- **Story 6 last.** It appends `"054.4"` to `scripts/epic-sequence-range.ts:20` — `shippedEpics`, which `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` requires to stay a prefix of `authoredEpics`, and it reads every row Stories 1 to 5 proved.

**Each story is green on its own boundary.** EPIC 051.5 Story 10 keys supersession on the superseding scenario file over an epic in `authoredEpics`, so a story that adds its own scenario and deletes its predecessor's in one turn leaves every other diagram of the range untouched: while `release-reap-paid.ts` exists, `release-reap` is superseded and needs no scenario, and `sweep-external-runs` is still due and keeps its own.

**Two stories reach a fourth story's test file.** Story 5 cases 6, 7 and 8 add a case each to `src/commands/run/expire-runs.test.ts`, `src/commands/node/release-node.test.ts` and `src/commands/startup/recover-expired-runs.test.ts`. All three are the epic's own gate assignments — row 13 names one proof owner — and a test file is one lane, so no dispatch conflict follows.

## Stories

- 1 — the expiry pass ends the attempt with `run-expired` → `01-the-expiry-pass-ends-the-attempt.md` — draws `expiry-pass-one-due-paid`
- 2 — the release pays no attempt, and its cascade charges `ancestor-ended` → `02-the-release-pays-no-attempt.md` — draws `release-reap-paid`
- 3 — the external sweep pays its attempt, and its cascade charges `ancestor-ended` → `03-the-external-sweep-pays-its-attempt.md` — draws `sweep-external-runs-paid`
- 4 — the startup recovery pays its attempt → `04-the-startup-recovery-pays-its-attempt.md` — draws `recovery-verdict-run-paid`
- 5 — the closure is asserted by iteration → `05-the-closure-is-asserted.md` — draws nothing
- 6 — the proposal records the lifecycle → `06-the-proposal-records-the-lifecycle.md` — draws nothing

## Facts (needed for implementation)

- **`expireRuns` reads no attempt today.** `src/commands/run/expire-runs.ts:30` — `expireDueRuns` and `src/commands/run/expire-runs.ts:33` — `append` are its only two seam calls, and `src/commands/run/expire-runs.ts:6` — `ExpiredRun` carries `runId`, `nodeId` and `fence` and nothing else. Story 1 adds `execution.attemptsOfRun` because `attemptId` and `attemptNo` exist nowhere else on that path.
- **`expireDueRuns` has no driver predicate.** `src/services/execution/sqlite.ts:146` — `WHERE state = 'active' AND expires_at <= ?` expires an `internal` run and an `external` run alike, so the expiry path is not external-only.
- **The startup verdict's runs are `internal` by construction.** `src/commands/startup/recover-expired-leases.ts:229` — `internalRows` is the set it walks, and `src/commands/startup/recover-expired-leases.ts:228` — `externalRows` goes to the sweep. `run-expired` therefore carries the driver `both`, applied at `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:60` — `run-expired`.
- **The internal startup pass reaches no descendant run.** `src/commands/startup/recover-expired-leases.ts:252` — `lease-expired-on-non-task` refuses a non-task internal candidate before the verdict, so there is no startup cascade close. The one cascade in that file is the sweep's, at `src/commands/startup/recover-expired-leases.ts:196` — `closeAttempt`.
- **A function-valued dependency records nothing.** `test/helpers/sequence-conformance.ts:113` — `typeof capability !== "object"` returns it unwrapped, so a bare `endAttempt` key would be invisible at the seam and no diagram could hold the call.
- **The diagram parser fixes the token shape.** `test/helpers/sequence-conformance.ts:259` — `callMatch` requires `<key>.<method>` with a lowercase key, and `test/helpers/sequence-conformance.ts:267` — `dependencyKeys.includes(key)` requires the key to exist on the recorded object.
- **The release's accounting projection already carries the class.** `src/commands/node/release-node.ts:113` — `accountAttempts` runs before the close and decides the arm, so `src/commands/node/release-node.ts:134` — `attempt-limit` is reachable only through an earlier semantic attempt of the same run.
- **`endActiveTaskRunsUnderObjective` has no ancestor run id.** `src/commands/startup/recover-expired-leases.ts:166` — `Readonly<{` holds `objectiveId`, `skipTaskIds`, `outcome` and `at`, so Story 3 adds one field to carry `ancestorRunId`.
- **`attempt.caller` and `attempt.subject` are written at the open and not at the close.** `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:101` — `OpenAttemptInput` gains both, so no story of this epic supplies either.
- **The one writer of `attempt.outcome`.** `src/services/execution/sqlite.ts:294` — `UPDATE attempt SET outcome` is it, which is what makes the closure a count of callers of `execution.closeAttempt`.

## Decisions taken during authoring, and now recorded in the EPIC

- **The nested `endAttempt` is drawn as `attempt.end:A`, over an object-valued `attempt` key.** The human ruled it on 2026-09-04, and the rest of the family carries the same token: `.agents/plan/stories/054.2-the-execution-accept-pays-its-attempt/07-the-accepted-land-closes-through-the-command.md:15` — `Seams` declares `+attempt.end:A, -execution.closeAttempt:A`, and `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md:66` — `attempt.end` states it for the three accepted arms. A token with no key is refused by `test/helpers/sequence-conformance.ts:259` — `callMatch`, and a function-valued `endAttempt` key would record nothing at all per `test/helpers/sequence-conformance.ts:113` — `typeof capability !== "object"`. `objective.aggregate` at `.agents/plan/stories/053-node-state-ownership/08-the-accepted-settle-aggregates-the-parent.md:14` — `Seams` is the shipped nested-command idiom, subject noun as the key and verb as the method. **The projection is EPIC 054.2 Story 1's**, at `.agents/plan/stories/054.2-the-execution-accept-pays-its-attempt/01-the-unreachable-candidate-pays-its-attempt.md:206` — `attempt.end`, which projects `attemptId` and is what makes the `:A` label appear. See `01-the-expiry-pass-ends-the-attempt.md`, `02-the-release-pays-no-attempt.md`, `03-the-external-sweep-pays-its-attempt.md` and `04-the-startup-recovery-pays-its-attempt.md`.

- **Story 4 carries only the transaction-span half of the epic's gate row 10.** The human ruled it on 2026-09-04. Row 10 asks for a startup cascade close of a descendant run; `src/commands/startup/recover-expired-leases.ts:252` — `lease-expired-on-non-task` proves no such site exists, and the epic's own Decisions at line 44 assign the one cascade in that file to Story 3 under gate row 8b. Inventing a case over an unreachable fixture would either fail forever or pass vacuously. See `04-the-startup-recovery-pays-its-attempt.md`.

- **`execution.attemptsOfRun` is the reader Story 1 adds, and `expireDueRuns` is not widened.** `src/services/execution/index.ts:115` — `attemptsOfRun` is the shipped reader of an attempt row and the sweep already uses it at `src/commands/startup/recover-expired-leases.ts:106` — `attemptsOfRun`. Widening `src/services/execution/sqlite.ts:140` — `expireDueRuns` would make the one statement that ends a run also a read of a second table. See `01-the-expiry-pass-ends-the-attempt.md`.

- **Each of Stories 1 to 4 retires its own predecessor's scenario, in its own turn.** EPIC 051.5 Story 10 keys supersession on the superseding scenario file over an epic in `authoredEpics`, so Story 1's range insert is what arms the retirement and each story then adds one file and deletes one. Story 6 deletes none. See `06-the-proposal-records-the-lifecycle.md`.
