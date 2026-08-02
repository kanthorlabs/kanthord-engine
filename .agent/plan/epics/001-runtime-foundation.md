# EPIC 001 — Runtime foundation

Status: **draft**.

## Goal

The daemon starts from a packaged entry point, reads a discovered configuration file, and takes an exclusive lock on its home for the life of the process. A second daemon against one home refuses to start and names the holder.

## Non-goals

- No HTTP server. EPIC 004 opens the port.
- No database. EPIC 003 opens the file.
- No journal reconciliation. The startup sweep removes `*.lock` files and nothing else; the journal is phase 3.

## Stories

- **Config service on convict** — the master key, the HTTP bind address, the HTTP token, the `Host` allow list, the actor name, and the default attempt limit of 3. A schema violation fails at load, not at first use.
- **Config discovery and packaged entry points** — the daemon binary and the CLI binary, the file search order, and the version each reports.
- **Layer boundaries** — `eslint-plugin-boundaries` rules for `services`, `domain`, `commands`, `queries`, `http` and `cli`, with the allowed dependency direction of `docs/proposal/phase-1/domain.md`.
- **Startup refusal rules** — a non-loopback bind address with no token configured refuses to start; no master key refuses to start.
- **The `fcntl` binding** — a plain Node-API addon under `native/home-lock/` with a `binding.gyp`, exposing one attempt that returns either the acquired handle or the holder pid from `F_GETLK`. Plain Node-API, not V8 or NAN, so a prebuild survives a Node upgrade. A platform with no prebuild builds from source; a platform that cannot build fails loudly, and there is no socket or pid-file fallback.
- **`services/home-lock`** — the interface, and the POSIX implementation over that binding: `<home>/daemon.lock` opened `O_RDWR | O_CREAT | O_CLOEXEC` mode `0600`, `F_WRLCK` over `[0, 1)` by `F_SETLK`, descriptor held for the life of the process and never exposed outside the capability. On contention it calls `F_GETLK`, retries `F_SETLK` once, then refuses. A network filesystem is refused at startup.
- **Startup sequence and the lock sweep** — `src/main.ts` acquires the home lock before it opens any mutable service, writes the identity into the lock file, then removes every `*.lock` file in the bare home once. No running operation ever removes one.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/config/*.test.ts src/services/lock/*.test.ts \
  && echo "PASS EPIC-001"
```

Hermetic coverage required beyond the Proof:

- Two daemons against one temporary home: the second exits non-zero and its message names the first by the pid `F_GETLK` reported, not by the file contents.
- A daemon killed with `SIGKILL` leaves no held lock, and the next start takes it with no cleanup step and no wait.
- A lock file whose identity JSON is absent, truncated or contradicts the kernel pid still refuses the second daemon, and the message says the identity is unavailable.
- The home lock is held before the `*.lock` sweep runs, asserted by ordering rather than by timing.
- A `*.lock` file placed in the home before startup is gone after startup, and a `*.lock` file created during a running operation survives.
