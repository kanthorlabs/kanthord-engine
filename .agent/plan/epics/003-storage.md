# EPIC 003 — Storage

Status: **ready**.

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
- **Blob store and the event log** — content-addressed write and read on `sha256:<hex>`, and the append path every transition uses. A state write and its event append share one transaction, and the interface admits no way to do one without the other.

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
- Atomicity is proved by rollback in both directions: a failed event append leaves the state row unchanged, and a failed state write leaves no event. An available append path is not the same rule.
- The `profile` relational contract holds at the database level: the four columns under `STRICT`, the primary key, one profile per repository through the `UNIQUE` on `repository_id`, the foreign key to `repository`, and the foreign key from `content_blob` to `blob`. Nothing asserts the document, because phase 1 never parses one.
- `workspace.profile_blob` references `blob`, which is the pin phase 2 needs and phase 1 must not omit.
- The `agent_invocation.agent` `CHECK` clause and the domain agent-kind enum hold the same four values, asserted against each other so the two cannot drift.
