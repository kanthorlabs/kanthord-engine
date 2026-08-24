# Story 01 — Connection and pragmas

Epic: `.agents/plan/epics/003-storage.md`
Depends on: EPIC 002 Story 11 (`src/services/storage/index.ts`).

## Change

### 1. `src/services/storage/connection.ts` (new)

```ts
import { DatabaseSync } from "node:sqlite";

import type { Transaction } from "./index.ts";
import { StorageError } from "./index.ts";

export const pragmas = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = FULL",
  "PRAGMA busy_timeout = 5000",
] as const;

export function openDatabase(path: string): DatabaseSync;

export function runInTransaction<T>(
  database: DatabaseSync,
  work: (transaction: Transaction) => T,
): T;
```

#### `openDatabase(path)`

1. `const database = new DatabaseSync(path);`
2. In a `try`, call `database.exec(statement)` for every entry of `pragmas` in array order.
3. On a throw: `try { database.close(); } catch { /* the pragma error wins */ }`, then rethrow the pragma error. A half-configured handle is never returned and never leaked.
4. Return the database. It creates no table and reads nothing.

#### `runInTransaction(database, work)`

The lifecycle, exactly. `open` is a closure flag, `true` between `BEGIN` and the end of `COMMIT` or `ROLLBACK`.

1. `database.exec("BEGIN IMMEDIATE")` inside a `try`. A throw becomes a `StorageError` of code `storage-transaction-failed`, message `begin failed: <message>`, and `cause` set to the caught error. Lock contention, a closed connection and an already-open native transaction all land here.
2. `const result = work(context)` inside a `try`.
3. **A throw from `work`** — set `open = false`, then `try { database.exec("ROLLBACK"); } catch { /* the work error wins */ }`, then rethrow **the original error object**, unwrapped, with no `cause` rewriting. A rolled-back connection is not treated as poisoned: SQLite leaves it usable, and a poison flag would add a state nothing observes.
4. **A thenable result** — when `result` is a non-null object or a function with a callable `then` property, set `open = false`, roll back the same way as step 3, and throw `new StorageError("storage-transaction-failed", "transact work must be synchronous")`. `T` is unconstrained, so an `async` callback would otherwise commit before its first `await` resumed and then write through a closed context.
5. `database.exec("COMMIT")` inside a `try`. On a throw: `try { database.exec("ROLLBACK"); } catch { /* the commit error wins */ }`, then throw a `StorageError` of code `storage-transaction-failed`, message `commit failed: <message>`, and `cause` set to the caught error.
6. Set `open = false` and return `result`.

`context` is an object literal with the three methods of `Transaction`. Each one first throws `new StorageError("storage-transaction-failed", "the transaction is closed")` when `open` is `false`, so a retained context cannot write after the commit:

- `run(sql, parameters = [])` — `database.prepare(sql).run(...parameters)`, returns nothing.
- `get(sql, parameters = [])` — returns `database.prepare(sql).get(...parameters)`, which is `undefined` when no row matches.
- `all(sql, parameters = [])` — returns `database.prepare(sql).all(...parameters)`.

`node:sqlite` types the bound values as `SQLInputValue`, and the interface declares `readonly unknown[]`. Cast at the spread site — `...(parameters as never[])` — and nowhere else.

## Constraints

- The pragma order is the array order. `journal_mode` is first, because it is the one pragma that writes to the database file.
- No file in this story creates the `migration` table, opens a home lock, or reads configuration. `openDatabase` takes a path.
- `src/services/storage/index.ts` is not modified. Its `Transaction`, `StorageError` and `StorageErrorCode` are already fixed by EPIC 002 Story 11.
- **The error contract, stated once and inherited by every later story.** `storage-transaction-failed` covers exactly five conditions, and nothing else produces it: a failed `BEGIN`, a failed `COMMIT`, a thenable result, a call on a closed context, and the nested-transaction guard of Story 02. An error thrown by `work` — including a SQLite constraint error raised inside `transaction.run` — reaches the caller **unwrapped**, because a command must be able to catch its own error and a constraint failure is the database answering that command rather than the transaction primitive failing.

## Verify

`node --test src/services/storage/connection.test.ts` — new file, one suite named `"src/services/storage/connection.test"`. Every case builds its path with `createTemporaryDatabase()` from `test/helpers/database.ts` and calls `dispose()` after.

- `pragmas` deep-equals the four literal strings above, in that order.
- After `openDatabase(path)`, each pragma is read back through `Object.values({ ...row })[0]` rather than by column name, because `PRAGMA busy_timeout` answers in a column named `timeout` while the other three answer in a column named after the pragma:
  - `PRAGMA journal_mode` is `"wal"` — a file, never `:memory:`, which answers `"memory"`.
  - `PRAGMA foreign_keys` is `1`.
  - `PRAGMA synchronous` is `2`.
  - `PRAGMA busy_timeout` is `5000`.
  - The write-ahead file `<path>-wal` exists after one `CREATE TABLE`, checked with `fs.existsSync`.
- Commit: `runInTransaction(database, (t) => { t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT"); t.run("INSERT INTO a (id) VALUES (?)", ["x"]); return 42; })` returns `42`. The row is then counted through `database.prepare("SELECT COUNT(*) AS c FROM a").get()`, **not** through the transaction context — the context is out of its lifetime.
- Rollback: a `work` that inserts one row and then throws `new Error("boom")` — `assert.throws` catches an error whose `message` is exactly `"boom"`, which is not a `StorageError`, and which has no `cause`. `SELECT COUNT(*) AS c FROM a` through the database is then `0`.
- A constraint error inside `work` reaches the caller unwrapped: inserting a duplicate primary key throws an error that is not a `StorageError` and whose `errcode & 0xff` is `19`.
- The closed context: capture the context out of a committed `runInTransaction`, then each of `run`, `get` and `all` throws a `StorageError` with `code === "storage-transaction-failed"` and message `"the transaction is closed"`. A loop over the three method names drives it. Repeat once for a context captured out of a rolled-back call.
- A thenable result: `runInTransaction(database, () => Promise.resolve(1))` throws a `StorageError` with message `"transact work must be synchronous"`, and a row inserted before the return is rolled back. A second case returns `{ then: 1 }` — a non-callable `then` — and commits normally.
- A failed `BEGIN`: call `runInTransaction` on a database already inside `database.exec("BEGIN IMMEDIATE")`. It throws a `StorageError` with `code === "storage-transaction-failed"`, `message.startsWith("begin failed:")`, and a non-undefined `cause`.
- `get` on an empty table returns `undefined`.
- Foreign keys are enforced, not merely reported: with `a` and `CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES a(id)) STRICT`, inserting `b` with `a_id = "missing"` throws an error whose `errcode & 0xff` is `19` and whose `message` contains `"FOREIGN KEY constraint failed"`.
- `STRICT` is enforced: inserting the string `"y"` into an `INTEGER NOT NULL` column throws. Assert the throw only; the message text of a type refusal is a property of the bundled SQLite build and carries no `errcode` in the constraint class.
- `openDatabase` leaks nothing on a pragma failure: pass a path to a file whose first bytes are not a SQLite header (write `"not a database"` into the temporary path first). The call throws, and a second `openDatabase` on a fresh path in the same directory succeeds — the failed handle did not hold the directory.

Every row `node:sqlite` returns has a `null` prototype, so `assert.deepEqual(row, { … })` fails on the prototype alone. Spread the row (`{ ...row }`) before every deep comparison in this epic.

`npm run verify` exits 0.

Proof: contributes `src/services/storage/connection.test.ts` to `node --test src/services/storage/**/*.test.ts`.
