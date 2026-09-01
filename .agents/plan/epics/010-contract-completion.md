# EPIC 010 — Contract completion

Status: **ready**.

## Goal

Every route in `docs/proposal/api/` answers. A phase-1 route answers with data, a later-phase route answers `501 not-implemented` and writes no state, and a `post-mvp` path answers `404`.

## What EPIC 009.5 already did

`009.5` authored the `event.list` request and response pair, typed the error `details` per code,
tightened every authored schema to reject an unknown key, and published the document with a validated
example set, because a second repository builds against it. So this epic no longer authors the
`event.list` schema pair — it implements that handler and authors `blob.show`, whose media contract is
not a body schema. The non-goal below is unchanged in substance: a `stubbed` operation still carries no
schema.

`system.status` is no longer this epic's either. EPIC 009 needs `kanthord status` to answer with data,
and 009 runs first, so 009 authors the `system.status` schema, query and handler. This epic inherits
one consequence: `.agents/plan/stories/009-cli-and-composition-root/07-composition-root-asserted-complete.md`
pins `["blob.show", "event.list"]` as the exact set of `routed` operations with no handler, and the
stories below empty that constant.

## Non-goals

- No later-phase behaviour. A `501` route is a **registry entry** and nothing more. EPIC 004 already declared its identity — `operationId`, method, path tuple, `introducedIn` and `status` — and it carries no request or response schema until the phase that implements it. "One zod schema pair per `operationId`" is a uniqueness rule, not a completeness rule: a schema belongs to exactly one operation and no second copy exists outside `src/http/contract/`, and an operation with no schema is correct rather than incomplete. So this epic authors **no** zod schema pair, and none for a stubbed route. `blob.show` returns bytes, so it declares a media contract — one `responseMedia` field on its registry entry — rather than a request and response schema. A stub never reads a body, because dispatch answers `501` before the body parser runs.
- No `system.status`. EPIC 009 owns it, schema and handler both.

## Stories

- **`blob.show`** — the `sha256:<hex>` path parameter, the content type, the caching and `ETag` behaviour, the `Range` behaviour, and the bearer requirement.
- **`event.list`** — cursor paging over an append-only log, with the filters the domain declares. An offset cannot page it. **No `wait`.** `docs/proposal/api/event.md` defers the long poll to phase 2, so a phase-1 daemon rejects the parameter and a client polls the cursor on its own timer.
- **The `event` filter indexes** — the five filter columns and the cursor carry an index, in one migration. A full scan per filtered read is the cost of shipping the route without one.
- **The `501` sweep** — every stubbed `operationId` answers `501` and writes no state. The assertion enumerates the route registry, so a new stub is covered without a hand-written list.
- **The `404` sweep** — every `post-mvp` path answers `404`, because `501` says "this daemon will do it" and `404` says "this daemon does not have this operation". A `post-mvp` row has no registry entry, so this sweep reads the proposal matrix of `docs/proposal/api/` directly. The registry parity assertion of EPIC 004 covers `routed` and `stubbed` only, and these two sources must not be swapped.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/system.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/event.test.ts \
  src/http/server/query.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/route.test.ts \
  src/http/server/app.test.ts \
  src/http/server/blob/*.test.ts \
  src/http/server/event/*.test.ts \
  src/queries/blob/*.test.ts \
  src/queries/event/*.test.ts \
  test/helpers/database.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-010"
```

The glob `src/http/contract/**/*.test.ts` was the Proof and it collected none of the handlers, neither sweep and no part of the transport widening. Fourteen entries replace it, one per directory this epic writes plus the four test files it edits without adding.

Hermetic coverage required beyond the Proof:

- The `501` sweep calls every stubbed route and asserts, after each call, that no table gained a row.
- Adding a stubbed route to the registry without a `501` handler fails the sweep.
