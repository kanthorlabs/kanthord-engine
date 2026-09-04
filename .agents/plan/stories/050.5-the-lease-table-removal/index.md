# EPIC 050.5 — The lease table removal — stories

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Prereq: EPIC 050, EPIC 050.1, EPIC 050.2, EPIC 050.3 and EPIC 050.4, implemented. EPIC 050.1's migration `12` is what gives the rewritten candidate query `run.expires_at`, `run.fence` and `run_base`, and its Story 2 is what gives Story 3 the `expireRuns` pass. After EPIC 050.4 the `Lease` service has exactly three importers, and this epic removes all three.

The lease table has no writer left. This epic moves its remaining readers onto the run and deletes the
service and the domain module. **It drops no table**: EPIC 057's migration `18` already owns the lease
rows, and the drop belongs there.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the
ship diagram. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar,
and `scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 (`08-the-range-gate`) enforces it.

Nine stories, and four carry a pair: 1, 2, 3 and 4. Five carry none, and one of those five is the
groundwork story.

**Story 0 is the groundwork story, and it holds the two paths no engineer may write.**
`eslint.config.js` and `package.json` are the epic's whole locked set: `scripts/lane-check.sh` denies
both to the test-engineer and to the software-engineer and allows both to `groundwork-engineer`. It
draws nothing, its cases are build checks, and it counts against the ten-story cap — nine of ten.

**Every prior set here is a `baseline-` diagram.** No epic drew the external sweep, the recovery
verdict, the revocation or the status query, so each of the four stories draws the shipped path with a
citation per step and declares `Baselines:`. That is the opposite of EPIC 050.4, where six of seven
prior sets were live diagrams.

**No diagram in this epic pins a tail.** Each of the four draws its whole path.

## The one path this epic cannot draw

`recoverExpiredLeases` calls `storage.transact` three times — `:218` for the candidate read, `:231`
for the external sweep and `:328` for each per-node verdict. `storage.transact` has no projection in
the harness of EPIC 050.1 Story 6 (`06-the-conformance-harness`), and a method with no projection admits one call per diagram, so the
outer pass's trace would need `:#2` and `:#3` — tokens the parser refuses outside a `baseline-` id.

**The cause cannot be removed.** The git worktree reads at `:277-281` must sit outside a transaction,
so the pass is three transactions by design and `AGENTS.md` requires it to stay that way.

Story 2 therefore draws the pair for the **per-node verdict write**, which it extracts as an exported
nested command taking the caller's transaction, and states in prose what the outer pass changes. The
outer pass's only seam change is the nested sweep it calls, whose own pair is Story 1's.

**A human rules on whether the harness gains a `storage.transact` projection.** Nothing in this epic
depends on the answer, and no story is blocked by it.

## Dispatch order

Story 0 runs before the loop, and it runs once. `/work` Step 4.5 dispatches
`groundwork-engineer` over its `Paths:` grant, and the whole `## Change` of that story lands in that
one turn. Story 1 depends on its `eslint.config.js` entry and Story 8 depends on its `package.json`
value, so nothing of the loop may run before it.

Story 1 owns the shared candidate query and the two event-type renames, and Story 2 consumes both, so
Story 1 lands first of the loop.

Stories 3 and 4 are independent of Stories 1 and 2 and of each other.

Story 5 is independent — one plan store method and the two facts it feeds.

Story 6 deletes the service, so it follows Stories 1, 2 and 3, the last three importers. **It no
longer follows Story 4.** An earlier draft had Story 4 add `health` to `src/domain/layout.test.ts`
and Story 6 take the count back; Story 4 opens no service directory now, so Story 6 is the only story
that touches those literals and it takes the count from twenty-one to twenty on its own. Story 7
deletes the module Story 6 orphans. Story 8 follows every prior story, because its
tree assertion enumerates the result.

The serial order is the numeric order: **0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**.

## Stories

- 0 — groundwork → `00-groundwork.md` — draws nothing; `Paths: eslint.config.js package.json`
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
  `driver = 'internal'` biconditional CHECKs. EPIC 050 Story 2 (`02-the-run-row`) is the zod row schema `runRow` and
  creates no table. The external-versus-internal split the two readers turn
  on is therefore still expressible after EPIC 050.

- **`run.base_oid` does not survive migration `12`.** It is in that story's "gone, and not replaced"
  list. The rewritten candidate query reads `run_base.oid`, the table EPIC 050.1's migration `12` creates
  and EPIC 051 writes, so before EPIC 051 every candidate takes the shipped
  `row.base_oid === null` branch at `:258` and blocks with `recovery-inputs-missing`.

- **`revoke-actor`'s lease call is its only lease reach**, and its baseline citations are `:81`,
  `:95`, `:100` and `:104`. `storage.transact` is at `:81`, the clock at `:95` after the three refusals
  at `:82-94`, `lease.expireLeasesOfOwner` at `:100` and `events.append` at `:104`; `loadActor` at
  `:40-59` and the `UPDATE actor` at `:96-99` are raw SQL on `actor`.

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
  diagram. Story 4 removes the cause by injecting the **computed value**: `health` becomes
  `HealthResult`, `:50` becomes a field read, and `src/main.ts:398` becomes
  `health: readHealth(healthDependencies)`. The ship diagram loses the step and the `Health`
  participant with it. **No service capability is opened.** An earlier draft opened
  `src/services/health/index.ts`; `main.ts` binds `health` to `readHealth`, a **query** at
  `src/queries/system/read-health.ts:28`, so a `services/` interface would declare a capability whose
  only producer lives in `queries/`. Nothing is deferred by the value injection: `main.ts` builds the
  dependencies inside the per-request `readStatus` closure, `readHealth` takes no `storage` and no
  `clock`, and `readStatus` reads `health` unconditionally before `storage.transact` at `:54`.

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
  the `queries` list of `readSubtreeExecutionFacts` at `src/services/plan/sqlite.ts:351-382` carries one
  entry per member.
  Story 5 deletes exactly one and the list keeps **six**. An earlier draft of this tree said four,
  which would have dropped `check-result` and `git-operation` with it.

- **The `blocker` enum is open on the wire.** `src/http/contract/error-details.ts:36` is
  `blocker: z.string()`, so dropping the `lease` member changes no schema.

- **Every migration version through `18` is already allocated.** `12` is EPIC 050.1's run model, `13`
  is EPIC 051's `workspace_branch` table, `14` is EPIC 051.3's `checkpoint` table, `15` is EPIC 053's,
  `16` is EPIC 054's, `17` is EPIC 055's and `18` is EPIC 057's. An earlier draft of this epic took
  `13`, which would have renumbered six authored epics and their tests.

- **EPIC 057's migration `18` already owns the lease rows, and dropping the table under it would
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
  used only at `:125` inside `leaseHeldDetails`. EPIC 050.4 Story 8 (`08-lease-held-is-retired`) deletes that schema, so it must
  delete this import in the same edit; the amendment is listed in the epic.

- **`src/services/storage/migration-0007-external-execution.ts:69` copies lease rows.** It is a shipped historical
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

- **EPIC 050.4 Story 9 (`09-the-proposal-records-one-authority`) asserts the `Lease` importer set by value.** Story 6 deletes the service and
  retires that assertion in the same edit. A landed value assertion nobody retires is a red suite at
  the boundary of the story that made it false.

- **The epic edits exactly two paths that `scripts/lane-check.sh` denies to both engineers**, and the
  set was decided with the guard rather than from memory. `eslint.config.js` matches `*.config.*` and
  `package.json` is the toolchain manifest; `scripts/lane-check.sh groundwork-engineer` allows both.
  Nothing else the epic touches is locked: `src/**`, `test/**`, `docs/proposal/**` and `scripts/**`
  all stay in an engineer lane, `kanthord.config.json` holds no key this epic moves, and
  `pnpm-lock.yaml` records no package version, so the bump does not reach it.

- **`eslint.config.js:21` names the test file Story 1 renames.**
  `nodeEdgeWriteExemptions` at `eslint.config.js:17` lists
  `src/commands/startup/recover-expired-leases.test.ts`, which holds six raw `node` writes. Story 1
  moves that file to `recover-expired-runs.test.ts`, so the list must name the new path or
  `pnpm run lint` fails on every one of the six. This coupling was missed on the first pass: the epic
  swept `src/`, `test/` and `docs/` and no story read the toolchain config.

- **`src/domain/version.test.ts:13` is the only file that couples the two version strings.** The other
  eleven readers of `KANTHORD_VERSION` under `src/` read the constant alone, so the interval Story 0
  opens is one `it` in one file, closed by Story 8. Story 7's `node --test` list dropped that file for
  exactly this reason.

## What this epic is not

It is **not** wire-invisible. One response field, `system.status.leases[]`, leaves the contract. That
is outside the closed list of `docs/proposal/api/README.md:101-106`, and the amended policy of EPIC 050.2 Story 8 (`08-the-policy-amendment-and-the-capability-swap`) makes it legal behind a recorded human ruling **and** a capability retirement.
`system.status` is covered by no capability, so there is no name to retire — the epic records the
ruling, moves `KANTHORD_VERSION` to `30.0.0`, and writes a compatibility-record row whose "capability
retired" cell reads **none**.

It is also **not** an atomicity change. Startup recovery has three transaction call sites today and
three after this epic, and its per-node verdict stays in its own transaction so one unreadable
workspace blocks one node without failing the pass.

It is **not** a schema change either. The `lease` table, `src/domain/lease.ts` and `rows.lease` all
survive, empty and unreachable, until EPIC 057's migration `18`.

## Still open

- **The stale write-exemption entry.** **Decided: the list holds both names, and
  EPIC 057 prunes the dead one.** Story 0 adds
  `"src/commands/startup/recover-expired-runs.test.ts"` beside the shipped
  `"src/commands/startup/recover-expired-leases.test.ts"`, so `nodeEdgeWriteExemptions` holds
  nineteen and lint is green before Story 1's rename and after it.

  **The exemption follows the rename, and that is not a new authorization.**
  `eslint.config.js:13-16` says "a NEW file belongs on neither list — seed through
  test/helpers/rows.ts instead". A `git mv` of a grandfathered fixture produces no new file: it is the
  same six statements under a new name, and a rename that dropped their exemption would be a
  behaviour change this epic did not ask for. An earlier draft of this note called the renamed file
  "new" while also arguing the exemption should carry across; that was inconsistent, and the rename
  reading is the correct one.

  **Migrating the six writes to `test/helpers/rows.ts` was considered and rejected on scope.** It is
  the shape the config comment prefers, and `eslint.config.js:467` scopes the restriction to
  `files: ["src/**/*.ts"]`, so `test/**` is unrestricted and the helper is the right home for a _new_
  fixture. It does not fit here. Two of the six map cleanly — `UPDATE node SET state = 'running'` at
  `:495` and `:902` become `seedNodeState` (`test/helpers/rows.ts:267`), whose `block_reason` `CASE`
  writes NULL for a non-blocked state, which both sites already hold. The other four do not. The
  three inserts at `:198`, `:217` and `:236` pass this suite's **per-fixture** ids —
  `projectId = project_${ulid}` at `:158`, `revisionId = revision_${ulid}` at `:159`,
  `INSTRUCTION_BLOB` at `:53` and `NOW = 1700000000000` at `:46` — while `seedNode`
  (`test/helpers/rows.ts:297`) hardcodes `fixtureIds.project`, `fixtureIds.instructionBlob`,
  `fixtureIds.planRevision` and `updated_at: 1`. Serving them needs four new optional parameters on a
  helper many suites share. The `INSERT ... SELECT` at `:1819` copies `project_id`,
  `instruction_blob`, `acceptance_blob`, `worker`, `repository_id`, `revision` and `updated_at` from a
  sibling row, which `seedNode` cannot express at all and which needs a new helper. Refactoring
  shared test infrastructure to tidy one allowlist line is adjacent work in a lease-removal epic, and
  the smallest complete change is the rename that carries its exemption.

  **A pre-loop deletion was also rejected.** It would open a lint-red interval, and EPIC 050.4 Story 0
  (`00-groundwork`) is not a precedent for it: there the mismatch is forced by two locked lanes and
  its single assertion is isolated, whereas here the groundwork story would change lint policy and
  then decline to run the policy check. The standard gives a groundwork edit build-only checks
  because it opens no failing test, and swapping `pnpm run lint` for `pnpm run typecheck` proves the
  config parses, not that it works.

  **`/work` offers no mid-loop route for this path.** Step 5h.2 dispatches only an
  `OPEN: OUT-OF-LANE` marker "whose path the `groundwork-engineer` ceiling allows **and that no
  `GROUNDWORK-COMPLETE:` line of this cycle has written**", and Step 4.6 skips a marker whose path a
  completion line already names. Story 0 grants `eslint.config.js`, so a later turn for it is
  excluded by construction.

  The residue is one inert line: an unmatched `files` pattern at `eslint.config.js:478` applies to
  nothing, and reclaiming the old pathname would take a reviewed source change. The epic asks EPIC
  057 to delete it with the rest of the lease cleanup.

- **Two citations of the EPIC point one line high.** `.agents/plan/epics/050.5-the-lease-table-removal.md:47`
  and `:67` both cite `src/http/contract/event.ts:25` for `eventView.type`. The field is at `:26`;
  `:25` is `id`. The claim the citation supports — `type` is `z.string()`, so the event catalogue is
  not wire-constrained — is true. `/author` does not edit an EPIC, so **a human moves both to `:26`**.

- **The `system.status` policy hole.** **Ruled: the field leaves, and
  Story 8 writes the policy clause that makes it legal.** `docs/proposal/api/README.md:103` —
  `remove or rename a response field` is forbidden inside `/v1`, and `:106` closes the list. EPIC
  050.2 Story 8 (`08-the-policy-amendment-and-the-capability-swap`) opened the one legalizing path,
  and its sentence pairs a human ruling with "the capability swap that announced it". `system.status`
  is in no `capabilityOperations` entry (`src/http/contract/capability.ts:5-15`), so no swap exists to
  pair with — and a swap would not repair this direction anyway: a capability lets a _newer client_
  detect an _older daemon_, while this removal breaks an _older client_ against a _newer daemon_.

  The human ruled the removal, on the standing constraint that the product carries no
  backward-compatible obligation and has no deployment. **Story 8 therefore amends the policy rather
  than recording a hole**: it adds one clause admitting an operation that no capability covers, and
  writes the compatibility row with both capability cells reading the literal `none`. A deprecated
  `leases: []` on the wire was the alternative and is refused — it is a compatibility shim, which is
  the thing the constraint exists to avoid.

- **The dashboard types the field, and no `HANDOFF.md` entry asks it to drop it.**
  `apps/apps/dashboard/src/api/types.ts:440` — `leases: SystemStatusLease[]`, a fixture at
  `apps/apps/dashboard/src/api/fixtures/system.ts:23`, and a contract copy at
  `apps/docs/api/contract/source/components/system.yaml:617` with `leases` in the **required** list at
  `:656`. No file under `apps/apps/dashboard/src` reads `.leases`, so this is a contract and type
  divergence rather than a runtime break, and the contract copy regenerates from the engine's
  publication. `types.ts` and `fixtures/system.ts` are hand-written and do not. `AGENTS.md` puts an
  obligation the dashboard must take on in `HANDOFF.md`, and no story of the 050 family writes that
  file — the human does, and `HANDOFF.md:85` and `:92` are the EPIC 050.1 and EPIC 050.2 entries.
  **A human writes the entry**, and it is a second reason to prefer the deprecated-empty-array
  option.

- **The `storage.transact` projection.** The outer recovery pass is undrawable without one. Story 2
  works around it by drawing the nested verdict write, so no story is blocked; the ruling decides
  whether a later epic can draw the outer pass at all.

- **The recovery step vocabulary.** `RECOVERY_STEP_ORDER`'s `leases` step and
  `RecoverHomeDependencies.leases` outlive the mechanism they name. Renaming them needs either a
  harness projection for a function-valued dependency or a restructure of `recoverHome`, and neither
  belongs in a lease-removal epic. Story 2 asserts the names unchanged so the deferral is visible.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch. Each is named in the epic.

- **EPIC 057 Stories 5, 6 and 7** — migration `18` drops the `lease` table instead of narrowing it,
  and deletes `src/domain/lease.ts`, `rows.lease` and `docs/proposal/database/lease.md` in the same
  edit; its preflight loses the live-node-lease clause; its gate loses the surviving-`lease`-column
  assertion; and its `lease-hierarchy` deletion becomes a no-op, because EPIC 050.4 and Story 7 here
  already do it. **The default if no ruling arrives: migration `18` narrows the table instead of
  dropping it**, and the product ships an empty `lease` table.
