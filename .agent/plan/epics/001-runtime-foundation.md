# EPIC 001 — Runtime foundation

Status: **draft**.

## Goal

The daemon starts from a packaged entry point, reads a discovered configuration file, and takes an exclusive lock on its home for the life of the process. A second daemon against one home refuses to start and names the holder.

## Non-goals

- No HTTP server. EPIC 004 opens the port.
- No database. EPIC 003 opens the file.
- No journal reconciliation. The startup sweep removes `*.lock` files and nothing else; the journal is phase 3.
- No graceful shutdown. The kernel releases the home lock on process death, and the `SIGKILL` case is asserted, so a second release path adds a code path without adding a guarantee.

## Stories

- **Config service on convict** — the master key, the HTTP bind address, the HTTP token, the `Host` allow list, the actor name, and the default attempt limit of 3. A schema violation fails at load, not at first use.
- **Config discovery and packaged entry points** — the daemon binary and the CLI binary, the file search order, and the version each reports.
- **Layer boundaries** — `eslint-plugin-boundaries` rules for `services`, `domain`, `commands`, `queries`, `http` and `cli`, with the allowed dependency direction of `docs/proposal/phase-1/domain.md`.
- **Startup refusal rules** — a non-loopback bind address with no token configured refuses to start; no master key refuses to start.
- **`services/home-lock`** — the interface, and the SQLite implementation: `<home>/daemon.lock.db` with `busy_timeout = 0`, `locking_mode = NORMAL`, `journal_mode = DELETE`, and a `BEGIN IMMEDIATE` held for the life of the process with no further SQL on that connection. The connection never leaves the capability, and exactly one instance is constructed. A network filesystem is refused at startup, and a corrupt lock database fails closed and is never deleted.
- **Holder identity** — `<home>/daemon.lock.identity` written to a temporary name and renamed into place, published only **after** the lock is held. A contender waits briefly for it, retries `BEGIN IMMEDIATE` once, then refuses. Identity is diagnostic and never decides ownership.
- **Startup sequence and the lock sweep** — `src/main.ts` acquires the home lock before it opens any mutable service, writes the identity into the lock file, then removes every `*.lock` file in the bare home once. No running operation ever removes one.
- **Harness helpers** — `test/helpers/`: a temporary daemon home, the temporary-database convention every later test uses, a child-process launcher for the two-daemon cases, and the teardown that releases the home lock. It lives here because EPIC 003 already builds on the temporary-database convention and EPIC 004 needs an application factory beside it. The git smart-HTTP fixture stays in EPIC 005.
- **Staged `npm run verify`** — `verify` runs `typecheck`, `test` and `lint` only. `node src/main.ts db status` leaves the script here, because `docs/proposal/api/system.md` makes `db status` an HTTP client command and no daemon exists yet. EPIC 009 restores it as a daemon-backed step. Every epic gate is `npm run verify`, so a gate that cannot pass at the epic it gates is a planning defect.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/config/*.test.ts src/services/lock/*.test.ts \
  && echo "PASS EPIC-001"
```

Hermetic coverage required beyond the Proof:

- Two daemons against one temporary home: the second exits non-zero and names the first from the identity file. The daemon's own database still writes while the lock is held.
- A daemon killed with `SIGKILL` leaves no held lock, and the next start takes it with no cleanup step and no wait, including when a `daemon.lock.db-journal` survives the kill.
- A held lock with no identity file, or a truncated one, still refuses the second daemon, and the message says the identity is unavailable.
- The home lock is held before the `*.lock` sweep runs, asserted by ordering rather than by timing.
- A `*.lock` file placed in the home before startup is gone after startup, and a `*.lock` file created during a running operation survives.
