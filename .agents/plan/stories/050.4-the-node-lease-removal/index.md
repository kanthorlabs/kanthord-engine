# EPIC 050.4 — The node lease removal — stories

Epic: `.agents/plan/epics/050.4-the-node-lease-removal.md`
Prereq: EPIC 050, EPIC 050.1, EPIC 050.2 and EPIC 050.3, implemented. Every story here reads a `run` row and the authority check EPIC 050.2 Story 1 landed, and six of the seven implement stories supersede a live diagram of EPIC 050.1 or EPIC 050.2 — a superseding story cannot dispatch before the diagram it replaces is on disk.

A worker proves itself by the run it holds and by nothing else. Four operations and one nested command
stop naming the lease, and the node-lease fields leave the wire.

## One story, one path

A story that changes a shipped path draws a pair: the prior diagram and the ship diagram. A story
that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar, and
`scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 enforces it.

Ten stories, which is the cap. Seven carry a pair: 1, 2, 3, 4, 5, 6 and 7. Three carry none —
Story 0, Story 8 and Story 9.

**Six of the seven prior sets are live diagrams, not baselines.** EPIC 050.1 drew `claim-success-task`,
`claim-success-initiative` and `claim-refusal-objective-busy`; EPIC 050.2 drew `renew-success`,
`release-success` and `report-authority-prelude`. A path an earlier epic already drew has no
`baseline-` diagram, so those six stories declare `Supersedes:` where a first change declares
`Baselines:`. Story 7 is the one path nobody drew, and it carries `baseline-report-objective` with a
citation per step.

**No diagram in this epic pins a tail.** Each of the seven draws its whole path. Story 6 is why: the
call it deletes sits behind a duplicate token, so the prefix cannot stop short of the end.

**A line citation names the shipped file, not the file this epic edits.** EPIC 050.1 Story 3 rewrites
`claim-node.ts` whole and EPIC 050.2 Story 3 renames `heartbeat-node.ts` to
`src/commands/run/renew-run.ts`, so a line number in Stories 1 to 4 locates the code by the symbol
that survives those changes rather than by an offset that will have moved. The ordinal contract of
each of those stories is the superseded diagram. Stories 5, 6 and 7 cite files EPIC 050.2 amends at
one point, so their line numbers hold.

## The contract is split per operation, and the residue lands last

Each operation's request fields, response fields and `errors` entry die **in the story that changes
that operation's command**. Story 8 holds only what is cross-cutting: `errorStatuses`, `exitCodes`,
`leaseHeldDetails`, the capability swap, the version and the compatibility record.

**This is a sequencing rule, not a taste.** A required request field cannot leave `nodeRenewRequest`
before `renew-run.ts` stops reading it, because the handler between them would not compile and
`pnpm run verify` would be red for the length of the epic. Every story in this tree that touches a
schema ends with `pnpm run verify` exits 0, and that promise is only keepable if the schema and its
reader move together. Story 8 is therefore the last of the contract work and not the first:
`errorStatuses` can lose `lease-held` only once no operation declares it.

## The one locked path, and the one interval the tree admits

`package.json` is the only path this epic edits that `scripts/lane-check.sh` denies to **both**
engineers, so Story 0 (`00-groundwork`) holds it and declares `Executor: groundwork-engineer` and
`Paths: package.json`. Its edit is one value: `version` to `29.0.0`.

**That value has a matching half in the other lane, and the pair cannot be atomic.**
`src/domain/version.ts:1` — `KANTHORD_VERSION` holds the same string and
`src/domain/version.test.ts:13` — `assert.equal` asserts the two are equal. `src/domain/version.ts`
is the software-engineer lane. Story 0 runs pre-loop, per `/work` Step 4.5, and Story 8
(`08-lease-held-is-retired`) writes the constant, so `src/domain/version.test.ts` fails on that one
assertion between them.

**The interval is invisible to every case that runs in it.** `src/domain/version.test.ts` appears in
the `node --test` list of Story 8 alone, and `/work` runs the `Gates:` command once, as a
precondition of `IMPLEMENTATION_READY_FOR_REVIEW`, after every story. Assertion 8 of the epic's gate
is owned by Story 8, which lands the half that closes it. No other epic-wide claim is affected: the
schema-and-reader coupling above is a separate rule and it holds unchanged.

## Dispatch order

Story 0 runs first and outside the loop. `/work` Step 4.5 dispatches the `groundwork-engineer` for
its `Paths:` set before the first `test-engineer` turn, so no engineer story waits on it.

Stories 1, 2 and 3 are one command, `claim-node.ts`, and they run in order: Story 1 deletes
`liveLeasesOf` and `acquireWithHierarchyRefusal`, and Stories 2 and 3 draw the paths that remain.

Stories 4 and 5 are one command each and are independent of each other. Story 4 deletes the shared
`claimedLease` schema, so it follows Story 1, its other consumer.

Story 6 changes `report-outcome.ts` and Story 7 changes the nested `report-objective.ts` it dispatches
to. Story 7 follows Story 6, and Story 6 carries the whole `fence` removal on both sides of that call —
the request members, `ReportObjectiveInput` and the argument — because `body.fence` stops existing
there and an argument cannot outlive its value.

Story 8 follows Stories 1, 4, 5 and 6. Story 9 follows every prior story.

The serial order is the numeric order: **0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**. No story depends on a later one.

## Stories

- 0 — groundwork → `00-groundwork.md` — draws nothing; `Executor: groundwork-engineer`, `Paths: package.json`
- 1 — The claim of a task drops the lease → `01-the-claim-of-a-task-drops-the-lease.md` — draws `claim-lease-free-task`
- 2 — The claim of an initiative drops the lease → `02-the-claim-of-an-initiative-drops-the-lease.md` — draws `claim-lease-free-initiative`
- 3 — The objective-busy refusal drops the lease → `03-the-objective-busy-refusal-drops-the-lease.md` — draws `claim-lease-free-objective-busy`
- 4 — The renew drops the lease → `04-the-renew-drops-the-lease.md` — draws `renew-lease-free`
- 5 — The release drops the lease → `05-the-release-drops-the-lease.md` — draws `release-lease-free`
- 6 — The report drops the lease → `06-the-report-drops-the-lease.md` — draws `report-lease-free`
- 7 — The objective attestation drops the lease → `07-the-objective-attestation-drops-the-lease.md` — draws `baseline-report-objective` and `attest-lease-free`
- 8 — `lease-held` is retired and the capability is swapped → `08-lease-held-is-retired.md`
- 9 — The proposal records one authority → `09-the-proposal-records-one-authority.md`

## Facts, verified against the source

The draft epic that preceded this tree described a mechanism the code does not have. Each fact below
was read out of the source before a story was written, and each one changed a story or the epic.

- **The repository lease does not exist.** `lease.acquire` has exactly one caller,
  `src/commands/node/claim-node.ts:426`, and it passes `subjectKind: "node"`. Every `lease.read`,
  `lease.renew`, `lease.release` and `lease.assertHeld` call site passes `"node"` too.
  `lease.expireLeasesOfOwner` at `revoke-actor.ts:100` passes **no** `subjectKind` at all — its SQL
  filters on `owner` alone — so it is the one call that is not node-scoped by its argument, and it is
  node-scoped only by what the table happens to hold. The only `INSERT INTO lease` in production is
  `src/services/lease/sqlite.ts:160`. Five files under `src/commands/` hold
  `subjectKind: "repository"` — `assert-no-outside-writer.ts`, `register-repository.ts`,
  `reap-orphans.ts`, `sweep-remnants.ts` and `reconcile-journal.ts`, two of them more than once — and
  **every occurrence is an `events.append` subject kind, not a lease row**. The draft epic reserved a
  repository half with "every column, every caller and its fence semantics"; there is no caller.

- **`lease-held` has no surviving producer.** It is declared on `node.claim` (`execution.ts:302`),
  `node.heartbeat` (`:321`), `node.release` (`:340`) and `node.report` (`outcome.ts:151`), and on no
  repository operation. When Stories 1 to 7 land, nothing raises it. It is retired, not scoped, and
  `leaseHeldDetails` is deleted rather than left unreachable.

- **`error-details.ts` cannot be unchanged.** `:6` imports `leaseRelations` from
  `src/domain/lease-hierarchy.ts`, the file EPIC 050.5 deletes whole, and `:128` is its only use.
  `src/services/lease/index.ts:2` imports `LeaseRefusal` from the same file. Story 8 removes the
  contract import; EPIC 050.5 removes the service one.

- **Two of the three "outcome commands" hold no lease.** `aggregate-initiative.ts` imports
  `aggregate`, `initiativeOutcome`, `terminalStates`, `EventLog`, `PlanStore` and `Transaction` —
  no `Lease`. `close-objective.ts` imports `Clock`, `EventLog`, `Execution` and `PlanStore` — no
  `Lease`. Only `report-objective.ts` reads one, at `:80`, and it uses `lease.read` directly, not
  `liveLeaseRefusal`. The draft epic put all three in one story and named `liveLeaseRefusal` as the
  mechanism.

- **The wire fields reach two directories the first draft never enumerated.** `src/http/server/` and
  `src/cli/` are typed against `http/contract/`, so a deleted request or response field breaks them.
  `src/http/server/node/heartbeat-node.ts:31` and `:37`, `release-node.ts:31` and `:37`, and
  `report-node.ts:41-45` read the node-lease `fence`; `src/cli/node/claim.ts:51` and `:54` read
  `body.lease.fence`, `body.objectiveRunId` and `body.objectiveLease.fence`; `objectiveRunId` stays,
  while the two lease-fence reads leave; and
  `src/cli/node/heartbeat.ts`, `release.ts`, `report.ts` and `attest.ts` each declare a `--fence`
  option and send it. Stories 1, 4, 5 and 6 take those sites with the schema fields that force them,
  under the coupling rule of `.agents/plan/authoring.md`.

- **`lease-held` cannot leave `errorStatuses` while a server file raises it.** `httpError` at
  `src/http/contract/errors.ts:95-111` takes an `ErrorCode`, and `ErrorCode` is the key set of
  `errorStatuses`. `src/http/server/node/refusals.ts:242` and `:253` call
  `httpError("lease-held", ...)` inside `function leaseHeld` at `:231-259`, which is the only consumer
  of the `presented` channel threaded from `toHttpError` at `:14`. Story 8 deletes the helper and the
  channel in the same edit as the code, because five stories share the helper.

- **`field-decisions.fixture.ts` is derived and pinned.** `src/http/contract/coverage.test.ts:9` and
  `:457` deep-equal it against `scripts/derive-field-decisions.mjs`, and it holds one line per registry
  request and response field — including `node.claim.response#/properties/objectiveLease` at `:105-110`
  and `objectiveRunId` at `:111`. Every story that removes a field regenerates it, in that story.
  Deferring one regeneration to Story 8 leaves `coverage.test.ts` red for six stories.

- **`settings.leaseTtlMs` loses its last reader in Story 4.** `src/main.ts:555` and `:579` are its only
  consumers, and Stories 1 and 4 delete them. Story 4 takes the setting itself —
  `src/services/config/index.ts:35` and `src/services/config/convict.ts:242-245`, `:372` and `:538`,
  with the `KANTHORD_LEASE_TTL_MS` binding.

- **`liveLeaseRefusal` has two callers.** `src/commands/node/claim-node.ts:139` and
  `src/services/lease/sqlite.ts:128`. Story 1 removes the first; EPIC 050.5 removes the second with
  the file.

- **`readiness/dependency.ts` holds no lease.** Its dependencies are `events` and `instanceId`
  (`:7-10`). The draft epic gave it a disposition it does not need.

- **EPIC 050.2 deferred the wire fields to this epic, in writing.** Story 3 of that epic: _"The
  shipped `fence` field is the node lease fence and it stays … The two mechanisms run side by side
  inside one transaction until EPIC 050.4."_ The same sentence appears in its Story 5 and Story 6.
  `nodeClaimResponse` still holds `lease` and `objectiveLease` at `execution.ts:41-42`;
  `nodeRenewResponse` at `:52-53`; `nodeRenewRequest:33` and `nodeReleaseRequest:38` still carry the
  node-lease `fence`. The draft epic's "changes no wire shape" and `28.0.2` were both wrong.

- **`nodeClaimResponse.objectiveRunId` at `:45` remains produced after EPIC 050.** EPIC 050.1's
  `claim-success-task` opens or reuses the structural objective run and opens the task run, and EPIC
  050.1 Story 1 (`01-the-claim-contract`) now names the field. Story 1 of this tree removes only the
  node-lease fields and retains the objective run id for later objective authority.

- **`report-outcome.ts` reads its attempts twice**, at `:213` and `:240`, and `lease.release` sits at
  `:282`, after both. Two steps of one live diagram may not carry one token, so Story 6 collapses the
  reads. `release-node.ts:113-122` is the shipped pattern for that collapse, landed by EPIC 050.2
  Story 5 for the identical reason.

- **`releaseObjective` holds a second lease reader.** `release-node.ts:210-239` walks the objective's
  children and refuses `lease-held` on any live child lease. EPIC 050.2 Story 5 cites `:215` as
  _"`assertHeld`'s `lease.read`"_, which it is not: `assertHeld` is at `:302-326` and its read is
  inside the service, and `:215` is on the objective branch that a task-release fixture never reaches.
  **That citation is a defect in EPIC 050.2 Story 5**, and Story 5 of this tree states it rather than
  inheriting it.

- **`Lease.expired()` has no production caller.** `grep -rn '\.expired(' src/` returns test files
  only. EPIC 050.5 deletes it with the interface; no story here reads it.

- **`recover-expired-leases.ts` holds a second export.** `sweepExpiredExternalLeases` at `:79` is
  injected into `node.claim` (`main.ts:553`), `node.list` (`:515`) and `project.nodes` (`:634`), so
  the file's blast radius is three paths, not one. `recoverExpiredLeases` at `:213` is async and
  opens three separate transactions (`:218`, `:231`, `:328`) around git I/O. EPIC 050.5 owns both,
  and its gate cannot claim the recovery is atomic.

- **`run.worker` is not derived from `actorId`.** EPIC 050's Decisions state it outright: the claiming
  worker comes from a server-owned caller record, _"never from `actorId` and never from the request
  body"_. There is therefore no actor-to-run relation to query, which is what EPIC 050.5's revocation
  story turns on.

- **`system.status` exposes the lease table, and removing that projection is not free.**
  `system.ts:71` types `leases[].subjectKind` as `z.enum(leaseSubjectKinds)`, and `read-status.ts:79`
  reads `dependencies.clock.now()` **inside** the lease query — the query's only clock read. Deleting
  the projection therefore moves the seam trace of `system.status`, which makes it an implement story
  needing a pair; and `readStatus`'s `health` dependency is function-valued, so its baseline token is
  `health.call`, which a live diagram may not hold. The removal is **not in this epic**: the table
  still exists here, so the projection is truthful. EPIC 050.5 owns it with the table drop, and owns
  the `health.call` cause with it.

- **The `blocker` enum is open on the wire.** `error-details.ts:36` is `blocker: z.string()`, so
  dropping the `lease` member of `executionBlockers` changes no schema. That is EPIC 050.5's story,
  and this fact is what lets it stay wire-invisible everywhere except `system.status`.

- **`eventView.type` is `z.string()`** (`event.ts:25`), so the event catalogue is not wire-constrained
  and `recovery.leaseRecovered` and `recovery.leaseBlocked` cost no capability when EPIC 050.5
  retires them.

- **The refusal unions are erased types.** `ClaimRefusal`, `RenewRefusal`, `ReleaseRefusal`,
  `ReportOutcomeRefusal` and `ReportObjectiveRefusal` are `export type` unions of string literals with
  no runtime array. No story asserts one "by value against its runtime list"; each asserts the
  operation's contract `errors` record, which is runtime data, and leaves the type-level removal to
  `pnpm run typecheck`.

## Corrections already applied to the earlier epics' stories

Each chain must hold one live diagram. Six live diagrams gained or changed a `Superseded by:` line,
and every one of the six edits is **already in the tree**. Verify before editing; report a divergence
rather than re-applying.

| story              | diagram                        | was                           | now                                          |
| ------------------ | ------------------------------ | ----------------------------- | -------------------------------------------- |
| EPIC 050.1 Story 3 | `claim-success-task`           | `EPIC 051 claim-success-task` | `EPIC 050.4 claim-lease-free-task`           |
| EPIC 050.1 Story 4 | `claim-success-initiative`     | absent                        | `EPIC 050.4 claim-lease-free-initiative`     |
| EPIC 050.1 Story 5 | `claim-refusal-objective-busy` | absent                        | `EPIC 050.4 claim-lease-free-objective-busy` |
| EPIC 050.2 Story 3 | `renew-success`                | absent                        | `EPIC 050.4 renew-lease-free`                |
| EPIC 050.2 Story 5 | `release-success`              | absent                        | `EPIC 050.4 release-lease-free`              |
| EPIC 050.2 Story 6 | `report-authority-prelude`     | absent                        | `EPIC 050.4 report-lease-free`               |

EPIC 050.2 Story 6's ship diagram also re-pins its tail from `EPIC 051 report-execution-checkpoint`
to `EPIC 050.4 report-lease-free`, because this epic now owns that tail. That re-pin is applied too,
at `06-the-report-prelude.md:67`.

## Amendments the earlier epics needed, re-verified on 2026-09-02

**All four are applied or moot. Verify, and apply nothing.** Each was written as a pending one-line
edit; three landed before this tree was audited and the fourth was a misreading. They are recorded
here because an instruction to re-apply a landed edit is how a diagram gets pinned twice.

- **`.agents/plan/epics/050.2-the-run-renew-release-and-report.md:167` — APPLIED.** It names EPIC
  050.4, `report-lease-free` and `Story 6`.

- **`.agents/plan/stories/050.2-the-run-renew-release-and-report/06-the-report-prelude.md` — MOOT.**
  Its lines `:13`, `:120` and `:182` all name EPIC 050.4 Story 6 as the declarer of
  `report-lease-free`, and `:87` and `:107` carry the id. The earlier note claimed `:70` named Story
  8; `:173` is the only Story 8 reference in the file, it is about `refusals.ts:83` — `lease-held`,
  and it is correct, because Story 8 retires that code.

- **`.agents/plan/epics/051-the-execution-checkpoint.md:835` — APPLIED.** It reads _"EPIC 050.2's
  `report-authority-prelude` pins its tail to EPIC 050.4 `report-lease-free`. EPIC 050.4 Story 6
  declares that id."_ The same line defers EPIC 051's own `Supersedes:` to the story-tree conversion
  that `.agents/plan/pending/051-the-story-tree-conversion.md` owns, so `node.report`'s chain
  continues there and not in this tree.

- **`objectiveRunId` — DECIDED, and Story 1 takes it unconditionally.**
  `.agents/plan/stories/050.1-the-claim/01-the-claim-contract.md` never names the field, so EPIC
  050.1 does not remove it. The earlier hedge — _"if EPIC 050.1 removes it first, Story 1's item is a
  no-op"_ — is resolved against the tree: it is not a no-op, and the implementing agent deletes the
  field.

## What this epic is not

It is **not** wire-invisible, and it does not pretend to be. Two response fields and three required
request fields leave four operations, and an error code is retired. Every one of those is outside the
closed list of `docs/proposal/api/README.md:100-106`. The amendment EPIC 050.2 Story 8 landed makes
them legal behind a recorded human ruling plus a capability retirement, and Story 8 carries both.
`worker-model` — declared one epic ago over these same four operations — is retired, `worker-run`
replaces it, and `KANTHORD_VERSION` moves to `29.0.0`.

It is also **not** the whole lease removal. EPIC 050.5, at
`.agents/plan/epics/050.5-the-lease-table-removal.md`, owns the two recovery readers, the revocation,
the plan store's lease facts, the domain hierarchy, the service, the `system.status` projection and
the migration. Its story list is not yet expanded.

## The tokens this tree inherits, and the rule that settles them

**EPIC 050.1 records the approved objective/task run pair, so this tree copies it.**
Six of the seven paths here supersede a live diagram of EPIC 050.1 or EPIC 050.2, and this epic
changes only the lease. Every other token of those diagrams is a **context token**: no `Seams:` line
declares it, and `.agents/plan/authoring.md` requires it to be the prior diagram's token at one count
and one label. The rule is therefore mechanical and it takes no decision:

> Read the prior diagram in the landed EPIC 050.1 or EPIC 050.2 story, and copy each context token
> verbatim. A token here that differs from the prior one, with no `Seams:` sign covering it, is a
> stale copy in **this** tree. Fix the diagram. Never add a sign to make the difference legal, and
> never edit the prior diagram.

That works because EPIC 050.4 follows EPIC 050.1 and EPIC 050.2 by sequence order, so both are settled
facts on disk before this tree dispatches. The objective run tokens copy from the amended claim
diagram, and lease removal remains the only change this tree declares.

**Re-read these five tokens before dispatch.** They are the only inherited labels whose current value is in doubt.

| story                                               | diagram                           | step | token as drawn here                    | prior diagram                             |
| --------------------------------------------------- | --------------------------------- | ---- | -------------------------------------- | ----------------------------------------- |
| 1 (`01-the-claim-of-a-task-drops-the-lease`)        | `claim-lease-free-task`           | 7    | `execution.activeRunsOfNodes:siblings` | EPIC 050.1 `claim-success-task`           |
| 1 (`01-the-claim-of-a-task-drops-the-lease`)        | `claim-lease-free-task`           | 9    | `execution.activeRunsOfNodes:subtree`  | EPIC 050.1 `claim-success-task`           |
| 2 (`02-the-claim-of-an-initiative-drops-the-lease`) | `claim-lease-free-initiative`     | 7    | `execution.activeRunsOfNodes:subtree`  | EPIC 050.1 `claim-success-initiative`     |
| 2 (`02-the-claim-of-an-initiative-drops-the-lease`) | `claim-lease-free-initiative`     | 11   | `events.append:run.opened:I`           | EPIC 050.1 `claim-success-initiative`     |
| 3 (`03-the-objective-busy-refusal-drops-the-lease`) | `claim-lease-free-objective-busy` | 7    | `execution.activeRunsOfNodes:siblings` | EPIC 050.1 `claim-refusal-objective-busy` |

The `run.opened` tokens now copy the amended claim diagram. `renew-lease-free` and `release-lease-free` are **not** in doubt. They draw
`events.append:run.renewed:R` and `events.append:run.ended:R`, which agree with
`events.append:run.expired:R` of EPIC 050.1 Story 2 (`02-the-expiry-pass`).

**The set-name projection is a defect inside EPIC 050.1, and it is recorded rather than fixed here.**
`.agents/plan/stories/050.1-the-claim/06-the-conformance-harness.md:41` projects
`execution.activeRunsOfNodes` as _"the caller-supplied set name"_, while
`.agents/plan/pending/050.1-the-claim-seams.md` pins the signature
`activeRunsOfNodes(transaction, nodeIds: readonly string[])`, which supplies no name and argues
against a topology-named method. A projection must name a value the call receives, so `:siblings` and
`:subtree` are unproducible as written, and adding a parameter to separate two calls is refused by
the standard. `.agents/plan/pending/050.1-the-activerunsofnodes-projection.md` carries it, because
EPIC 050.1 is in flight and a story of this tree cannot edit its harness.

## Still open

**Recommendation: dispatch this tree as soon as EPIC 050.1 to EPIC 050.3 land, and fix item 1 inside
EPIC 050.1 while it is still in flight.** Nothing below blocks EPIC 050.4. Item 1 is the only one
that stops a loop, and the loop it stops is EPIC 050.1's own — every later item is owned by another
epic and triggered by EPIC 057.

| #   | issue                                                              | owner                                             | blocks                                    |
| --- | ------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| 1   | `activeRunsOfNodes` has a projection its signature cannot supply   | EPIC 050.1 Story 6 (`06-the-conformance-harness`) | EPIC 050.1's first claim scenario         |
| 2   | `system.status`'s `leases[]` removal has no covering capability    | EPIC 050.5, or the version policy                 | EPIC 050.5                                |
| 3   | EPIC 051 declares no `Supersedes: report-lease-free`               | the EPIC 051 story-tree conversion                | `node.report`'s chain after this epic     |
| 4   | ten epics hold a gate bullet list where the standard wants a table | Ulrich, per epic                                  | `pnpm run verify`, once the gate is wired |
| 5   | EPIC 051 holds 22 mermaid blocks in the epic file                  | `/author`, invoked on EPIC 051                    | `pnpm run verify`, once the gate is wired |

**1 — the projection. Fix it now, in EPIC 050.1.**
`.agents/plan/stories/050.1-the-claim/06-the-conformance-harness.md:41` projects
`execution.activeRunsOfNodes` as _"the caller-supplied set name"_, while
`.agents/plan/pending/050.1-the-claim-seams.md` pins the signature
`activeRunsOfNodes(transaction, nodeIds: readonly string[])`, which supplies no name and argues
against a topology-named method. A projection must name a value the call receives, so `:siblings` and
`:subtree` are unproducible as written, and adding a parameter to separate two calls is refused by the
standard. The fix needs no interface change: the two calls of a claim receive different `nodeIds`, so
a projection over that argument separates them. It is one row of one table, and that table is read by
every diagram of the range. `.agents/plan/pending/050.1-the-activerunsofnodes-projection.md` carries
it. **Why now:** the harness does not exist yet, so nothing is red — the first scenario that replays a
claim path is what fails, and it fails as a diagram defect reaching the human rather than an
implementation defect.

**2 — the `system.status` capability gap.** The amended policy makes an out-of-list change legal
behind a recorded ruling _and_ a capability retirement, but `system.status` belongs to no capability,
so there is no name to retire. EPIC 050.5 carries the ruling with that gap stated, or the policy gains
a clause for an operation outside every capability. Not this epic: the table still exists here, so the
projection is truthful.

**3 — EPIC 051's supersession.** `.agents/plan/epics/051-the-execution-checkpoint.md:835` resolves the
pin correctly and then defers its own `Supersedes:` line: _"The successor of `report-lease-free` is the
`node.report` diagram of story 12. The conversion declares that id and its `Supersedes` line, so this
document declares neither yet."_ The chain therefore ends at this epic until item 5 lands. That is
recorded, not lost.

**4 and 5 — the two gate debts.** `.agents/plan/pending/gate-table-retrofit.md` and
`.agents/plan/pending/051-the-story-tree-conversion.md` own them, and both name the same trigger:
`scripts/verify-epic-sequence.ts` entering the `verify` script, which EPIC 050.1 Story 8
(`08-the-range-gate`) defers to the change that completes the last story of the range — EPIC 057.
That script does not exist yet, and neither does the harness of item 1; both are EPIC 050.1 outputs,
so a reference to either is a forward reference and not a stale anchor. EPIC 050.4 already satisfies
the table form, so neither debt reaches this tree.

Nothing above blocks the dispatch of this epic.
