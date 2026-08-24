# Story 2 — Migration 0006 and the revision provenance DDL

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: Story 1 (`docs/proposal/database/plan_revision.md` carries the amended fence). Depends on EPIC 015 Story 3 (`migration-0005-actor.ts` exports `migration0005Actor` at version 5).

## Change

### A new `src/services/storage/migration-0006-revision-origin.ts`

Export one constant, in the shape of `src/services/storage/migration-0004-event-indexes.ts`:

```ts
export const migration0006RevisionOrigin: Migration = {
  version: 6,
  name: "0006-revision-origin",
  statements: [/* the seven statements below, in this order */],
};
```

`statements` holds exactly these seven entries, in this order. `src/services/storage/sqlite.ts:78-80` runs each through `transaction.run`, which is `database.prepare(sql).run(...)`, so each entry is exactly one SQL statement.

1. `PRAGMA defer_foreign_keys = ON`
2. `PRAGMA legacy_alter_table = ON`
3. `ALTER TABLE plan_revision RENAME TO plan_revision_old`
4. The `CREATE TABLE plan_revision` statement below, verbatim.
5. The `INSERT INTO plan_revision ... SELECT ... FROM plan_revision_old` statement below, verbatim.
6. `DROP TABLE plan_revision_old`
7. `PRAGMA legacy_alter_table = OFF`

Statement 4:

```sql
CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES plan_revision(id),
  origin TEXT NOT NULL CHECK (origin IN ('import', 'node-write')),
  import_id TEXT,
  submitted_blob TEXT REFERENCES blob(hash),
  choices_blob TEXT REFERENCES blob(hash),
  accepted_blob TEXT NOT NULL REFERENCES blob(hash),
  UNIQUE (project_id, import_id),
  CHECK ((origin = 'import') = (import_id IS NOT NULL)),
  CHECK ((origin = 'import') = (submitted_blob IS NOT NULL)),
  CHECK ((origin = 'import') = (choices_blob IS NOT NULL))
) STRICT
```

Statement 5:

```sql
INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) SELECT id, project_id, parent_id, 'import', import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision_old
```

Why each pragma is load-bearing:

- `PRAGMA foreign_keys` is a no-op inside an open transaction, and `src/services/storage/connection.ts:35` opens `BEGIN IMMEDIATE` before the first statement. `defer_foreign_keys` is the one pragma that defers enforcement to commit inside an open transaction. It resets at commit and needs no `OFF` statement.
- With `legacy_alter_table` off, the rename at step 3 rewrites every referencing schema, so `node.revision` at `src/services/storage/migration-0002-graph-and-plan.ts:30` would repoint at `plan_revision_old`. With the pragma on, the rename leaves the `node` schema text unchanged, and step 4 recreates the name `node.revision` already references.

There is no down migration. `src/services/storage/migration.ts` declares `version`, `name` and `statements` only, so the guarantee is transactional rollback plus a lossless forward migration.

### `src/services/storage/migrations.ts`

Add the import after the `migration-0005-actor.ts` import of EPIC 015, and append the constant to the array after `migration0005Actor`.

## Constraints

- Do not change `src/services/storage/migration-0002-graph-and-plan.ts`. The version-2 DDL is history and stays byte-identical.
- Do not add a `plan_revision` index. The table carries none today.
- Do not write a down migration and do not add a field to `Migration`.
- Change no file under `src/services/plan/`. Story 4 owns the store.
- `UNIQUE (project_id, import_id)` stays. SQLite treats two `NULL` values as distinct in a `UNIQUE` index, so many `node-write` rows coexist under one project.
- **The three separate `CHECK` clauses are correct and stay three.** Do not collapse them into one conjunction to match the zod refine message of EPIC 014 Story 9: a combined clause would admit a partially populated `node-write` row on some SQLite evaluation orders. One clause per column refuses it on every order. `014-external-drive-contract/09-revision-provenance.md` and `.agents/plan/epics/014-external-drive-contract.md:30,101` both state this relation, and no test compares the refine message with a `CHECK`.
- Column order in statement 4 is normative: `origin` sits between `parent_id` and `import_id`, matching the field order EPIC 014 Story 9 put in `src/domain/plan-revision.ts`.

## Verify

Create `src/services/storage/migration-0006-revision-origin.test.ts`, suite name `src/services/storage/migration-0006-revision-origin.test`. Build a database at version 5 by handing `SqliteStorage` a truncated migration array, in the pattern of `src/services/storage/migration-0002-graph-and-plan.test.ts:50-63`. Assert each of these.

- `migration0006RevisionOrigin.version === 6` and `migration0006RevisionOrigin.name === "0006-revision-origin"`.
- `migrations` holds six entries; `migrations.map((m) => m.version)` deep-equals `[1, 2, 3, 4, 5, 6]` and `migrations.map((m) => m.name)` deep-equals the six names in order.
- `statements.length === 7`, and each statement equals the text above, compared after collapsing every whitespace run to one space.
- Applies on a version-5 database holding two `plan_revision` rows and the `node` rows that reference them: the `plan_revision` row count is equal before and after, every copied row carries `origin = 'import'`, every other column of every row is byte-identical before and after, every `node.revision` resolves to a `plan_revision` row, and every non-null `plan_revision.parent_id` resolves to a `plan_revision` row.
- `PRAGMA foreign_key_check` returns no row after the migration commits.
- The `node` table schema text in `sqlite_master` is byte-identical before and after the migration.
- No `plan_revision_old` table is present in `sqlite_master` after the migration.
- Injected failure after statement 5 leaves the database at version 5 with the original `plan_revision` table, no `plan_revision_old` table and every `node` row intact. Inject by constructing `SqliteStorage` with a migration whose `statements` are statements 1 to 5 followed by one statement that throws, at `version: 6`, and asserting the thrown `StorageError` carries the code `storage-migration-failed`.
- **The same failure test asserts `PRAGMA legacy_alter_table` returns `0` afterwards.** `legacy_alter_table` is connection-scoped, not transaction-scoped: a failure between statement 2 and statement 7 rolls the data back but leaves the pragma on, and `SqliteStorage.migrate()` at `src/services/storage/sqlite.ts:86-94` catches and rethrows without closing the connection. Assert it explicitly. If the assertion fails, the fix is in this story: move statement 7 out of the failure window by resetting the pragma in the `catch` branch of `migrate()`, or split the pragma out of `statements` entirely. Do not leave the leak unasserted, and do not weaken the assertion — `defer_foreign_keys` needs no such check, because it does reset at commit.
- Six constraint refusals at the database level, one per column per direction, asserted through the `assertRefused` helper shape of `src/services/storage/migration-0002-graph-and-plan.test.ts:72-93`: a `node-write` row carrying an `import_id`, a `submitted_blob` or a `choices_blob` is refused; an `import` row omitting `import_id`, `submitted_blob` or `choices_blob` is refused.
- An `origin` outside the two values is refused.
- An `accepted_blob` of `NULL` is refused under both origins.
- Two `node-write` rows under one project both insert, proving `UNIQUE (project_id, import_id)` admits repeated nulls.
- `node --test src/services/storage/migration-0006-revision-origin.test.ts` exits 0.
- Proof: `PASS EPIC-017`, through `src/services/storage/migration-0006-revision-origin.test.ts`. Hermetic coverage bullets `.agents/plan/epics/017-per-node-graph-write.md:137`, `:138`, `:139`, `:140` and `:141`.
