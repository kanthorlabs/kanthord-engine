# Story 02 — The migration gate at startup

Epic: `.agents/plan/epics/004-transport-skeleton.md`
Depends on: Story 01 (`src/main.ts` `serve` order, `src/http/server/start.ts`).

`docs/proposal/api/system.md:36` states the rule: "The daemon owns the database file, and an unmigrated database stops the daemon from starting, so a route that applies migrations is unreachable exactly when it is needed."

## Change

### 1. `src/http/server/migration-gate.ts` (new)

```ts
export type PendingEntry = Readonly<{ version: number; name: string }>;

export type StartupErrorCode = "db-migration-pending";

export class StartupError extends Error {
  readonly code: StartupErrorCode;
  constructor(code: StartupErrorCode, message: string);
}

export function assertMigrated(
  input: Readonly<{ home: string; pending: readonly PendingEntry[] }>,
): void;
```

`PendingEntry` is declared structurally rather than imported. `MigrationStatus` lives in `src/services/storage/index.ts`, and `eslint.config.js:138-155` gives `http-server` no route to a service. `src/main.ts` passes `storage.status().pending` in, and the shapes match by field.

`assertMigrated` returns when `input.pending` is empty. Otherwise it throws `StartupError("db-migration-pending", message)` where `message` is exactly:

```
the daemon home <home> has unapplied migrations <names>; run kanthord db migrate
```

`<names>` is every `pending` entry's `name`, sorted ascending by `version`, joined with `", "`. The refusal names `kanthord db migrate` because that is the only way to clear it, and `docs/proposal/api/system.md:36` makes it the one command that opens SQLite directly.

`StartupError` sets `this.name = "StartupError"`. `db-migration-pending` joins the closed startup-refusal set of `.agents/plan/epics/001-runtime-foundation.md:67`, which EPIC 003 already extended with `db-remote-base-url`. It is not an HTTP code and it never appears in `src/http/contract/errors.ts`.

The gate lives under `src/http/server/` because it is a precondition of listening, and Story 01 owns the listen sequence. It is a separate module from `start.ts` so a test reaches it without opening a port.

### 2. `src/main.ts` — insert the gate and construct storage

The `serve` action of Story 01 runs config, then the home lock, then the server. Insert between them:

1. Construct the storage implementation: `new SqliteStorage({ path: join(settings.home, "kanthord.db"), clock, migrations })`. The path is the same one `src/cli/db/migrate.ts` derives from `--home`, and both must resolve to the same file — Story 07 reuses one helper for it.
2. `assertMigrated({ home: settings.home, pending: storage.status().pending })`.
3. On any exit path after step 1, call `storage.close()`.

`storage.status()` bootstraps the `migration` table, per `.agents/plan/stories/003-storage/02-migration-runner.md:53`. That is why the gate reads `status()` and never `migrate()`: the daemon must not apply a migration, and it must still be able to report that none is applied.

Add `StartupError` to the `instanceof` chain of the refusal printer at `src/main.ts:51-58`, beside `ConfigError` and `HomeLockError`. The printed line keeps its shape: `kanthord: db-migration-pending: <message>`, exit code `1`.

The gate runs **after** the home lock. A daemon that cannot take the home must not report a migration problem it never verified, and the home lock is also what serialises `db migrate` against a running daemon — `.agents/plan/stories/003-storage/index.md:75`.

## Constraints

- The gate reads. It never applies a migration, and it never creates the database directory.
- Do not add `db-migration-pending` to `src/http/contract/errors.ts`. A startup refusal is not an HTTP error, per `.agents/plan/epics/001-runtime-foundation.md:65`.
- Do not import `MigrationStatus`, `Storage` or any other service type into `src/http/server/migration-gate.ts`.
- One message format. Do not branch on `pending.length` to produce a singular wording.

## Verify

`node --test src/http/server/migration-gate.test.ts` — new file, suite `"src/http/server/migration-gate.test"`:

- `assertMigrated({ home: "/h", pending: [] })` returns `undefined` and throws nothing.
- `assertMigrated({ home: "/h", pending: [{ version: 2, name: "0002-graph-and-plan" }] })` throws, and the caught error satisfies `error instanceof StartupError`, `error.code === "db-migration-pending"`, `error.name === "StartupError"`, and `error.message` is exactly `"the daemon home /h has unapplied migrations 0002-graph-and-plan; run kanthord db migrate"`.
- Two pending entries supplied out of order — `[{ version: 3, name: "0003-execution-and-journal" }, { version: 2, name: "0002-graph-and-plan" }]` — produce the message with `"0002-graph-and-plan, 0003-execution-and-journal"` in version order. The input order does not reach the message.
- The message names the command: `error.message` includes the substring `"kanthord db migrate"`. Asserted separately from the exact-string case, because that substring is the rule `docs/proposal/api/system.md:36` states and it must not be lost to a rewording.
- `StartupError` is not a `ConfigError` and not a `HomeLockError`, so `src/main.ts` cannot catch it by accident through an existing branch.

`node --test src/services/home-lock/startup.test.ts` — the existing file, extended with two child-process cases. Each uses `createTemporaryHome()` from `test/helpers/home.ts` and `launchDaemon` from `test/helpers/daemon.ts`, and its `after()` calls `killAll()` before `home.dispose()`:

- **The daemon refuses an unmigrated database.** Write the config with `writeConfig()`, launch the daemon against the fresh home, and assert `exited()` gives `code === 1`. Assert `stderr()` matches `/^kanthord: db-migration-pending: [^\n]+\n$/` — one line exactly, the shape `src/services/home-lock/startup.test.ts:96` already established. Assert `stderr()` includes `"kanthord db migrate"`. Assert `stdout()` does not include `"kanthord: ready"`.
- **The daemon starts after `db migrate` on the same home.** Run `node src/main.ts db migrate --home <home>` to completion through `spawnSync(process.execPath, [...])` with `env: {}`, assert its status is `0`, then launch the daemon against the same home and `await ready()`. Assert `stderr()` is `""`. The two halves must use the same home directory, which is what makes this the ordering proof the epic asks for rather than two independent cases.
- The second case also asserts the database file exists at `join(home.path, "kanthord.db")` after `db migrate` and before the launch, so a failure points at the migration rather than at the gate.

`npm run verify` exits 0.

Proof: contributes `src/http/server/migration-gate.test.ts` to `node --test src/http/**/*.test.ts`.
