# EPIC 010 — Contract completion — stories

Epic: `.agents/plan/epics/010-contract-completion.md`
Prereq: EPIC 009 (sequence order), expanded at `.agents/plan/stories/009-cli-and-composition-root/` and not built.
**Hard prereq for Story 02: EPIC 009.5 — now built.** `eventListRequest`, `eventView` and `eventListResponse` exist at `src/http/contract/event.ts:11-31`. Story 02 is dispatch-ready and amends the filter cardinality of that pair. See B3.

Every route in `docs/proposal/api/` answers. `blob.show` and `event.list` answer with data, every `stubbed` route answers `501` and is proved to write no row, and every `post-mvp` path answers `404`.

## Dispatch order

```
01 ─┬─→ 04
    ├─→ 05
    └─→ 02 ─→ 03
```

- **`01` starts alone, and everything waits on it.** It touches `src/http/server/app.ts`, `dispatch.ts`, two new files (`query.ts`, `single.ts`) and `test/helpers/app.ts`.
- **`04`, `05` and `02` all unblock together** once `01` lands, and they run in parallel. `04` touches `dispatch.test.ts` and `test/helpers/database.ts`; `05` touches `route.test.ts`; `02` touches the event route, a migration and `src/main.ts`. No two share a file.
- `04` needs `01` for two reasons: both edit `src/http/server/dispatch.test.ts` (`01` extends the handler-context block at `:196-249`, `04` replaces the sweep at `:288-310`), and `04` imports the `drive` helper `01` exports.
- `05` needs `01` for `drive` only. It was independent until S3 moved that helper into `test/helpers/app.ts`; one shared helper is worth one edge.
- `02` needs `01` for `HandlerContext.query` and `singleValued`. It also needs EPIC 009.5's two schemas — see B3, the one open blocker.
- `03` needs `01` for `HandlerResult.headers` and `HandlerContext.headers`.
- **`02` and `03` both edit the `pending` constant of `src/main.test.ts`.** They must not run concurrently. Order is `02` then `03`; `03` writes the final `[]`.

## Stories

- 01 — the transport carries a query string and response headers → `01-transport-carries-query-and-headers.md`
- 02 — `event.list`: query, handler, binding → `02-event-list.md`
- 03 — `blob.show`: media contract, `Range`, query, handler, binding → `03-blob-show.md`
- 04 — the `501` sweep gains no row → `04-stub-sweep-writes-nothing.md`
- 05 — the `post-mvp` `404` sweep → `05-post-mvp-404-sweep.md`

Five stories for four EPIC bullets. `01` is the one addition this expansion makes: neither `blob.show` nor `event.list` is expressible through the current `HandlerContext` and `HandlerResult`, and folding the widening into either story would make the two conflict on the same three transport files.

## Where the code lands

| Directory            | Files this epic adds                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/http/server/`   | `query.ts`, `single.ts`, `blob/range.ts`, `blob/show-blob.ts`, `event/list-event.ts`                         |
| `src/queries/`       | `blob/show-blob.ts`, `event/list-event.ts`                                                                   |
| `src/http/contract/` | `responseMedia` on `operation.ts`, `system.ts`, `openapi.ts`, and one `registryFaults` rule in `registry.ts` |
| `src/services/`      | `storage/migration-0004-event-indexes.ts`                                                                    |
| `src/`               | two handler bindings and one `SqliteBlobStore` in `main.ts`                                                  |
| `test/helpers/`      | `tableCounts` and `drive` in `database.ts` and `app.ts`                                                      |

One migration — three indexes on `event`, no column and no table. No new operation, no new path, no new error code.

## Facts (needed for implementation)

State of the tree at the start of this epic. EPIC 008 and 009 are expanded and not built, so `src/main.test.ts`, `src/queries/project/*` and `src/http/server/project/*` are contracts of their stories rather than settled code.

- **The two services this epic reads are already written and one is unwired.** `SqliteEventLog.list` (`src/services/event/sqlite.ts:61-120`) implements all five filters, `WHERE id > ?` and `ORDER BY id ASC`. `SqliteBlobStore.get` (`src/services/blob/sqlite.ts:33-64`) reads the row and returns `null` on a miss. `SqliteBlobStore` is constructed **nowhere outside its own test** — Story 03 adds the one construction in `src/main.ts`.
- **`HandlerContext` has no query and no headers; `HandlerResult` has no headers.** `src/http/server/app.ts:21-31`. Nothing under `src/http/server/` sets a header or a content type today: the only writes are `context.status` and `context.body` at `dispatch.ts:34-35` and `envelope.ts:17-25`. `blob.show` is the first route that returns non-JSON bytes.
- **`src/main.ts` derives `unimplemented`; it is not a literal.** The `const unimplemented = registry…` block (currently `:257-260`) filters the registry by `status === "routed"` minus the keys of `handlers`. Binding a handler is therefore the whole edit — no second list to keep in step.
- **Every `src/main.ts` line number in these stories is provisional.** EPICs 008 and 009 are unbuilt and both edit that file heavily. Stories 02 and 03 name semantic anchors — `const events`, `const blobs`, `const handlers`, `const unimplemented` — and the line numbers are a reading aid only.
- **`http/server/` may not import a service, not even an interface.** `eslint.config.js:140-156` allows `domain`, `command`, `query`, `http-contract` and `http-server` only. A handler dependency typed `RecordedEvent` or `BlobRecord` fails `npm run lint`, which is why Stories 02 and 03 each export a view type from the query module. `src/domain/health.ts` in `.agents/plan/stories/009-cli-and-composition-root/04-system-status-route.md:65-76` solves the same problem for two queries.
- **A test reaches an implementation only in the capability it covers.** `AGENTS.md`, Tests. A test under `src/queries/` therefore mocks a service interface and never constructs `SqliteEventLog` or `SqliteBlobStore`; `src/services/event/sqlite.test.ts` and `src/services/blob/sqlite.test.ts` already cover those.
- **`bindingOffenders` enforces the exclusive-or.** `src/http/server/app.ts:90-117` throws `BindingError` when a routed id is in both lists or in neither, and when any id in either list is unknown or `stubbed`. Story 04's witness map relies on it.
- **The `501` for a stub and the `501` for an unbound routed operation are different strings.** `src/http/server/dispatch.ts:16-28`: `"<id> ships in <introducedIn>"` versus `"<id> is not implemented yet"`. Both carry `code: "not-implemented"`.
- **Twenty-one unimplemented ids stay twenty-one.** `src/http/server/app.test.ts:160-165` and `dispatch.test.ts:182-194` compute `unimplementedFor({ "system.health", "system.db" })` from the registry (`test/helpers/app.ts:16-23`), not from `src/main.ts`. This epic binds two handlers in `src/main.ts` and neither number moves.
- **The registry counts move by nothing.** `src/http/contract/registry.test.ts:14-16` (53 entries) and `:29-38` (23 routed / 30 stubbed), `parity.test.ts` in full, and `openapi.test.ts:74-80` (47 paths) and `:112-120` (53 ids) are all untouched. This epic adds no operation.
- **`blob.show` is the one operation whose path parameter is keyed `hash`.** `src/http/contract/path.ts:92` builds `{ kind: "parameter", value: "hash" }`; `registry.test.ts:105-118` pins it; `registry.ts:205-210` raises `"non-minted locator outside blob"` for any other. A colon is legal in a path segment and nothing is percent-encoded (`docs/proposal/api/system.md:75`).
- **The `event` table has no sequence and no timestamp column.** `src/services/storage/migration-0003-execution-and-journal.ts:146-154`. The ULID id is the only order and the only clock; `identityTime` (`src/domain/identity.ts:133-145`) decodes it and `src/services/event/sqlite.ts:113` already fills `occurredAt`. Every filter column is unindexed today; Story 02 adds `migration-0004-event-indexes.ts`, three composite indexes each ending in `id`.
- **A query may not import another query, and may not import a service implementation.** `eslint.config.js:117-129`. Both new queries take a service interface and call it once.
- **`Transaction` is synchronous.** `src/services/storage/index.ts:1-5`; `connection.ts:90-101` rolls back and throws on a returned promise. Both new queries are synchronous end to end.
- **`src/domain/rows.ts:21` is the closed table inventory**, nineteen entries, with `TableName` at `:43`. Story 04's `tableCounts` walks it, so a new table joins the no-write snapshot with no test edit.
- **A migrated database reports three applied migrations today and four after Story 02.** `src/services/storage/migrations.ts:6-10`. `src/services/storage/migration-0002-graph-and-plan.test.ts:231-232` deep-equals the exact three-entry list and is the assertion Story 02 moves. Story 04's helper test pins the resulting count, so **Story 04 must read four** if it lands after Story 02, and three if before. Story 04 asserts `migrations.length` rather than a literal, and pins the literal in Story 02's own migration test.
- **`test/helpers/proposal.ts:59-88` is the only reader of `docs/proposal/api/`.** It excludes `README.md` and `new-decisions.md`, accepts a table row only when it has five cells and cell 2 is a valid `introducedIn`, and returns a sixth `source` field. No production file reads the proposal.
- **The four `post-mvp` rows are `binding.e2e.project`, `binding.provider.agents`, `binding.provider.project` and `event.stream`.** Every one also carries `status: "deferred"`, and no other row carries either value. `src/http/contract/parity.test.ts:24-36` already pins them from the registry side.
- **`createTestApp` is the app builder and supertest is the client.** `test/helpers/app.ts:34-84` defaults `token = "test-token"` and `allowedHosts = ["kanthord.test"]`, and its `get/post/put/del` pre-set `Host` and `Authorization` while `raw` does not. `test/helpers/agent.ts:8-29` binds one loopback server per app in a `WeakMap` and calls `server.unref()`.
- **`createMigratedStorage()` hardwires a mock clock** at `{ start: 1700000000000, step: 1000 }` (`test/helpers/database.ts:30-46`). `createMockIdGenerator({ ulids })` (`test/helpers/ids.ts:8-25`) replays a fixed list and throws `ids-exhausted` when drained.
- **Bytewise ordering is the house rule and is duplicated, never exported.** `Buffer.compare(Buffer.from(a), Buffer.from(b))` at `registry.ts:36`, `parity.ts:87`, `openapi.ts:137`, `test/helpers/proposal.ts:120` and `openapi.test.ts:24`. Every new comparator in this epic copies it verbatim.
- **A test name spells its counts in words.** `"registers fifty-three operations"`, `"renders forty-seven distinct paths"`. A `describe` name is the test file's repo path minus `.ts`; `openapi.test.ts` is the one file that uses flat `test()`.

### Source facts the stories depend on

- `blob.show`'s six-clause contract is `docs/proposal/api/system.md:73-80`. The blob table is `docs/proposal/database/blob.md:5-20`; `hash` is `sha256:<lowercase hex>` and the prefix is stored, not implied.
- `event.list`'s filters and cursor are `docs/proposal/api/event.md:16-24`. The `wait` long poll is specified at `:36`.
- `501` versus `404` is `docs/proposal/api/README.md:54-56` and `new-decisions.md:14`. "A route of a later phase answers `501 not-implemented` and writes no state."
- The error code matrix is `docs/proposal/api/README.md:165-187`. It declares **no `416`**, which is why Story 03 ignores an unsatisfiable `Range`.
- No route is readable without the token, and a registered and an unregistered path answer identically: `docs/proposal/api/README.md:207`.
- `docs/proposal/api/README.md:11` keeps a field schema out of the proposal. No story edits a file under `docs/`.

## Decisions this expansion settled

- **The transport widening is its own story and lands first.** Both remaining phase-1 routes need it, and it is the one change that touches `app.ts` and `dispatch.ts`. Splitting it out keeps Stories 02 and 03 off each other's files except for the one `src/main.test.ts` literal.
- **`readQuery` runs inside dispatch, not as its own middleware.** A duplicate query key on a `stubbed` route must still answer `501`, and `dispatch.ts:16-21` throws the `501` before the parse. A middleware placed before dispatch would answer `400` and invert the two.
- **The transport reports every query value and refuses nothing; the operation owns cardinality.** `readQuery` returns `Record<string, readonly string[]>` and throws nothing. `singleValued` collapses the lists and answers `400 invalid-request` on a repeat, naming the bytewise-first offender, and `event.list` is its only caller. Last-value-wins was rejected because it makes `?limit=1&limit=500` silently mean `500`; a transport-wide refusal was rejected because it sets a policy for every future operation.
- **A response header map is applied to `context.set` in bytewise key order, before the body.** That fixes the middleware's own call sequence and stops Koa overwriting an explicit `Content-Type`. It does **not** make the wire header order deterministic — `node:http` adds `date`, `content-length` and `connection` — and no test asserts one.
- **`response` and `responseMedia` are mutually exclusive, enforced by a `registryFaults` rule.** Allowing both and letting one win silently would make contradictory registry data legal.
- **Two view types are exported from the query modules, `EventView` and `BlobView`.** A handler may not import a service, so a handler dependency cannot be typed `RecordedEvent` or `BlobRecord`.
- **Both new query tests mock the service interface.** These queries are one-call adapters; their tests prove exact argument forwarding and return identity. Filtering, cursor behaviour, hashing and deduplication belong to the service implementation tests that already exist.
- **Story 04's claim is "gains no row", not "writes nothing".** A row count cannot see an `UPDATE` or a `DELETE` offset by an `INSERT`. `writes === 0` is the stronger assertion; the count snapshot is kept because it is the EPIC's literal wording.
- **Story 05 does not claim to prove the two sources are unswapped.** Registry parity already makes the two sets equal, so no assertion over them can distinguish which was read. Provenance is visible in the source: one sweep iterates `registry`, the other iterates `readRouteMatrix()`.
- **An array-valued request header is joined with `", "`.** That is the one form `node:http` produces, and it keeps the boundary type a plain string in both directions.
- **`responseMedia` is a new optional `Operation` field, not a `response` schema.** `blob.show` returns bytes. `.agents/plan/epics/009.5-contract-schemas.md:58-60` excluded it from the schema slice for exactly this reason, and `src/http/contract/system.test.ts:168-171` — `blob.show` carries no response schema — stays true unweakened.
- **The OpenAPI binary body is inline, not a component.** `{ type: "string", format: "binary" }` under the declared media type. `components.schemas` gains no key, so `openapi.test.ts:205-230` is untouched by this epic.
- **An unsatisfiable or unparseable `Range` is ignored and the whole payload is returned with `200`**, and `Cache-Control` is `private, immutable, max-age=31536000`. Both are now stated in `docs/proposal/api/system.md`, with the reason for the `200`: a `Range` is a client optimisation rather than a precondition, so the whole payload always satisfies the request the client made. The route never answers `416` and never answers `304`.
- **No `If-None-Match` and no `304`.** `docs/proposal/api/system.md:73-80` declares neither, and this epic invents no clause.
- **A malformed blob hash is `404`, not `400`.** `docs/proposal/api/system.md:80` — "An unknown hash is `404 not-found`". Validating with `src/domain/blob.ts:5` in the handler also means the query never triggers `BlobStoreError`.
- **`event.list` returns no cursor field.** `docs/proposal/api/event.md:18` makes `after` the id of the last event read, so the client already holds the value and a `nextAfter` field would be a second authority for it.
- **The `501` sweep binds a witness handler to every `routed` operation.** A sweep against an app with no handlers proves nothing, because nothing could have written. The witness makes `writes === 0` mean "dispatch refused" rather than "nothing was reachable", and the companion routed case proves the witness works.
- **The no-write snapshot walks `src/domain/rows.ts`, not a hand-written table list.** A new table joins the sweep with no test edit.
- **The `404` sweep reads the proposal matrix and the `501` sweep reads the registry.** A `post-mvp` row has no registry entry, so the registry cannot be its source; a stub has no proposal-only existence, so the proposal is not its source. Story 05 Case 3 asserts the two sets are disjoint, which is what makes the swap a test failure rather than a review comment.
- **Story 05 also asserts a post-mvp path answers `401` without a token.** `docs/proposal/api/README.md:207` requires a registered and an unregistered path to be indistinguishable, and a `404` sweep that only ran authenticated would let that regress.

## Open items

This section was rewritten twice: once after an adversarial review, once after Ulrich settled the nine items it raised. Fifteen review findings changed a story — the handler types broke the import matrix, both query tests broke the test import rule, `responseMedia` allowed contradictory registry data, the `Range` and cache decisions were planner inventions, the `501` sweep overclaimed and miscounted the tables, three assertions in the `404` sweep were redundant or unprovable, the response-header test claimed a wire order it cannot fix, the `event.list` fixtures used ids that fail their own schema, `parseRange` ignored unsafe integers, the dispatch order contradicted itself, EPIC 009.5 was a real prerequisite, and every `src/main.ts` line anchor was going to go stale.

**One blocker is open, and it blocks Story 02 alone. Stories 01, 03, 04 and 05 are dispatch-ready.**

### Settled

- B1 - **done** - epic-proof-widened - `.agents/plan/epics/010-contract-completion.md` now runs fourteen entries instead of `src/http/contract/**/*.test.ts`, which collected none of the handlers, neither sweep and no part of the transport widening. `Gates: npm run verify` is unchanged and stays the real collector.

- B2 - **done, proposal amended** - wait-is-phase-2 - `docs/proposal/api/event.md` now marks `wait` phase-2 in both the `event.list` and the `event.stream` sections, and states that a phase-1 daemon answers `400 invalid-request`. A phase-1 client polls the cursor on its own timer, which is the same mechanism with the wait on the client side, so no client code is discarded when `wait` arrives.

  This was the only fix that had to reach `docs/proposal/`. An EPIC non-goal would not have done: `AGENTS.md` makes the proposal the source of truth, so a story answering `400` to a declared phase-1 parameter would have left EPIC 010 unable to claim contract completion whatever its own EPIC file said. Story 02's `?wait=5` test now asserts specified behaviour instead of recording a gap.

- B3 - **done** - event.list-schemas-reconciled - EPIC 009.5 is built and `src/http/contract/event.ts` holds `eventListRequest`, `eventView` and `eventListResponse`. What it shipped differed from Story 02's quote on three points, and Ulrich settled all three:

  - **The wire timestamp stays `createdAt`**, the shipped and conventional name. `RecordedEvent` keeps `occurredAt`, and the **handler** renames it — a handler does parse, invoke and format, and a rename to the wire name is formatting. `src/queries/event/list-event.ts` stays a pure pass-through.
  - **The six filter fields move from `.nullable().default(null)` to `.optional()`**, which Story 02 section 1 now performs. A query string cannot carry JSON `null`, so the nullable branch was reachable only through its own default. Under `.optional()`, `eventListRequest.parse({})` returns exactly `{ limit: 100 }` and is structurally `EventFilter`, so no `null`-to-`undefined` translation exists anywhere in the epic.
  - **`after` and `subject` stay `z.string().min(1)`**, not `identity("event")` / `anyIdentity`. 009.5 settled that deliberately; Story 02 drops the identity-typed expectations, and `?after=repo_…` is now a `200` with an empty page rather than a `400`.

  Consequence: Story 02 is the one story in this epic that edits `src/http/contract/`. The `Where the code lands` row above understates it by that much.

- B4 - **done, proposal amended** - range-and-caching-are-now-specified - `docs/proposal/api/system.md` states the three accepted `Range` forms, the `206` with `Content-Range`, `Accept-Ranges: bytes` on every response, the `200` fallback for anything else, the explicit refusal of `416` with its reason, `max-age=31536000`, and the refusal of `If-None-Match` and `304`. Story 03 implements the proposal instead of inventing it, and the `["200", "default"]` OpenAPI question dissolves with it.

- S1 - **done, and the chosen fix does not work as stated** - no-blob-size-cap - Ulrich chose "no cap; stream instead". **`node:sqlite` cannot stream a BLOB**: `DatabaseSync` in Node 24.17 exposes `open, close, prepare, exec, function, createTagStore, location, aggregate, createSession, applyChangeset, enableLoadExtension, enableDefensive, loadExtension, serialize, deserialize, setAuthorizer` and no `blobOpen`, so there is no incremental blob API and a column read always materializes one buffer. A stream body would have wrapped a buffer already in memory and bounded nothing.

  Delivered instead: the intent of the choice minus the mechanism. `docs/proposal/database/blob.md` records that there is **no cap**, that `blob.show` materializes the payload, why streaming cannot change that, and that `size` serves `Content-Length` rather than a refusal. No threshold is invented and `HandlerResult` is not widened for a stream. The real fix — moving `content` out of the row — is named as belonging to the epic that first writes a payload large enough to matter.

- S2 - **done** - event-filter-indexes - Story 02 adds `migration-0004-event-indexes.ts`: three composite indexes, `event_subject (subject_kind, subject_id, id)`, `event_type (type, id)` and `event_actor (actor_kind, actor_id, id)`. Three rather than five, because `docs/proposal/api/event.md` describes kind-plus-id as the shape a client sends; each ends in `id` so the cursor and `ORDER BY id ASC` are satisfied from the index rather than by a sort. Its test asserts each index is actually chosen, through `EXPLAIN QUERY PLAN`, and that no plan uses a temp B-tree.

  This is the one place the epic gains a migration. `src/services/storage/migration-0002-graph-and-plan.test.ts:231-232` deep-equals the three-entry migration list and is named in Story 02 as the assertion that moves.

- S3 - **done** - drive-is-exported-once - Story 01 exports `drive(app, method, path)` from `test/helpers/app.ts`; Stories 04 and 05 import it instead of writing a copy each. It costs one dependency edge — Story 05 was independent and now waits on `01` — and it stops the `reservePort` pattern repeating with a second helper.

- S5 - **done** - cardinality-belongs-to-the-operation - `readQuery` now returns `Record<string, readonly string[]>`, rejects nothing and throws nothing. A new `singleValued` in `src/http/server/single.ts` collapses the lists and refuses a repeat, and `event.list` is its only caller. The transport reports what arrived; each operation decides what it accepts. A later route that legitimately repeats a key changes its own schema rather than the transport.

- S6 - **done** - epic-wording-corrected - `.agents/plan/epics/010-contract-completion.md` said "this epic authors one schema pair — `blob.show`" while also saying its media contract is not a body schema. It now says the epic authors no zod pair at all, and that `blob.show` declares one `responseMedia` field.

### Recorded, not changed

- S4 - action:NO - **system.status-is-in-two-slice-lists** - see the explanation below; nothing is edited.
