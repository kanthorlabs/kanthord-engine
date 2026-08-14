# Story 3 — Migration 0005, the actor table and the event widening

Epic: `.agent/plan/epics/015-actor-identity.md`
Depends on: Story 1 (`bootstrapActorId`, `actorRow` in `src/domain/rows.ts`).

## Change

- Create `src/services/storage/migration-0005-actor.ts`, exporting `export const migration0005Actor: Migration` with `version: 5` and `name: "0005-actor"`. `Migration` at `src/services/storage/migration.ts` is `{ version, name, statements: readonly string[] }` — raw SQL only, no function.
- The module also exports two named DDL constants that its statement list uses, so the parity test can compare each against its proposal document:
  - `export const actorTableDdl = \`CREATE TABLE actor (...) STRICT\`;`
  - `export const eventTableDdl = \`CREATE TABLE event (...) STRICT\`;`
- `statements` holds exactly these **nine** entries, in this exact order. Nine is the sum of the work, not a chosen number: two statements build `actor` (create, bootstrap insert), four rebuild `event` (rename, create, copy, drop), and three recreate the indexes. The order is load-bearing: the rename must precede the create, and the three indexes must follow the drop, because `ALTER TABLE event RENAME TO event_old` carries the migration-0004 indexes onto `event_old` and `DROP TABLE event_old` removes them.

  1. `actorTableDdl`
  2. the bootstrap insert (below)
  3. `ALTER TABLE event RENAME TO event_old`
  4. `eventTableDdl`
  5. the copy insert (below)
  6. `DROP TABLE event_old`
  7. `CREATE INDEX event_subject ON event (subject_kind, subject_id, id)`
  8. `CREATE INDEX event_type ON event (type, id)`
  9. `CREATE INDEX event_actor ON event (actor_kind, actor_id, id)`

  Entries 7 to 9 are copied verbatim from `src/services/storage/migration-0004-event-indexes.ts:7-9`.

- **Rename-first, not create-under-a-temporary-name.** Statement 4 must create the table under its final name `event`, so `eventTableDdl` is byte-comparable with the DDL in `docs/proposal/database/event.md`. A `CREATE TABLE event_new` followed by a rename would make that comparison impossible.
- `actorTableDdl` holds, in this column order, matching the style of `src/services/storage/migration-0001-core-entities.ts:13-25`:

  ```sql
  CREATE TABLE actor (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'harness')),
    name TEXT NOT NULL UNIQUE,
    token_sha256 BLOB,
    registered_by TEXT REFERENCES actor(id),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_by TEXT REFERENCES actor(id),
    CHECK (token_sha256 IS NULL OR length(token_sha256) = 32),
    CHECK ((token_sha256 IS NULL) = (id = 'actor_00000000000000000000000000')),
    CHECK ((registered_by IS NULL) = (id = 'actor_00000000000000000000000000')),
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
  ) STRICT
  ```

  The bootstrap id is written as a **frozen SQL literal**, not interpolated from `bootstrapActorId`. An applied migration is a historical artifact and its bytes must never change, so it must not read a constant a later epic could edit. The test below asserts the **current `bootstrapActorId` still equals the frozen literal**; the direction matters — a future divergence is a defect in the domain change, and the fix is to revert the constant, never to edit migration 0005.

- Statement 2 is `INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES ('actor_00000000000000000000000000', 'human', 'bootstrap', NULL, NULL, 0, NULL, NULL)`.
- `eventTableDdl` is the DDL of `src/services/storage/migration-0003-execution-and-journal.ts:146-154` with two changes and nothing else:

  ```sql
  CREATE TABLE event (
    id           TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    type         TEXT NOT NULL,
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'daemon', 'harness')),
    actor_id     TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    CHECK (actor_kind <> 'harness' OR actor_id LIKE 'actor\_%' ESCAPE '\')
  ) STRICT
  ```

- Statement 5 is `INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event_old`. Every column is named on both sides; no `SELECT *`.
- Register the migration in `src/services/storage/migrations.ts`: import `migration0005Actor` at `:6` and append it to the array at `:11`, after `migration0004EventIndexes`.
- Create `docs/proposal/database/actor.md`, following the template of `docs/proposal/database/provider.md`: an `# actor` title, a `**Question it answers:**` line, one ` ```sql ` fence holding `actorTableDdl` with a trailing `;` and one `--` comment per column, then the prose sections, then an `## Example` fence. `test/helpers/proposal.ts:29-42` strips `--` comments before comparison, so the inline comments are free.
- `docs/proposal/database/event.md:11`: change the `CHECK (actor_kind IN ('human', 'daemon'))` to `CHECK (actor_kind IN ('human', 'daemon', 'harness'))` and add the `CHECK (actor_kind <> 'harness' OR actor_id LIKE 'actor\_%' ESCAPE '\')` line, so the fence matches `eventTableDdl`.
- `docs/proposal/database/README.md`: add `actor.md` to its table of tables, in the position the file's existing order implies.
- `docs/proposal/database/migration.md`: add the row for `0005-actor`, following the shape of the existing `0003-execution-and-journal` row. A test below asserts the document names it.

## Constraints

- SQLite cannot alter a `CHECK`, so the rebuild is the only mechanism. Do not attempt `ALTER TABLE ... ADD CONSTRAINT`.
- **No `event.actor_id` value is rewritten.** Statement 5 copies every column verbatim. A phase-1 human name such as `ulrich` survives byte-identically, and a database whose configured name changed over its life keeps both names. Do not invent a legacy actor row and do not add a legacy attribution column.
- The `harness` `CHECK` binds `harness` rows only, and no legacy `harness` row can exist, so every copied row passes. Do not add a `CHECK` that constrains a `human` or `daemon` `actor_id`.
- `PRAGMA foreign_keys = ON` is set at `src/services/storage/connection.ts:8`. `actor.registered_by` and `actor.revoked_by` are self-references on a table created in statement 1, and the bootstrap row sets both to `NULL`, so statement 2 violates nothing. `event` holds no foreign key, so statements 3 to 6 need no `defer_foreign_keys`.
- `runInTransaction` at `src/services/storage/sqlite.ts:77-85` runs every statement of one migration plus its `migration` row inside one `BEGIN IMMEDIATE`, so the whole nine-statement sequence is atomic. Add no explicit `BEGIN`, `COMMIT` or `SAVEPOINT`.
- The `token_sha256` length `CHECK` must be written as `token_sha256 IS NULL OR length(token_sha256) = 32`. A bare `length(token_sha256) = 32` evaluates to `NULL` for the bootstrap row, which SQLite treats as a pass, so the bare form would work by accident rather than by statement.

## Verify

- `test/helpers/database.ts`: add `export function createStorageAtVersion(version: number): TemporaryStorage`. It builds a `SqliteStorage` exactly as `createMigratedStorage` at `:35-50` does, but passes `migrations.filter((migration) => migration.version <= version)` in place of `migrations`, then calls `storage.migrate()`. This helper does not exist today and Hermetic coverage line 106 requires it. `createMigratedStorage` keeps its present behaviour and signature.
- Create `src/services/storage/migration-0005-actor.test.ts`, suite name `src/services/storage/migration-0005-actor.test`, asserting:
  - `migration0005Actor.version === 5`, `migration0005Actor.name === "0005-actor"`, and `docs/proposal/database/migration.md` includes the string `"0005-actor"`, following the shape of `migration-0003-execution-and-journal.test.ts:417-427`.
  - `migration0005Actor.statements.length === 9`, and the statements appear in the exact order listed above, asserted by `deepEqual` over the normalized array.
  - **The bootstrap-id literal matches the domain constant**: the count of occurrences of `bootstrapActorId` inside `actorTableDdl` is 2, and statement 2 includes `bootstrapActorId`. This is the anti-drift assertion the SQL literal needs.
  - **Parity**: with the normalizer of `migration-0003-execution-and-journal.test.ts:402-407`, `normalize(actorTableDdl)` deep-equals `proposalStatements("actor")` and `normalize(eventTableDdl)` deep-equals `proposalStatements("event")`.
  - **Applies on a version-4 database that already holds event rows.** Build `createStorageAtVersion(4)`, insert four `event` rows directly: two `human` rows with the different bare `actor_id` values `"ulrich"` and `"someone-else"`, one `daemon` row with `actor_id` `"daemon"`, and one more `human` row. Read every row ordered by `id` into an array. Then run the full `migrations` array through a second `SqliteStorage` on the **same file path** and call `migrate()`. Assert the row count is equal, and assert the read-back array is deep-equal to the pre-migration array, so every `actor_id` is byte-identical and both legacy human names survive.
  - **The `actor` table holds exactly the bootstrap row** after migration: one row, `id` equal to `bootstrapActorId`, `kind` `"human"`, `name` `"bootstrap"`, `token_sha256` `null`, `registered_by` `null`, `created_at` `0`, `revoked_at` `null`, `revoked_by` `null`.
  - **The rebuilt `event` table refuses a bad harness row at the database level**: a direct `INSERT` of `actor_kind = 'harness'` with `actor_id = 'ulrich'` throws; the same insert with `actor_id = 'actor_' + <ulid>` succeeds; and an insert of `actor_kind = 'human'` with the bare `actor_id = 'ulrich'` succeeds. Assert the throw with `assert.throws`.
  - **The `actor` table refuses each `CHECK` violation**: a non-bootstrap row with a `null` `token_sha256`; a non-bootstrap row with a `null` `registered_by`; a `token_sha256` of 31 bytes; a `revoked_at` set with `revoked_by` `null`; a `kind` of `'daemon'`; and a duplicate `name`. Six `assert.throws` cases.
  - **An injected failure after the event drop rolls the whole migration back.** Build `createStorageAtVersion(4)`, then construct a `SqliteStorage` over the same path with a migration list whose fifth entry is `migration0005Actor` with one extra tenth statement that is deliberately invalid SQL, such as `"SELECT this_column_does_not_exist FROM event"`. Assert `migrate()` throws a `StorageError` of code `storage-migration-failed`, then assert against the same database: `status().applied` names version 4 as the highest, no `actor` table exists in `sqlite_master`, no `event_old` table exists, the `event` table still holds the original DDL read from `sqlite_master.sql` (it still names only `'human', 'daemon'`), and the pre-inserted event rows are all present.
  - **The three migration-0004 indexes exist after the rebuild**, read from `sqlite_master` with the query of `migration-0004-event-indexes.test.ts:24-32`, deep-equal to `["event_actor", "event_subject", "event_type"]`. Also assert no index remains whose `tbl_name` is `event_old`.
- `src/services/storage/migration-0004-event-indexes.test.ts:35-49`: raise the version array to `[1, 2, 3, 4, 5]`, add `"0005-actor"` to the name array, and change the `it(...)` title from `four entries, versions 1 to 4` to `five entries, versions 1 to 5`.
- `src/services/storage/migration-0003-execution-and-journal.test.ts`: in `"the table inventory maps to the nineteen names in order"` at `:464`, add `"actor"` as the first entry of the sorted list and change the title to `twenty names`. In `"all eighteen product tables are STRICT"` at `:500`, raise the count and change the title to `nineteen`. Check the whole file for any further pinned table count.
- Run `node --test --test-timeout=60000 src/services/storage/migration-0005-actor.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/domain/rows.test.ts`; each exits 0.
- `npm run verify` exits 0. It ends with `node scripts/verify-db-status.ts`, which migrates a real home, so a broken migration fails there too.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 106, 107, 108, 109 and 110.
