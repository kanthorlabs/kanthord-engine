# Story 04 — Registry DDL

Epic: `.agent/plan/epics/003-storage.md`
Depends on: Story 02 (`Migration`, `SqliteStorage`).

## Change

### 1. `src/services/storage/migration-0001-core-entities.ts` (new)

```ts
import type { Migration } from "./migration.ts";

export const coreEntities: Migration = {
  version: 1,
  name: "0001-core-entities",
  statements: [ … ],
};
```

Six statements, in this order — `blob`, `provider`, `project`, `project_binding`, `repository`, `profile`. The order is the foreign-key order: `repository` references `provider`, and `profile` references `repository` and `blob`.

Each statement is the `CREATE TABLE` of its `docs/proposal/database/<table>.md` file with every `--` comment removed and nothing else changed. The implementer copies each block out of the proposal file; the parity test under **Verify** is what proves the copy, so the text below is for reading rather than for retyping. Column order, types, `NOT NULL`, `UNIQUE`, `DEFAULT`, `REFERENCES`, `CHECK` and the trailing `STRICT` are verbatim:

```sql
CREATE TABLE blob (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT
```

```sql
CREATE TABLE provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('llm', 'git')),
  set_default_at INTEGER,
  payload_ciphertext BLOB NOT NULL,
  payload_iv BLOB NOT NULL,
  payload_tag BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(payload_iv) = 12),
  CHECK (length(payload_tag) = 16)
) STRICT
```

```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  worker TEXT,
  e2e_json TEXT,
  updated_at INTEGER NOT NULL
) STRICT
```

```sql
CREATE TABLE project_binding (
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('git', 'provider')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind, target_id)
) STRICT
```

```sql
CREATE TABLE repository (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  remote_url TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES provider(id),
  home_path TEXT NOT NULL,
  upstream_branch TEXT NOT NULL,
  landing_branch TEXT NOT NULL,
  publish_ref TEXT NOT NULL,
  publish_on_approval INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('ready', 'needs-reconcile')),
  diverged_landing_oid TEXT,
  diverged_upstream_oid TEXT,
  fetched_upstream_oid TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (state = 'needs-reconcile')
    = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)
  )
) STRICT
```

```sql
CREATE TABLE profile (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repository(id),
  content_blob TEXT NOT NULL REFERENCES blob(hash),
  updated_at INTEGER NOT NULL
) STRICT
```

### 2. `src/services/storage/migrations.ts` (new)

```ts
import type { Migration } from "./migration.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";

export const migrations: readonly Migration[] = [coreEntities];
```

Stories 05 and 06 append to this array.

### 3. `test/helpers/proposal.ts` (new) — the mechanical DDL source

The migrations claim to reproduce the proposal exactly. A behavioural sample cannot prove that claim, so one helper extracts the truth and the parity tests compare against it.

```ts
export function proposalStatements(table: string): readonly string[];
```

Exact transformation, in this order:

1. Read `docs/proposal/database/${table}.md` as UTF-8.
2. Take the **first** fenced block matched by the regular expression for a triple-backtick `sql` fence — capture group one is the block body. No match throws a plain `Error` with the message `no sql block in <table>.md`.
3. Remove every `--` comment. A `--` is a comment only when the count of `'` characters before it on its own line is even; otherwise it is inside a string literal and stays. No DDL block holds such a case today, and the rule keeps the helper correct if one appears.
4. Split on `;`.
5. For each part, collapse every run of whitespace to one space and trim. Drop an empty part.

Measured over all nineteen tables: every file yields exactly one statement, except `docs/proposal/database/run.md`, whose block holds the table **and** `CREATE UNIQUE INDEX run_one_active`, and therefore yields two. Story 06 relies on that.

The helper returns normalized text, so the comparison is exact in content and insensitive to line breaks and indentation. That is what lets a story quote readable SQL while the test compares one canonical form.

### 4. `test/helpers/rows.ts` (new)

The row fixture every DDL test and the atomicity test of Story 08 insert. Stories 05 and 06 extend it.

```ts
import type { Transaction } from "../../src/services/storage/index.ts";

export const fixtureIds = {
  provider: "provider_a",
  repository: "repo_a",
  project: "project_a",
  profile: "profile_a",
  instructionBlob: `sha256:${"0".repeat(64)}`,
  acceptanceBlob: `sha256:${"1".repeat(64)}`,
  profileBlob: `sha256:${"2".repeat(64)}`,
} as const;

export function seedRegistry(transaction: Transaction): void;
```

`seedRegistry` inserts, in this order and with these exact values:

- three `blob` rows — `fixtureIds.instructionBlob`, `fixtureIds.acceptanceBlob` and `fixtureIds.profileBlob`, each with `size = 1`, `content = new Uint8Array([0])` and `created_at = 1`;
- one `provider` row — `id = fixtureIds.provider`, `name = "work-anthropic"`, `kind = "llm"`, `set_default_at = null`, `payload_ciphertext = new Uint8Array([1])`, `payload_iv = new Uint8Array(12)`, `payload_tag = new Uint8Array(16)`, `key_version = 1`, `updated_at = 1`;
- one `project` row — `id = fixtureIds.project`, `name = "kanthord-verify"`, `worker = "general@1"`, `e2e_json = null`, `updated_at = 1`;
- one `repository` row — `id = fixtureIds.repository`, `name = "kanthord-verify"`, `remote_url = "https://example.invalid/r.git"`, `credential_id = fixtureIds.provider`, `home_path = "repos/r.git"`, `upstream_branch = "main"`, `landing_branch = "main"`, `publish_ref = "refs/heads/main"`, `publish_on_approval = 1`, `state = "ready"`, the three `*_oid` columns `null`, `updated_at = 1`;
- one `project_binding` row — `(fixtureIds.project, "git", fixtureIds.repository, 1)`.

## Constraints

- No index and no trigger. `docs/proposal/database/` declares one index, `run_one_active`, and it belongs to Story 06.
- No `DEFAULT` beyond `repository.publish_on_approval DEFAULT 1`, which the source states.
- The migration `name` is `0001-core-entities`, verbatim from `docs/proposal/database/migration.md:19`.
- `src/services/storage/sqlite.ts` and `connection.ts` are not modified.

## Verify

`node --test src/services/storage/migration-0001-core-entities.test.ts` — new file, one suite named `"src/services/storage/migration-0001-core-entities.test"`. Every case builds a `SqliteStorage` over `createTemporaryDatabase()` with `migrations: [coreEntities]` and a `createMockClock({ start: 1700000000000 })`, calls `migrate()`, and closes it after.

**How a refusal is asserted, in this story and in Stories 05 and 06.** Every refusal case asserts three things: the thrown error's `errcode & 0xff` is `19`, which is SQLite's base `SQLITE_CONSTRAINT` class and is stable across the extended codes; the target table's row count is unchanged after the throw; and, only where the named column is the point of the case, the `message` contains the full prefix such as `"UNIQUE constraint failed: profile.repository_id"`. Measured: a primary-key conflict answers `1555`, a unique-index conflict `2067`, a `CHECK` `275`, a foreign key `787` and a `NOT NULL` `1299` — every one of them `19` in the base class. A test never asserts a bare extended code, and it never depends on message wording alone.

Write the three as one helper inside the test file — `assertRefused(fn, table, { message })` — so a case is one line and the rule cannot be applied inconsistently.

**What the parity test proves, and what the behavioural cases add.** The parity test is what establishes the exact schema: every column, type, order, default, nullability and `CHECK`, plus the absence of anything extra. The behavioural cases prove the constraints are live in a real database and name the rules a human must be able to read. Neither replaces the other, and no behavioural case is written to prove an **absence** — a single accepted sample cannot establish that a column has no `CHECK` over an infinite string domain.

Parity, the load-bearing case:

- `coreEntities.statements` deep-equals `["blob", "provider", "project", "project_binding", "repository", "profile"].flatMap(proposalStatements)` after each authored statement is put through the same normalization the helper applies. Statement count, order and text are therefore all asserted at once.
- `coreEntities.version` is `1` and `coreEntities.name` is `"0001-core-entities"`, and `docs/proposal/database/migration.md` contains the literal `"0001-core-entities"`.
- `migrations` deep-equals `[coreEntities]` — exactly one entry at this story.

- The table inventory: `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name` maps to exactly
  `["blob", "migration", "profile", "project", "project_binding", "provider", "repository"]`.
- No extra schema object: `SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'` returns an empty array. A table inventory cannot see a trigger, and "no index and no trigger" is a constraint of this story.
- Every one of the six tables is `STRICT`: `SELECT sql FROM sqlite_master WHERE name = ?` returns a string whose `trimEnd()` ends with `"STRICT"`.
- The `profile` relational contract, at the database level:
  - `PRAGMA table_info(profile)` returns four rows. Their `name` values in order deep-equal `["id", "repository_id", "content_blob", "updated_at"]`; their `type` values in order deep-equal `["TEXT", "TEXT", "TEXT", "INTEGER"]`; every row has `notnull === 1` and `dflt_value === null`; and `pk` is `1` on `id` and `0` on the other three. The declared types and the absent defaults are part of the relational contract, not decoration.
  - After `seedRegistry`, inserting `("profile_a", repository, profileBlob, 1)` succeeds.
  - A second `profile` row for the same `repository_id` is refused, with the message containing `"UNIQUE constraint failed: profile.repository_id"`.
  - A `profile` row whose `repository_id` is `"repo_missing"` is refused, with the message containing `"FOREIGN KEY constraint failed"`.
  - A `profile` row whose `content_blob` is `` `sha256:${"9".repeat(64)}` `` is refused, with the message containing `"FOREIGN KEY constraint failed"`.
- `provider`:
  - `payload_iv` of 11 bytes is refused; 13 bytes is refused; 12 bytes succeeds.
  - `payload_tag` of 15 bytes is refused; 17 bytes is refused; 16 bytes succeeds.
  - `kind = "slack"` is refused; `"llm"` and `"git"` both succeed.
  - A duplicate `name` is refused, with the message containing `"UNIQUE constraint failed: provider.name"`.
- `repository`, driven by a truth table over `state` and the two `diverged_*` columns. All eight combinations of `state ∈ {ready, needs-reconcile}` and each `diverged_*` column null or set are covered, because the `CHECK` is an equivalence and a defective clause that reads only `diverged_landing_oid` would pass a partial table:
  - `ready` with both null succeeds; `needs-reconcile` with both set succeeds.
  - `needs-reconcile` with both null is refused; `ready` with both set is refused.
  - `needs-reconcile` with only `diverged_landing_oid` set is refused, and with only `diverged_upstream_oid` set is refused.
  - `ready` with only `diverged_landing_oid` set is refused, and with only `diverged_upstream_oid` set is refused.
  - `state = "broken"` is refused.
  - `credential_id = "provider_missing"` is refused, with the message containing `"FOREIGN KEY constraint failed"`.
  - The `publish_on_approval` default: an insert that names every column except it reads back `1`.
- `project_binding`:
  - `kind = "agent"` is refused.
  - The same `(project_id, kind, target_id)` twice is refused, with the message containing `"UNIQUE constraint failed"`.
  - The same project with a second `target_id` succeeds.
  - `project_id = "project_missing"` is refused, with the message containing `"FOREIGN KEY constraint failed"`.
- `blob` round trip: a row inserted with `content = new Uint8Array([1, 2, 3])` reads back a value whose prototype is `Uint8Array.prototype` and which spreads to `[1, 2, 3]`.

`node --test test/helpers/rows.test.ts` — new file, one suite named `"test/helpers/rows.test"`:

- `fixtureIds` spread into a plain object deep-equals the seven literal values above.
- After `migrate()` and one `transact((t) => seedRegistry(t))`, the row count of each of `blob`, `provider`, `project`, `repository` and `project_binding` is `3, 1, 1, 1, 1` respectively.
- `seedRegistry` called twice inside two transactions throws — the fixture is not idempotent by design, and a test that needs a clean database builds a new one.

`npm run verify` exits 0.

Proof: contributes `src/services/storage/migration-0001-core-entities.test.ts` to `node --test src/services/storage/**/*.test.ts`.
