# EPIC 051 — The workspace branch and the first claim — stories

Epic: `.agents/plan/epics/051-the-workspace-branch.md`
Prereq: EPIC 050.5 (sequence order), and through it EPIC 050, EPIC 050.1, EPIC 050.2, EPIC 050.3 and
EPIC 050.4. Story 3 supersedes EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`)'s
`claim-lease-free-task` and inherits its ordinal contract. Story 3 also consumes EPIC 050 Story 2
(`02-the-run-row`)'s `run_base` cardinality refine. Every scenario runs on the harness of
EPIC 050.1 Story 6 (`06-the-conformance-harness`), and Story 6 relies on the primitive-argument
projection EPIC 050.2 Story 2 (`02-the-authority-seams`) adds. This epic needs neither EPIC 050.6 nor
EPIC 107.

An objective owns a branch record. The first execution claim on an objective cuts
`refs/heads/<objectiveId>` from `repository.branch` as a journaled write and writes the record in its
settle; every later claim reads the record in one transaction and passes `head_oid` as the run's base
oid; a concurrent loser fails on the primary key and refuses `objective-busy`; and a crash between
the two transactions is reconciled at startup from the `cut` journal row.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the
ship diagram, which replaces it. A story that writes a path from nothing draws the ship diagram
alone. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar and
`scripts/verify-epic-sequence.ts` enforces it.

Six stories carry a diagram: 3, 4, 5, 6, 7 and 8. **No story draws a `baseline-` diagram.** Story 3's
path was drawn by EPIC 050.4, so its prior set is that epic's live diagram and it declares
`Supersedes:`; the other five paths are written from nothing, because no shipped code reads
`workspace_branch`, no shipped command opens a journal row and no `cut` intent exists before
migration `13`. Stories 1, 2 and 9 draw nothing.

**Five stories declare every token of their diagram with `+`.** Their prior sets are empty, and
`scripts/verify-epic-sequence.ts:650` — `changed` demands exactly one sign owner for every token a
diagram's prior does not hold. A sibling branch of the same function is not a prior, so
`claim-branch-base-task`'s context tokens do not carry into `claim-cut-begin` or
`claim-first-execution`. `.agents/plan/stories/051.3-the-checkpoint-and-the-land/index.md:29` records
the same reading for the same reason.

The gate table now holds thirty-two rows, and every story owns at least one. Rows 26 to 32 were added
during authoring: the `git_operation` document and its historical constant (Story 9), the
`gitIntents` parity (Story 1), the advancing-source race (Story 6), the retry after recovery
(Story 8), the typed conflict result (Story 2), the widened `objectiveBusyDetails` (Story 7) and the
pid-file removal on both arms (Story 6).

There is **no groundwork story**. `scripts/lane-check.sh` denies only `package.json` and
`eslint.config.js` to both engineers, and this epic touches neither. Every path it edits is in an
engineer lane: every `src/**` and `docs/proposal/**` path to `software-engineer`, and every `test/**`
path to `test-engineer`. `scripts/epic-sequence-range.ts` is not a `*.test.ts` file, so it is the
`software-engineer` lane too. No `Paths:` grant exists to write.

## Dispatch order

Story 1 creates the schema and every later story reads it. Story 2 depends on Story 1 and **closes
the red interval Story 1 opens**: migration `13` creates `workspace_branch` before
`src/domain/rows.ts` registers it, so `src/services/storage/schema-parity.test.ts:90` — `it` is red
between the two. They dispatch back to back, and Story 1's `## Verify` command does not name that
file.

Story 3 depends on Story 2 and is the first diagram. It also puts `"051"` into `authoredEpics`, which
is what makes the supersession line legal at all.

Story 4 depends on Story 3, because it branches on the read Story 3 inserts and replaces the interim
throw Story 3 leaves. Story 5 depends on Stories 2, 3 and 4. Story 6 depends on Stories 4 and 5 and
is the story that makes `claimNode` asynchronous. Story 7 depends on Stories 5 and 6, and it replaces
the interim throw Story 6 leaves.

Story 8 is last of the code stories because it appends to `shippedEpics`, which makes all six
diagrams due at once. Story 9 is last, so the document describes a schema no later story moves.

A workable serial order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**.

No story depends on a story later than itself in that order.

**A dispatch precondition Story 8 cannot satisfy alone.**
`test/sequence/conformance.test.ts:264` — `slice` asserts `shippedEpics` is a prefix of
`authoredEpics`, so `"051"` may join `shippedEpics` only after EPIC 050.2, EPIC 050.3, EPIC 050.4 and
EPIC 050.5 have shipped. EPIC 051 cannot land before them.

## Stories

- 1 — Migration 13 → `01-migration-13.md`
- 2 — The workspace branch record → `02-the-workspace-branch-record.md`
- 3 — The claim reads the workspace head → `03-the-claim-reads-the-workspace-head.md` — draws
  `claim-branch-base-task`
- 4 — The claim's begin → `04-the-claims-begin.md` — draws `claim-cut-begin`
- 5 — The claim's settle → `05-the-claims-settle.md` — draws `claim-cut-settle`
- 6 — The first execution claim → `06-the-first-execution-claim.md` — draws `claim-first-execution`
- 7 — The loser of two first claims refuses → `07-the-loser-of-two-first-claims-refuses.md` — draws
  `claim-cut-settle-contested`
- 8 — Startup reconciles an open cut row → `08-startup-reconciles-an-open-cut-row.md` — draws
  `reconcile-cut`
- 9 — The proposal records the workspace branch → `09-the-proposal-records-the-workspace-branch.md`

## Facts (needed for implementation)

- **`claimNode` is synchronous today and becomes `async` in Story 6.**
  `src/commands/node/claim-node.ts:141` — `claimNode` returns `ClaimNodeResult`, not a promise, and
  `src/services/git/index.ts:179` — `resolveRef` and `src/services/git/index.ts:182` — `refUpdate`
  both return promises. The flip reaches `src/main.ts:553` — `node.claim` and the seventy-three cases
  of `src/commands/node/claim-node.test.ts`, through its two call helpers
  `src/commands/node/claim-node.test.ts:228` — `claim` and
  `src/commands/node/claim-node.test.ts:280` — `refused`. This is the largest single edit of the
  epic, and it is not optional.
- **This is the first journaled write in the repository.** `grep` for `journal.open(` outside tests
  finds nothing, and `src/services/git/index.ts:182` — `refUpdate` has no production caller: every
  hit is a test stub. `src/commands/startup/reconcile-journal.ts:176` — `settle` and
  `src/commands/startup/reap-orphans.ts:143` — `settle` are the only multi-transaction shapes to copy.
- **`run_base` has no writer anywhere.** `grep` for `INSERT INTO run_base` returns nothing, and two
  shipped cases pin the absence: `src/commands/node/claim-node.test.ts:908` — `it`, which Story 3
  replaces, and `src/commands/node/claim-node.test.ts:1915` — `it`, which stays. Its primary key is
  `(run_id, repository_id)` at `src/services/storage/migration-0012-run-model.ts:40` — `PRIMARY KEY`.
- **`git_operation` carries no index and no trigger**, so migration `13`'s rebuild needs no index
  dance. `src/services/storage/migration-0006-revision-origin.ts:8` — `ALTER` is the four-statement
  form it copies; `src/services/storage/migration-0007-external-execution.ts:11` — `DROP` is the
  fourteen-statement form it does not need.
- **`src/services/storage/migration-0011-deliverable.ts:8` — `PRAGMA` inlines its pragmas** although
  it declares `rebuild: true`. It is the deviant, and
  `src/services/storage/sqlite.ts:76` — `rebuild` is what actually owns both pragmas.
- **No UPDATE trigger exists in the repository.**
  `src/services/storage/migration-0009-one-branch.ts:8` — `TRIGGER` is the only `CREATE TRIGGER` in
  the migration set and it is a TEMP `BEFORE INSERT` trigger dropped inside its own migration. Story
  1's trigger is the first persistent one, and the syntax convention is all that carries over.
- **`workspace_branch` needs no `identityKinds` entry.** It is keyed on the node id, so
  `src/domain/identity.ts:127` — `nodeIdentity` is the fit and the three pinned counts of
  `src/domain/identity.test.ts:17` — `it` do not move.
- **Registering the row moves four shipped pins**: `src/domain/rows.test.ts:10` — `it` (22 → 23),
  `src/domain/rows.test.ts:14` — `it` (the name list), `docs/proposal/phase-1/domain.md:39` (the
  table line) and `src/services/storage/schema-parity.test.ts:90` — `it`.
- **`docs/proposal/database/workspace.md`'s first SQL fence is under test.**
  `src/services/storage/migration-0003-execution-and-journal.test.ts:476` — `proposalStatements`
  deep-equals it against migration `3`, and `test/helpers/proposal.ts:8` — `proposalStatements` reads
  the first fence only. `workspace` is the last table in that list still bound directly to the
  proposal; four others already use a `historical...Statement` constant, and Story 9 adds the fifth
  for `git_operation`.
- **`src/services/storage/sqlite.ts:37` — `assertIdle` refuses a nested `storage.transact`.** Every
  `claim.settle` call site is outside a transaction, and Story 5's case 4 asserts it.
- **`test/helpers/sequence-conformance.ts:121` — `input` calls a projection only when the last
  argument is an object.** `plan.readWorkspaceBranch` and `plan.readObjectiveRepository` take a
  primitive, so both are drawn bare.
- **`test/helpers/sequence-conformance.ts:345` — `pinned` throws for a note-pinned terminal**, and
  `test/helpers/sequence-conformance.ts:215` — `tail` accepts only the `tail pinned by` form, not the
  `tail unchanged by` form `.agents/plan/authoring.md` also declares. No diagram of this epic uses
  either note, and the divergence is reported below rather than worked around.
- **`scripts/epic-sequence-range.ts:1` — `authoredEpics` carries `"051.2"` and `"051.3"` and carries
  neither `"051"` nor `"051.1"`**, and `test/sequence/conformance.test.ts:255` — `assert` pins both
  lists by value. Story 3 inserts `"051"` between `"050.5"` and `"051.2"`, and Story 8 appends to
  `shippedEpics`. The list grows as sibling epics are authored, so both stories read it before they
  edit it rather than replacing it with a literal.
- **Measured on 2026-09-03: with `"051"` in `authoredEpics` and the supersession line in place,
  `scripts/verify-epic-sequence.ts:743` — `verifyEpicSequence` passes over this tree.** Without the
  range entry it throws `supersession names an epic outside the authored set: EPIC 051`.
- **`scripts/verify-epic-sequence.ts` is not named in `package.json:28` — `verify`.** It runs through
  `pnpm test`, because `scripts/verify-epic-sequence.test.ts:880` — `it` runs the gate against the
  real tree. A gate violation still fails `pnpm run verify`.
- **`docs/workflow/worker.md` is in the umbrella repository, not in this one.** Section 7 holds the
  workspace record and the first-claim rule the epic quotes, and section 8 holds the compare and swap.
  No path under `docs/` in this repository resolves it.

## Decisions taken during authoring, and now recorded in the EPIC

Every ruling below is applied to `.agents/plan/epics/051-the-workspace-branch.md` on 2026-09-03: its
`## Decisions` carries each one, its `## Stories` entries 1, 6, 8 and 9 are restated, gate rows 12,
14, 22 and 24 are rewritten, rows 26 to 32 are added, and the `Proof` block runs the five further
test files the stories deliver. This index repeats them so a reader of one story need not open the
epic.

- **The branch tip is resolved between the two transactions, not before the first.** The epic's
  Decisions say `git.resolveRef:branch` runs before the begin transaction and that its value is
  carried into the begin. That cannot be implemented:
  `src/commands/node/claim-node.ts:105` — `ClaimNodeInput` carries `nodeId`, `actorId`, `actorKind`
  and `available` only, so the command cannot know a `gitDir` or a branch name before it reads the
  database, and `src/services/storage/migration-0003-execution-and-journal.ts:136` — `base_oid` and
  `:137` — `proposed_head_oid` are both `NOT NULL`, so `journal.open` cannot be deferred past the git
  read either. **Ulrich ruled on 2026-09-03**: the begin transaction reads the claim state, the
  repository's `home_path` and `branch`, and opens the `cut` row at `base_oid` and
  `proposed_head_oid` both `ZERO_OID`; the tip is resolved after that transaction commits and before
  the ref is created. Two transactions, no git call inside either.
  **Three amendments follow.** The epic's Decision "`git.resolveRef:branch` runs before the begin
  transaction" is deleted. Gate row 14 becomes: a first claim resolves `repository.branch` **after**
  its begin transaction commits and **before** the ref creation, asserted by ordinals. Gate row 22
  becomes: startup completes an `open` `cut` row whose ref **exists** and discards one whose ref is
  absent. See `04-the-claims-begin.md`, `06-the-first-execution-claim.md` and
  `08-startup-reconciles-an-open-cut-row.md`.

- **`claim.begin` is a direct call and `claim.settle` is an injected nested command.** The epic's
  Story 6 entry calls `claim-first-execution` "the composed outer of `claim.begin`,
  `git.refUpdate:cut` and `claim.settle`", composing only, with no `Seams:` line. A full composition
  collapses `claimNode`'s trace to one token on **every** path, which breaks not only
  `claim-lease-free-task` but also EPIC 050.4 Story 2's initiative diagram and Story 3's
  `objective-busy` refusal — two supersessions this epic has no room for. Injecting neither leaves
  two bare `storage.transact` tokens in one diagram, which
  `test/helpers/sequence-conformance.ts:283` — `duplicate` refuses. The asymmetry is what the
  notation forces: `claim-first-execution` therefore holds sixteen steps and carries a `Seams:` line.
  **The epic's Story 6 entry must be restated.** See `06-the-first-execution-claim.md`.

- **`plan.readObjectiveRepository` is added, and the epic's Decisions now name it.** The begin
  transaction needs the objective's `home_path` and `branch` to hand the composer a `gitDir` and a
  ref, and `src/services/plan/index.ts:94` — `readRepositoryName` returns the name only. It is read
  on the cut branch alone, so `claim-branch-base-task` gains no token. See `04-the-claims-begin.md`.

- **`run_base` is written by `execution.openRun`, not by a seam of its own.** The epic requires the
  base row to be inserted atomically with the run, and one method inserting both rows is what makes
  it atomic. `OpenRunInput` gains a nullable `base` field, and no diagram gains a token. See
  `03-the-claim-reads-the-workspace-head.md`.

- **The settle reads no clock.** `src/commands/node/claim-node.test.ts:2526` — `it` asserts one claim
  reads the clock once. A second `clock.now` in the settle would break it for the journaled path
  while the later-claim path still read it once, so the begin's `now` is carried on
  `ClaimBegunCut`. See `05-the-claims-settle.md`.

- **The objective ref is read back after the cut, and that oid — never the source tip — is what the
  settle records.** Without it the epic has a corruption: claim A cuts `refs/heads/objective_a` at
  `commit1`, `refs/heads/main` advances to `commit2`, claim B resolves `commit2`, B's create-only
  swap loses, and B's settle wins the branch-record insert, leaving `workspace_branch`, `run_base`
  and the journal row all naming `commit2` while the ref stands at `commit1`. The swap's own verdict
  cannot repair it: `src/services/git/ref-update.ts:28` — `parseObservedOid` matches
  `is at <oid> but expected`, which git's create-only "already exists" failure never emits, so
  `observedOid` is `null` on exactly the losing branch. `claim-first-execution` therefore holds
  `16 git.resolveRef:cut`, unconditional so the path keeps one trace. **The epic's Decision that both
  claims "create the same ref at the same oid" is false whenever the source branch moves**, and it is
  the sentence this ruling replaces. See `05-the-claims-settle.md`,
  `06-the-first-execution-claim.md` and `08-startup-reconciles-an-open-cut-row.md`.

- **The contention is a typed store result, not a caught SQLite error.**
  `plan.writeWorkspaceBranch` carries `ON CONFLICT (node_id) DO NOTHING RETURNING` and returns
  `null`; the settle branches on `null` and discards in the same transaction, so the journaled write
  still opens exactly two. An earlier draft caught `errcode & 0xff === 19` in the command: that mask
  is **every** SQLite constraint class, so it would have swallowed a foreign-key, CHECK or NOT NULL
  defect as contention, and it would have put a vendor semantic inside `commands/`, which the import
  matrix of `AGENTS.md` refuses. See `02-the-workspace-branch-record.md` and
  `07-the-loser-of-two-first-claims-refuses.md`.

- **`objectiveBusyDetails` is widened, and Ulrich ruled on 2026-09-03.**
  `src/http/contract/error-details.ts:168` — `objectiveBusyDetails` is a `z.strictObject` requiring
  `siblingNodeId`, `siblingRunId` and `expiresAt`, and a contended first claim has no sibling run to
  name. The epic's Decision pins the shipped `objective-busy` code, so the three run-scoped members
  become nullable and the shipped four-field raise at
  `src/commands/node/claim-node.ts:302` is unchanged. The alternative — a new refusal code with its
  own status, exit code, handler arm and details schema across six files — was rejected, because it
  contradicts that Decision. Story 7 (`07-the-loser-of-two-first-claims-refuses`) step 2b implements
  it, and gate row 31 proves it.

- **The pid-file removal is a drawn step.** It runs on the same recorded `git` dependency before
  `claimNode` returns or throws, so the recorder emits it and `claim-first-execution` must hold it as
  step 18. An earlier draft placed it "after the terminal" and omitted it; the trace would not have
  conformed. See `06-the-first-execution-claim.md`.

- **`claim-cut-settle-contested` ends `ok`, not `refuse:objective-busy`.** `claimSettle` returns
  `{ disposition: "contended" }` and raises nothing, and
  `test/helpers/sequence-conformance.ts:303` — `resultTerminal` derives the terminal from the real
  result. The refusal belongs to the composed command and is proven by cases. A scenario that
  converted the return into a synthetic error would assert a terminal the code does not produce. See
  `07-the-loser-of-two-first-claims-refuses.md`.

- **The `cut` reconcile arm is an exported nested unit.** `reconcileJournal` opens one transaction
  for `src/commands/startup/reconcile-journal.ts:41` — `listOpen` and one per settled row, so its
  trace holds two bare `storage.transact` tokens. `reconcileCut` is the smallest decomposition that
  makes the path drawable, and it mirrors the module-private
  `src/commands/startup/reconcile-journal.ts:176` — `settle` the file already uses. See
  `08-startup-reconciles-an-open-cut-row.md`.

- **`gitIntents`, `GitIntent` and the CHECK move together in Story 1.** The epic's Story 1 entry
  names the CHECK only. `src/domain/git-operation.ts:7` — `gitIntents` and
  `src/services/git/index.ts:197` — `GitIntent` are the two readers of that literal set, and Story 4
  passes `intent: "cut"` through both. `src/services/git/index.ts:146` — `intent`, the inline union
  of `OutsideWriterInput`, is deliberately **not** widened. See `01-migration-13.md`.

- **Story 9 amends `docs/proposal/database/git_operation.md` and adds a fifth historical constant.**
  The epic's Story 9 entry names `workspace.md` only, and the epic's gate has **no row** for the
  `git_operation` document. Leaving it at four intents ships a record that contradicts the live
  schema. The amendment forces `historicalGitOperationStatement` in
  `src/services/storage/migration-0003-execution-and-journal.test.ts`, following the four constants
  that file already carries. **The epic's gate needs a row for it**, owned by Story 9. See
  `09-the-proposal-records-the-workspace-branch.md`.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`)** — its `## Change` step 3 declares a
  `refNamespace` projection for `git.resolveRef`, and `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:127` still
  projects it that way. EPIC 051 Story 6 lands `git.resolveRef` projecting the **ref value**, not its
  namespace: `claim-first-execution` resolves
  two different refs, and a namespace projection would emit `git.resolveRef:branch` twice, which
  `test/helpers/sequence-conformance.ts:283` — `duplicate` refuses. **That story must alias its
  candidate refs by value instead of introducing `refNamespace`.** **The default if no ruling arrives: EPIC 051.1 Story 4 emits `git.resolveRef:branch` twice**, and its own conformance case is red.

- **EPIC 051.3 Story 3 (`03-the-land-opens-its-journal-row`)** — its `## Change` step 3 declares the
  `journal.open` projection. EPIC 051 Story 4 lands it first, so that step becomes a no-op it must
  restate. **The default if no ruling arrives: that story re-applies a projection the harness already
  holds**, and its groundwork turn reports a no-op edit.
