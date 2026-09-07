# EPIC 050 — The run row and exclusion — stories

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Prereq: EPIC 049 (sequence order). EPICs 047, 048 and 049 must all be implemented before any story here runs — none of their outputs exists in `src/` yet. See **Facts** below.

The run vocabulary exists — its kind, its row schema, its provenance and its budgets — the node assignment is published, and the two exclusion rules are written as pure functions. This epic changes no table and implements no seam: migration `12` and the three claim seams belong to EPIC 050.1, because `src/services/execution/sqlite.ts:88` `openRun` cannot satisfy the new `run` shape and EPIC 050.1 is the epic that rewrites it. The claim that opens the run belongs to EPIC 050.1. `node.renew`, `node.release` and `node.report` belong to EPIC 050.2, and the node lease is removed in EPIC 050.4.

## One story, one path

Every story of this epic is a `story-foundation`: a migration, a schema, a pure function, a service interface, a configuration budget or a proposal document. A story that changes no path draws nothing, and the pair rule does not reach it. `.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1 enforces it.

No story of this epic carries a diagram.

## Dispatch order

Stories 1, 4 and 6 are independent and can run concurrently — each is a greenfield pure module or a configuration addition.

Story 5 depends on Story 4 (same file, shared liveness predicate); implement Story 5 directly after Story 4 in the same unit.

Story 2 depends on Story 1 alone. It is a zod schema and needs no DDL to exist first. **Story 2 registers no table.** `run_base` reaches `src/domain/rows.ts`, `src/domain/rows.test.ts` and `docs/proposal/phase-1/domain.md:39` in EPIC 050.1, together with the migration that creates it, because `src/services/storage/schema-parity.test.ts:90-105` asserts the migrated table set equals `Object.keys(rows)`.

Story 3 depends on Story 2.

Story 7 depends on every prior story of this epic. It states what the code does, so write it last. It records the run model only: the claim sections are EPIC 050.1 Story 9 and the authority sections are EPIC 050.2 Story 9, so no sentence of it describes code a later epic ships.

A workable serial order: **1 → 2 → 4 → 5 → 6 → 3 → 7**.

No story depends on a story later than itself in that order.

## Stories

- 1 — The run kind → `01-the-run-kind.md`
- 2 — The run row → `02-the-run-row.md`
- 3 — `assignment` is published → `03-assignment-is-published.md`
- 4 — Subtree exclusion → `04-subtree-exclusion.md`
- 5 — The objective-branch rule → `05-the-objective-branch-rule.md`
- 6 — Configuration → `06-configuration.md`
- 7 — The proposal records the run model → `07-the-proposal-records-the-run-model.md`

## Transferred to EPIC 050.1 during implementation

Migration `12` and the three claim seams left this epic on 2026-09-01, after Story 4 failed three
attempts. The drafts are parked at `.agents/plan/pending/050.1-migration-12.md` and
`.agents/plan/pending/050.1-the-claim-seams.md`, and `/plan` must absorb both into EPIC 050.1.
The reason is one fact: migration `12` drops `run.parent_run_id`, `lease_fence` and `base_oid`,
narrows the `kind` CHECK to the three new values, and makes `worker`, `fence`, `agents_json`,
`expires_at` and `max_lifetime_at` `NOT NULL`, while `src/services/execution/sqlite.ts:88` `openRun`
writes the dropped columns, a null `worker` and the `kind` values `objective` and `task`, and writes
none of the four new `NOT NULL` columns. EPIC 050 defers that rewrite to EPIC 050.1 by its own
non-goal, so the schema and its only writer must land in one epic. `plan.setNodeAssignment`,
`execution.activeRunsOfNodes` and `execution.expireDueRuns` move with it, because they read
`run.fence` and `run.expires_at`.

Two node changes left the drafts entirely. Migration `12` no longer drops `node.worker` and no
longer makes `node.deliverable` and `node.verify_json` `NOT NULL`, and its null-deliverable guard is
gone. EPIC 047 keeps `node.worker` through EPIC 056, EPIC 049 keeps a plan document naming neither
`worker` nor `deliverable` legal, `src/commands/node/create-node.ts:178` writes a null
`deliverable`, and every node read path still selects `worker`. EPIC 057 migration `18` owns all
three changes and its preflight.

## Moved to EPIC 050.1

The claim contract, the expiry pass, the claim of a task, the claim of an initiative, the objective-busy refusal, the conformance harness, the conformance runner, the range gate and the claim half of the proposal left this epic when it split at the ten-story cap. `.agents/plan/stories/050.1-the-claim/` holds all nine. EPIC 050 changes no drawn path and nothing on the wire. EPIC 050.1 now stands at eleven stories with the two transferred drafts, over the ten-story cap, so `/plan` must decide its split.

## Moved to EPIC 050.2

Run authority, the renew, the release, the report prelude, the worker contract and the capability swap left this epic in an earlier split. `.agents/plan/stories/050.2-the-run-renew-release-and-report/` holds all six.

## Decisions taken during authoring, and now recorded in the EPIC

A human ruled on each. The EPIC carries them; these stories implement them.

- **Migration 12 rebuilds the run table empty and discards every run and attempt row, and it lands in EPIC 050.1.** SQLite cannot widen or drop a table-level CHECK with `ALTER TABLE`, so the rename-copy-drop pattern of migration `0007` is forced. There are no deployments, so there is no row to preserve and no backfill rule to invent. The migration is destructive to run history and to nothing else. See `.agents/plan/pending/050.1-migration-12.md`.
- **The `run_base` cardinality rule lands at its upper bound.** EPIC 050 states the rule as a zod refine, EPIC 050.1 creates the table, and EPIC 051 writes the row. An `execution` run therefore holds no row for the whole of this range, so the refine states _at most_ one for `execution` and exactly none for `structural` and `review`. `runRow` is parsed only in `src/domain/run.test.ts`, so no production path validates a live run row against it. See `02-the-run-row.md`.
- **The proposal document is written in three parts, one per epic.** Story 7 here creates `docs/proposal/phase-2/runs-and-exclusion.md` and records the run model. EPIC 050.1 Story 9 adds the claim sections and EPIC 050.2 Story 9 adds the authority sections. One story carrying the whole document would state rules two later epics implement, and would import `runAuthorityRefusals` from a module EPIC 050.2 creates — a story EPIC 050 cannot prove in dispatch order. See `07-the-proposal-records-the-run-model.md`.
- **The Proof names the config test files that exist.** `src/services/config/config.test.ts` does not exist; the EPIC Proof names `src/services/config/convict.test.ts` and `src/services/config/refusals.test.ts`. See `06-configuration.md`.
- **`graph_revision` is a plan revision identity.** The column is `TEXT REFERENCES plan_revision(id)`. A compare and swap needs equality on an immutable token, not ordering, so a ULID identity is sufficient and no counter is added to `plan_revision`. Which revision the claim records is EPIC 050.1's ruling. See `02-the-run-row.md`.
- **One liveness predicate governs both exclusion rules.** A run whose `expires_at` has passed is live for neither `subtreeExclusion` nor `objectiveBusy`, the boundary instant is expired, and a module-private `isLive(run, now)` helper is what keeps the two from disagreeing. See `04-subtree-exclusion.md` and `05-the-objective-branch-rule.md`.

## Still open

Nothing blocks dispatch.

## Facts (needed for implementation)

### The prerequisite epics are not implemented

`grep -rn "deliverable\|assignment\|workerId\|routeWorker" src/` returns zero hits. None of these exists yet, and Stories 1, 2 and 3 import them:

- `src/domain/deliverable.ts` — `deliverables = ["test", "implementation", "review", "expansion"]`, four members. EPIC 047 Story 1.
- `src/domain/node-pair.ts` — `nodePairLegality(kind, deliverable)`. EPIC 047 Story 2.
- `src/domain/worker-id.ts` — `WORKER_ID_PATTERN = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/`, a RegExp and **not** a zod schema. EPIC 048 Story 1. Story 2 here adds the zod schema beside it.
- `src/services/storage/migration-0011-deliverable.ts` at version `11`, which creates `node.assignment`, `node.deliverable` and `node.verify_json`. EPIC 047 Story 7. It is the highest version this epic leaves in the tree.
- `node.worker` is legacy. The shipped `workerKinds` enum at `src/domain/worker.ts:3-11` holds seven values. The four dotted ones — `claude.swe@1`, `claude.te@1`, `opencode.swe@1`, `opencode.te@1` — are refused by `WORKER_ID_PATTERN`, because `.` is outside `[a-z0-9-]`. The three undotted ones — `general@1`, `tdd@1`, `git@1` — match the grammar. The two sets **overlap**; they are not disjoint. A test asserting disjointness would fail.
- `docs/proposal/phase-1/domain.md:24` states that `project.worker`, `node.worker` and `run.worker` hold a worker _kind_ and that the set is a `CHECK` clause and a zod enum. Story 2 widens `run.worker` to the id grammar and amends that sentence.

### Line anchors the EPIC cites that are stale

- `worker.md` **section 13 does not exist**. The file is at `docs/workflow/worker.md`, outside this repository, at the monorepo root, and it ends at section 11. The migration step plan the EPIC attributes to section 13 lives at `.agents/plan/epics/046-worker-model-overview.md:87-113`; step 3 deploys the writers and step 8 enforces.
- The EPIC's Proof names `src/services/config/config.test.ts`. That file does not exist. The loader's tests are `src/services/config/convict.test.ts` and `src/services/config/refusals.test.ts`.

### Storage

- `src/services/storage/migrations.ts:13` opens the array; the highest shipped version is **10**. Registration is array membership, and `migration-0009-one-branch.test.ts:216-232` asserts the exact array identity and version sequence.
- Every migration batch runs under `BEGIN IMMEDIATE` (`src/services/storage/connection.ts:35`) and rolls back atomically, so an aborted guard leaves no temp residue and no `migration` bookkeeping row.
- The abort message is wrapped by `src/services/storage/sqlite.ts:90-98` into `migration <version> <name> failed: <the RAISE text>`, with code `storage-migration-failed`.
- `rebuild: true` sets `PRAGMA foreign_keys = OFF` and `PRAGMA legacy_alter_table = ON` for the batch (`sqlite.ts:76-79`). The `run` rename cycle needs both: `attempt`, `candidate`, `check_result` and `git_operation` all hold foreign keys into `run`.
- The shipped `run` DDL is `migration-0007-external-execution.ts:12-32` verbatim. `run_one_active` at `:33` is `CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'` — a partial unique index that defends the same-node case only.
- `attempt` carries `FOREIGN KEY (run_id, driver) REFERENCES run(id, driver)` at `src/services/storage/migration-0007-external-execution.ts:52`, so `UNIQUE (id, driver)` on `run` must survive the rebuild.
- `node.repository_id` is non-null **exactly** for an objective, by `CHECK ((kind = 'objective') = (repository_id IS NOT NULL))` at `src/services/storage/migration-0002-graph-and-plan.ts:33`. That is what makes the `run_base` ancestor walk terminate at the objective.
- Every production run today is `driver = 'external'` with `base_oid` NULL: `openRun` at `src/services/execution/sqlite.ts:85-112` hardcodes them. `'internal'` appears only in the 0007 backfill and in test fixtures.
- A new table must be added to `src/domain/rows.ts` (`run: runRow` is at `:43`) or `src/services/storage/schema-parity.test.ts:90-105` fails, and it needs a `docs/proposal/database/<table>.md` ` ```sql ` fence or the DDL parity test fails.

### Config

- The `attemptLimit` template spans four sites: the `Settings` member (`index.ts:34`), the schema entry (`convict.ts:231-235`), the env-integer table row (`src/services/config/convict.ts:354`) and the projection (`src/services/config/convict.ts:516`). All four are required, and a numeric env var absent from the table stays a string.
- `positiveInteger` (`convict.ts:44-48`) admits `1`, so the `runTtlMs` floor of `1000` needs its own format.
- A bad value is `config-invalid`; a legal-but-unstartable combination is `config-refused` and belongs in `src/services/config/refusals.ts`, not in a convict format.
- `src/services/config/convict.test.ts:104-121` pins the `Settings` key order.

### Verify

`pnpm run verify` is `format && typecheck && test && lint && node scripts/verify-db-status.ts && verify:guards`. It emits and validates the master OpenAPI document and every feature slice in a temporary directory.
