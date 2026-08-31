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

## Tasks

### Task 04 — Cover migration 11

**Input:** `src/services/storage/migration-0011-deliverable.test.ts`,
`src/services/storage/migration-0011-deliverable.ts`, `src/services/storage/migrations.ts`

**Action — RED:** Two parts. Write both before you hand the Task over.

Part A — create `src/services/storage/migration-0011-deliverable.test.ts` holding the seven
steps named under `## Verify`, in that order. The test file is the required Proof target.
The Proof command names it, so no other lane can supply it.

Part B — repair the migration-count fixtures that registering version 11 makes stale. Each
one asserts the exact registry, so each one must name eleven migrations with
`migration0011Deliverable` last:

- `src/services/storage/migration-0001-core-entities.test.ts:209` — `migrations holds the ten declared migrations in order`
- `src/services/storage/migration-0002-graph-and-plan.test.ts:248` — `migrations holds the ten declared migrations in order`
- `src/services/storage/migration-0003-execution-and-journal.test.ts:504` — `migrations holds exactly the ten migrations and versions map to 1 through 10`
- `src/services/storage/migration-0004-event-indexes.test.ts:35` — `migrations holds ten entries, versions 1 to 10 in order`
- `src/services/storage/migration-0006-revision-origin.test.ts:176` — `migrations holds ten entries, versions 1 to 10 with the ten names in order`
- `src/services/storage/migration-0008-graph-indexes.test.ts:176` — `migrations holds the ten declared migrations in order`
- `src/services/storage/migration-0009-one-branch.test.ts:215` — `migrations holds exactly ten migrations with migration0010ProviderLogin last`
- `src/services/storage/migration-0010-provider-login.test.ts:152` — `migrations holds exactly ten migrations with migration0010ProviderLogin last`

Rename each `it(...)` title to state eleven, and to name `migration0011Deliverable` where
the old title named `migration0010ProviderLogin`. A title that states a count and a count
that no longer matches is a defect on its own.

`src/services/storage/migration-0006-revision-origin.test.ts:199` — `the rebuild applies on
a version-5 database and copies every row` — asserts the exact `node` DDL text after every
migration applies. Update that expected string to the post-migration-11 DDL. Three changes
land in it, and all three are consequences of step 5 of `## Change`:

- The table name is quoted as `"node"`, because `ALTER TABLE … RENAME TO` writes the stored
  DDL with the identifier quoted.
- `deliverable TEXT`, `verify_json TEXT` and `assignment TEXT` follow `updated_at`.
- The four added CHECK clauses follow the existing CHECK clauses, in the `## Change` order.

Take the expected string from `## Change`, not from a test run. Do not paste an actual value
a failing run printed — that asserts what the code does rather than what the Story requires.

**Action — GREEN:** Create `src/services/storage/migration-0011-deliverable.ts` and register
it in `src/services/storage/migrations.ts`, exactly as `## Change` names both.

**Action — REFACTOR:** None.

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
   - `domainLegal`: iterate all 12 `(kind, deliverable)` pairs via `nodeKinds × deliverables`; collect pairs where `nodePairLegality(kind, deliverable).legal === true` as strings `"${kind}:${deliverable}"`.
   - `sqliteLegal`: for each of the 12 pairs, attempt to insert a node row with that `(kind, deliverable)` into the migrated database (using raw SQL with `PRAGMA foreign_keys = OFF`); collect pairs where the insert succeeds.
   - Assert `domainLegal` deep-equals `sqliteLegal` via `assert.deepStrictEqual` after sorting both arrays with `.sort()`.

6. Attempt to insert a node with `verify_json = '{'`. Assert the insert throws with a SQLite constraint error.

7. Assert the error message from step 5's `('task', 'expansion')` insert names the CHECK — it must contain the word `CHECK` in the error message.

Test framework: `node:test` and `node:assert/strict`. Uses real SQLite via helpers.

Proof: PASS EPIC-047 line for `src/services/storage/migration-0011-deliverable.test.ts`; hermetic coverage — migration applied to a pre-seeded database, existing rows unchanged with three new columns null, domain and SQLite legal sets deep-equal across all 12 pairs, `json_valid` CHECK refuses malformed JSON, pair-illegal refusal error names the CHECK.
