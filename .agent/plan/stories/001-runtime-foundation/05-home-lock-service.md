# Story 05 — `services/home-lock`

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: Story 03. The capability element must be `src/services/*` before a second capability exists.
Source: `docs/proposal/phase-1/git-foundation.md:59-92`.

## Change

**1. `src/services/home-lock/index.ts`** — new file, the interface only.

```ts
export type FilesystemKind = "local" | "network" | "unknown";

export interface FilesystemProbe {
  classify(path: string): FilesystemKind;
}

export interface HeldHome {
  readonly path: string;
  release(): void;
}

export type AcquireInput = Readonly<{ home: string }>;

export type HomeLockErrorCode =
  "home-network-filesystem" | "home-lock-corrupt" | "home-locked";

export class HomeLockError extends Error {
  readonly code: HomeLockErrorCode;
  constructor(code: HomeLockErrorCode, message: string) {
    super(message);
    this.name = "HomeLockError";
    this.code = code;
  }
}

export interface HomeLock {
  acquire(input: AcquireInput): HeldHome;
}
```

**2. `src/services/home-lock/statfs-probe.ts`** — new file.

```ts
export const NETWORK_FILESYSTEM_MAGICS: readonly number[];

export type StatfsProbeDependencies = Readonly<{
  platform: string;
  statfs: (path: string) => Readonly<{ type: number }>;
}>;

export class StatfsProbe implements FilesystemProbe {
  constructor(dependencies: StatfsProbeDependencies);
  classify(path: string): FilesystemKind;
}
```

`NETWORK_FILESYSTEM_MAGICS` holds exactly these ten values, in this order: `0x6969`, `0xff534d42`, `0xfe534d42`, `0x65735546`, `0x01021997`, `0x00c36400`, `0x0bd00bd0`, `0x5346414f`, `0x01161970`, `0x7461636f`.

`classify` returns `"unknown"` when `platform !== "linux"`. On Linux it reads `statfs(path).type` and returns `"network"` when the value is in the list, `"local"` otherwise.

`platform` and `statfs` are constructor arguments so that the Linux branch is covered on any machine and no assertion reads the host's own filesystem. `src/main.ts` constructs `new StatfsProbe({ platform: process.platform, statfs: fs.statfsSync })`.

`"unknown"` is admitted, and a network home on Darwin therefore starts. That is the stated scope of `docs/proposal/phase-1/git-foundation.md:90-94`, not an omission: the refusal is effective where the platform reports a filesystem type, and a deployment that needs it enforced runs on Linux. Do not refuse `unknown` — Darwin answers nothing else, so that would refuse every Darwin start.

**3. `src/services/home-lock/sqlite.ts`** — new file.

```ts
export type SqliteHomeLockDependencies = Readonly<{
  probe: FilesystemProbe;
  sleeper?: (milliseconds: number) => void;
}>;

export class SqliteHomeLock implements HomeLock {
  constructor(dependencies: SqliteHomeLockDependencies);
  acquire(input: AcquireInput): HeldHome;
}
```

`sleeper` defaults to `(ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }`. Story 06 is its only caller. It is a constructor argument so that no test in this capability sleeps.

`acquire` runs exactly these steps, in this order:

1. A second call on the same instance throws `new Error("the home lock is already held")`. That is a wiring defect, not a runtime condition, so it carries no `HomeLockError` code.
2. `fs.mkdirSync(input.home, { recursive: true, mode: 0o700 })`.
3. `probe.classify(input.home)`. `"network"` throws `HomeLockError("home-network-filesystem", ...)` naming the path. `"local"` and `"unknown"` both continue.
4. `lockPath = join(input.home, "daemon.lock.db")`. `fd = fs.openSync(lockPath, "a", 0o600)`, then `fs.fchmodSync(fd, 0o600)`, then `fs.closeSync(fd)`. Two measured facts force both calls: `new DatabaseSync(path)` creates a missing file `0644`, and the `mode` argument of `openSync` applies only when the call creates the file, so an existing `0644` lock database keeps `0644` without the `fchmodSync`. Never unlink to fix a mode — the inode must survive.
5. Inside one `try`: `new DatabaseSync(lockPath)`, then `exec` these four statements in this order — `PRAGMA busy_timeout = 0`, `PRAGMA locking_mode = NORMAL`, `PRAGMA journal_mode = DELETE`, `BEGIN IMMEDIATE`.
6. On a throw: close the connection when it was constructed, then dispatch on `error.errcode`. `5` throws `HomeLockError("home-locked", "the daemon home <path> is locked by another process")`. Every other value throws `HomeLockError("home-lock-corrupt", "<path> is not a usable lock database: <errstr>")`.
7. The lock is now held. `fs.rmSync(join(input.home, "daemon.lock.identity"), { force: true })`. A predecessor's identity file outlives the predecessor, and leaving it would let a contender name a dead process while this holder has not published yet. `docs/proposal/phase-1/git-foundation.md:94` requires that window to report the identity as unavailable.
8. Return a `HeldHome` holding the connection in a private field. `release()` calls `close()` once and sets a private released flag. Measured: `DatabaseSync.close()` twice throws `ERR_INVALID_STATE`, so the flag is what makes `release()` idempotent.

Run no further SQL on that connection, ever. The transaction is the lock.

**4. `test/helpers/lint.test.ts`** — add the two cases Story 03 could not write, because this story creates the second capability:

| `filePath`                         | import                 | expected `ruleIds`            |
| ---------------------------------- | ---------------------- | ----------------------------- |
| `src/services/home-lock/sqlite.ts` | `../config/convict.ts` | `["boundaries/dependencies"]` |
| `src/services/home-lock/sqlite.ts` | `../config/index.ts`   | `[]`                          |

## Constraints

- The `DatabaseSync` connection never leaves `src/services/home-lock/`. It is not a field of `HeldHome`'s public type, not a return value and not an argument.
- Never unlink, truncate or recreate `daemon.lock.db`, in any branch. Unlinking a path another process holds by inode is how one home gets two owners.
- Dispatch on `error.errcode`, never on `error.message`. `node:sqlite` reports both conditions as `code: "ERR_SQLITE_ERROR"`.
- `sqlite.ts` imports `./index.ts`, `node:fs`, `node:path` and `node:sqlite`. It imports no other capability's implementation.
- `acquire` is synchronous. Do not return a promise.

## Verify

`node --test src/services/home-lock/statfs-probe.test.ts`, which asserts. Every case injects `platform` and `statfs`, so no assertion reads the host's own filesystem and every branch runs on every platform:

- `NETWORK_FILESYSTEM_MAGICS` deep-equals the ten values above, in that order. This is the guard against a silent edit to the deny set.
- `platform: "linux"` with a `statfs` returning each of the ten magic numbers gives `"network"` — ten cases, driven from the exported array.
- `platform: "linux"` with a `statfs` returning `0xef53` (ext4) gives `"local"`, and `0x01021994` (tmpfs) gives `"local"`.
- `platform: "darwin"` gives `"unknown"`, and the injected `statfs` is never called, counted by the test's own closure. `platform: "win32"` gives `"unknown"` the same way.
- `platform: "linux"` with a `statfs` that throws propagates the throw. A home whose filesystem cannot be read is not silently `"local"`.

`node --test src/services/home-lock/sqlite.test.ts`, which asserts. Each test makes its own `fs.mkdtempSync(join(tmpdir(), "kanthord-home-"))` and removes it in `after`. The probe is a hand-written object, never `StatfsProbe`:

- A fake probe answering `"local"` acquires, `daemon.lock.db` exists, and `statSync(lockPath).mode & 0o777` is `0o600`.
- An existing `daemon.lock.db` created by the test at mode `0o644` is `0o600` after `acquire`, and its inode is unchanged, compared through `statSync(...).ino` before and after. This is the case the `mode` argument of `openSync` alone does not cover.
- `acquire` on a home directory that does not exist creates it, and `statSync(home).mode & 0o777` is `0o700`.
- A mock probe answering `"network"` throws `HomeLockError` with `code === "home-network-filesystem"`, the message names the home path, and `daemon.lock.db` was never created.
- A probe answering `"unknown"` acquires. This is the Darwin path.
- A second `acquire` on the same `SqliteHomeLock` instance throws `/already held/` and is not a `HomeLockError`.
- Two `SqliteHomeLock` instances against one home: the second throws `code === "home-locked"`, and the message names the home path.
- After the first instance's `release()`, a third instance acquires.
- `release()` twice does not throw.
- A `daemon.lock.db` holding the bytes `not a database at all` throws `code === "home-lock-corrupt"`, the file still exists, and its bytes are unchanged, compared with `Buffer.equals`.
- A second `node:sqlite` database at `join(home, "kanthord.db")` creates a table and inserts a row while the lock is held, and the row reads back. The lock file blocks no other database in the same home.
- `BEGIN IMMEDIATE` leaves `daemon.lock.db-journal` present while the lock is held, and `release()` removes it. This is a canary on our own pragma set, measured directly after our own `BEGIN IMMEDIATE`. It is not a product invariant, and no child-process test asserts that a kill leaves one.
- A `daemon.lock.identity` written by the test before `acquire` is gone after `acquire` returns. A stale identity never survives a new holder.

`node --test test/helpers/lint.test.ts` covers the two added cases.

`npm run verify` exits 0.

Proof: `PASS 001-HOME-LOCK`, and the two added cases under `PASS 001-BOUNDARIES`.
