# EPIC 050.5 — The lease table removal — stories

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Prereq: EPIC 050, EPIC 050.1, EPIC 050.2, EPIC 050.3 and EPIC 050.4, implemented. EPIC 050.1's migration `12` is what gives the rewritten candidate query `run.expires_at`, `run.fence` and `run_base`, and its Story 2 is what gives Story 3 the `expireRuns` pass. After EPIC 050.4 the `Lease` service has exactly three importers, and this epic removes all three.

The lease table has no writer left. This epic moves its remaining readers onto the run and deletes the
service and the domain module. **It drops no table**: EPIC 057's migration `17` already owns the lease
rows, and the drop belongs there.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the
ship diagram. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar,
and `scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 enforces it.

Four stories carry a pair: 1, 2, 3 and 4. Four carry none.

**Every prior set here is a `baseline-` diagram.** No epic drew the external sweep, the recovery
verdict, the revocation or the status query, so each of the four stories draws the shipped path with a
citation per step and declares `Baselines:`. That is the opposite of EPIC 050.4, where six of seven
prior sets were live diagrams.

**No diagram in this epic pins a tail.** Each of the four draws its whole path.

## The one path this epic cannot draw

`recoverExpiredLeases` calls `storage.transact` three times — `:218` for the candidate read, `:231`
for the external sweep and `:328` for each per-node verdict. `storage.transact` has no projection in
the harness of EPIC 050.1 Story 6, and a method with no projection admits one call per diagram, so the
outer pass's trace would need `:#2` and `:#3` — tokens the parser refuses outside a `baseline-` id.

**The cause cannot be removed.** The git worktree reads at `:277-281` must sit outside a transaction,
so the pass is three transactions by design and `AGENTS.md` requires it to stay that way.

Story 2 therefore draws the pair for the **per-node verdict write**, which it extracts as an exported
nested command taking the caller's transaction, and states in prose what the outer pass changes. The
outer pass's only seam change is the nested sweep it calls, whose own pair is Story 1's.

**A human rules on whether the harness gains a `storage.transact` projection.** Nothing in this epic
depends on the answer, and no story is blocked by it.

## Dispatch order

Story 1 owns the shared candidate query and the two event-type renames, and Story 2 consumes both, so
Story 1 lands first.

Stories 3 and 4 are independent of Stories 1 and 2 and of each other.

Story 5 is independent — one plan store method and the two facts it feeds.

Story 6 deletes the service, so it follows Stories 1, 2 and 3, the last three importers, and it
follows Story 4, because the two write the same two literals of `src/domain/layout.test.ts`: Story 4
adds `health` and takes the count to twenty-two, Story 6 removes `lease` and takes it back to
twenty-one. Story 7 deletes the module Story 6 orphans. Story 8 follows every prior story, because its
tree assertion enumerates the result.

The serial order is the numeric order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**.

## Stories

- 1 — The external sweep scans runs → `01-the-external-sweep-scans-runs.md` — draws `baseline-sweep-external-leases` and `sweep-external-runs`
- 2 — Startup recovery scans runs → `02-startup-recovery-scans-runs.md` — draws `baseline-recovery-verdict` and `recovery-verdict-run`
- 3 — `revoke-actor` drops its lease pass → `03-revoke-actor-drops-its-lease-pass.md` — draws `baseline-revoke-actor` and `revoke-actor-lease-free`
- 4 — `system.status` drops the lease projection → `04-system-status-drops-the-lease-projection.md` — draws `baseline-read-status` and `read-status-lease-free`
- 5 — The plan store stops computing the lease facts → `05-the-plan-store-stops-computing-the-lease-facts.md`
- 6 — The lease service is deleted → `06-the-lease-service-is-deleted.md`
- 7 — The lease hierarchy is deleted → `07-the-lease-hierarchy-is-deleted.md`
- 8 — The proposal records the removal → `08-the-proposal-records-the-removal.md`

## Facts, verified against the source

Each was read out of the source before a story was written, and each one changed a story or the epic.

- **`sweepExpiredExternalLeases` never calls its `lease` dependency.** Its deps record at `:62-67`
  declares `plan`, `lease`, `execution` and `events`, and the body reaches the table twice through
  raw SQL — `CANDIDATE_SQL` at `:84` and the `UPDATE lease` at `:124`. `dependencies.lease` appears
  nowhere in the function. The key is dead, so removing it changes no seam and the ship diagram
  differs from the baseline by one event label alone.

- **Raw SQL is invisible at the seam.** `transaction.all` and `transaction.run` are calls on the
  transaction object, not on an injected capability, so replacing `CANDIDATE_SQL`'s lease join with a
  run scan and deleting the `UPDATE lease` moves no token. That is why Story 1's pair looks small
  against the size of its change, and why its Verify section carries the weight.

- **The two readers share one candidate query.** `CANDIDATE_SQL` at `:44-60` is consumed by
  `sweepExpiredExternalLeases` at `:84` and by `recoverExpiredLeases` at `:219`. Story 1 rewrites it
  and Story 2 adjusts what the internal half does with the rows.

- **Both emit sites of `recovery.leaseRecovered` are in that one file.** The sweep appends it at
  `:142` and `writeVerdict` appends it at `:343`. `eventPayloads` is typed
  `Readonly<Record<EventType, ZodType>>`, so a type removed without its payload does not compile.
  Story 1 therefore renames both types, both payload aliases and both emit sites; Story 2 changes the
  verdict's inputs and its run write, not the event name.

- **`recoverExpiredLeases` writes no run row today.** Its internal half at `:247-312` reads the
  worktree, sets the node state at `:329` and clears the lease at `:339`, and it **never ends the
  run**. The lease expiry was what freed the node. With the lease gone, the verdict write must end the
  run itself, which is why Story 2's ship diagram gains `execution.endRun` and the attempt close
  beside it.

- **Neither reader may call `expireRuns`.** Recovery reads its candidates as **active** runs past
  their expiry; a pass that ended them first would leave the external sweep at `:231` nothing to find.
  Each reader ends the run it handles through `execution.endRun`, exactly as
  `sweepExpiredExternalLeases` already ends one at `:118`, and the fence rises there. The draft of
  this epic said recovery would take `expireRuns` as an injected dependency; it must not.

- **`run.driver` survives migration `12`.** EPIC 050.1's migration `12`, drafted at
  `.agents/plan/pending/050.1-migration-12.md`, keeps
  `driver TEXT NOT NULL CHECK (driver IN ('internal', 'external'))` and drops only the three
  `driver = 'internal'` biconditional CHECKs. EPIC 050 Story 2 is the zod row schema `runRow` and
  creates no table. The external-versus-internal split the two readers turn
  on is therefore still expressible after EPIC 050.

- **`run.base_oid` does not survive migration `12`.** It is in that story's "gone, and not replaced"
  list. The rewritten candidate query reads `run_base.oid`, the table EPIC 050.1's migration `12` creates
  and EPIC 051 writes, so before EPIC 051 every candidate takes the shipped
  `row.base_oid === null` branch at `:258` and blocks with `recovery-inputs-missing`.

- **`revoke-actor`'s lease call is its only lease reach**, and its baseline citations are `:81`,
  `:95`, `:100` and `:104`. `storage.transact` is at `:81`, the clock at `:95` after the three refusals
  at `:82-94`, `lease.expireLeasesOfOwner` at `:100` and `events.append` at `:104`; `loadActor` at
  `:39-58` and the `UPDATE actor` at `:96-99` are raw SQL on `actor`.

- **`actor.revoked` has a strict payload and `leasesFenced` is required in it.**
  `src/http/contract/event-payload.ts:78-85`. `eventView.payload` is `z.unknown()` at
  `src/http/contract/event.ts:31`, so the emitted shape does not change, but the internal validation
  contract does and a field the command stops producing would refuse every append. Story 3 removes it
  deterministically rather than telling the implementing agent to check.

- **`readStatus` reads the clock only inside the lease query.** `dependencies.clock.now()` at `:79`
  is the sole use of that dependency, so deleting the projection deletes the dependency and moves the
  query's seam trace.

- **`readStatus`'s `health` dependency is function-valued.** `health: () => HealthResult` at `:8`,
  called at `:50`, so its baseline token is `health.call` — legal in a baseline and refused in a live
  diagram. Story 4 removes the cause by making it an object with one method. That is **not** the shape
  of EPIC 050.1's `expiry` key, which is an inline object literal over a nested command with no
  interface file; Story 4 opens a service capability and `src/domain/layout.test.ts` moves with it. The
  epic records the open ruling between that and an inline structural type.

- **The CLI renders the lease lines.** `src/cli/status.ts:88-95` prints
  `kanthord: no expired lease` or one line per row, so Story 4 changes the CLI with the query.

- **`RecoveryReport` is not on the wire.** `recoverHome` returns it and `main.ts:347` writes its
  findings to `process.stderr`. Renaming the `leases` step to `runs` therefore changes no schema, and
  `RECOVERY_STEP_ORDER` is asserted only by `src/domain/recovery.test.ts:14`.

- **`recoverHome` is undrawable, and that is why the recovery step vocabulary is not renamed.** Its
  four dependencies — `reap`, `sweep`, `reconcile` and `leases` — are all function-valued, so its trace
  is four `.call` tokens and it has no live diagram and can have none. Renaming
  `RecoverHomeDependencies.leases` to `runs` would change `leases.call` to `runs.call`: a seam change
  on a path nothing measures, which `Seams:` exists to prevent and which no story here can own. The
  step name, `LeasesStep`, `LeasesResultLike` and the key all keep their names in this epic. The two
  event types and the two target enums are values, not seams, and Story 1 renames those.

- **`Lease.expired()` has no production caller.** `grep -rn '\.expired(' src/` returns test files
  only. Story 6 deletes it with the interface and no command loses a call.

- **`plan.leaseHeld` is private and reached from three places.** `src/services/plan/sqlite.ts:564`,
  called at `:278` and `:308` for `ContainmentFacts.lease`, with a separate `lease` blocker query at
  `:351-356` inside `readSubtreeExecutionFacts`. No command calls it, so no command's seam trace
  changes when it dies — which is why Story 5 draws nothing.

- **`executionBlockers` has seven members, not five.** `src/domain/plan-graph.ts:38-46` is
  `["lease", "workspace", "run", "attempt", "commit", "check-result", "git-operation"]`, and
  `readSubtreeExecutionFacts` at `src/services/plan/sqlite.ts:351-382` carries one query per member.
  Story 5 deletes exactly one and the list keeps **six**. An earlier draft of this tree said four,
  which would have dropped `check-result` and `git-operation` with it.

- **The `blocker` enum is open on the wire.** `src/http/contract/error-details.ts:36` is
  `blocker: z.string()`, so dropping the `lease` member changes no schema.

- **Every migration version through `17` is already allocated.** `12` is EPIC 050's run model, `13` is
  EPIC 051's `checkpoint` table (`epics/051-…md:70,686`), `14` is EPIC 053's (`:61,67`), `15` is EPIC
  054's (`:26,79`), `16` is EPIC 055's (`:25`) and `17` is EPIC 057's (`:63`). An earlier draft of this
  epic took `13`, which would have renumbered five authored epics and their tests.

- **EPIC 057's migration `17` already owns the lease rows, and dropping the table under it would
  invalidate that migration.** `epics/057-…md:35` makes its preflight refuse while a live node lease
  exists, `:63` narrows the `subject_kind` CHECK and deletes the node rows, and `:105` asserts every
  surviving `lease` column is present afterwards. None of that is satisfiable against a dropped table.
  Deferring the drop to that epic costs one amended sentence; taking it here costs a renumbering
  cascade plus a redesign of `17`.

- **The table cannot be dropped without `rows.lease` in the same edit.**
  `src/services/storage/schema-parity.test.ts:90` asserts the migrated table set deep-equals
  `Object.keys(rows)`, and `src/domain/rows.ts:10,33` registers `leaseRow` from
  `src/domain/lease.ts`. Drop the table alone and parity fails; delete `rows.lease` alone and parity
  fails the other way. That coupling is a second reason the drop belongs to one migration story, and
  EPIC 057 already has one.

- **Migrations record themselves.** `src/services/storage/sqlite.ts:86-87` inserts a row into
  `migration` inside every migration's transaction, so a "no other table's row count changed"
  assertion is false by construction unless it excludes `migration`. An earlier draft of this epic
  carried exactly that assertion.

- **There is no `src/services/storage/migrations.test.ts`.** `migrations.ts` is the list, and the
  density assertions live in per-migration tests — `migration-0003-…test.ts:505`,
  `migration-0004-…test.ts:35` and `migration-0006-…test.ts:211`, each asserting eleven entries today.
  An earlier draft of this epic named a file that does not exist.

- **`leaseOwnerKinds` has one consumer outside the lease modules**, `src/http/contract/error-details.ts:5`,
  used only at `:125` inside `leaseHeldDetails`. EPIC 050.4 Story 8 deletes that schema, so it must
  delete this import in the same edit; the amendment is listed in the epic.

- **`migration-0007-external-execution.ts:69` copies lease rows.** It is a shipped historical
  migration and no story here touches it.

- **`test/helpers/lease.ts` imports all three modules this epic deletes**, and fourteen `*.test.ts`
  files import it. Story 6 deletes it, and its table assigns each importer to the first story that
  invalidates it: six to EPIC 050.4, three to Stories 1 to 3 here, five to Story 6. Every tree
  assertion in this epic enumerates **production** files, so none of them sees a test helper. That is
  how the coupling was missed on the first pass.

- **`src/domain/layout.test.ts` pins the service inventory by value**, at `:101` for the directory
  list and `:151` for the `not-implemented.ts` set. Story 4 adds `health` and Story 6 removes `lease`,
  so the file moves twice and the count returns to twenty-one. It is in the epic's Proof.

- **`run_base`'s primary key is `(run_id, repository_id)`**, and the migration's own constraints
  forbid a CHECK on its cardinality, so a run holds one base row per repository. The candidate query
  therefore joins `workspace` first and `run_base` on `rb.run_id = r.id AND rb.repository_id =
w.repository_id`. A join on `run_id` alone returns one candidate row per base, and both readers
  write once per row. An earlier draft of Story 1 carried exactly that join.

- **EPIC 050.4 Story 9 asserts the `Lease` importer set by value.** Story 6 deletes the service and
  retires that assertion in the same edit. A landed value assertion nobody retires is a red suite at
  the boundary of the story that made it false.

## What this epic is not

It is **not** wire-invisible. One response field, `system.status.leases[]`, leaves the contract. That
is outside the closed list of `docs/proposal/api/README.md:100-106`, and the amended policy of EPIC
050.2 Story 8 makes it legal behind a recorded human ruling **and** a capability retirement.
`system.status` is covered by no capability, so there is no name to retire — the epic records the
ruling, moves `KANTHORD_VERSION` to `30.0.0`, and writes a compatibility-record row whose "capability
retired" cell reads **none**.

It is also **not** an atomicity change. Startup recovery has three transaction call sites today and
three after this epic, and its per-node verdict stays in its own transaction so one unreadable
workspace blocks one node without failing the pass.

It is **not** a schema change either. The `lease` table, `src/domain/lease.ts` and `rows.lease` all
survive, empty and unreachable, until EPIC 057's migration `17`.

## Still open

- **The `system.status` policy hole.** A response field removal on an operation covered by no
  capability has no announcement mechanism. A human decides before dispatch: either
  `docs/proposal/api/README.md` gains a clause for such an operation, or `system.status` gains a
  capability. Story 8 ships one shape — both capability cells empty, plus a sentence saying why — and a
  ruling amends that story rather than leaving the implementing agent a branch.

- **The `storage.transact` projection.** The outer recovery pass is undrawable without one. Story 2
  works around it by drawing the nested verdict write, so no story is blocked; the ruling decides
  whether a later epic can draw the outer pass at all.

- **The recovery step vocabulary.** `RECOVERY_STEP_ORDER`'s `leases` step and
  `RecoverHomeDependencies.leases` outlive the mechanism they name. Renaming them needs either a
  harness projection for a function-valued dependency or a restructure of `recoverHome`, and neither
  belongs in a lease-removal epic. Story 2 asserts the names unchanged so the deferral is visible.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch. Each is named in the epic.

- **EPIC 057 Stories 5, 6 and 7** — migration `17` drops the `lease` table instead of narrowing it,
  and deletes `src/domain/lease.ts`, `rows.lease` and `docs/proposal/database/lease.md` in the same
  edit; its preflight loses the live-node-lease clause; its gate loses the surviving-`lease`-column
  assertion; and its `lease-hierarchy` deletion becomes a no-op, because EPIC 050.4 and Story 7 here
  already do it.

- **EPIC 050.4 Story 8** — delete the `leaseOwnerKinds` import at `error-details.ts:5` with the
  `leaseRelations` import at `:6`. Both serve only `leaseHeldDetails`, which that story deletes.

- **EPIC 050.4, the `leaseTtlMs` configuration** — its Story 1 and Story 4 delete the last two readers
  and no epic through EPIC 057 removes the setting. The default if no ruling arrives is that Story 6
  here takes it.

- **EPIC 050.2 Story 2, the `endRun` fence raise** — gate rows 1 and 10b depend on it and no `## Change`
  section in the family instructs the write. The default if no ruling arrives is that the implementing
  agent reports a red row as an EPIC 050.2 defect rather than writing the execution service here.

Nothing else blocks dispatch.
