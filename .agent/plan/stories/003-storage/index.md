# EPIC 003 — Storage — stories

Epic: `.agent/plan/epics/003-storage.md`
Prereq: EPIC 002 (sequence order). Every domain schema exists in `src/domain/`, and every service capability exists as an interface in `src/services/`, including `storage`, `crypto` and `event`.

Every phase-1 table exists on `node:sqlite`, `kanthord db migrate` applies the migrations directly and changes nothing on a second run, a secret is encrypted at rest, a payload is content addressed, and a transition and its event share one transaction.

## Dispatch order

```
01 → 02 → 04 → 05 → 06 → 03 → 07 → 08
```

- `01` and `02` are the runner. `02` tests against its own fixture migrations, so it needs no DDL.
- `04` creates `src/services/storage/migrations.ts` and `test/helpers/rows.ts`; `05` and `06` each append one migration and extend the fixture. They are a chain, not a coupled pair.
- `03` needs only `04`, because it derives its expected output from the `migrations` array rather than typing three lines. It is placed after `06` so its end-to-end run exercises the whole schema; move it earlier at no cost.
- `07` is independent of every other story. Dispatch it any time after `02`.
- `08` is last. It needs the `blob` and `event` tables from `06`, and it edits the capability literal in `src/domain/layout.test.ts` that EPIC 002 Story 11 wrote.

## Stories

- 01 — `openDatabase`, the four pragmas, and `runInTransaction` → `01-connection-and-pragmas.md`
- 02 — the `migration` table, ordered application, and idempotence → `02-migration-runner.md`
- 03 — `src/cli/db/migrate.ts` with an injected handler, and the non-loopback refusal → `03-kanthord-db-migrate.md`
- 04 — `blob`, `provider`, `project`, `project_binding`, `repository`, `profile` → `04-registry-ddl.md`
- 05 — `plan_revision`, `node`, `edge`, and the state-machine `CHECK` clauses → `05-graph-ddl.md`
- 06 — the nine execution and journal tables, and `run_one_active` → `06-execution-ddl.md`
- 07 — AES-256-GCM seal and open over the configured master key → `07-crypto-service.md`
- 08 — the content-addressed blob store, the event append path, and the rollback proof → `08-blob-store-and-event-log.md`

## Facts (needed for implementation)

State of the tree at the start of this epic:

- `src/services/` holds thirteen capabilities after this epic: the twelve of EPIC 002 plus `blob`.
- `src/services/storage/index.ts` is already written by EPIC 002 Story 11 and is **not** modified here. It fixes `Transaction`, `AppliedMigration`, `PendingMigration`, `MigrationStatus`, `StorageError`, the two codes `storage-migration-failed` and `storage-transaction-failed`, and the four methods `transact`, `migrate`, `status`, `close`.
- `src/services/crypto/index.ts` fixes `SealedPayload` with its four fields and the two codes `crypto-key-missing` and `crypto-authentication-failed`.
- `src/services/event/index.ts` fixes `EventLog.append(transaction, input)` and `list(filter)`.
- `test/helpers/` holds `daemon.ts`, `database.ts`, `home.ts`, `lint.ts`, and from EPIC 002 `ids.ts` and `clock.ts`. This epic adds `proposal.ts`, `rows.ts` and `cli.ts`, each with its sibling `.test.ts`, and extends `database.ts` with `createMigratedStorage()`.
- `src/main.ts:20-59` is the `serve` command and `src/main.ts:61` is `parseAsync`. This epic inserts one `registerDbMigrate` call between them.
- No file under `src/commands/`, `src/queries/`, `src/http/` or `src/cli/` exists. This epic creates the first two files under `src/cli/` — `base-url.ts` and `db/migrate.ts` — and none under the other three.

Measured `node:sqlite` behaviour on Node 24 — each of these changes an assertion:

- `PRAGMA journal_mode` answers `"memory"` on `:memory:` and `"wal"` on a file. Every pragma test uses a file from `createTemporaryDatabase()`.
- Every row is a **null-prototype** object, so `assert.deepEqual(row, { … })` fails on the prototype alone. Spread the row before every deep comparison.
- A `BLOB` column reads back as a `Uint8Array`, and a `Buffer` binds into it unchanged.
- Every constraint failure carries the base class `SQLITE_CONSTRAINT` in its extended code: `errcode & 0xff === 19`. Measured — primary key `1555`, unique index `2067`, `CHECK` `275`, foreign key `787`, `NOT NULL` `1299`. A refusal case asserts the base class and an unchanged row count, and the message only where a named column is the point. A bare extended code is brittle, and message wording alone is a property of the bundled SQLite build.
- A type refusal under `STRICT` — `"cannot store TEXT value in INTEGER column …"` — carries no constraint errcode. Assert the throw, not the text.
- `PRAGMA` results are read through `Object.values({ ...row })[0]`, because `busy_timeout` answers in a column named `timeout` while the other three answer in a column named after the pragma.
- `docs/proposal/database/run.md` is the one table file whose fenced block holds **two** statements, the table and `CREATE UNIQUE INDEX run_one_active`. Every other file holds one.
- `STRICT` **accepts** an integer bound into a TEXT column, so only the TEXT-into-INTEGER direction is assertable.
- `new URL("http://[::1]:7421").hostname` is `"[::1]"`, with the brackets.

Source facts the stories depend on:

- One `CREATE TABLE` per table at `docs/proposal/database/<table>.md`, with a comment per column. A migration statement carries the block with the `--` comments removed and nothing else changed, and `test/helpers/proposal.ts` is what proves it rather than a reviewer's eye.
- Migration names are `0001-core-entities`, `0002-graph-and-plan`, `0003-execution-and-journal`, verbatim from `docs/proposal/database/migration.md:19-21`.
- Pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = FULL` — `docs/proposal/database/README.md:36`. `busy_timeout = 5000` is added here; the source names no value, and a zero timeout is the home-lock convention rather than the database one.
- One command is one transaction — `docs/proposal/database/README.md:45`.
- Every transition writes a state row and appends one event in one transaction — `docs/proposal/database/event.md:17`.
- `db migrate` is the one command that opens SQLite directly, and the CLI refuses it against a non-loopback base URL — `docs/proposal/api/system.md:36`.
- The only index in the proposal is `run_one_active` — `docs/proposal/database/run.md:23`.
- `workspace.state`, `run.outcome`, `git_operation.outcome`, `event.type` and `event.subject_kind` carry no `CHECK`.

## Decisions this epic settled

Eleven choices the EPIC and the proposal leave open. Each is pinned here so no story hands a decision to build time. The last six were settled by the adversarial review of this story set.

- **`blob` is the thirteenth service capability.** The EPIC pairs the blob store with the event log, `services/event` already exists as an interface, and a content-addressed store is a capability rather than a generic SQL method. The alternative was two methods on `Storage`, which would put a product table inside the transaction primitive. Story 08 adds `src/services/blob/index.ts` and edits the capability literal in `src/domain/layout.test.ts` that EPIC 002 Story 11 wrote. The proposal's service list at `docs/proposal/phase-1/domain.md:51` is illustrative and already omits `ids`, `clock` and `home-lock`.
- **`db migrate` is a CLI module with an injected handler.** `AGENTS.md` states it: "`main.ts` constructs the storage implementation and passes the migration handler into the commander program." Story 03 therefore creates `src/cli/db/migrate.ts` and `src/cli/base-url.ts` — the first two files under `src/cli/` — and `src/main.ts` builds the handler and binds it. The `cli/` element imports no service, and EPIC 004's CLI program skeleton then refactors a directory that already obeys the matrix rather than moving a handler out of the composition root. The decisive argument is testability: a test may not import the composition root (`eslint.config.js:270`), so command logic left in `main.ts` is reachable only by spawning a process. EPIC 004 carries the refactor, and `.agent/plan/epics/001-runtime-foundation.md` still records "EPIC 004 owns commander", which this supersedes. Putting the whole command in `src/main.ts` was the first draft, and it contradicted the structural source of truth.
- **`db migrate` reads configuration only when no `--home` is given.** The EPIC Proof runs `node src/main.ts db migrate --home "$(mktemp -d)"` from a repository that holds no `kanthord.config.json`, so a mandatory config load would fail the gate. Migration apply needs a database path and nothing else. `db migrate` declares its own `--home`, because commander does not accept a program option written after a subcommand.
- **The base URL check lives in `src/cli/base-url.ts`.** EPIC 004 gives the CLI a shared base URL, and no such setting exists yet. Story 03 reads `--base-url` and falls back to `KANTHORD_BASE_URL`, and `isLoopbackUrl` admits only the `http:` and `https:` protocols. The refusal code is `db-remote-base-url`, printed as `kanthord: db-remote-base-url: <message>` with exit `1`, which extends the closed startup-refusal set of EPIC 001 and is not an HTTP code. EPIC 004 imports the same function — `cli/` may import `cli/` — so the policy has one home and cannot diverge.
- **`db migrate` holds the home lock, and the lock is the migration exclusion mechanism.** It is an offline maintenance command. Two concurrent `db migrate` processes would otherwise both read the applied set, both choose the same pending migration and race on the insert, and one would report a failure against a correctly migrated database. The home lock refuses the second process by name, so the runner needs no lock of its own and `migrate()` needs no concurrency policy beyond one transaction per migration. A daemon holding the home also blocks migration, which is the correct answer for an offline command: stop the daemon, migrate, start it.

- **The schema is proved mechanically, not by sample.** `test/helpers/proposal.ts` extracts each table's fenced `CREATE TABLE` block, strips `--` comments under one defined rule, splits on `;` and normalizes whitespace. Each migration story asserts its `statements` deep-equal the proposal statements of its table list, in order, plus its version, its name, and an empty trigger and view inventory. A behavioural sample cannot prove a column type, a default, an exact `CHECK` member list, or the **absence** of an extra constraint or index; the parity test can, and it is what makes "verbatim from the proposal" an audited claim rather than a requirement. The behavioural cases then prove the constraints are live and name the rules a human reads.
- **A migration test freezes its enum literals, and one test compares the live schema with the domain.** A migration is history and must never be edited, so the `0002` and `0003` tests carry frozen literals for the node states, the block reasons and the agent kinds. `src/services/storage/schema-parity.test.ts` from Story 06 is the single place that compares the fully migrated schema against `nodeStates`, `blockReasons`, `nodeKinds` and `agentKinds`. That is the drift guard the EPIC asks for, and it puts the failure on a domain change instead of pressuring a maintainer to edit migration `0002` when a later release adds a state through `0004`.
- **`storage-transaction-failed` covers five conditions and nothing else**: a failed `BEGIN`, a failed `COMMIT`, a thenable returned by `work`, a call on a closed context, and the idle guard. `transact` never wraps an error thrown by its `work`: a SQLite constraint failure raised inside `transaction.run` reaches the caller unchanged, because a command must be able to catch its own error and a constraint failure is the database answering that command. `runInTransaction` rejects a thenable because `T` is unconstrained, and an `async` callback would otherwise commit before its first `await` resumed and then write through a closed context.
- **`migrate()` refuses a database it does not recognise.** An applied version absent from the code list is an older binary against a newer database, and an applied version whose stored `name` differs from the declared one is an edited migration. Both refuse before anything is applied. `status()` still reports both, and `status()` is acknowledged as a writing operation because it bootstraps the `migration` table.
- **`keyVersion` is bound as GCM additional authenticated data.** It selects the key on the read path and sits in its own `provider` column outside the ciphertext, so an edited `key_version` must fail authentication rather than silently select another key generation. The AAD changes the tag and not the ciphertext, which is why the pinned vector of Story 07 carries the tag `76fda6d5…`.
- **A test constructs an implementation only in the capability it covers.** `src/services/blob/` and `src/services/event/` tests take a migrated `Storage` from `createMigratedStorage()` in `test/helpers/database.ts` and hold the interface type. The helper is where the cross-capability construction is allowed to live.

## Open items

None blocks `/work`. Four are worth a proposal amendment rather than a story change:

- S1 - action:NO - busy-timeout-value - `docs/proposal/database/README.md:36` names three pragmas and no busy timeout. `5000` is pinned in Story 01 and asserted there. A later phase that measures contention may change the value; nothing in phase 1 depends on the number.
- S2 - action:NO - event-order-is-id-order - `docs/proposal/database/event.md:19` calls `ORDER BY id` creation order, and EPIC 002 Story 01 records that `ulid()` is not the monotonic factory. Two events appended inside one millisecond can therefore list in either order. Story 08 asserts id order with pinned mock ids and claims nothing about append order. A monotonic `IdGenerator` contract would close the gap, and it belongs to the proposal and to `services/ids`, not to this epic.
- S3 - action:NO - transaction-identity - `EventLog.append` and `BlobStore.put` taking a `Transaction` forces a caller to hold a context; it does not prove the state row and the event share one. That rule belongs to each write command, and EPIC 007 onward carries it. Story 08 states the limit rather than overclaiming a type-level guarantee.
- S4 - action:NO - migration-checksum - `migrate()` compares a stored `name` against the declared one, which catches a renamed migration. It cannot catch an edited statement list that keeps its name. A checksum would, and `docs/proposal/database/migration.md:6-10` gives the table three columns and no checksum column, so adding one is a proposal amendment. Story 02 records the limit.
