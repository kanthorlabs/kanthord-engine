# EPIC 009 — CLI surface and composition root

Status: **draft**.

## Goal

The program is assembled. Every declared CLI command exists and reaches a registered operation, every `routed` operation is bound to a real command or query in `src/main.ts`, and `npm run verify` proves it against a daemon it starts itself.

This epic exists because a phase can close with every unit test green and no working program. A command can be written, exported, unit tested and never referenced by the composition root, and nothing in EPICs 001 to 008 notices.

## Non-goals

- No new domain behaviour. Every command and query this epic wires already exists.
- No later-phase execution. `kanthord run` reports `not-implemented`; it does not start a run.
- No `501` route sweep. EPIC 010 enumerates the registry.

## Stories

- **The declared CLI inventory** — one authored module listing every command the proposal declares, each bound to the `operationId` it calls. `docs/proposal/api/` names the CLI command beside the route in its Source column, and that column is the source. `kanthord db migrate` is the one entry that names no route, and it is marked rather than omitted.
- **CLI inventory parity** — the assertion that each declared command exists in the commander program, that it calls a registered `operationId`, and that no command calls an operation absent from the registry. Parity is one way on purpose: most operations are deliberately not CLI commands, so the assertion covers declared commands, never every route.
- **`kanthord status`** — the CLI over `system.status`. It reports nodes by kind and state, the repositories in `needs-reconcile`, and the expired leases. P1-E1 reads two objectives and four tasks from it.
- **`kanthord run`** — the one CLI command that fronts a `stubbed` route. It calls `run.start`, receives `501 not-implemented`, exits non-zero, and writes nothing. The exit code routes on the error `code` and never on `message`.
- **The composition root, asserted complete** — a test that constructs the real application from `src/main.ts` with a temporary home and a migrated database, then calls every `routed` operation with valid fixtures. It fails when an operation is unbound, when it resolves to the shared `501` handler, and when a service implementation was never constructed. Asserting only "not the 501 handler" would still pass a route whose dependencies were never wired.
- **Daemon-backed `npm run verify`** — `verify` regains its `db status` step, now correct: migrate a temporary home, start the daemon on a loopback port with a token, call `db status` over HTTP, stop the daemon, and remove the home. EPIC 001 staged `verify` without it because `docs/proposal/api/system.md` makes `db status` an HTTP client command and no daemon existed then.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/cli/**/*.test.ts src/main.test.ts && echo "PASS EPIC-009"
```

Hermetic coverage required beyond the Proof:

- Removing a handler binding from `src/main.ts` fails the composition-root test, and the failure names the operation.
- Adding a declared CLI command to the inventory without implementing it fails the parity assertion.
- `kanthord status` and `kanthord run` each answer against the started daemon rather than a stub, so the CLI-to-HTTP path is proved and not assumed.
- `npm run verify` leaves no daemon process, no temporary home and no held home lock, asserted after a failing run as well as a passing one.
