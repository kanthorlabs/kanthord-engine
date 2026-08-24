# Story 03 — `kanthord db migrate`

Epic: `.agents/plan/epics/003-storage.md`
Depends on: Story 02 (`SqliteStorage`), Story 04 (`src/services/storage/migrations.ts` holds at least one migration).

`AGENTS.md` fixes the shape: "`main.ts` constructs the storage implementation and passes the migration handler into the commander program." The command therefore lives in `src/cli/`, and it names no service. `src/cli/` does not exist yet, and this story creates the first two files in it.

## Change

### 1. `src/cli/base-url.ts` (new)

```ts
export function isLoopbackUrl(value: string): boolean;
```

Exact behaviour. Parse with `new URL(value)` inside a `try`; a throw returns `false`. Return `false` unless `url.protocol` is `"http:"` or `"https:"`. Then return `true` when `url.hostname` is `"localhost"`, `"::1"` or `"[::1]"`, or matches `/^127\.\d+\.\d+\.\d+$/`. Return `false` otherwise.

`new URL("http://[::1]:7421").hostname` is `"[::1]"`, with the brackets. Both spellings are accepted.

This file is the single loopback classifier. EPIC 004 gives the CLI its shared base URL and imports this function; `cli/` may import `cli/`.

### 2. `src/cli/db/migrate.ts` (new)

```ts
import type { Command } from "commander";

import { isLoopbackUrl } from "../base-url.ts";

export type AppliedMigrationLine = Readonly<{ version: number; name: string }>;

export type MigrateHandler = (
  input: Readonly<{ home: string | undefined }>,
) => readonly AppliedMigrationLine[];

export type RegisterDbMigrateInput = Readonly<{
  program: Command;
  migrate: MigrateHandler;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerDbMigrate(input: RegisterDbMigrateInput): void;
```

`registerDbMigrate` declares the commands and nothing else:

```ts
input.program
  .command("db")
  .description("database maintenance")
  .command("migrate")
  .description("apply every pending migration to the daemon database")
  .option("--home <path>", "override the configured daemon home")
  .option("--base-url <url>", "daemon base url; a non-loopback url is refused")
  .action((options) => { … });
```

`db migrate` declares its own `--home`, because commander does not accept a program option written after a subcommand.

The action body, exactly:

1. `const baseUrl = options.baseUrl ?? input.env.KANTHORD_BASE_URL;`
2. When `baseUrl` is a non-empty string and `isLoopbackUrl(baseUrl)` is `false`: call `input.stderr` with the line `kanthord: db-remote-base-url: <baseUrl> is not a loopback daemon; db migrate opens the database file on the daemon machine`, terminated by one newline, where `<baseUrl>` is the value. Then call `input.fail()` and return. `input.migrate` is not called, so nothing on disk is touched.
3. `const applied = input.migrate({ home: options.home ?? input.program.opts().home });`
4. When `applied.length === 0`, call `input.stdout("kanthord: no change\n")`. Otherwise call `input.stdout` once per entry, in array order, with `` `kanthord: applied ${entry.version} ${entry.name}\n` ``.

`MigrateHandler` is a plain callback type declared here. `src/cli/` imports no service and no command, and it never learns that SQLite exists.

### 3. `src/main.ts` — construct the handler and bind it

`src/main.ts:1-13` holds the imports, `:14-18` the program, `:20-59` the `serve` command and `:61` the `parseAsync`. Add to the import block:

```ts
import fs from "node:fs";
import { join } from "node:path";

import { SystemClock } from "./services/clock/system.ts";
import { SqliteStorage } from "./services/storage/sqlite.ts";
import { StorageError } from "./services/storage/index.ts";
import { migrations } from "./services/storage/migrations.ts";
import { registerDbMigrate } from "./cli/db/migrate.ts";
```

Between the `serve` block and `parseAsync`, add one call:

```ts
registerDbMigrate({
  program,
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fail: () => {
    process.exitCode = 1;
  },
  migrate: (input) => { … },
});
```

The handler body, exactly:

1. `const home = input.home ?? <configured home>`, where `<configured home>` is `new ConvictConfig().load({ explicitConfigPath: program.opts().config, env: process.env, cwd: process.cwd(), homeDir: homedir(), etcDir: "/etc" }).settings.home`. The configuration is loaded only when `input.home` is `undefined`.
2. Take the home lock for the whole operation, with the same construction `serve` uses at `src/main.ts:34-40`:
   `const held = new SqliteHomeLock({ probe: new StatfsProbe({ platform: process.platform, statfs: statfsSync }) }).acquire({ home });`
   `acquire` creates the home directory `0o700` (`src/services/home-lock/sqlite.ts:37`), so no separate `mkdirSync` is needed.
3. In a `try` whose `finally` calls `held.release()`:
   - `const storage = new SqliteStorage({ path: join(home, "kanthord.db"), clock: new SystemClock(), migrations });`
   - In a nested `try` whose `finally` calls `storage.close()`:
     - `const before = new Set(storage.status().applied.map((entry) => entry.version));`
     - `const after = storage.migrate();`
     - return `after.applied.filter((entry) => !before.has(entry.version)).map(({ version, name }) => ({ version, name }));`
   - A throw from `storage.close()` inside the `finally` is not caught. A throw from the body wins over it, because `finally` runs before the body's error propagates and a `close()` throw would replace it — so `close()` is called as `try { storage.close(); } catch { /* the body error wins */ }` when the body already threw. Implement it as one `let failed = false;` set in a `catch (error) { failed = true; throw error; }`, and a `finally` that swallows a `close()` throw only when `failed` is `true`.
4. The whole `registerDbMigrate` call is wrapped by the same `try`/`catch` shape as `serve` at `src/main.ts:51-58`, applied to `await program.parseAsync(process.argv)` at `src/main.ts:61`: a `ConfigError`, a `HomeLockError` or a `StorageError` writes `` `kanthord: ${error.code}: ${error.message}\n` `` to stderr and sets `process.exitCode = 1`. Any other error is rethrown. Every failure the handler can raise — configuration, the home lock, the `SqliteStorage` constructor, `status`, `migrate` and `close` — is one of those three types or a programming error.

## Constraints

- `db migrate` **holds the home lock** for the whole operation. It is an offline maintenance command: a running daemon owns the home, and a second concurrent `db migrate` must be refused rather than raced. The lock is the exclusion mechanism, so the runner needs none of its own, and the refusal is the existing `home-locked` message naming the holder.
- `db migrate` is the one command in the product that reaches storage without HTTP (`docs/proposal/api/system.md:36`). `src/cli/db/migrate.ts` still imports no service — the handler is injected, which is exactly what `AGENTS.md` requires.
- `serve` at `src/main.ts:20-59` is not modified.
- The refusal code `db-remote-base-url` is new, and it belongs to the startup-refusal set of EPIC 001 rather than to the HTTP code table. It is never a `StorageError` code.
- No route, no `db status`, no HTTP client, no `X-Kanthord-Client` header. This story adds the two files `AGENTS.md` names and no more. EPIC 004 refactors both into its commander program: `--base-url` becomes a program-level option with one resolver, and `isLoopbackUrl` is reused there rather than duplicated. `.agents/plan/epics/004-transport-skeleton.md` names that refactor, and it makes the tests of this story the regression suite for it.

## Verify

`node --test src/cli/base-url.test.ts` — new file, one suite named `"src/cli/base-url.test"`, table driven:

- `true` for `"http://127.0.0.1:7421"`, `"http://127.0.0.5:1"`, `"https://127.0.0.1"`, `"http://localhost:7421"`, `"http://[::1]:7421"`.
- `false` for `"https://daemon.example.com"`, `"http://10.0.0.1:7421"`, `"http://127.0.0.1.example.com"`, `"ssh://localhost"`, `"file:///tmp"`, `"not a url"`, `""`.

`node --test src/cli/db/migrate.test.ts` — new file, one suite named `"src/cli/db/migrate.test"`. Each case builds a fresh `new Command()`, a recording `stdout`/`stderr`/`fail`, and a `migrate` spy, then calls `program.parseAsync([...], { from: "user" })`.

- `["db", "migrate", "--home", "/tmp/h"]` with a spy returning `[{ version: 1, name: "0001-core-entities" }, { version: 2, name: "0002-graph-and-plan" }]`: the spy is called exactly once with `{ home: "/tmp/h" }`, stdout is exactly `"kanthord: applied 1 0001-core-entities\nkanthord: applied 2 0002-graph-and-plan\n"`, stderr is empty, `fail` was not called.
- The same with a spy returning `[]`: stdout is exactly `"kanthord: no change\n"`.
- `["db", "migrate"]` calls the spy with `{ home: undefined }`.
- `["db", "migrate", "--base-url", "https://daemon.example.com"]`: the spy is **not** called, `fail` was called once, and stderr starts with `"kanthord: db-remote-base-url:"`.
- The same base url supplied through `env: { KANTHORD_BASE_URL: "https://daemon.example.com" }` and no flag: same result. A flag of `"http://127.0.0.1:1"` with that same env value calls the spy — the flag wins.
- `["db", "migrate", "--base-url", "http://127.0.0.1:7421"]` calls the spy.

`node --test test/helpers/cli.test.ts` — new file, one suite named `"test/helpers/cli.test"`. This is the end-to-end half: it runs the real binary. `test/helpers/cli.ts` (new) mirrors `test/helpers/daemon.ts:26,39-43`:

```ts
export type CliResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

export type RunCliInput = Readonly<{
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}>;

export function runCli(input: RunCliInput): Promise<CliResult>;
```

The entry is `fileURLToPath(new URL("../../src/main.ts", import.meta.url))`, the child is `spawn(process.execPath, [entry, ...input.args], { cwd: input.cwd ?? tmpdir(), env: { ...(input.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] })`, and the promise resolves on `exit` with the accumulated streams. It never rejects on a non-zero exit.

Every case builds a home with `createTemporaryHome()` and calls `dispose()` after. The expected stdout of a first migration is **derived**, never typed twice:

```ts
const expected = migrations
  .map((entry) => `kanthord: applied ${entry.version} ${entry.name}\n`)
  .join("");
```

- `runCli({ args: ["--version"] })` returns `code === 0` and `stdout.trim()` equal to `KANTHORD_VERSION`.
- `runCli({ args: ["db", "migrate", "--home", home.path] })` returns `code === 0`, `stdout === expected`, and `fs.existsSync(join(home.path, "kanthord.db"))` is `true`.
- A second identical run returns `code === 0` and `stdout === "kanthord: no change\n"`.
- A home that does not exist yet — `join(home.path, "nested")` — is created by the home lock, and the run returns `code === 0`.
- `runCli({ args: ["db", "migrate", "--home", home.path, "--base-url", "https://daemon.example.com"] })` returns `code === 1`, empty stdout, `stderr.startsWith("kanthord: db-remote-base-url:")`, and no `kanthord.db`.
- The home lock is held and it excludes: with a daemon launched by `launchDaemon({ home: home.path, configPath })` and awaited to `ready()`, `runCli({ args: ["db", "migrate", "--home", home.path] })` returns `code === 1` and `stderr.startsWith("kanthord: home-locked:")`. Kill the daemon, and the same call then returns `code === 0`.
- With no `--home`: `runCli({ args: ["db", "migrate"], env: { KANTHORD_CONFIG: home.writeConfig() } })` returns `code === 0` and creates `join(home.path, "kanthord.db")` — the configured home is used.

`npm run verify` exits 0.

Proof: delivers `node src/main.ts db migrate --home "$(mktemp -d)"`, the second line of the EPIC Proof.
