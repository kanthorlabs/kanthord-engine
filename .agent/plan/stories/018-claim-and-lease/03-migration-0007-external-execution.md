# Story 3 — Migration 0007, the foreign-key-safe rebuild

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 2. **Coupled with Story 2 and Story 4.**

## Change

### The new file

One new file `src/services/storage/migration-0007-external-execution.ts`, exporting `migration0007ExternalExecution` of type `Migration` from `src/services/storage/migration.ts`, with `version: 7` and `name: "0007-external-execution"`. Mirror the shape of `src/services/storage/migration-0003-execution-and-journal.ts:3-6`: an object literal with `version`, `name` and `statements`.

Register it in `src/services/storage/migrations.ts`. The import list at `:1-5` gains one line, and the array at `:7-12` gains `migration0007ExternalExecution` as the **last** member, after `migration0006RevisionOrigin` of EPIC 017. `src/services/storage/sqlite.ts:70-72` sorts by version before it applies, so the array order is documentation and the version number is the total order.

### `statements`, in this exact order

Sixteen statements, in this order and no other:

1. `PRAGMA defer_foreign_keys = ON`
2. `PRAGMA legacy_alter_table = ON`
3. `ALTER TABLE run RENAME TO run_old`
4. `ALTER TABLE attempt RENAME TO attempt_old`
5. `ALTER TABLE lease RENAME TO lease_old`
6. `CREATE TABLE run (...)` — the final DDL, identical to the `run` fence Story 2 wrote.
7. `CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'`
8. `CREATE TABLE attempt (...)` — the final DDL, identical to the `attempt` fence Story 2 wrote.
9. `CREATE TABLE lease (...)` — the final DDL, identical to the `lease` fence Story 2 wrote.
10. the `run` copy
11. the `attempt` copy
12. the `lease` copy
13. `DROP TABLE attempt_old`
14. `DROP TABLE run_old`
15. `DROP TABLE lease_old`
16. `PRAGMA legacy_alter_table = OFF`

Add no seventeenth statement. `PRAGMA foreign_keys` appears nowhere in the file: it is a no-op inside a transaction, and `src/services/storage/connection.ts:8` already sets it at connection time.

The three copies, verbatim:

```sql
INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at)
SELECT id, kind, node_id, parent_run_id, 'internal', workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at FROM run_old
```

```sql
INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at)
SELECT id, run_id, 'internal', attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at FROM attempt_old
```

```sql
INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at)
SELECT subject_kind, subject_id, owner, CASE WHEN owner IS NULL THEN NULL ELSE 'daemon' END, fence, acquired_at, renewed_at, expires_at FROM lease_old
```

### Why each step is where it is

- Step 1 defers foreign-key enforcement to commit. It is the only pragma that has an effect inside an open transaction, and `src/services/storage/sqlite.ts:77` runs the whole list inside the `BEGIN IMMEDIATE` of `src/services/storage/connection.ts:35`.
- Step 2 stops the renames from repointing the child tables. With `legacy_alter_table` off, `attempt`, `agent_invocation`, `candidate`, `check_result` and `git_operation` follow the rename to `run_old` and `attempt_old`, which is the opposite of the wanted result. Five tables reference the rebuilt pair: `attempt.run_id` at `src/services/storage/migration-0003-execution-and-journal.ts:49`, `agent_invocation.attempt_id` at `:63`, `candidate.run_id` at `:80`, `check_result.run_id` at `:107` and `git_operation.run_id` at `:132`.
- Step 7 recreates the index because an index follows its table through a rename, so `run_one_active` now sits on `run_old`.
- Steps 13-15 drop child before parent.
- There is no down migration. `Migration` in `src/services/storage/migration.ts` declares none, so the guarantee is transactional rollback plus a lossless forward migration.

### The new columns

`run` gains `driver TEXT NOT NULL CHECK (driver IN ('internal', 'external'))`; `workspace_id`, `worker` and `base_oid` lose `NOT NULL` and gain one clause each, `CHECK ((driver = 'internal') = (<column> IS NOT NULL))`; and `run` gains `UNIQUE (id, driver)`. `head_oid` keeps no driver clause.

`attempt` gains the same `driver` column, four clauses over `provider_id`, `provider_model`, `timeout_ms` and `base_oid`, and `FOREIGN KEY (run_id, driver) REFERENCES run(id, driver)` **beside** its existing `run_id TEXT NOT NULL REFERENCES run(id)`. The composite key is the mechanism that makes an external attempt under an internal run impossible; a table-level `CHECK` cannot read another table. `UNIQUE (id, driver)` on `run` exists so SQLite finds a parent key for it.

`lease` gains `owner_kind TEXT CHECK (owner_kind IS NULL OR owner_kind IN ('daemon', 'actor'))`, `CHECK ((owner IS NULL) = (owner_kind IS NULL))` and `CHECK (owner_kind <> 'actor' OR owner LIKE 'actor\_%' ESCAPE '\')`.

## Constraints

- `CHECK ((kind = 'objective') = (parent_run_id IS NULL))` stays intact and unamended on the rebuilt `run`. Write no driver-aware replacement for it.
- `run_one_active` keeps its exact predicate `WHERE state = 'active'`. Do not add a `driver` predicate here; EPIC 110 owns its own objective index.
- `PRIMARY KEY (id)` on `run` is unchanged. `UNIQUE (id, driver)` is additive.
- Add no table and remove no table. `src/domain/rows.ts:21-41` and therefore `src/services/storage/schema-parity.test.ts` must see the identical key set.
- Edit no other migration file. Migration 0003 keeps its version-3 DDL byte for byte.
- Edit no `src/domain/` file. EPIC 014 owns `runRow`, `attemptRow` and `leaseRow`.
- Add no index other than the recreated `run_one_active`.

## Verify

New test file `src/services/storage/migration-0007-external-execution.test.ts`. It builds a database migrated to version 6 with a full referencing fixture, then applies migration 0007. Follow the fixture and helper conventions of `src/services/storage/migration-0003-execution-and-journal.test.ts`.

The fixture holds **one row in every referencing table**: a `workspace`, a `run`, an `attempt`, an `agent_invocation`, a `candidate`, a `check_result`, a `git_operation` and a `lease` whose `owner` is not null. Build it from the seeded `project`, `repository`, `node`, `blob` and `provider` rows the migration-0003 suite already seeds.

Assertions, each its own `it`:

- `migration0007ExternalExecution carries version 7 and the name migration.md declares` — `version` is `7` and `name` is `0007-external-execution`.
- `the statements hold no PRAGMA foreign_keys` — the joined statement list does not include the literal `PRAGMA foreign_keys`.
- `every row of every referencing table survives the rebuild` — the row count of `workspace`, `run`, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation` and `lease` is equal before and after, asserted per table.
- `every copied run and attempt row carries driver internal` — read both tables and assert `driver` is `internal` on every row.
- `every non-null-owner lease row carries owner_kind daemon` — assert `owner_kind` is `daemon` on the fixture row, and assert a lease row with a null `owner` carries a null `owner_kind`.
- `PRAGMA foreign_key_check returns no row after the migration commits` — assert the result array is empty.
- `an injected failure after the copy leaves the database at version 6` — construct a `Migration` with `version: 7` whose `statements` are the sixteen above plus a seventeenth that throws (`SELECT raise_error`, or a statement against a missing table), apply it, and assert: `migration` holds no version-7 row; `sqlite_master` holds `run`, `attempt` and `lease` with the version-3 DDL; `sqlite_master` holds no name ending in `_old`; and every dependent row is intact.
- `the rebuilt run refuses an external row that carries a workspace_id, a worker or a base_oid` — three inserts, each with exactly one of the three set, each asserted to throw.
- `the rebuilt run refuses an internal row that omits a workspace_id, a worker or a base_oid` — three inserts, each omitting exactly one, each asserted to throw.
- `the rebuilt attempt refuses an external row that carries a provider_id, a provider_model, a timeout_ms or a base_oid` — four inserts, each asserted to throw.
- `the rebuilt attempt refuses an internal row that omits a provider_id, a provider_model, a timeout_ms or a base_oid` — four inserts, each asserted to throw.
- `an external attempt under an internal run is refused by the composite foreign key` — insert an `internal` run, then an `external` attempt naming it, and assert the insert throws. Then the reverse: an `external` run and an `internal` attempt, also asserted to throw. Assert `PRAGMA foreign_keys` reads `1` in the same connection first, so the refusal is attributed to the key and not to a disabled pragma.
- `UNIQUE (id, driver) broke no single-column reference` — insert a `candidate` row through `REFERENCES run(id)` against an `internal` run and assert it succeeds. Then assert `PRAGMA table_info(run)` reports exactly one column with `pk` equal to `1`, and that column is `id`.
- `the rebuilt lease refuses a broken owner pair` — three inserts, each asserted to throw: an owner with a null `owner_kind`; an `owner_kind` with a null `owner`; and `owner_kind = 'actor'` whose `owner` is `daemon_a`. A fourth insert with `owner_kind = 'actor'` and owner `actor_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E` succeeds.
- `run_one_active exists after the rebuild and still refuses a second active run` — read the index DDL from `sqlite_master` and assert it equals the step-7 statement modulo whitespace, then insert a second `active` run on one node and assert it throws.

Run:

- `node --test src/services/storage/migration-0007-external-execution.test.ts src/services/storage/schema-parity.test.ts src/services/storage/sqlite.test.ts` exits 0.
- `src/services/storage/schema-parity.test.ts` needs no edit in this story: `Object.keys(rows)` is unchanged. Story 4 adds the domain-to-DDL parity assertion.
- Proof: `PASS EPIC-018`, through `src/services/storage/migration-0007-external-execution.test.ts` and `src/services/storage/schema-parity.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:174-181`.
