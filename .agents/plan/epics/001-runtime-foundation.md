# EPIC 001 — Runtime foundation

Status: **ready**.

## Goal

The daemon starts from a packaged entry point, reads a discovered configuration file, and takes an exclusive lock on its home for the life of the process. A second daemon against one home refuses to start and names the holder.

## Non-goals

- No HTTP server. EPIC 004 opens the port.
- No database. EPIC 003 opens the file.
- No journal reconciliation, and no removal of anything from the home. EPIC 007.5 owns every remnant, because removing one safely needs a reap that needs a journal row.
- No graceful shutdown. The kernel releases the home lock on process death, and the `SIGKILL` case is asserted, so a second release path adds a code path without adding a guarantee.
- No `src/cli/` program here. `src/main.ts` parses `--version`, `--config`, `--home` and `serve` and nothing else. `src/cli/` opens at EPIC 003, not EPIC 004: `AGENTS.md` puts the `kanthord db migrate` handler in the commander program with `main.ts` injecting it, so EPIC 003 creates `src/cli/base-url.ts` and `src/cli/db/migrate.ts`. EPIC 004 refactors both into its program skeleton. Command logic in `src/main.ts` would also be untestable except through a child process, because a test may not import the composition root.

## Stories

- **Config service on convict** — the master key, the HTTP bind address, the HTTP token, the `Host` allow list, the actor name, and the default attempt limit of 3. A schema violation fails at load, not at first use.
- **Config discovery and packaged entry points** — one `kanthord` binary, the file search order, and the version it reports.
- **Layer boundaries** — `eslint-plugin-boundaries` rules for `services`, `domain`, `commands`, `queries`, `http` and `cli`, with the allowed dependency direction of `docs/proposal/phase-1/domain.md`.
- **Startup refusal rules** — a non-loopback bind address with no token configured refuses to start; no master key refuses to start.
- **`services/home-lock`** — the interface, and the SQLite implementation: `<home>/daemon.lock.db` with `busy_timeout = 0`, `locking_mode = NORMAL`, `journal_mode = DELETE`, and a `BEGIN IMMEDIATE` held for the life of the process with no further SQL on that connection. The connection never leaves the capability, and exactly one instance is constructed. A network filesystem is refused at startup, and a corrupt lock database fails closed and is never deleted.
- **Holder identity** — `<home>/daemon.lock.identity` written to a temporary name and renamed into place, published only **after** the lock is held. A contender waits briefly for it, retries `BEGIN IMMEDIATE` once, then refuses. Identity is diagnostic and never decides ownership.
- **Startup sequence** — `src/main.ts` acquires the home lock before it opens any mutable service, writes the identity into the lock file in the bare home once. No running operation ever removes one.
- **Harness helpers** — `test/helpers/`: a temporary daemon home, the temporary-database convention every later test uses, a child-process launcher for the two-daemon cases, and the teardown that releases the home lock. It lives here because EPIC 003 already builds on the temporary-database convention and EPIC 004 needs an application factory beside it. The git smart-HTTP fixture stays in EPIC 005.
- **Staged `npm run verify`** — `verify` runs `typecheck`, `test` and `lint` only. `node src/main.ts db status` leaves the script here, because `docs/proposal/api/system.md` makes `db status` an HTTP client command and no daemon exists yet. EPIC 009 restores it as a daemon-backed step. Every epic gate is `npm run verify`, so a gate that cannot pass at the epic it gates is a planning defect.

## Decisions taken here

`docs/proposal/` names each of these and decides none of them. They are pinned here so that no story hands a choice to build time. Each one is a candidate for a proposal amendment, and none of them changes a proposal rule.

**One packaged binary.** `package.json` declares `bin: { "kanthord": "./src/main.ts" }`. The daemon is `kanthord serve`. There is no second executable, so the P1-E1 version-parity oracle compares `kanthord --version` against the version `system.status` reports, which EPIC 010 delivers. Two bin names for one file would make that oracle assert nothing.

The `bin` target is proved here as far as this epic can prove it: `src/main.ts` carries the shebang and the executable bit, the Proof invokes `./src/main.ts` through that shebang rather than through `node`, and a test asserts the `bin` map names a file that exists, is executable, and starts with `#!/usr/bin/env node`. `npm pack`, an install and an invocation of the linked `kanthord` name belong to P1-E1 in EPIC 011, which exists because a unit suite cannot see packaging.

**The config search order.** First existing path wins. The format is JSON, because convict parses it with no parser registration.

```
1. --config <path>                         explicit; absent => refuse, naming that path
2. $KANTHORD_CONFIG
3. <cwd>/kanthord.config.json
4. $XDG_CONFIG_HOME/kanthord/config.json   default $HOME/.config/kanthord/config.json
5. /etc/kanthord/config.json
```

No file at any location refuses startup and prints every path in this order. That is the P1-E1 oracle.

**The settings.** Precedence is flag, then environment variable, then file, then default.

| Key                 | Type                | Default     | Environment variable          |
| ------------------- | ------------------- | ----------- | ----------------------------- |
| `home`              | directory path      | required    | `KANTHORD_HOME`               |
| `actor`             | non-empty string    | required    | `KANTHORD_ACTOR`              |
| `masterKey`         | base64, 32 bytes    | `""`        | `KANTHORD_MASTER_KEY`         |
| `masterKeyFile`     | file path           | `""`        | `KANTHORD_MASTER_KEY_FILE`    |
| `http.bind`         | string              | `127.0.0.1` | `KANTHORD_HTTP_BIND`          |
| `http.port`         | port                | required    | `KANTHORD_HTTP_PORT`          |
| `http.token`        | string              | `""`        | `KANTHORD_HTTP_TOKEN`         |
| `http.allowedHosts` | non-empty string[]  | required    | `KANTHORD_HTTP_ALLOWED_HOSTS` |
| `attemptLimit`      | integer, at least 1 | `3`         | `KANTHORD_ATTEMPT_LIMIT`      |

`--config <path>` and `--home <path>` are the two flags. `--home` overrides `home`. `http.port` carries no default, because a default port collides on a shared machine and the collision surfaces as a bind failure rather than as a configuration mistake.

**The startup error codes.** A startup refusal is not an HTTP error, so it uses its own closed set and never a code from the table of `docs/proposal/api/README.md`. Every refusal writes one line to stderr, `kanthord: <code>: <message>`, and exits `1`.

`config-not-found`, `config-invalid`, `config-refused`, `home-network-filesystem`, `home-lock-corrupt`, `home-locked`.

**The supported platforms are Linux and Darwin.** Every rule here assumes POSIX: a `fcntl` record lock, a file mode, `SIGTERM` and `SIGKILL`. Windows is out of scope for phase 1, and a test may assert a signal name and an octal mode without a platform branch.

**The network-filesystem refusal is effective where the platform reports a type.** `docs/proposal/phase-1/git-foundation.md:90-94` states the scope: Linux reports a filesystem magic number and the home is refused on a denied type; Darwin reports a kernel table index, so the type is unreadable and startup continues. Measured: APFS answers `type: 26`, an index into a kernel table. Node exposes no `f_fstypename` and no mount table, and reading the type through the `git` binary or a native addon is refused for the same reasons the lock itself refuses them.

`StatfsProbe` therefore takes its `platform` and its `statfs` function as constructor arguments, answers `network` for a magic number in the deny set on Linux, and answers `unknown` on every other platform. `acquire` refuses `network` and admits `unknown`. Both branches are asserted, so the scope is a tested rule rather than an omission.

Deny set: NFS `0x6969`, CIFS `0xff534d42`, SMB2 `0xfe534d42`, FUSE `0x65735546`, 9P `0x01021997`, CEPH `0x00c36400`, LUSTRE `0x0bd00bd0`, AFS `0x5346414f`, GFS2 `0x01161970`, OCFS2 `0x7461636f`. FUSE is in the set because the P1-E4 topology of `docs/proposal/phase-1/README.md` requires a host bind mount to be refused.

**A capability is an element, and same-capability imports need no policy.** `eslint.config.js:32` declares one element for the whole of `src/services`, so it cannot tell a same-capability import from a cross-capability one. The element becomes `src/services/*` with a `capability` capture. Measured with the installed `eslint-plugin-boundaries@7.0.2`: the plugin allows an import inside one element by default, and a capture-templated same-capability policy matches every pair instead, which silently reopens the rule. So the fix is the capture alone, with no extra policy.

**Ordering is structural, and it is also observed.** `HomeLock.acquire()` returns a `HeldHome`, and `publishIdentity()` is a method on it. There is no way to reach either without holding the lock, and the module exports only `SqliteHomeLock`, so no free function can sweep. That is the structural half, and on its own it proves only the exported names. The observed half is one pair of child-process assertions: at the readiness line a second daemon is already refused, and at that same line a `*.lock` planted before startup is already gone. A held lock and a completed sweep are both true at one observable instant, which is the guarantee the proposal asks for.

**The ULID and the timestamp are minted in `src/main.ts` and passed in.** AGENTS.md requires a ULID to come from a service. No id service and no clock service exist until EPIC 002, and the composition root is the one place allowed to name a concrete value. So `serve` calls `ulid()`, `new Date().toISOString()`, `process.pid` and `hostname()` itself and passes the whole `HomeIdentity` into `publishIdentity`. `services/home-lock` mints nothing, which is the rule that matters. EPIC 002 replaces the two ambient calls with the id and clock service interfaces, and the signature it calls does not change. No test asserts a minted value: every test passes its own identity.

**Nothing is removed from the home.** This epic once specified a `*.lock` sweep on the home lock alone. A `git` child outlives the daemon, so the lock does not prove that no `git` is running, and deleting a lock a live `git` still owns corrupts a repository. EPIC 007.5 restores the capability behind a reap. See `docs/proposal/phase-3/recovery.md`.

**The daemon's own database.** EPIC 003 opens no file here, so the "writes normally while the lock is held" rule is proved against a second `node:sqlite` database at `<home>/kanthord.db` opened by the test. The guarantee is that a dedicated lock file blocks no other database in the same home, and that needs no schema.

**Recovery from a hot journal is the requirement; producing one is not.** Measured on Node 24.17.0: `BEGIN IMMEDIATE` with `journal_mode = DELETE` writes a 512-byte `daemon.lock.db-journal` at once, a `SIGKILL` leaves it behind, and the next `acquire` rolls it back, removes it and succeeds. Journal creation depends on the SQLite build and on which pages a transaction touched, so it is a canary and never a product invariant. The unit test asserts the journal exists under our own configuration, directly after our own `BEGIN IMMEDIATE`. The child-process test asserts only what the proposal requires: after a `SIGKILL`, the next daemon reaches readiness with no cleanup step. It asserts nothing about the journal, because the new holder opens one of its own the moment it acquires. `docs/proposal/phase-1/git-foundation.md:96` forbids removing a journal by hand, so SQLite performs every rollback and every removal.

**The refusal is dispatched on `errcode`.** `node:sqlite` throws one `Error` with `code: "ERR_SQLITE_ERROR"` for both conditions, and only `errcode` separates them. Measured: a held lock gives `errcode 5`, `"database is locked"`; a file that is not a database gives `errcode 26`, `"file is not a database"`. `5` enters the contender path, and every other `errcode` becomes `home-lock-corrupt`. Nothing dispatches on `message`.

**The lock file mode is set before SQLite opens it, and it is set on an existing file too.** `new DatabaseSync(path)` creates the file `0644`. The `mode` argument of `fs.openSync` applies only when the call creates the file, so a `daemon.lock.db` left at `0644` by an earlier version would keep it — measured. The implementation opens the path with `fs.openSync(path, "a", 0o600)`, calls `fs.fchmodSync(fd, 0o600)` on the descriptor, then closes it. It never unlinks the path, so the inode survives.

**A stale identity is removed by the new holder, not by a contender.** `acquire` unlinks `<home>/daemon.lock.identity` immediately after it takes the lock, before it returns the handle. Without that step the sequence "A publishes, A dies, B acquires, B has not published yet" leaves a contender naming A — a dead process — while `docs/proposal/phase-1/git-foundation.md:94` requires the identity to report as unavailable in exactly that window. The removal is safe because the lock is already held, and it never reads the file to decide anything.

**No test sleeps, and no production sleep is called in a test.** `SqliteHomeLock` takes a `sleeper` function as a constructor argument, defaulting to the `Atomics.wait` implementation. Every contender test injects a counting sleeper and passes an explicit `identityWaitMs` and `identityPollMs`, so the wait is asserted by call count rather than by elapsed time.

**The contender wait is a parameter.** `identityWaitMs` defaults to `200` and `identityPollMs` to `20`. A test passes `identityWaitMs: 0`, so no assertion depends on wall-clock time.

**The version is one constant.** `src/domain/version.ts` exports `KANTHORD_VERSION`. `src/domain/version.test.ts` asserts it equals the `version` field of `package.json`, so the literal cannot drift. `src/domain/` stays pure, and `src/cli/` reads the same constant in EPIC 004 without importing a service.

**The readiness line.** `kanthord serve` prints `kanthord: ready` to stdout after the sweep. The harness launcher waits for that exact line, so no test sleeps.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test src/domain/version.test.ts src/services/config/*.test.ts \
  && echo "PASS 001-CONFIG" \
  && node --test src/services/home-lock/*.test.ts \
  && echo "PASS 001-HOME-LOCK" \
  && node --test test/helpers/lint.test.ts \
  && echo "PASS 001-BOUNDARIES" \
  && node --test test/helpers/home.test.ts test/helpers/database.test.ts \
    test/helpers/daemon.test.ts \
  && echo "PASS 001-HARNESS" \
  && ./src/main.ts --version \
  && echo "PASS 001-ENTRY" \
  && echo "PASS EPIC-001"
```

Hermetic coverage required beyond the Proof:

- Two daemons against one temporary home: the second exits non-zero and names the first from the identity file. A second `node:sqlite` database in the same home still writes while the lock is held.
- A daemon killed with `SIGKILL` leaves no held lock, and the next start takes it with no cleanup step and no wait. The next daemon prints `kanthord: ready` and nothing else, and writes nothing to stderr.
- A held lock with no identity file, or a truncated one, still refuses the second daemon, and the message says the identity is unavailable.
- The identity a dead predecessor published never names the live holder. A published identity, a killed holder, a second daemon that acquired and has not published, and a third contender: the third reports the identity as unavailable rather than naming the dead process.
- The home lock is held before the identity is published, asserted by construction rather than by timing.
- A `*.lock` file placed in the home before startup is still there after startup. This epic removes nothing, and EPIC 007.5 is where a stale lock is removed, after a reap proves it stale.
