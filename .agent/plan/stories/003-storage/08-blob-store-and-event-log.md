# Story 08 — Blob store and the event log

Epic: `.agent/plan/epics/003-storage.md`
Depends on: Story 06 (`blob` and `event` tables exist), EPIC 002 Story 11 (`src/services/event/index.ts`), EPIC 002 Story 01 (`src/services/ids`, `src/services/clock`), EPIC 002 Story 02 (`src/domain/identity.ts`).

## Change

### 1. `src/domain/identity.ts` — add the ULID timestamp decode

EPIC 002 Story 02 creates this file. Append one export, and change nothing else:

```ts
export function identityTime(value: string): number | null;
```

Exact behaviour: call `parseIdentity(value)`. Return `null` when it returns `null`. Otherwise decode the **first 10 characters** of `identity.ulid` as Crockford base32, most significant character first, over the alphabet `"0123456789ABCDEFGHJKMNPQRSTVWXYZ"`, and return the resulting integer of epoch milliseconds.

The decode is `characters.reduce((total, character) => total * 32 + alphabet.indexOf(character), 0)`. The alphabet constant is module-level and shared with nothing else. No import is added — `src/domain/` stays pure.

### 2. `src/services/blob/index.ts` (new)

`blob` is the thirteenth service capability. `src/services/config/index.ts:1-46` is the interface convention.

```ts
import type { Transaction } from "../storage/index.ts";

export type BlobRecord = Readonly<{
  hash: string;
  size: number;
  content: Uint8Array;
  createdAt: number;
}>;

export type BlobStoreErrorCode = "blob-hash-invalid";

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  constructor(code: BlobStoreErrorCode, message: string) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
  }
}

export interface BlobStore {
  put(transaction: Transaction, content: Uint8Array): string;
  get(hash: string): BlobRecord | null;
}
```

`put` takes the transaction context, because a blob write is part of the one transaction of its command (`AGENTS.md`, `docs/proposal/database/README.md:45`). `get` takes an optional transaction context, the same shape as `EventLog.list`. A caller outside a transaction omits it, and `get` opens its own. A caller inside its command's one transaction passes the context, because `Storage.transact` refuses a nested call.

### 3. `src/services/blob/sqlite.ts` (new)

```ts
import { createHash } from "node:crypto";

import type { Clock } from "../clock/index.ts";
import type { Storage, Transaction } from "../storage/index.ts";
import type { BlobRecord, BlobStore } from "./index.ts";

export type SqliteBlobStoreDependencies = Readonly<{
  storage: Storage;
  clock: Clock;
}>;

export class SqliteBlobStore implements BlobStore { … }
```

Exact behaviour:

- `put(transaction, content)`:
  1. The address is `sha256:` followed by the lowercase hex sha256 of `content`, from `createHash("sha256").update(content).digest("hex")`.
  2. `transaction.run("INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING", [hash, content.byteLength, content, this.clock.now()])`
  3. return `hash`.
     A second write of the same bytes inserts no row and keeps the original `created_at`. `clock.now()` is still called, and its value is discarded by the conflict clause.
- `get(hash)`:
  1. A `hash` that does not match `/^sha256:[0-9a-f]{64}$/` throws a `BlobStoreError` of code `blob-hash-invalid`, with the message `<hash> is not a sha256 blob hash`. The address is the identity of the payload, and a malformed one is a caller defect rather than a miss.
  2. `this.storage.transact((transaction) => transaction.get("SELECT hash, size, content, created_at FROM blob WHERE hash = ?", [hash]))`, mapped to a `BlobRecord` with `createdAt` from `created_at`, or `null` when the row is `undefined`. `content` is returned as the `Uint8Array` `node:sqlite` yields.

The query names its columns. No `SELECT *` in this capability.

### 4. `src/services/event/sqlite.ts` (new)

```ts
import type { IdGenerator } from "../ids/index.ts";
import type { Storage, Transaction } from "../storage/index.ts";
import type {
  AppendEventInput,
  EventFilter,
  EventLog,
  RecordedEvent,
} from "./index.ts";

export type SqliteEventLogDependencies = Readonly<{
  storage: Storage;
  ids: IdGenerator;
}>;

export class SqliteEventLog implements EventLog { … }
```

Exact behaviour:

- `append(transaction, input)`:
  1. `const id = this.ids.mint("event");`
  2. `transaction.run("INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, input.subjectKind, input.subjectId, input.type, input.actorKind, input.actorId, JSON.stringify(input.payload)])`
  3. returns `{ id, ...the six input fields, occurredAt: identityTime(id) ?? 0 }`. `payload` is `input.payload` unchanged, not a re-parse.
- `list(filter, transaction?)` — one `SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event`, run on the caller's transaction context when one is passed and on its own when none is. The `WHERE` is built from the present filter fields joined by `AND`, in this fixed order:

  | field         | clause             |
  | ------------- | ------------------ |
  | `subjectKind` | `subject_kind = ?` |
  | `subject`     | `subject_id = ?`   |
  | `type`        | `type = ?`         |
  | `actorKind`   | `actor_kind = ?`   |
  | `actor`       | `actor_id = ?`     |
  | `after`       | `id > ?`           |

  then `ORDER BY id ASC`, then `LIMIT ?` when `filter.limit` is present. Parameters are bound positionally in that same order. An absent field contributes no clause and no parameter. The rows are mapped to `RecordedEvent` with `payload = JSON.parse(payload_json)` and `occurredAt = identityTime(id) ?? 0`. It runs inside `this.storage.transact`.

`ORDER BY id ASC` is **id order**. `docs/proposal/database/event.md:19` calls it creation order because the id is a ULID, and that holds to millisecond resolution. `ulid()` is not the monotonic factory (EPIC 002 Story 01), so two events appended inside one millisecond carry independent randomness and may order either way. The tests assert id order with pinned mock ids, and no test asserts that append order equals list order.

### 4b. `test/helpers/database.ts` — add a migrated storage helper

```ts
import type { Storage } from "../../src/services/storage/index.ts";

export type TemporaryStorage = Readonly<{
  storage: Storage;
  path: string;
  dispose(): void;
}>;

export function createMigratedStorage(): TemporaryStorage;
```

It builds a `createTemporaryDatabase()`, constructs a `SqliteStorage` with the full `migrations` array and `createMockClock({ start: 1700000000000, step: 1000 })`, calls `migrate()`, and returns the instance **typed as `Storage`**. `dispose()` closes the storage and removes the directory.

`test/helpers/` is where a construction like this belongs. `AGENTS.md` lets a test reach an implementation only in the capability it covers, so a test under `src/services/blob/` and `src/services/event/` must not construct `SqliteStorage` itself. It takes the helper and holds the interface.

`createTemporaryDatabase` is unchanged, and every existing caller keeps working.

### 5. `src/domain/layout.test.ts` — extend the capability inventory

EPIC 002 Story 11 asserts the sorted `src/services/` directory list deep-equals a twelve-entry literal. Add `"blob"` to it, in sorted position:

```ts
[
  "agent",
  "blob",
  "clock",
  "config",
  "crypto",
  "event",
  "git",
  "graph",
  "home-lock",
  "ids",
  "lease",
  "storage",
  "verify",
];
```

Change nothing else in that file. The existing assertions — an `index.ts` in every capability, a `not-implemented.ts` in three of them, and no `"implements "` in any `index.ts` — then cover `blob` with no edit.

## Constraints

- `SqliteBlobStore` and `SqliteEventLog` reach SQLite only through the `Storage` interface and the `Transaction` context. Neither imports `node:sqlite`, and neither opens a database.
- Neither class writes a state row. A transition is a command, and it arrives with its use case.
- `append` and `put` accept a `Transaction` and offer no overload that omits it, so a caller must already hold a transaction context to write either. That is a structural aid, not a proof: nothing in the type system stops a caller from passing one context to `append` and writing the state row through another. The guarantee that the two share one transaction is a rule of the write command, and the tests below prove it for this implementation under one context. Do not restate it as a type-level guarantee anywhere.
- `src/services/event/index.ts`, `src/services/storage/index.ts` and every migration file are unchanged.

## Verify

`node --test src/domain/identity.test.ts` — the existing file gains:

- `identityTime("event_01HZY8QF3M4N5P6R7S8T9V0W1X")` equals exactly `1717928967284`.
- `identityTime("task_01HZY8QF3M4N5P6R7S8T9V0W1X")` equals the same value — the prefix does not enter the decode.
- `identityTime("0000000000000000000000000000")` is `null`, and `identityTime("widget_01HZY8QF3M4N5P6R7S8T9V0W1X")` is `null`.
- `identityTime("event_00000000000000000000000000")` equals `0`.
- `identityTime("event_7ZZZZZZZZZ0000000000000000")` equals `281474976710655`, the largest 48-bit timestamp.

`node --test src/services/blob/sqlite.test.ts` — new file, one suite named `"src/services/blob/sqlite.test"`. Every case takes its storage from `createMigratedStorage()` and builds `new SqliteBlobStore({ storage, clock: createMockClock({ start: 1700000000000, step: 1000 }) })`. It imports no implementation of another capability.

- `storage.transact((t) => store.put(t, Buffer.from("kanthord", "utf8")))` returns exactly
  `"sha256:6716f913a54334239c6614653425bad87302dbc49f3d7ccc3d9d7c44ecfaf7ac"`.
- The empty payload returns
  `"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"`.
- `store.get(hash)` after that first write deep-equals
  `{ hash: "sha256:6716…", size: 8, content: <Uint8Array of "kanthord">, createdAt: 1700000000000 }`, with `content` compared through `Buffer.compare` and `Object.getPrototypeOf(record.content) === Uint8Array.prototype`.
- Deduplication: the same bytes written in two separate `transact` calls return the same hash, `SELECT COUNT(*) AS c FROM blob` is `1`, and `get(hash).createdAt` is still `1700000000000` — the second write did not move it.
- Two different payloads produce two hashes and two rows.
- `store.get("sha256:" + "9".repeat(64))` returns `null`.
- `store.get("nonsense")` throws with `error instanceof BlobStoreError`, `error.name === "BlobStoreError"`, `error.code === "blob-hash-invalid"` and message `"nonsense is not a sha256 blob hash"`. The same for an uppercase-hex hash and for a 63-character hash.
- A rolled-back transaction stores nothing: a `transact` that calls `put` and then throws leaves `SELECT COUNT(*) AS c FROM blob` at `0`, and `get(hash)` returns `null`.

`node --test src/services/event/sqlite.test.ts` — new file, one suite named `"src/services/event/sqlite.test"`. Every case takes its storage from `createMigratedStorage()`, seeds with `seedRegistry` and `seedGraph`, and builds `new SqliteEventLog({ storage, ids: createMockIdGenerator({ ulids: [...] }) })` from `test/helpers/ids.ts`. The mock ULIDs are, in order, `"01HZY8QF3M4N5P6R7S8T9V0W1X"`, `"01HZY8QF3N4N5P6R7S8T9V0W1X"` and `"01HZY8QF3P4N5P6R7S8T9V0W1X"`.

- `append` returns a `RecordedEvent` deep-equal to
  `{ id: "event_01HZY8QF3M4N5P6R7S8T9V0W1X", subjectKind: "node", subjectId: "task_a", type: "task.done", actorKind: "daemon", actorId: "daemon_a", payload: { note: 1 }, occurredAt: 1717928967284 }`.
- The stored row: `SELECT payload_json FROM event WHERE id = ?` returns exactly `'{"note":1}'`.
- `list({})` after three appends returns the three ids ascending. The mock ids are pinned and increasing, so this asserts the `ORDER BY id ASC` clause, not a property of the real generator.
- Filters, each asserted on its own: `subjectKind`, `subject`, `type`, `actorKind` and `actor` each select the matching subset; two filters together are an `AND`; `after` with the first id returns the second and third only; `limit: 2` returns the first two.
- `list({ subject: "task_missing" })` returns an empty array.
- A `payload` of `null` round-trips as `null`, and an array payload round-trips as an array.
- `actorKind: "human"` and `actorKind: "daemon"` both append. The `CHECK` clause is asserted in Story 06 and is not repeated here.

`node --test src/services/event/atomicity.test.ts` — new file, one suite named `"src/services/event/atomicity.test"`. It takes its storage from `createMigratedStorage()`, seeds it, and asserts the rollback in both directions.

- **A failed event append leaves the state row unchanged.** One `transact` that runs
  `UPDATE node SET state = 'done', updated_at = 2 WHERE id = 'task_a'` and then calls
  `append(transaction, { …, actorKind: "robot" as never, … })` throws — the `event.actor_kind` `CHECK` fails. After the `transact` returns by throwing, `SELECT state, updated_at FROM node WHERE id = 'task_a'` spreads to `{ state: "pending", updated_at: 1 }`, and `SELECT COUNT(*) AS c FROM event` is `0`.
- **A failed state write leaves no event.** One `transact` that calls `append` with a valid input and then runs
  `UPDATE node SET state = 'nonsense' WHERE id = 'task_a'` throws on the `node.state` `CHECK`. After it, `SELECT COUNT(*) AS c FROM event` is `0` and the node state is still `"pending"`.
- **The success case commits both.** One `transact` that updates the node to `"done"` and appends `task.done` leaves `state = "done"` and exactly one event row, and `list({ subject: "task_a" })` returns it.
- The thrown error in both failure cases is the SQLite error, not a `StorageError` — `runInTransaction` rethrows the original object.

`npm run verify` exits 0, which is where `src/domain/layout.test.ts` with its thirteen-capability literal runs.

Proof: covered by `npm run verify`. This story adds no file under `src/services/storage/`.
