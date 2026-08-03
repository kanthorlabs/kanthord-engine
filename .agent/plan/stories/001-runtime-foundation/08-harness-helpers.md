# Story 08 — Harness helpers

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: Story 03 for `test/helpers/` and the `test/**/*.ts` type check, and Story 02 for `kanthord serve`'s entry file.
Consumers: Story 07 here, EPIC 003 for the temporary-database convention, EPIC 004 for the application factory it puts beside these.

## Change

**1. `test/helpers/home.ts`** — new file.

```ts
export type TemporaryHome = Readonly<{
  path: string;
  writeConfig(overrides?: Readonly<Record<string, unknown>>): string;
  dispose(): void;
}>;

export function createTemporaryHome(): TemporaryHome;
```

- `path` is `fs.mkdtempSync(join(tmpdir(), "kanthord-home-"))`.
- `writeConfig` writes `join(path, "kanthord.config.json")` and returns that path. The base document is exactly:

```ts
{
  home: path,
  actor: "ulrich",
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  http: {
    bind: "127.0.0.1",
    port: 7421,
    token: "test-token",
    allowedHosts: ["127.0.0.1:7421"],
  },
  attemptLimit: 3,
}
```

`overrides` merges over it at the top level, and an `http` key in `overrides` merges one level deep over the base `http`. No deeper merge. A value of `undefined` in `overrides` **deletes** that key, so a test can build an invalid document.

`7421` is this fixture's port, not a product default. `docs/proposal/` names no default port and `http.port` is a required setting. EPIC 001 opens no port, so nothing binds it here.

- `dispose()` is `fs.rmSync(path, { recursive: true, force: true })`.

**2. `test/helpers/database.ts`** — new file. This is the convention EPIC 003 builds on, so its shape is fixed here.

```ts
export type TemporaryDatabase = Readonly<{ path: string; dispose(): void }>;

export function createTemporaryDatabase(): TemporaryDatabase;
```

- `path` is `join(fs.mkdtempSync(join(tmpdir(), "kanthord-db-")), "kanthord.db")`. The file itself is not created; SQLite creates it.
- `dispose()` removes the containing directory recursively, so a `-journal` or a `-wal` sibling goes with it. A helper that unlinked only `path` would leak.

**3. `test/helpers/daemon.ts`** — new file.

```ts
export type DaemonExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type DaemonProcess = Readonly<{
  pid: number;
  ready(): Promise<void>;
  exited(): Promise<DaemonExit>;
  stdout(): string;
  stderr(): string;
  kill(signal?: NodeJS.Signals): void;
}>;

export type LaunchInput = Readonly<{
  configPath?: string;
  home?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>;

export function launchDaemon(input: LaunchInput): DaemonProcess;
export function killAll(): Promise<void>;
```

- `entry` is `fileURLToPath(new URL("../../src/main.ts", import.meta.url))`.
- `spawn(process.execPath, [entry, ...globalOptions, "serve"], { cwd: input.cwd ?? tmpdir(), env: { ...(input.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] })`.
- `globalOptions` is `--config <configPath>` when present, then `--home <home>` when present. Both precede `serve`, because commander reads a program-level option before the subcommand.
- `env` does **not** inherit `process.env`. `process.execPath` is an absolute path, so no `PATH` is needed, and an inherited `HOME` or `XDG_CONFIG_HOME` would break the discovery tests of Story 07.
- `stdout()` and `stderr()` return everything collected so far, as utf8.
- `ready()` resolves when the collected stdout contains `kanthord: ready\n`. It rejects when the process exits first, with a message holding the exit code, the signal and the collected stderr. It rejects after 5000 ms with the same detail. No passing assertion depends on that timeout.
- `exited()` resolves on the `exit` event with `{ code, signal }`. Calling it after the exit resolves with the recorded value.
- `kill(signal = "SIGTERM")`.
- The module keeps every launched process in a private list. `killAll()` sends `SIGKILL` to each one that is still running, awaits every exit, and clears the list. A test calls it in `after`, and that is what releases the home lock: the kernel releases it on process death, and the product installs no release path.

## Constraints

- These helpers hold no assertion and import nothing from `src/`, except that `daemon.ts` names `src/main.ts` as a spawn argument. It must not `import` it — a `test-helper` element importing the composition root is a lint error, and the Verify section of this story pins that as a lint case.
- Each helper owns its own `mkdtemp` directory. No helper reads or writes a shared temporary path, and none of them reads `process.env`.
- `writeConfig` builds its document from the literal above every call. No module-level mutable base object, because one test's override would leak into the next.

## Verify

`node --test test/helpers/home.test.ts`, which asserts:

- `createTemporaryHome()` returns a `path` that exists and is a directory.
- `writeConfig()` writes a file whose `JSON.parse` deep-equals the base document, with `home` equal to the temporary path.
- `writeConfig({ actor: "someone" })` changes `actor` and leaves every other key at its base value.
- `writeConfig({ http: { bind: "0.0.0.0" } })` yields `http.port` `7421`, `http.token` `"test-token"` and `http.allowedHosts` `["127.0.0.1:7421"]` unchanged, with `bind` replaced.
- `writeConfig({ actor: undefined })` yields a document with no `actor` key, asserted with `Object.hasOwn`.
- Two `writeConfig` calls on one home, the first with an override, leave the second at the base document. This is the leak guard.
- `dispose()` removes the directory, and a second `dispose()` does not throw.

`node --test test/helpers/database.test.ts`, which asserts:

- `path` ends with `kanthord.db` and its parent directory exists, and the file does not yet exist.
- Opening `path` with `node:sqlite`, creating a table and inserting a row works, and the row reads back.
- `dispose()` after that removes the parent directory, and a second `dispose()` does not throw.

`node --test test/helpers/daemon.test.ts`, which asserts. Every test calls `killAll()` and every home's `dispose()` in `after`:

- A daemon launched with a written config reaches `ready()`, and `stdout()` holds `kanthord: ready`.
- `kill("SIGTERM")` makes `exited()` resolve, and `signal` is `SIGTERM`.
- A daemon launched with no config, an empty `env` and a `cwd` of a fresh temporary directory exits non-zero, and `ready()` rejects with a message holding its stderr. The test first asserts `/etc/kanthord/config.json` does not exist, and fails naming it if it does. A child process reads the real `/etc`, and only the unit test of Story 02 can inject an `etcDir`.
- `--home` reaches the process: a daemon launched with `home` pointed at a second temporary directory creates `daemon.lock.db` there and not in the config's `home`.
- `killAll()` with two live daemons resolves, and both `exited()` promises resolve.

`node --test test/helpers/lint.test.ts` gains the two cases Story 03 could not write, because this story creates the first non-test helper:

| `filePath`               | import              | expected `ruleIds`            |
| ------------------------ | ------------------- | ----------------------------- |
| `test/helpers/daemon.ts` | `../../src/main.ts` | `["boundaries/dependencies"]` |
| `test/helpers/daemon.ts` | `./home.ts`         | `[]`                          |

The first case is the guard on the `test-helper` policy of Story 03. Without it that policy is committed and never exercised.

`npm run verify` exits 0.

Proof: `PASS 001-HARNESS`, and the two added cases under `PASS 001-BOUNDARIES`.
