# EPIC 009 — CLI surface and composition root

Status: **draft**.

## Goal

The program is assembled. Every declared CLI command exists and reaches a registered operation, every `routed` operation is bound to a real command or query in `src/main.ts`, and `npm run verify` proves it against a daemon it starts itself.

This epic exists because a phase can close with every unit test green and no working program. A command can be written, exported, unit tested and never referenced by the composition root, and nothing in EPICs 001 to 008 notices.

## Non-goals

- No new domain behaviour, with one declared exception. Every command and query this epic wires already exists, except `system.status`: `kanthord status` cannot report nodes by kind and state against a route that answers `501`, and EPIC 010 runs after this epic. This epic therefore authors the `system.status` schema, query and handler. `blob.show` and `event.list` stay with EPIC 010.
- No later-phase execution. `kanthord run` reports `not-implemented`; it does not start a run.
- No `501` route sweep. EPIC 010 enumerates the registry.

## Stories

- **The declared CLI inventory** — one authored module listing every command the proposal declares, each bound to every `operationId` it calls, in call order. Two sources are needed and neither is sufficient alone: `docs/proposal/api/` names a CLI command beside a route in its Source column, and `docs/proposal/phase-1/README.md` names the eight commands the P1-E1 oracle runs. `kanthord db migrate` and `kanthord serve` are the two entries that call no route, and both are marked rather than omitted.
- **CLI inventory parity** — the assertion that each declared command exists in the commander program, that every `operationId` it calls is registered, and that no command calls an operation absent from the registry. Parity is one way on purpose: most operations are deliberately not CLI commands, so the assertion covers declared commands, never every route.
- **`system.status`** — the response schema, the query and the handler, so `kanthord status` has a route to answer it. The daemon version, the bind address, the process start time, nodes by kind and state, the repositories in `needs-reconcile`, and the expired leases of either subject kind.
- **`kanthord status`** — the CLI over `system.status`. P1-E1 reads two objectives and four tasks from it.
- **`kanthord run`** — the one CLI command that fronts a `stubbed` route. It calls `run.start`, receives `501 not-implemented`, exits non-zero, and writes no state. The exit code routes on the error `code` and never on `message`.
- **Graceful shutdown** — the daemon answers `SIGTERM` and `SIGINT` by closing the listener, closing storage and releasing the home lock, in that order, then exits zero. Today `src/main.ts` discards the listening server, installs no handler and never releases the lock on the serve path, so every consumer kills the process outright. A composition root that cannot be stopped cleanly is not assembled, and the `verify` step below stops a daemon on every run.
- **The composition root, asserted complete** — a test that starts the real application from `src/main.ts` against a temporary home and a migrated database, then calls every `routed` operation with valid fixtures, and drives `kanthord status` and `kanthord run` through the real binary. It fails when an operation is unbound, when it resolves to the shared `501` handler, and when a service implementation was never constructed. Asserting only "not the 501 handler" would still pass a route whose dependencies were never wired.

  "Complete" means every `routed` operation this phase has implemented. `blob.show` and `event.list` belong to EPIC 010, so the test pins them as the exact remaining set rather than ignoring them: a third unbound operation fails the assertion, and EPIC 010 empties the set.

- **Daemon-backed `npm run verify`** — `verify` regains its `db status` step, now correct: migrate a temporary home, start the daemon on a loopback port with a token, call `db status` over HTTP, stop the daemon, and remove the home. EPIC 001 staged `verify` without it because `docs/proposal/api/system.md` makes `db status` an HTTP client command and no daemon existed then.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/cli/**/*.test.ts \
  src/main.test.ts \
  src/queries/system/*.test.ts \
  src/http/server/system/*.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/contract/system.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/openapi.test.ts \
  scripts/verify-db-status.test.ts \
  && echo "PASS EPIC-009"
```

Nine globs, because this epic writes into six directories. `src/cli/**` alone would print `PASS EPIC-009` with the `system.status` route, the shutdown path and the verify step entirely unbuilt. `Gates: npm run verify` stays the real collector; the Proof is the focused run over what this epic writes.

Hermetic coverage required beyond the Proof:

- Removing a handler binding from `src/main.ts` fails the composition-root test, and the failure names the operation.
- Adding a declared CLI command to the inventory without implementing it fails the parity assertion.
- `kanthord status` and `kanthord run` each answer against the started daemon **through the real binary**, so the CLI-to-HTTP path is proved and not assumed. `kanthord run` leaves `kanthord status` unchanged, and the daemon and the CLI report one version.
- `SIGTERM` to a running daemon exits zero and releases the home lock, proved by acquiring the same home afterwards.
- `npm run verify` leaves no daemon process, no temporary home and no held home lock, asserted after a failing run as well as a passing one.
