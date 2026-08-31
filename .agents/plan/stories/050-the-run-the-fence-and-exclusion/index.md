# EPIC 050 — The run, the fence and exclusion — stories

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Prereq: EPIC 049 (sequence order). EPICs 047, 048 and 049 must all be implemented before any story here runs — none of their outputs exists in `src/` yet. See **Facts** below.

A claim opens exactly one run, records its kind, its provenance and its budgets, writes the node assignment in the same transaction, and a fence plus three exclusion rules guard every later write.

## Dispatch order

Stories 1, 5, 9 and 12 are independent and can run concurrently — each is a greenfield pure module or a configuration addition.

Story 6 depends on Story 5 (same file, shared liveness predicate); implement Story 6 directly after Story 5 in the same unit.

Story 3 depends on Story 1 alone. It is a zod schema and needs no DDL to exist first. **Story 3 owns every `run_base` registration** — `src/domain/rows.ts`, `src/domain/rows.test.ts` and `docs/proposal/phase-1/domain.md:39`. Story 2 adds none of them.

Story 2 depends on Story 1 and Story 3. The dependency is one way: 3 → 2. There is no cycle.

Story 13 is a wide fan-out across the contract and must land before Story 7, Story 8 and Story 10, all of which need its request fields and its `run.expired` event type.

Story 4 depends on Story 3.

Story 7 depends on Stories 2 and 13.

Story 8 depends on Stories 1, 2, 3, 4, 5, 6, 7 and 13 — it is the integration point and the largest story.

Story 10 depends on Stories 7, 9, 12 and 13.

Story 11 depends on Stories 7, 8 and 10, and adds tests only.

Story 14 depends on Story 13.

Story 15 depends on every prior story.

A workable serial order: **1 → 3 → 2 → 5 → 6 → 9 → 12 → 13 → 4 → 7 → 8 → 10 → 11 → 14 → 15**.

No story depends on a story later than itself in that order.

## Stories

- 1 — The run kind → `01-the-run-kind.md`
- 2 — Migration 12 → `02-migration-12.md`
- 3 — The run row → `03-the-run-row.md`
- 4 — `assignment` is published → `04-assignment-is-published.md`
- 5 — Subtree exclusion → `05-subtree-exclusion.md`
- 6 — The objective-branch rule → `06-the-objective-branch-rule.md`
- 7 — The expiry pass → `07-the-expiry-pass.md`
- 8 — The claim writes the assignment and opens the run → `08-the-claim-writes-the-assignment-and-opens-the-run.md`
- 9 — Run authority → `09-run-authority.md`
- 10 — Renew, release and report carry the authority check → `10-renew-release-and-report-carry-the-authority-check.md`
- 11 — An ordinary failure never changes the assignment → `11-an-ordinary-failure-never-changes-the-assignment.md`
- 12 — Configuration → `12-configuration.md`
- 13 — The contract carries the run, the fence and the availability assertion → `13-the-contract-carries-the-run-the-fence-and-the-availability-assertion.md`
- 14 — The policy amendment and the capability swap → `14-the-policy-amendment-and-the-capability-swap.md`
- 15 — The proposal records the run model → `15-the-proposal-records-the-run-model.md`

## Decisions taken during authoring, and now recorded in the EPIC

A human ruled on each. The EPIC carries all four; these stories implement them.

- **The expiry pass deletes no candidate ref.** The namespace `refs/kanthord/candidate/<runId>/<attemptNo>` is declared by EPIC 051 (`.agents/plan/epics/051-the-execution-checkpoint.md:30`), nothing in EPIC 050 creates one, and `services/git` carries no delete primitive — `RefUpdateInput.nextOid` at `src/services/git/index.ts:51` is a non-null `string`. EPIC 051 adds the expiry path as a fourth caller of its own deletion. Recorded as an EPIC Decision; the unsatisfiable gate line is struck. See `07-the-expiry-pass.md`.
- **Migration 12 rebuilds the run table and drops two legacy CHECK groups.** SQLite cannot widen or drop a table-level CHECK with `ALTER TABLE`, so the rename-copy-drop pattern of migration `0007` is forced. The objective/`parent_run_id` biconditional and the three `driver = 'internal'` biconditionals are dropped and not replaced: the backfill sets every shipped row to `kind = 'execution'`, and an external run now carries a non-null `worker`. "Additive" means no column and no enum member is removed, which is what EPIC 057 depends on. See `02-migration-12.md` and `03-the-run-row.md`.
- **The `run_base` cardinality rule lands at its upper bound.** EPIC 050 creates the table and the rule; EPIC 051 writes the row. An `execution` run therefore holds no row for the whole of this epic, so the refine states _at most_ one for `execution` and exactly none for `structural` and `review`. EPIC 051 raises it to exactly one. `runRow` is parsed only in `src/domain/run.test.ts`, so no production path validates a live run row against it. See `03-the-run-row.md`.
- **The Proof names the config test files that exist.** `src/services/config/config.test.ts` does not exist; the EPIC Proof now names `src/services/config/convict.test.ts` and `src/services/config/refusals.test.ts`. See `12-configuration.md`.

- **`graph_revision` is a plan revision identity, and it is the project's newest, not the node's.** The column is `TEXT REFERENCES plan_revision(id)`. A compare and swap needs equality on an immutable token, not ordering, so a ULID identity is sufficient and no counter is added to `plan_revision`. The claim reads `plan.newestRevision(transaction, node.projectId)` (`src/services/plan/index.ts:75`) and never `node.revision`, which `docs/proposal/database/node.md:44` defines as the revision that last _wrote_ the node — pinning it would make EPIC 052 refuse a run that raced nothing. See `02-migration-12.md`, `03-the-run-row.md` and `08-…`.
- **The claiming worker comes from a server-owned caller record.** `ClaimNodeDependencies` carries `{ worker, authorized }`; `main.ts` binds `{ worker: "claude@1", authorized: ["claude@1"] }`. It is never derived from `input.actorId`, an `actor_<ULID>` authentication identity, and never read from the wire — a `worker` request field would create two worker authorities once EPIC 055 lands. EPIC 055 swaps the record for `{ worker: grant.worker, authorized: [grant.worker] }` and changes no schema. The command intersects `authorized` with `capableWorkers` before calling `routeWorker`, because EPIC 048 throws on an unintersected input. See `08-…`.

- **A refusal rolls the expiry back with everything else, and that is correct.** `src/services/storage/connection.ts:83` rolls back the whole callback on a throw, and the engine exposes no savepoint and no nested transaction. A command that expires a run and then refuses leaves the run `active` with its fence unchanged. An expired-but-unswept run authorizes nothing, because every operation runs the pass before it evaluates authority. Splitting the expiry into its own transaction would break one command, one transaction, open a window for another claim, and break the rule that a refusal writes nothing — which every refusal test here asserts by comparing database bytes. A claim that _succeeds_ commits the expiry and the replacement run atomically, so `run_one_active` never sees two active rows. See `07-…` and `10-…`.
- **The claim dispatches on `deliverable`, and one total refusal order governs both models.** A legacy node (`deliverable === null`) takes the shipped path unchanged, including `openOrAdoptRun`. A new-model node takes a separate path that never calls `openOrAdoptRun`, opens no parent objective run, and creates exactly one run. Keeping both would collide on `run_one_active`. The fifteen-step total order is in the EPIC and in `08-…`; an inapplicable predicate is skipped, never simulated. Every new-model refusal fires before the first mutation.
- **A review claim refuses `review-head-unavailable` in this epic.** No workspace record exists, so no head can be pinned into `judged_oid`, and writing `NULL` now and filling it in EPIC 051 would record a commit chosen after the claim — the retrospective choice the pin exists to prevent. EPIC 051 lifts the gate in the epic that establishes the head inside the same claim. See `08-…` and `13-…`.

## Still open

Nothing blocks dispatch. Every defect the review raised is resolved in the EPIC and in the stories.

## Facts (needed for implementation)

### The prerequisite epics are not implemented

`grep -rn "deliverable\|assignment\|workerId\|routeWorker" src/` returns zero hits. None of these exists yet, and Stories 1, 2, 3, 4 and 8 import them:

- `src/domain/deliverable.ts` — `deliverables = ["test", "implementation", "review", "expansion"]`, four members. EPIC 047 Story 1.
- `src/domain/node-pair.ts` — `nodePairLegality(kind, deliverable)`. EPIC 047 Story 2.
- `src/domain/worker-id.ts` — `WORKER_ID_PATTERN = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/`, a RegExp and **not** a zod schema. EPIC 048 Story 1. Story 3 here adds the zod schema beside it.
- `routeWorker` — `{ registry, kind, deliverable, authorized, available }` returning `{ routed: true, worker }` or `{ routed: false, refusal: "unroutable", failedSet: "capable" | "authorized" | "available" }`. EPIC 048 Story 3. `available` is a `readonly string[]`; the wire field is a boolean, and Story 8 maps one to the other.
- `src/services/storage/migration-0011-deliverable.ts` at version `11`, which creates `node.assignment`, `node.deliverable` and `node.verify_json`. EPIC 047 Story 7. Migration `12` is the next version.
- `node.worker` is legacy. The shipped `workerKinds` enum at `src/domain/worker.ts:3-11` holds seven values. The four dotted ones — `claude.swe@1`, `claude.te@1`, `opencode.swe@1`, `opencode.te@1` — are refused by `WORKER_ID_PATTERN`, because `.` is outside `[a-z0-9-]`. The three undotted ones — `general@1`, `tdd@1`, `git@1` — match the grammar. The two sets **overlap**; they are not disjoint. A test asserting disjointness would fail.
- `docs/proposal/phase-1/domain.md:24` states that `project.worker`, `node.worker` and `run.worker` hold a worker _kind_ and that the set is a `CHECK` clause and a zod enum. Story 3 widens `run.worker` to the id grammar and amends that sentence.

### Line anchors the EPIC cites that are stale

- `src/commands/node/claim-node.ts` — the EPIC cites lines 99, 104 and 105. The real sites are: `storage.transact` opens at **:104**, `clock.now()` at **:105**, the lease sweep at **:107-110**, `plan.readAllNodes` at **:112**, `ClaimRefusal` at **:27-35**.
- `docs/proposal/api/README.md:100` — line 100 is the opening line of the forbidden list, not an item. `add a required request field;` is line **105**, and the closing sentence Story 14 replaces is line **108**.
- `worker.md` **section 13 does not exist**. The file is at `../docs/workflow/worker.md`, outside this repository, at the monorepo root, and it ends at section 11. The migration step plan the EPIC attributes to section 13 lives at `.agents/plan/epics/046-worker-model-overview.md:87-113`; step 3 deploys the writers and step 8 enforces.
- The EPIC's Proof names `src/services/config/config.test.ts`. That file does not exist. The loader's tests are `src/services/config/convict.test.ts` and `src/services/config/refusals.test.ts`.

### Storage

- `src/services/storage/migrations.ts:13` opens the array; the highest shipped version is **10**. Registration is array membership, and `migration-0009-one-branch.test.ts:216-232` asserts the exact array identity and version sequence.
- Every migration batch runs under `BEGIN IMMEDIATE` (`src/services/storage/connection.ts:35`) and rolls back atomically, so an aborted guard leaves no temp residue and no `migration` bookkeeping row.
- The abort message is wrapped by `src/services/storage/sqlite.ts:90-98` into `migration <version> <name> failed: <the RAISE text>`, with code `storage-migration-failed`.
- `rebuild: true` sets `PRAGMA foreign_keys = OFF` and `PRAGMA legacy_alter_table = ON` for the batch (`sqlite.ts:76-79`). The `run` rename cycle needs both: `attempt`, `candidate`, `check_result` and `git_operation` all hold foreign keys into `run`.
- The shipped `run` DDL is `migration-0007-external-execution.ts:12-32` verbatim. `run_one_active` at `:33` is `CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'` — a partial unique index that defends the same-node case only.
- `attempt` carries `FOREIGN KEY (run_id, driver) REFERENCES run(id, driver)` at `migration-0007-external-execution.ts:52`, so `UNIQUE (id, driver)` on `run` must survive the rebuild.
- `node.repository_id` is non-null **exactly** for an objective, by `CHECK ((kind = 'objective') = (repository_id IS NOT NULL))` at `migration-0002-graph-and-plan.ts:33`. That is what makes the `run_base` ancestor walk terminate at the objective.
- Every production run today is `driver = 'external'` with `base_oid` NULL: `openRun` at `src/services/execution/sqlite.ts:85-112` hardcodes them. `'internal'` appears only in the 0007 backfill and in test fixtures.
- A new table must be added to `src/domain/rows.ts` (`run: runRow` is at `:43`) or `src/services/storage/schema-parity.test.ts:90-105` fails, and it needs a `docs/proposal/database/<table>.md` ` ```sql ` fence or the DDL parity test fails.

### Commands

- `src/commands/run/` does not exist. Stories 7 and 10 create it.
- `Transaction` (`src/services/storage/index.ts:1-5`) has exactly `run`, `get` and `all`. `transact` is synchronous and refuses a thenable (`connection.ts:90-101`), and re-entrant `transact` throws (`sqlite.ts:143-150`) — so a nested transaction is impossible and `expireRuns` must take the caller's transaction.
- `EventLog.append(transaction, input)` at `src/services/event/index.ts:50`; the canonical call site is `src/commands/node/claim-node.ts:300-317`.
- `Clock` is `{ now(): number }`. Every command reads it once as the first statement inside `storage.transact`.
- Test fixture: `createMigratedStorage()` and `databaseBytes()` from `test/helpers/database.ts`, `createMockClock({ start: 1700000000000 })`, `createMockIdGenerator({ ulids })`, and the row seeders in `test/helpers/rows.ts` (`seedRegistry` `:21`, `seedGraph` `:102`, `seedNodeState` `:267`, `seedRunRow` `:658`).
- The refusal test convention is: seed, snapshot `databaseBytes`, call the `refused` helper, assert `error.refusal`, assert `error.details` with `assert.deepEqual`, assert the bytes are unchanged — `src/commands/node/claim-node.test.ts:550-562`.

### Contract

- There is no `src/http/contract/node.ts`. The four node operations live in `execution.ts` (`node.claim` `:246-264`, `node.heartbeat` `:265-283`, `node.release` `:284-302`) and `outcome.ts` (`node.report` `:135-157`).
- `actionSegments` at `src/http/contract/path.ts:40-65` is a bytewise-sorted closed array of 24. `"renew"` sorts **after** `"rename"` and before `"report"`. `src/http/contract/path.test.ts:40` pins the count.
- The registry total is **73** and routed is **48** (`registry.test.ts:49-51`, `:64-73`). A rename moves neither.
- `parity.test.ts` reads **every** `*.md` under `docs/proposal/api/` except `README.md` and `new-decisions.md`, and compares four fields: `method`, rendered `path`, `introducedIn`, `status`. Its comparable count is pinned at 73 at `:16`.
- `runtime-matrix.test.ts` reads `docs/proposal/phase-1/runtime-capability-matrix.md`, requires the rows in registry order, pins the count at 48, and requires exactly nine cells per row.
- The harness operation list is duplicated in **three** places: `registry.test.ts:27-46`, `authorization.test.ts:17-36` and `system.test.ts:359-436`. All three move together.
- `errorStatuses` at `errors.ts:7-31` is ordered by ascending HTTP status, and every 409 is a `PreconditionCode` whose `httpError` overload **requires** a `details` argument (`errors.ts:95-111`).
- `eventPayloads` at `event-payload.ts:71` is typed `Readonly<Record<EventType, ZodType>>`, so a new event type without a payload fails type checking. The shared `fence` alias is at `:29-35`.
- `src/http/contract/system.ts:84` is already stale: it lists three capabilities where the live registry declares four.
- `coverage.test.ts:273` asserts every `z.enum` in the contract traces to a `domain/` import, and `:355` requires a line in `field-decisions.fixture.ts` for every registry field.

### Config

- The `attemptLimit` template spans four sites: the `Settings` member (`index.ts:34`), the schema entry (`convict.ts:231-235`), the env-integer table row (`convict.ts:354`) and the projection (`convict.ts:516`). All four are required, and a numeric env var absent from the table stays a string.
- `positiveInteger` (`convict.ts:44-48`) admits `1`, so the `runTtlMs` floor of `1000` needs its own format.
- A bad value is `config-invalid`; a legal-but-unstartable combination is `config-refused` and belongs in `src/services/config/refusals.ts`, not in a convict format.
- `src/services/config/convict.test.ts:104-121` pins the `Settings` key order.

### Verify

`pnpm run verify` is `format && typecheck && test && lint && node scripts/verify-db-status.ts && verify:guards`. It emits and validates the master OpenAPI document and every feature slice in a temporary directory.
