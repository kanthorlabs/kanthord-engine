# EPIC 050.4 — The node lease removal — stories

Epic: `.agents/plan/epics/050.4-the-node-lease-removal.md`
Prereq: EPIC 050, EPIC 050.2 and EPIC 050.3, implemented. Every story here reads a `run` row and the authority check EPIC 050.2 Story 1 landed.

A worker proves itself by the run it holds and by nothing else. Four operations and one nested command
stop naming the lease, and the node-lease fields leave the wire.

## One story, one path

A story that changes a shipped path draws a pair: the prior diagram and the ship diagram. A story
that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar, and
`scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 enforces it.

Seven stories carry a pair: 1, 2, 3, 4, 5, 6 and 7. Two carry none.

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
`pnpm run verify` would be red for the length of the epic. Every story in this tree ends with
`pnpm run verify` exits 0, and that promise is only keepable if the schema and its reader move
together. Story 8 is therefore the last of the contract work and not the first: `errorStatuses` can
lose `lease-held` only once no operation declares it.

## Dispatch order

Stories 1, 2 and 3 are one command, `claim-node.ts`, and they run in order: Story 1 deletes
`liveLeasesOf` and `acquireWithHierarchyRefusal`, and Stories 2 and 3 draw the paths that remain.

Stories 4 and 5 are one command each and are independent of each other. Story 4 deletes the shared
`claimedLease` schema, so it follows Story 1, its other consumer.

Story 6 changes `report-outcome.ts` and Story 7 changes the nested `report-objective.ts` it dispatches
to. Story 7 follows Story 6, because Story 6 stops passing the `fence` Story 7 deletes.

Story 8 follows Stories 1, 4, 5 and 6. Story 9 follows every prior story.

The serial order is the numeric order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**.

## Stories

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

- **`nodeClaimResponse.objectiveRunId` at `:44` has no producer after EPIC 050.** That epic's
  `claim-success-task` opens one run where the baseline opened two, and its Story 13 lists what the
  response keeps, gains and loses without naming the field. Story 1 of this tree closes the gap rather
  than leaving a required field for a test to discover.

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

## Corrections made to the earlier epics' stories

Each chain must hold one live diagram. Six live diagrams gain or change a `Superseded by:` line:

| story              | diagram                        | was                           | now                                          |
| ------------------ | ------------------------------ | ----------------------------- | -------------------------------------------- |
| EPIC 050.1 Story 3 | `claim-success-task`           | `EPIC 051 claim-success-task` | `EPIC 050.4 claim-lease-free-task`           |
| EPIC 050.1 Story 4 | `claim-success-initiative`     | absent                        | `EPIC 050.4 claim-lease-free-initiative`     |
| EPIC 050.1 Story 5 | `claim-refusal-objective-busy` | absent                        | `EPIC 050.4 claim-lease-free-objective-busy` |
| EPIC 050.2 Story 3 | `renew-success`                | absent                        | `EPIC 050.4 renew-lease-free`                |
| EPIC 050.2 Story 5 | `release-success`              | absent                        | `EPIC 050.4 release-lease-free`              |
| EPIC 050.2 Story 6 | `report-authority-prelude`     | absent                        | `EPIC 050.4 report-lease-free`               |

EPIC 050.2 Story 6's ship diagram also re-pins its tail from `EPIC 051 report-execution-checkpoint`
to `EPIC 050.4 report-lease-free`, because this epic now owns that tail.

## Amendments the earlier epics still need, and this tree cannot make alone

Three of them, each a one-line edit to a document this epic does not own. **A human applies them
before dispatch**, because each makes an earlier gate false or true by fiat.

- **`.agents/plan/epics/050.2-…md:164`** reads _"`report-authority-prelude` pins its tail with a note
  naming EPIC 051 and `report-execution-checkpoint`, and the range gate refuses if EPIC 051 declares
  no such diagram."_ After the re-pin above it must name EPIC 050.4 and `report-lease-free`.

- **EPIC 051's `report-execution-checkpoint` never superseded `report-authority-prelude` anyway.**
  `.agents/plan/epics/051-…md:341` draws it with `Caller->>Command: acceptExecution` — a nested
  command on a different path, not a `node.report` diagram. The pin was already pointing at a diagram
  that does not supersede it, which the re-pin corrects rather than causes. EPIC 051 must declare that
  it supersedes `report-lease-free`, or `node.report`'s chain ends here.

- **EPIC 050.1 Story 1 must remove `objectiveRunId` or cede it.** Story 1 of this tree takes it, and
  the compatibility row Story 8 writes names it. If EPIC 050.1 removes it first, Story 1's item is a
  no-op and the implementing agent says so.

## What this epic is not

It is **not** wire-invisible, and it does not pretend to be. Three response fields and three required
request fields leave four operations, and an error code is retired. Every one of those is outside the
closed list of `docs/proposal/api/README.md:100-106`. The amendment EPIC 050.2 Story 8 landed makes
them legal behind a recorded human ruling plus a capability retirement, and Story 8 carries both.
`worker-model` — declared one epic ago over these same four operations — is retired, `worker-run`
replaces it, and `KANTHORD_VERSION` moves to `29.0.0`.

It is also **not** the whole lease removal. EPIC 050.5, at
`.agents/plan/epics/050.5-the-lease-table-removal.md`, owns the two recovery readers, the revocation,
the plan store's lease facts, the domain hierarchy, the service, the `system.status` projection and
the migration. Its story list is not yet expanded.

## Still open

- **`system.status`'s `leases[]` removal has no covering capability.** The amended policy makes an
  out-of-list change legal behind a recorded ruling _and_ a capability retirement, but `system.status`
  belongs to no capability, so there is no name to retire. EPIC 050.5 must carry the ruling with that
  gap stated, or the policy needs a clause for an operation outside every capability. A human decides
  which.

Nothing else blocks dispatch.
