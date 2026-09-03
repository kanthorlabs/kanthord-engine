# EPIC 051.3 — The checkpoint schema and the land — stories

Epic: `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md`
Prereq: EPIC 051.2 (sequence order), and through it EPIC 051 and EPIC 051.1. Story 1 takes migration
version `14` behind EPIC 051's migration `13`, which creates `workspace_branch` and the
`origin_oid` trigger. Story 4 calls EPIC 051's `plan.setWorkspaceBranchHead`. Stories 6 and 8 consume
`execution.endRun`'s fence raise and `execution.runById`, both of EPIC 050.2 Story 2
(`02-the-authority-seams`), and the `run.ended` event type of EPIC 050.2 Story 7
(`07-the-worker-contract`). Every scenario runs on the harness of EPIC 050.1 Story 6
(`06-the-conformance-harness`).

An accepted commit becomes the checkpoint of an execution run. The land is a compare and swap on the
objective branch, bracketed by a `merge` journal row; a successful swap writes the checkpoint,
advances the branch head, records the node transition and the event in one transaction; a lost swap
is `contended`, consumes no attempt, ends the run and returns the node to `ready`; and a crash
between the ref move and the transaction is reconciled at startup.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the
ship diagram, which replaces it. A story that writes a path from nothing draws the ship diagram
alone. A story that changes no path draws nothing, and the pair rule does not reach it.
`.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` enforces it.

Four stories carry a diagram: 3, 4, 5 and 6. Only Story 6 draws a pair, because only Story 6 changes
shipped code. Stories 1 and 2 draw nothing.

**No story here composes.** `land.begin` and `land.settle` are nested units with no caller in this
epic. EPIC 051.4's `acceptExecution` injects them, orders them around the compare and swap, removes
the pid file the settle returns, and draws the composed paths. There is no `land.execute` command.

There is no groundwork story. `scripts/lane-check.sh` allows every path this epic edits to one of the
two TDD engineers: every `src/**` path to `software-engineer`, and
`test/helpers/sequence-conformance.ts` and `test/sequence/scenarios/**` to `test-engineer`. No
locked path is touched, so no `Paths:` grant exists to write.

## Dispatch order

Story 1 is the schema and every later story reads it. Story 2 depends on Story 1 and gives Stories 4
and 8 the writer they call.

Story 3 creates `src/commands/checkpoint/land-execution.ts` and must land before Stories 4 and 5,
both of which extend that file. Story 4 depends on Stories 1, 2 and 3. Story 5 depends on Stories 3
and 4, for the shared `landSettle` signature.

Story 6 depends on Stories 3 and 4, and it is placed last because it is the only story that edits
shipped code, its cases carry the whole shipped verdict ladder as a regression, and it owns the
epic's gate row 24, which needs every scenario to exist.

A workable serial order: **1 → 2 → 3 → 4 → 5 → 6**.

No story depends on a story later than itself in that order.

## Stories

- 1 — Migration 14 → `01-migration-14.md`
- 2 — The checkpoint row → `02-the-checkpoint-row.md`
- 3 — The land opens its journal row → `03-the-land-opens-its-journal-row.md` — draws `land-begin`
- 4 — The accepted settle → `04-the-accepted-settle.md` — draws `land-settle-accepted`
- 5 — The contended settle → `05-the-contended-settle.md` — draws `land-settle-contended`
- 6 — Startup reconciles an open merge row → `06-startup-reconciles-an-open-merge-row.md` — draws
  `reconcile-merge-land` and `baseline-reconcile-merge`

## Facts (needed for implementation)

- **The highest shipped migration is `12`.** `src/services/storage/migrations.ts:27` —
  `migration0012RunModel` is the last entry, and neither `13` nor `14` exists in the tree today.
- **`run_base` is created by migration `12`**, not by migration `7`:
  `src/services/storage/migration-0012-run-model.ts:36` — `run_base`, primary key
  `(run_id, repository_id)`.
- **`attempt` carries `id TEXT PRIMARY KEY` and `UNIQUE (run_id, attempt_no)` and no key on
  `(id, run_id)`.** `src/services/storage/migration-0007-external-execution.ts:47` — `UNIQUE`. The
  epic's index decision rests on this.
- **The only trigger in the shipped migration set is a temporary guard.**
  `src/services/storage/migration-0009-one-branch.ts:8` — `TRIGGER` fixes the syntax convention;
  Story 1's trigger is the first persistent one.
- **`git_operation` carries `node_id` and `run_id` and no `attempt_id`.**
  `src/services/storage/migration-0003-execution-and-journal.ts:131` — `node_id`. `listOpen` at
  `src/services/git/journal.ts:60` — `SELECT` projects neither today.
- **`execution.endRun` does not raise the fence in the shipped implementation.**
  `src/services/execution/sqlite.ts:219` — `endRun` writes `state`, `outcome` and `ended_at` only;
  `src/services/execution/sqlite.ts:145` — `fence` is the only `fence + 1` today.
  `.agents/plan/epics/050.5-the-lease-table-removal.md:115` records that the raise belongs to
  EPIC 050.2 Story 2 (`02-the-authority-seams`).
- **There is no `execution.runById` and no `run.ended` event type today.** Both arrive with
  EPIC 050.2. `src/domain/event-type.ts:1` — `eventTypes` holds `run.expired` and `run.opened` and
  no other run type.
- **`refUpdate` returns a verdict and never throws on a lost swap.**
  `src/services/git/ref-update.ts:28` — `observedOid`, and the observed oid is `null` when git's
  stderr does not name it.
- **`src/commands/checkpoint/` does not exist**, and the identifier `checkpoint` appears nowhere in
  `src/`.
- **`storage.transact` refuses a nested call.** `src/services/storage/sqlite.ts:37` — `assertIdle`,
  so a settle called from inside a caller's transaction throws. Every `land.settle` call site is
  outside a transaction.
- **The recorder projects `execution.closeAttempt` by `attemptId` alone.**
  `test/helpers/sequence-conformance.ts:64` — `closeAttempt`. Six authored diagrams already draw
  `execution.closeAttempt:A`, so the projection may not be widened.

## Decisions taken during authoring, and now recorded in the EPIC

A human rules on each before dispatch. The stories implement the ruling as written here.

- **Migration `14` creates the complete review shape, and EPIC 053 adds no column.** The epic's Goal
  and Non-goals say migration `14` creates the whole `checkpoint` table, and the same Decisions
  paragraph that defers the review columns also requires a CHECK "of the same shape for the review
  group" — which cannot exist without them. Story 1 therefore adds `verdict`, `judged_oid`,
  `reason_blob` and `judged_checkpoint_id` with two review CHECKs. The alternative, three CHECKs and
  no review column, admits a `kind = 'review'` row with every column null until EPIC 053 lands, and
  it forces a later `checkpoint` rebuild because SQLite cannot widen a CHECK in place. The column set
  is the one the epic's `## Amendments` enumerates, so nothing is invented.
  **EPIC 053's amendment must be rewritten: it gains a writer and adds no migration column.** See
  `01-migration-14.md` and `02-the-checkpoint-row.md`.

- **The accepted settle appends the shipped `outcome.reported` and `run.ended`, and registers no new
  event type.** An earlier draft of these stories invented `checkpoint.written`. An event that
  describes a node transition must sit in the transaction of that transition, and the epic moves the
  transition into this settle, so `outcome.reported` moves with it. A third event for the checkpoint
  itself has no requirement behind it; a consumer reads `outcome.reported.objectId` and joins the
  `checkpoint` table. This deletes the event-type registration, the payload schema, the fixture and
  the openapi count bump from Story 4. **EPIC 051.4 must remove those writes from `reportOutcome`'s
  own path when it wires the route.** See `04-the-accepted-settle.md`.

- **The contended settle appends `run.ended` and registers no new type.** It ends the run, and
  EPIC 050.2 Story 7 (`07-the-worker-contract`) already declares that event with a run subject. See
  `05-the-contended-settle.md`.

- **The node transitions use the shipped external triggers `outcome-accepted` and
  `report-cancelled`.** `src/domain/external-transition.ts:4` — `externalTriggerIds` is closed, and
  `src/domain/external-transition.ts:215` — `externalTriggerConsumer` is asserted against the files
  on disk, so both stories append `src/commands/checkpoint/land-execution.ts` to their trigger's
  consumer list. See `04-the-accepted-settle.md` and `05-the-contended-settle.md`.

- **There is no `land.execute`, and `acceptExecution` is the journaled write.** The epic
  contradicted itself: its `### Seam keys` section declared `land.begin` and `land.settle` as
  "nested unit functions injected into `AcceptExecutionDependencies`", while its Non-goals and two
  story entries named a composed outer. An earlier draft of these stories took the second reading and
  drew `land-execution-success` and `land-execution-contended`. Both were deleted: a command whose
  only work is to sequence three calls its one caller could sequence itself has no second reason to
  exist, and EPIC 051.4's stories already draw the composed order. This epic ships two nested units
  with no caller, and its gate rows for the compare and swap and for the git write outside a
  transaction move to EPIC 051.4's gate as rows 9a and 9b.

- **`git.refUpdate` projects its `ref`, and `journal.complete` and `journal.discard` project their
  `outcome`.** `.agents/plan/authoring.md` requires a projection to name a value the call actually
  receives, so the epic's `:land`, `:merge` and `:cancelled` labels are not available:
  `src/services/git/index.ts:214` — `CompleteJournalRowInput` and
  `src/services/git/index.ts:221` — `DiscardJournalRowInput` carry no `intent`, and no
  `RefUpdateInput` field names the call site. `journal.open` keeps `:merge`, because
  `src/services/git/index.ts:199` — `OpenJournalRowInput` does carry `intent`. No diagram of this
  epic draws `git.refUpdate` any more, so the `:land` correction is EPIC 051.4's to apply. See
  `03-the-land-opens-its-journal-row.md`, `04-the-accepted-settle.md` and
  `05-the-contended-settle.md`.

- **`execution.closeAttempt` keeps its shipped `attemptId` projection.** The epic asks for
  `:cancelled`, and six authored diagrams already draw `execution.closeAttempt:A`. The outcome is
  asserted by case 5 of `05-the-contended-settle.md` instead.

- **The startup reconcile calls `land.settle` and appends no `recovery.journalReconciled` event on
  that path, and the actor carries the provenance.** The settle owns the whole completion of a landed
  row, including `journal.complete`, and a second event appended outside it would need a second
  transaction at that level or a recovery-only branch of the settle that no diagram draws.
  `LandSettleInput` therefore carries `actorKind` and `actorId`: the reconcile passes
  `"daemon"` and the startup actor, and `reportOutcome` passes the authenticated harness actor, so
  both `outcome.reported` and `run.ended` record which one wrote them. The removal is declared with
  its baseline and the other five verdicts keep the event.
  `ReconcileJournalDependencies` therefore gains `execution` and `land`, and not `plan` as the
  epic's story entry states: the objective the branch record needs is derived inside the settle from
  the node it already reads. See `06-startup-reconciles-an-open-merge-row.md`.

- **The accepted settle closes the attempt, ends the run and raises the fence, and the epic's
  Decisions must be amended.** The epic states that `land-settle-accepted` never ends the run, and
  gives one reason: Story 6 derives the checkpoint fence from `run.fence` at reconcile time. That
  derivation is unaffected, because the reconcile runs only when the settle did **not** — the run is
  still active and its fence still holds the begin-time value. Leaving the run active is not a free
  alternative: `acceptExecution` writes git, so `AGENTS.md` gives it two transactions and never a
  third, and no command may open one after the land. A task would otherwise reach `done` holding an
  active run and an open attempt. See `04-the-accepted-settle.md` and
  `06-startup-reconciles-an-open-merge-row.md`.

- **This epic adds three external triggers, and it reuses none for a meaning it does not have.**
  `objective-land-accepted` carries an atomic objective from `running` to `awaiting_approval`;
  `land-contended` and `objective-land-contended` carry a task and an atomic objective from
  `running` to `ready`. `src/domain/external-transition.ts:90` — `object-reported` carries
  `childAggregation: "every-task-terminal-one-done"`, and
  `src/domain/external-transition.ts:180` — `report-cancelled` is `actorKind: "harness"`, so
  borrowing either would make the audit log claim an aggregation or a report that never happened.
  `src/domain/node-trigger.ts:135` — `triggerTransition` resolves one trigger to one row, which is
  why the objective needs its own ids. `src/domain/outcome.ts:17` — `objectiveOutcome` is not called
  at all: it projects a `TerminalState` from children an atomic objective does not have. See
  `04-the-accepted-settle.md` and `05-the-contended-settle.md`.

- **The `running` to `ready` legality row gains its objective column, so a contended atomic objective
  is claimable again.** `src/domain/transition.ts:136` — `to` makes it task-only today, and an
  atomic objective that can land accepted can equally lose its swap. Leaving it stranded in `running`
  would contradict this epic's Goal — a failed swap returns the node to `ready` — and
  `.agents/plan/authoring.md` requires a change to carry the repairs it forces. The widening is safe
  because a write reaches the table only through a trigger, and only the two new contention triggers
  name that row for an objective. See `05-the-contended-settle.md`.

- **`land.settle` returns the pid-file token and its callers remove the file.**
  `src/services/git/index.ts:262` — `complete` and `src/services/git/index.ts:266` — `discard` each
  return the row's `child_token` before clearing it, and
  `src/commands/startup/reconcile-journal.ts:233` — `removeClearedToken` is the shipped pattern.
  Dropping the return value clears the column and leaks the file, so `git.removePidFile` is a drawn
  step of the reconcile pair here and of EPIC 051.4's composed diagrams. See
  `04-the-accepted-settle.md` and `06-startup-reconciles-an-open-merge-row.md`.

- **`clock.now` is a drawn step of both settles.** It is an injected capability, so the recorder sees
  it wherever it runs; placing the read before `storage.transact` changes its ordinal and not its
  visibility. See `04-the-accepted-settle.md` and `05-the-contended-settle.md`.

- **The recorder must call a declared projection whatever the last argument's type is.**
  `test/helpers/sequence-conformance.ts:121` — `input` applies a projection only when that argument
  is an object, so a projection on a method taking a primitive id is dead. That makes
  `execution.runById:R` and `execution.attemptsOfRun:R` — drawn by EPIC 050.2, EPIC 050.4 and
  EPIC 050.5 — unemittable. Dropping the label loses discrimination and changing the signature
  changes a production interface for a notation, so the repair is the harness: call the projection
  unconditionally, give `runById` and `attemptsOfRun` projections that read the primitive directly,
  and add controls proving a no-argument method (`clock.now`) and a function-argument method
  (`storage.transact`) stay bare. `plan.readNode` gets no entry and stays bare.
  **The change belongs to the earliest story whose live diagram needs it, which looks like EPIC 050.2
  Story 2 (`02-the-authority-seams`) — a cross-epic amendment either way.** These stories draw the
  labels on that basis.

- **`execution.stampRunHead` needs a projection entry, and Story 4 adds it.** Its input is an object,
  but the table holds no entry, so the recorder emits it bare — which is why EPIC 050.4 Story 6
  (`06-the-report-drops-the-lease`) draws `execution.stampRunHead:R` that the harness cannot produce.
  See `04-the-accepted-settle.md`.

- **`events.append:run.ended` carries three labels.**
  `test/helpers/sequence-conformance.ts:72` — `events.append` appends `String(payload.reason)`
  whenever the payload holds the key, and EPIC 050.2 Story 5 (`05-the-release`) declares
  `reason: z.string().nullable()` on `run.ended`. Story 6 writes `reason: "contended"`, so the token
  is `events.append:run.ended:R:contended`. See `05-the-contended-settle.md`.

- **Gate row 24 is owned by Story 6.** It names four diagrams now, and Story 6 dispatches last, so
  it is the first point at which every scenario exists. The standard lets other stories contribute
  implementation while one story owns the proof, and each earlier story keeps its own scenario file
  and its own cases. See `06-startup-reconciles-an-open-merge-row.md` case 12.

- **The reconcile derives the attempt and the fence inside the listing transaction.** Read in a
  transaction of their own, `storage.transact` would appear twice in the live diagram and would need
  the `:#<n>` discriminator, which `.agents/plan/authoring.md` refuses outside a baseline. See
  `06-startup-reconciles-an-open-merge-row.md`.

- **The `workspace_branch` delete trigger tests the objective and its children.**
  `workspace_branch.node_id` is the objective and `checkpoint.node_id` is the node that ran, so a
  predicate comparing the two directly would never fire for a task checkpoint. See
  `01-migration-14.md`.
