# Story 3 — Migration 0007, the foreign-key-safe rebuild

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 2. **Coupled with Story 2 and Story 4.**

## Change

### The new file

One new file `src/services/storage/migration-0007-external-execution.ts`, exporting `migration0007ExternalExecution` of type `Migration` from `src/services/storage/migration.ts`, with `version: 7` and `name: "0007-external-execution"`. Mirror the shape of `src/services/storage/migration-0003-execution-and-journal.ts:3-6`: an object literal with `version`, `name` and `statements`.

Register it in `src/services/storage/migrations.ts`. The import list at `:1-5` gains one line, and the array at `:7-12` gains `migration0007ExternalExecution` as the **last** member, after `migration0006RevisionOrigin` of EPIC 017. `src/services/storage/sqlite.ts:70-72` sorts by version before it applies, so the array order is documentation and the version number is the total order.

### The migration runner gains a rebuild mode

**Do this part first.** A rebuild cannot be expressed as a statement list, and three spiked facts fix the mechanism. Each was verified against `node:sqlite` on SQLite 3.53.0:

- `PRAGMA foreign_keys` is a **no-op inside an open transaction**. Setting it after `BEGIN` leaves it at `1`.
- While foreign keys are enabled, `ALTER TABLE run RENAME TO run_old` rewrites `attempt.run_id` to `REFERENCES "run_old"(id)` **even under `PRAGMA legacy_alter_table = ON`**. That is exactly the outcome the rename-first shape exists to prevent. `PRAGMA defer_foreign_keys` does not help: it defers the check, not the rewrite.
- `PRAGMA legacy_alter_table` is **connection state, not transaction state**. It reads `1` after a `ROLLBACK`, so a trailing `= OFF` statement never runs on the failure path and every later migration and query on that connection stays in legacy mode.

The only recipe that leaves a child table's text unmoved is `PRAGMA foreign_keys = OFF` **before** `BEGIN`, with `PRAGMA legacy_alter_table = ON`. Make two edits:

`src/services/storage/migration.ts:1-5` gains one optional member:

```ts
export type Migration = Readonly<{
  version: number;
  name: string;
  statements: readonly string[];
  rebuild?: true;
}>;
```

`src/services/storage/sqlite.ts:76-85` wraps the per-migration `runInTransaction` call. When `migration.rebuild === true`, and **only** then:

1. Before `runInTransaction`, run `PRAGMA foreign_keys = OFF` then `PRAGMA legacy_alter_table = ON` on the database handle directly.
2. Call `runInTransaction` exactly as it is called today.
3. In a `finally`, run `PRAGMA legacy_alter_table = OFF` then `PRAGMA foreign_keys = ON`. The `finally` is what makes a failed rebuild leave the connection as it found it.

A migration with no `rebuild` member takes today's path byte for byte, so migrations 0001 to 0004 are unaffected. The `finally` restores the two pragmas to the values `src/services/storage/connection.ts:6-10` establishes, and never to a value it merely assumes: read neither pragma back, and write the two literals.

**EPIC 017's migration 0006 needs the identical mechanism** and `.agent/plan/epics/017-per-node-graph-write.md` now says so. Whichever epic lands first ships this runner change; the second consumes it and adds no second mechanism. When `rebuild` already exists on `Migration` when this story runs, skip this section and assert the behaviour is the one described above.

### `statements`, in this exact order

Eleven statements, in this order and no other. **No statement is a pragma**: the runner owns both.

1. `ALTER TABLE run RENAME TO run_old`
2. `ALTER TABLE attempt RENAME TO attempt_old`
3. `ALTER TABLE lease RENAME TO lease_old`
4. `DROP INDEX run_one_active`
5. `CREATE TABLE run (...)` — the final DDL, identical to the `run` fence Story 2 wrote.
6. `CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'`
7. `CREATE TABLE attempt (...)` — the final DDL, identical to the `attempt` fence Story 2 wrote.
8. `CREATE TABLE lease (...)` — the final DDL, identical to the `lease` fence Story 2 wrote.
9. the `run` copy
10. the `attempt` copy
11. the `lease` copy
12. `DROP TABLE attempt_old`
13. `DROP TABLE run_old`
14. `DROP TABLE lease_old`

That is fourteen. Add no fifteenth, and add no pragma.

**Step 4 is load-bearing.** An index name is global in SQLite, and an index follows its table through a rename, so after step 1 the old `run_one_active` still owns the name while sitting on `run_old`. Without step 4, step 6 fails with `index run_one_active already exists` — spiked and confirmed. Step 4 sits after the renames so the drop names the index unambiguously.

The migration declares `rebuild: true`.

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

- Steps 1 to 3 rename under the runner's `foreign_keys = OFF` plus `legacy_alter_table = ON`, so no child table text moves. Five tables reference the rebuilt pair: `attempt.run_id` at `src/services/storage/migration-0003-execution-and-journal.ts:49`, `agent_invocation.attempt_id` at `:63`, `candidate.run_id` at `:80`, `check_result.run_id` at `:107` and `git_operation.run_id` at `:132`.
- Step 4 frees the globally unique index name, per the spiked fact above.
- Step 6 recreates the index on the new table.
- Steps 12 to 14 drop child before parent.
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
- The `rebuild` branch in `src/services/storage/sqlite.ts` changes the path of a migration with no `rebuild` member in no way. Migrations 0001 to 0004 keep today's behaviour byte for byte.
- Put no pragma in `statements`, and restore no pragma from inside the transaction.
- Edit no `src/domain/` file. EPIC 014 owns `runRow`, `attemptRow` and `leaseRow`.
- Add no index other than the recreated `run_one_active`.

## Verify

New test file `src/services/storage/migration-0007-external-execution.test.ts`. It builds a database migrated to version 6 with a full referencing fixture, then applies migration 0007. Follow the fixture and helper conventions of `src/services/storage/migration-0003-execution-and-journal.test.ts`.

The fixture holds **one row in every referencing table**: a `workspace`, a `run`, an `attempt`, an `agent_invocation`, a `candidate`, a `check_result`, a `git_operation` and a `lease` whose `owner` is not null. Build it from the seeded `project`, `repository`, `node`, `blob` and `provider` rows the migration-0003 suite already seeds.

Assertions, each its own `it`:

- `migration0007ExternalExecution carries version 7, its name and rebuild true` — `version` is `7`, `name` is `0007-external-execution`, and `rebuild` is `true`.
- `the statements hold no pragma at all` — assert no member of `statements` includes the literal `PRAGMA`. The runner owns both pragmas.
- `the statements hold fourteen members in the declared order` — assert the length is `14` and assert the leading keyword of each member in order: three `ALTER TABLE`, one `DROP INDEX`, `CREATE TABLE`, `CREATE UNIQUE INDEX`, two `CREATE TABLE`, three `INSERT INTO`, three `DROP TABLE`.
- `the index name is freed before it is recreated` — assert the `DROP INDEX run_one_active` member appears at an index **lower** than the `CREATE UNIQUE INDEX run_one_active` member. Then, as a live proof of why: run the fourteen statements with the `DROP INDEX` member removed and assert the run throws with a message including `already exists`.
- `a rebuild migration restores both pragmas on the success path` — after `storage.migrate()` completes, assert `PRAGMA foreign_keys` reads `1` and `PRAGMA legacy_alter_table` reads `0` on the same connection.
- `every row of every referencing table survives the rebuild` — the row count of `workspace`, `run`, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation` and `lease` is equal before and after, asserted per table.
- `every copied run and attempt row carries driver internal` — read both tables and assert `driver` is `internal` on every row.
- `every non-null-owner lease row carries owner_kind daemon` — assert `owner_kind` is `daemon` on the fixture row, and assert a lease row with a null `owner` carries a null `owner_kind`.
- `PRAGMA foreign_key_check returns no row after the migration commits` — assert the result array is empty.
- `no child table REFERENCES clause moved` — read the DDL of `attempt`, `agent_invocation`, `candidate`, `check_result` and `git_operation` from `sqlite_master` and assert each names `run` or `attempt` and **no name ending in `_old`**. This is the assertion that catches the pragma recipe silently reverting: with foreign keys enabled the rename rewrites these clauses, and every other assertion in this file still passes.
- `an injected failure immediately after the copy leaves the database at version 6` — construct a `Migration` with `version: 7`, `rebuild: true`, and `statements` equal to the first **eleven** members above, then the literal statement `INSERT INTO no_such_table VALUES (1)`, then the last three members. The failure therefore lands **after the three copies and before the three drops**, which is the point the sequence is most exposed. Do not append the failing statement at the end: that path never exercises a rollback with `_old` tables still present. Assert:
  - `migration` holds no version-7 row;
  - `sqlite_master` holds `run`, `attempt` and `lease` with the **version-3** DDL, compared against the three historical constants Story 4 declares;
  - `sqlite_master` holds no name ending in `_old`, asserted with `SELECT count(*) FROM sqlite_master WHERE name LIKE '%\_old' ESCAPE '\'` equal to `0`;
  - `run_one_active` exists and its `tbl_name` is `run`;
  - every dependent row of all seven referencing tables is intact, asserted by row count per table;
  - **`PRAGMA foreign_keys` reads `1` and `PRAGMA legacy_alter_table` reads `0`** on the same connection afterwards. This is the assertion that proves the runner's `finally` runs. `legacy_alter_table` survives a `ROLLBACK`, so without the `finally` this reads `1` and every later migration on that connection silently changes behaviour.
- `a failed rebuild leaves the next migration unaffected` — after the failure above, apply a trivial `version: 8` migration with no `rebuild` member that creates one table, and assert it applies and that its `CREATE TABLE` text in `sqlite_master` is unmodified. A leaked `legacy_alter_table` is invisible until a later rename, so this asserts the leak is closed rather than merely unobserved.
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
