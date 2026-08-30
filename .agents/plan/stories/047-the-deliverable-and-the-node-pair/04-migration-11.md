# Story 04 — Migration 11

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 01, Story 02

## Change

### New migration file

Create `src/services/storage/migration-0011-deliverable.ts`.

SQLite does not support `ALTER TABLE … ADD CONSTRAINT` for cross-column CHECKs. The pair checks reference both `kind` and `deliverable`. The migration must recreate the `node` table.

The current `node` table DDL is in `src/services/storage/migration-0002-graph-and-plan.ts:17–42`. Migration 8 (`migration-0008-graph-indexes.ts:7`) adds `CREATE INDEX node_project ON node (project_id, id)`. The `edge` table at `migration-0002-graph-and-plan.ts:43–50` has FK columns `from_node` and `to_node` both referencing `node(id)` — drop and recreate the index and FKs are maintained by name after the rename.

Steps inside `statements` (write them in this exact order):

1. `PRAGMA foreign_keys = OFF`
2. ```sql
   CREATE TABLE node_new (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES project(id),
     kind TEXT NOT NULL CHECK (kind IN ('initiative', 'objective', 'task')),
     parent_id TEXT REFERENCES node(id),
     title TEXT NOT NULL,
     instruction_blob TEXT NOT NULL REFERENCES blob(hash),
     acceptance_blob TEXT REFERENCES blob(hash),
     worker TEXT,
     repository_id TEXT REFERENCES repository(id),
     state TEXT NOT NULL,
     block_reason TEXT,
     discard_reason TEXT,
     revision TEXT NOT NULL REFERENCES plan_revision(id),
     updated_at INTEGER NOT NULL,
     deliverable TEXT,
     verify_json TEXT,
     assignment TEXT,
     CHECK ((kind = 'initiative') = (parent_id IS NULL)),
     CHECK ((kind = 'objective') = (repository_id IS NOT NULL)),
     CHECK ((kind = 'task') = (acceptance_blob IS NOT NULL)),
     CHECK (state IN ('pending', 'ready', 'running', 'blocked',
                      'awaiting_approval', 'done', 'partial', 'discarded')),
     CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
     CHECK (block_reason IS NULL OR block_reason IN ('attempt-limit', 'dependency-discarded',
                      'stale-base', 'dirty-recovery', 'e2e-failed', 'abandoned')),
     CHECK (state <> 'awaiting_approval' OR kind = 'objective'),
     CHECK (state <> 'partial' OR kind <> 'task'),
     CHECK (deliverable IS NULL OR deliverable IN
           ('test', 'implementation', 'review', 'expansion')),
     CHECK (deliverable IS NULL OR kind <> 'initiative' OR deliverable = 'expansion'),
     CHECK (deliverable IS NULL OR kind <> 'task' OR deliverable <> 'expansion'),
     CHECK (verify_json IS NULL OR json_valid(verify_json))
   ) STRICT
   ```
3. `INSERT INTO node_new SELECT id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at, NULL, NULL, NULL FROM node`
4. `DROP TABLE node`
5. `ALTER TABLE node_new RENAME TO node`
6. `CREATE INDEX node_project ON node (project_id, id)`
7. `PRAGMA foreign_keys = ON`

Set `rebuild: true` on the migration constant.

Export the constant as `migration0011Deliverable: Migration`.

### Register the migration

Edit `src/services/storage/migrations.ts`:

- Add import after line 11: `import { migration0011Deliverable } from "./migration-0011-deliverable.ts";`
- Append `migration0011Deliverable` to the `migrations` array after line 23.

## Constraints

- Three added columns are nullable. No `NOT NULL`.
- Every existing column and CHECK from `migration-0002-graph-and-plan.ts:17–42` is copied verbatim — no column or CHECK is dropped or changed.
- `assignment` has no format check and no CHECK clause.
- Migration version is exactly `11`.
- `schema-parity.test.ts` passes unchanged — it does not reference `deliverable`, `verify_json`, or `assignment`.

## Verify

```bash
node --test src/services/storage/migration-0011-deliverable.test.ts
```

Create `src/services/storage/migration-0011-deliverable.test.ts` using `createStorageAtVersion` from `test/helpers/database.ts`.

**Critical sequencing rule:** Seed the initiative, objective, and task rows at version 10 — before running `storage.migrate()` to version 11. Only this order proves that migration 11 preserves existing rows. Rows inserted after migration cannot test preservation.

Test steps in this order:

1. `createStorageAtVersion(10)` returns a version-10 database helper. Through that helper's `transaction.run`, insert:
   - One initiative: `id = 'ini_01JTEST000000000000000000'`, `project_id = '<valid project id>'`, `kind = 'initiative'`, `parent_id = NULL`, `title = 'root'`, `instruction_blob = '<any blob hash>'`, `acceptance_blob = NULL`, `worker = NULL`, `repository_id = NULL`, `state = 'pending'`, `block_reason = NULL`, `discard_reason = NULL`, `revision = '<valid revision id>'`, `updated_at = 1000`.
   - One objective: same pattern but `kind = 'objective'`, `parent_id = '<initiative id>'`, `repository_id = '<valid repository id>'` (required by CHECK), `state = 'pending'`.
   - One task: same pattern but `kind = 'task'`, `parent_id = '<objective id>'`, `acceptance_blob = '<any blob hash>'` (required by CHECK), `state = 'pending'`.

   Use unique ULID-formatted ids consistent with the kind prefix (e.g., `ini_`, `obj_`, `tsk_`). The project, repository, plan_revision, and blob rows must also be inserted to satisfy FK constraints — or set `PRAGMA foreign_keys = OFF` for the seed inserts.

2. Open a new `SqliteStorage` with all 11 migrations and call `storage.migrate()`. Assert `storage.status().applied` includes version 11.

3. Run `PRAGMA table_info(node)` and assert columns `deliverable`, `verify_json`, `assignment` are present.

4. Read each of the three seeded rows. Assert every original column of every row is unchanged, field by field via `assert.strictEqual`. Assert `deliverable`, `verify_json`, `assignment` are all `null` for every row.

5. **Domain/SQLite parity proof.** Import `nodePairLegality` from `src/domain/node-pair.ts` and `nodeKinds` from `src/domain/state.ts` and `deliverables` from `src/domain/deliverable.ts`. Build two sets:
   - `domainLegal`: iterate all 15 `(kind, deliverable)` pairs via `nodeKinds × deliverables`; collect pairs where `nodePairLegality(kind, deliverable).legal === true` as strings `"${kind}:${deliverable}"`.
   - `sqliteLegal`: for each of the 15 pairs, attempt to insert a node row with that `(kind, deliverable)` into the migrated database (using raw SQL with `PRAGMA foreign_keys = OFF`); collect pairs where the insert succeeds.
   - Assert `domainLegal` deep-equals `sqliteLegal` via `assert.deepStrictEqual` after sorting both arrays with `.sort()`.

6. Attempt to insert a node with `verify_json = '{'`. Assert the insert throws with a SQLite constraint error.

7. Assert the error message from step 5's `('task', 'expansion')` insert names the CHECK — it must contain the word `CHECK` in the error message.

Test framework: `node:test` and `node:assert/strict`. Uses real SQLite via helpers.

Proof: PASS EPIC-047 line for `src/services/storage/migration-0011-deliverable.test.ts`; hermetic coverage — migration applied to a pre-seeded database, existing rows unchanged with three new columns null, domain and SQLite legal sets deep-equal across all 15 pairs, `json_valid` CHECK refuses malformed JSON, pair-illegal refusal error names the CHECK.
