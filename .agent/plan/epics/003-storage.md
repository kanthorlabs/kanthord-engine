# EPIC 003 — Storage

Status: **draft**.

## Goal

Every phase-1 table exists on `node:sqlite`. `kanthord db migrate` applies migrations directly, and a second run changes nothing. A secret is encrypted at rest, a large payload is content-addressed, and a transition can append an event.

## Non-goals

- No `db status` route. That is HTTP, and it belongs to EPIC 004.
- No business logic. Commands and queries arrive with their use case.

## Stories

- **Connection and pragmas** — `node:sqlite`, the pragmas, and the temporary-file convention every test uses.
- **Migration runner** — the `migration` table, ordered application, and idempotence on a second run.
- **`kanthord db migrate`** — the one command that opens SQLite directly. It refuses a non-loopback base URL, because the schema of another machine is not reachable from here.
- **Registry DDL** — `repository`, `project`, `project_binding`, `provider`, `profile`.
- **Graph DDL** — `node`, `edge`, `plan_revision`, with the `CHECK` clauses that restate the state machine and with `choices_blob`.
- **Execution DDL** — `workspace`, `lease`, `run`, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation`.
- **Crypto service** — the master key from configuration, encrypt and decrypt a `provider` secret. No route reads a secret back.
- **Blob store and the event log** — content-addressed write and read on `sha256:<hex>`, and the append path every transition uses.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/storage/**/*.test.ts \
  && node src/main.ts db migrate --home "$(mktemp -d)" \
  && echo "PASS EPIC-003"
```

Hermetic coverage required beyond the Proof:

- A `CHECK` clause refuses a task in `partial` and a task in `awaiting_approval`, at the database level.
- A `blocked` row with no block reason is refused, and a non-blocked row with one is refused.
- The same bytes written twice produce one blob row and one hash.
