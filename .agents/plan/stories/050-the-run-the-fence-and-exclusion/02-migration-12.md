# Story 2 — Migration 12

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 1 (`runKinds`), Story 3 (`runBaseRow`, and the `src/domain/rows.ts` registration Story 3 owns), EPIC 047 Story 7 (`src/services/storage/migration-0011-deliverable.ts` at version `11`).

## Change

**Create `src/services/storage/migration-0012-run-model.ts`** (greenfield).

Export `migration0012RunModel: Migration` with `version: 12`, `name: "0012-run-model"`, and **`rebuild: true`**.

`rebuild: true` is required. SQLite cannot change a table-level `CHECK` or drop a column referenced by another table's foreign key with `ALTER TABLE` alone, so the migration uses the rename-copy-drop pattern of `migration-0007-external-execution.ts:8-72`. `rebuild: true` sets `PRAGMA foreign_keys = OFF` and `PRAGMA legacy_alter_table = ON` for the batch (`src/services/storage/sqlite.ts:76-79`), which the rename cycle needs because `attempt`, `candidate`, `check_result` and `git_operation` hold foreign keys into `run`.

**This migration lands the final shape.** There are no deployments, so there is no run row to preserve, no client to break and no additive window to hold open. It applies every constraint at once and drops every legacy column.

**It is destructive to run history and to nothing else.** It deletes every `attempt` and `run` row. It touches no `node`, `edge`, `blob`, `plan_revision`, `project`, `project_binding` or `repository` row.

### Statement order

**1 — the null-deliverable guard**, in the `migration-0009-one-branch.ts:7-17` pattern. It runs first, before any drop:

```sql
CREATE TEMP TABLE migration_0012_guard (project TEXT NOT NULL, total INTEGER NOT NULL)
```

```sql
CREATE TEMP TRIGGER migration_0012_refuse BEFORE INSERT ON migration_0012_guard BEGIN
  SELECT RAISE(ABORT, 'project ' || NEW.project || ' holds ' || NEW.total || ' node(s) with no deliverable; run kanthord plan convert and kanthord plan import against that project, then migrate again');
END
```

```sql
INSERT INTO migration_0012_guard (project, total)
  SELECT project_id, COUNT(*) FROM node WHERE deliverable IS NULL
  GROUP BY project_id ORDER BY project_id LIMIT 1
```

```sql
DROP TRIGGER migration_0012_refuse
```

```sql
DROP TABLE migration_0012_guard
```

`GROUP BY project_id ORDER BY project_id LIMIT 1` names the lexicographically first offending project, which makes the message deterministic. A database with no null `deliverable` inserts no row, the trigger never fires, and the migration continues. This refusal replaces the whole of EPIC 057's planned preflight for `node.deliverable`.

**2 — discard run history**, before the rebuild, so the `NOT NULL` columns land with no row to violate them:

```sql
DELETE FROM check_result
```

```sql
DELETE FROM candidate
```

```sql
DELETE FROM attempt
```

```sql
DELETE FROM run
```

`check_result` and `candidate` both carry `run_id` foreign keys (`migration-0003-execution-and-journal.ts:80`, `:107`), so they are emptied first. `git_operation.run_id` is nullable; set it null rather than deleting the journal row:

```sql
UPDATE git_operation SET run_id = NULL WHERE run_id IS NOT NULL
```

**3 — the rename**:

```sql
ALTER TABLE run RENAME TO run_old
```

```sql
DROP INDEX run_one_active
```

The index drop follows the rename, mirroring `migration-0007-external-execution.ts:8-11`: in SQLite an index follows its table across a rename and would otherwise stay attached to `run_old`.

**4 — the new `run` table**:

```sql
CREATE TABLE run (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('structural', 'execution', 'review')),
  node_id         TEXT NOT NULL REFERENCES node(id),
  driver          TEXT NOT NULL CHECK (driver IN ('internal', 'external')),
  workspace_id    TEXT REFERENCES workspace(id),
  worker          TEXT NOT NULL,
  fence           INTEGER NOT NULL,
  attempt_limit   INTEGER NOT NULL,
  head_oid        TEXT,
  judged_oid      TEXT,
  graph_revision  TEXT REFERENCES plan_revision(id),
  agents_json     TEXT NOT NULL CHECK (json_valid(agents_json)),
  expires_at      INTEGER NOT NULL,
  max_lifetime_at INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  outcome         TEXT,
  ended_at        INTEGER,
  UNIQUE (id, driver)
) STRICT
```

Gone, and not replaced: `parent_run_id` (a claim opens one run and pairs no parent), `lease_fence`, `base_oid`, and all four shipped table-level CHECKs — the objective/`parent_run_id` biconditional and the three `driver = 'internal'` biconditionals. `worker` is now `NOT NULL`, because every run this epic opens carries the routed worker id.

`UNIQUE (id, driver)` is kept, because `attempt` carries `FOREIGN KEY (run_id, driver) REFERENCES run(id, driver)` at `migration-0007-external-execution.ts:52`.

**5 — the index**, recreated verbatim:

```sql
CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'
```

**6 — the `run_base` table**:

```sql
CREATE TABLE run_base (
  run_id        TEXT NOT NULL REFERENCES run(id),
  repository_id TEXT NOT NULL REFERENCES repository(id),
  oid           TEXT NOT NULL,
  PRIMARY KEY (run_id, repository_id)
) STRICT
```

**7 — drop the old table**. No backfill: `run_old` is empty by step 2.

```sql
DROP TABLE run_old
```

**8 — the node columns**. `node.deliverable` and `node.verify_json` become `NOT NULL`, and `node.worker` is dropped. `node` carries table-level CHECKs, so this is a second rename-copy-drop cycle in the same migration. Copy the `node` DDL from `migration-0002-graph-and-plan.ts:17-42` and from migration `11`, remove the `worker` column, and add `NOT NULL` to `deliverable` and `verify_json`. Keep every shipped CHECK, keep `assignment` nullable — it is runtime state and an unclaimed node holds none — and recreate `node_project` (`migration-0008-graph-indexes.ts:7`) after the copy. Copy every row: step 1 proved none has a null `deliverable`.

### Registration and the sites outside the migration

- `src/services/storage/migrations.ts:13` — append `migration0012RunModel`, after the migration `11` import.
- `docs/proposal/database/run.md` — replace the DDL fence with the table above, and state that migration `12` discards run history. `test/helpers/proposal.ts` `proposalStatements("run")` parses this fence, and the DDL parity test compares it to `sqlite_master`.
- `docs/proposal/database/run_base.md` — create it, carrying the `run_base` DDL verbatim in a `sql` fence, mirroring `docs/proposal/database/run.md`.
- `docs/proposal/database/node.md` — update the DDL fence and remove the `worker` row from the column table.
- `src/domain/rows.ts`, `src/domain/rows.test.ts` and `docs/proposal/phase-1/domain.md:39` are registered by **Story 3**, not here.

## Constraints

- Do not backfill any run column. Step 2 leaves the table empty.
- Do not keep `objective` or `task` in the `kind` CHECK.
- Do not delete a `node`, `edge`, `blob`, `plan_revision`, `project` or `repository` row.
- Do not add a kind-conditional CHECK on `graph_revision` or `judged_oid`.
- Do not add a CHECK expressing the `run_base` cardinality. That rule is a zod refine in Story 3; a SQL CHECK cannot see another table.
- Do not touch the `lease` table. EPIC 050.1 removes its node rows.

## Verify

```
node --test src/services/storage/migration-0012-run-model.test.ts src/services/storage/schema-parity.test.ts src/domain/rows.test.ts
```

Create `src/services/storage/migration-0012-run-model.test.ts`. Suite name `"src/services/storage/migration-0012-run-model.test"`. Mirror `src/services/storage/migration-0009-one-branch.test.ts` for structure: `describe`/`it`/`after`, `createTemporaryDatabase()`, `createMockClock({ start: 1700000000000 })`, a `buildMigratedThroughEleven()` helper passing the explicit eleven-element migration list, then a second `SqliteStorage` over the same `temporary.path` with the full `migrations` array. Register `after(() => storage.close())` and `after(() => temporary.dispose())` immediately after each construction. Reuse `columnNames`, `tableSql`, `normalize` and `appliedVersions`.

Assert, each as a separate `it`:

1. `"migration0012RunModel carries version 12, its name, and rebuild true"`.

2. `"migrations holds exactly twelve migrations with migration0012RunModel last"` — `assert.deepEqual(migrations.map((m) => m.version), [1,2,3,4,5,6,7,8,9,10,11,12])`.

3. `"the guard aborts against a node with a null deliverable, naming the project and the count"` — migrate through `11`, seed two nodes with a null `deliverable` in `project_a`. Assert `assert.throws` with `error.code === "storage-migration-failed"`, `error.message.includes("migration 12 0012-run-model failed:")` and `error.message.includes("project project_a holds 2 node(s) with no deliverable")`. Then assert `appliedVersions` is `[1..11]` and `node` still holds its `worker` column.

4. `"the guard names the lexicographically first project"` — seed a null-deliverable node in `project_b` and one in `project_a`. Assert the message names `project_a`.

5. `"no temp object survives a refused migration"` — `SELECT COUNT(*) AS c FROM temp.sqlite_master WHERE name LIKE 'migration_0012%'` equals `0`.

6. `"the migration succeeds when every node carries a deliverable"` — assert `appliedVersions` is `[1..12]` and `status().pending` is `[]`.

7. `"run and attempt are empty after the migration"` — seed two runs and two attempts before migrating. Assert `SELECT COUNT(*) FROM run` and `FROM attempt` are both `0`.

8. `"the migration preserves every non-run row"` — seed a project, a repository, a plan revision, an initiative, an objective, a task and an edge. Snapshot `SELECT * FROM node ORDER BY id` and the same for `edge`, `blob`, `plan_revision`, `project` and `repository` before the migration. After it, assert each deep-equals its snapshot except that `node` has lost its `worker` key. The destruction is bounded by this assertion.

9. `"lease_fence, base_oid, parent_run_id and node.worker are absent"` — read `PRAGMA table_info(run)` and assert `columnNames` deep-equals the exact literal:
   `["id","kind","node_id","driver","workspace_id","worker","fence","attempt_limit","head_oid","judged_oid","graph_revision","agents_json","expires_at","max_lifetime_at","state","outcome","ended_at"]`.
   Read `PRAGMA table_info(node)` and assert `"worker"` is absent and `"assignment"`, `"deliverable"` and `"verify_json"` are present.

10. `"each NOT NULL run column refuses a null"` — four cases, one per column of `fence`, `agents_json`, `expires_at`, `max_lifetime_at`. Insert an otherwise-valid run row with that one column null and `assert.throws`. One column per case, so a failure names the column.

11. `"the kind CHECK admits the three new values and refuses the two shipped ones"` — insert one run per value of `['structural','execution','review']` and assert each succeeds; then `assert.throws` for `kind = 'objective'` and for `kind = 'task'`. Both directions.

12. `"node.deliverable and node.verify_json refuse a null after the migration"` — two cases, each `assert.throws` on an insert.

13. `"node.assignment still accepts a null"` — assert an insert with a null `assignment` succeeds. It is runtime state, not converted data.

14. `"run_one_active still refuses a second active run on the same node"` — insert one active run, then `assert.throws` on a second with the same `node_id` and `state = 'active'`. This proves the index survived the rename cycle.

15. `"the migrated run table equals the run proposal fence"` — `assert.deepEqual(normalize(tableSql(storage, "run")), proposalStatements("run"))`.

16. `"the migrated run_base table equals the run_base proposal fence"` — the same against `proposalStatements("run_base")`.

17. `"the migrated node table equals the node proposal fence"` — the same against `proposalStatements("node")`.

18. `"a git_operation row survives with a null run_id"` — seed one with a non-null `run_id`; assert the row still exists afterwards and its `run_id` is null. The journal is not deleted.

19. `"re-applying the full chain to an already-migrated database is a no-op"` — mirror `migration-0009-one-branch.test.ts:400-432`.

`pnpm run verify` exits 0. `node scripts/verify-db-status.ts` is a step of it.

Proof: PASS line delivered — `src/services/storage/migration-0012-run-model.test.ts` in `PASS EPIC-050`.
