# EPIC 010 — Contract completion

Status: **draft**.

## Goal

Every route in `docs/proposal/api/` answers. A phase-1 route answers with data, a later-phase route answers `501 not-implemented` and writes no state, and a `post-mvp` path answers `404`.

## What EPIC 004.5 already did

`004.5` authored the request and response schemas for every phase-1 read operation, plus a validated
example set, ahead of the handlers, because a second repository builds against them. So this epic no
longer authors the `system.status` and `event.list` schema pairs — it implements their handlers and
authors `blob.show`, whose media contract is not a body schema. The non-goal below is unchanged in
substance: a `stubbed` operation still carries no schema.

## Non-goals

- No later-phase behaviour. A `501` route is a **registry entry** and nothing more. EPIC 004 already declared its identity — `operationId`, method, path tuple, `introducedIn` and `status` — and it carries no request or response schema until the phase that implements it. "One zod schema pair per `operationId`" is a uniqueness rule, not a completeness rule: a schema belongs to exactly one operation and no second copy exists outside `src/http/contract/`, and an operation with no schema is correct rather than incomplete. So this epic authors three schema pairs — `system.status`, `blob.show` and `event.list` — and none for a stubbed route. A stub never reads a body, because dispatch answers `501` before the body parser runs.

## Stories

- **`system.status`** — the daemon version, the bind address, the start time, nodes by state, the repository reconciliation line, and the stale lease line. The shape exists even where phase 1 leaves a list empty.
- **`blob.show`** — the `sha256:<hex>` path parameter, the content type, the caching and `ETag` behaviour, the `Range` behaviour, and the bearer requirement.
- **`event.list`** — cursor paging over an append-only log, with the filters the domain declares. An offset cannot page it.
- **The `501` sweep** — every stubbed `operationId` answers `501` and writes no state. The assertion enumerates the route registry, so a new stub is covered without a hand-written list.
- **The `404` sweep** — every `post-mvp` path answers `404`, because `501` says "this daemon will do it" and `404` says "this daemon does not have this operation". A `post-mvp` row has no registry entry, so this sweep reads the proposal matrix of `docs/proposal/api/` directly. The registry parity assertion of EPIC 004 covers `routed` and `stubbed` only, and these two sources must not be swapped.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/http/contract/**/*.test.ts && echo "PASS EPIC-010"
```

Hermetic coverage required beyond the Proof:

- The `501` sweep calls every stubbed route and asserts, after each call, that no table gained a row.
- Adding a stubbed route to the registry without a `501` handler fails the sweep.
