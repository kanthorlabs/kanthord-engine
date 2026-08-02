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
- **`services/home-lock`** — the interface, and an implementation that takes an advisory lock held by an open handle, so the kernel releases it however the process dies. A second daemon refuses and names the holder. `src/main.ts` acquires it before it opens any mutable service, and holds it until shutdown.
- **Startup sequence and the lock sweep** — take the home lock first, then remove every `*.lock` file in the bare home once. No running operation ever removes one.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/config/*.test.ts src/services/lock/*.test.ts \
  && echo "PASS EPIC-001"
```

Hermetic coverage required beyond the Proof:

- Two daemons against one temporary home: the second exits non-zero and its message names the first.
- A daemon killed with `SIGKILL` leaves no held lock, and the next start takes it.
- A `*.lock` file placed in the home before startup is gone after startup, and a `*.lock` file created during a running operation survives.
