# Story 02 — Migration runner

Epic: `.agent/plan/epics/003-storage.md`
Depends on: Story 01 (`src/services/storage/connection.ts`).

## Change

### 1. `src/services/storage/migration.ts` (new)

```ts
export type Migration = Readonly<{
  version: number;
  name: string;
  statements: readonly string[];
}>;
```

The type only. The ordered list is `src/services/storage/migrations.ts`, created by Story 04.

### 2. `src/services/storage/sqlite.ts` (new)

```ts
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "../clock/index.ts";
import type { MigrationStatus, Storage, Transaction } from "./index.ts";
import { StorageError } from "./index.ts";
import type { Migration } from "./migration.ts";
import { openDatabase, runInTransaction } from "./connection.ts";

export type SqliteStorageDependencies = Readonly<{
  path: string;
  clock: Clock;
  migrations: readonly Migration[];
}>;

export class SqliteStorage implements Storage {
  constructor(dependencies: SqliteStorageDependencies);
  transact<T>(work: (transaction: Transaction) => T): T;
  migrate(): MigrationStatus;
  status(): MigrationStatus;
  close(): void;
}
```

The constructor validates the migration list, then calls `openDatabase(dependencies.path)` once and holds the `DatabaseSync` in a private field. The connection never leaves the capability.

Exact behaviour.

- **List validation, in the constructor, before the database is opened.** Every `version` is a positive safe integer, and no two entries share one. A violation throws a `StorageError` of code `storage-migration-failed`, with the message `the migration list is invalid: <detail>`, where `<detail>` is `version <value> is not a positive integer` or `version <value> appears twice`. Validating here means an invalid list can never touch a database.
- **`private assertIdle()`** — throws `new StorageError("storage-transaction-failed", "a transaction is already open")` when a `transact` call is in flight. `transact`, `migrate` and `status` each call it first. Without it, `migrate()` reached from inside a `transact` callback would start a second native transaction, and `status()` would run DDL inside the caller's transaction.
- **`private assertOpen()`** — throws `new StorageError("storage-transaction-failed", "the storage is closed")` after `close()`. `transact`, `migrate` and `status` each call it first.
- **`private ensureMigrationTable()`** — `database.exec("CREATE TABLE IF NOT EXISTS migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT")`. Called by both `migrate()` and `status()`. **`status()` therefore writes**: it bootstraps the table on a first call and fails on a read-only database. That is deliberate — the alternative is a `status()` that answers "no migration table" as a fourth state — and it is stated here so no later story treats `status()` as observational.
- **`transact(work)`** — `assertOpen()`, `assertIdle()`, set the in-flight flag, delegate to `runInTransaction(this.database, work)`, clear the flag in a `finally`.
- **`migrate()`**:
  1. `assertOpen()`, `assertIdle()`, `ensureMigrationTable()`.
  2. Read the applied rows: `SELECT version, name FROM migration ORDER BY version ASC`.
  3. **Refuse an unknown applied version.** An applied version absent from `dependencies.migrations` throws a `StorageError` of code `storage-migration-failed`, with the message `the database holds migration <version> <name>, which this binary does not know`. That is an older binary against a database a newer binary wrote, which is exactly when a schema assumption may be wrong. Nothing is applied.
  4. **Refuse a renamed applied version.** An applied version whose stored `name` differs from the code entry's `name` throws a `StorageError` of code `storage-migration-failed`, with the message `migration <version> is recorded as <storedName> and declared as <declaredName>`. Version alone is not an identity, and a silently edited migration would otherwise pass as idempotent.
  5. Walk `dependencies.migrations` sorted by `version` ascending, skipping an applied version.
  6. For each remaining migration, one `runInTransaction`: run every entry of `statements` in array order through `transaction.run(statement)`, then `transaction.run("INSERT INTO migration (version, name, applied_at) VALUES (?, ?, ?)", [version, name, clock.now()])`.
  7. A throw inside step 6 leaves that migration's transaction rolled back. Catch it and throw a `StorageError` of code `storage-migration-failed`, with the message `migration <version> <name> failed: <message>` and `cause` set to the caught error. Later migrations are not attempted.
  8. Return `this.status()`.
- **`status()`**:
  - `assertOpen()`, `assertIdle()`, `ensureMigrationTable()`.
  - `applied` — `SELECT version, name, applied_at FROM migration ORDER BY version ASC`, mapped to `{ version, name, appliedAt }`. An unknown version appears here, because `status()` reports what the database holds and refuses nothing.
  - `pending` — every entry of `dependencies.migrations` whose `version` has no row, sorted by `version` ascending, mapped to `{ version, name }`.
- **`close()`** — returns at once when already closed. Otherwise it marks the instance closed **before** calling `database.close()`, so a throw from `close()` cannot leave an instance that reports itself open. The throw propagates, and a second `close()` is a no-op.

`clock.now()` is called exactly once per newly applied migration, and nowhere else in this class.

## Constraints

- One transaction per migration, never one for all of them. A failed third migration leaves the first two applied.
- `migrate()` writes nothing when every version is already applied, and it calls `clock.now()` zero times in that case.
- **Concurrency is the caller's, and the caller is the home lock.** `migrate()` reads the applied set and then applies, and two processes could otherwise both decide the same version is pending and race on the DDL or on the `migration` insert — `busy_timeout` serialises the writes but not the stale decision. Every caller holds the exclusive home lock of EPIC 001 for the whole operation: `kanthord db migrate` acquires it in Story 03, and the daemon holds it for the life of the process. This class adds no lock of its own, and the assumption is written here rather than assumed.
- No file in this story names a table of the product schema. The DDL arrives in Stories 04, 05 and 06.
- `src/services/storage/index.ts` is not modified.
- A migration checksum is **not** added. It would catch an edited statement list that keeps its name, which the name check does not. The `migration` table of `docs/proposal/database/migration.md:6-10` has three columns and no checksum column, so adding one is a proposal amendment rather than a story. Recorded as open item S4 in `index.md`.

## Verify

`node --test src/services/storage/sqlite.test.ts` — new file, one suite named `"src/services/storage/sqlite.test"`.

Fixtures declared at the top of the file, and used by every case:

```ts
const alpha: Migration = {
  version: 1,
  name: "0001-alpha",
  statements: ["CREATE TABLE alpha (id TEXT PRIMARY KEY) STRICT"],
};
const beta: Migration = {
  version: 2,
  name: "0002-beta",
  statements: [
    "CREATE TABLE beta (id TEXT PRIMARY KEY) STRICT",
    "INSERT INTO beta (id) VALUES ('b1')",
  ],
};
const broken: Migration = {
  version: 3,
  name: "0003-broken",
  statements: [
    "CREATE TABLE gamma (id TEXT PRIMARY KEY) STRICT",
    "INSERT INTO gamma (id) VALUES",
  ],
};
```

Every case builds its path with `createTemporaryDatabase()` and its clock with `createMockClock({ start: 1700000000000, step: 1000 })` from `test/helpers/clock.ts`.

- On a fresh file, `status()` deep-equals `{ applied: [], pending: [{ version: 1, name: "0001-alpha" }, { version: 2, name: "0002-beta" }] }`.
- `migrate()` returns `applied` deep-equal to `[{ version: 1, name: "0001-alpha", appliedAt: 1700000000000 }, { version: 2, name: "0002-beta", appliedAt: 1700000001000 }]` and `pending` deep-equal to `[]`.
- Idempotence: `close()`, then a second `SqliteStorage` over the **same path** with `createMockClock({ start: 9000000000000 })`. Its `migrate()` returns exactly the same `applied` array as above — both `appliedAt` values are still `1700000000000` and `1700000001000` — and `pending` is `[]`. `SELECT COUNT(*) AS c FROM migration` returns `c === 2`.
- Ordering is by version and not by array order: a storage built with `[beta, alpha]` applies `alpha` first — `appliedAt` on version 1 is `1700000000000`.
- Failure: a storage built with `[alpha, beta, broken]` throws from `migrate()`. The thrown error satisfies `error instanceof StorageError`, `error.code === "storage-migration-failed"`, `error.message.startsWith("migration 3 0003-broken failed:")`, and `error.cause` is not `undefined`. After the throw, `status().applied` maps to versions `[1, 2]`, and `SELECT name FROM sqlite_master WHERE name = 'gamma'` returns `undefined` — the whole third migration rolled back.
- An unknown applied version is refused: after `migrate()` with `[alpha, beta]`, insert `(99, '0099-unknown', 5)` into `migration` through `transact`. A new storage over the same path with `[alpha, beta]` throws from `migrate()` with `code === "storage-migration-failed"` and message `"the database holds migration 99 0099-unknown, which this binary does not know"`. Its `status()` still answers, with `applied` mapping to versions `[1, 2, 99]` and `pending` deep-equal to `[]`.
- A renamed applied version is refused: after `migrate()` with `[alpha]`, a new storage over the same path with `[{ ...alpha, name: "0001-renamed" }]` throws from `migrate()` with message `"migration 1 is recorded as 0001-alpha and declared as 0001-renamed"`.
- List validation, each case constructing the storage and asserting the throw with `code === "storage-migration-failed"`:
  - `[alpha, { ...beta, version: 1 }]` — message `"the migration list is invalid: version 1 appears twice"`.
  - `[{ ...alpha, version: 0 }]` and `[{ ...alpha, version: -1 }]` and `[{ ...alpha, version: 1.5 }]` — message `` `the migration list is invalid: version ${value} is not a positive integer` ``.
  - An invalid list creates no file: `fs.existsSync(path)` is `false` after the throw.
- `transact` commits and returns the value of `work`, and rolls back on a throw — one case each against the `alpha` table.
- The idle guard, all three entry points: inside a `transact` callback, each of `storage.transact(() => 0)`, `storage.migrate()` and `storage.status()` throws a `StorageError` with `code === "storage-transaction-failed"` and message `"a transaction is already open"`. A loop over the three drives it. The outer transaction still commits its own row after the inner calls are caught.
- The closed guard: after `close()`, each of `transact`, `migrate` and `status` throws a `StorageError` with message `"the storage is closed"`.
- `close()` called twice does not throw.

`npm run verify` exits 0.

Proof: contributes `src/services/storage/sqlite.test.ts` to `node --test src/services/storage/**/*.test.ts`.
