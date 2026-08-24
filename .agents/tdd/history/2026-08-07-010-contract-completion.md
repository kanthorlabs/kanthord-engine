---
epic: .agents/plan/epics/010-contract-completion.md
opened: 2026-08-07
opener: test-engineer
base-ref: 49ff9d07b4635e53d44f04203246604a22e59188
---

# Implementation cycle — 010-contract-completion

Pulled from EPIC: `.agents/plan/epics/010-contract-completion.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/system.test.ts \
>   src/http/contract/openapi.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/event.test.ts \
>   src/http/server/query.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/app.test.ts \
>   src/http/server/blob/*.test.ts \
>   src/http/server/event/*.test.ts \
>   src/queries/blob/*.test.ts \
>   src/queries/event/*.test.ts \
>   test/helpers/database.test.ts \
>   src/main.test.ts \
>   && echo "PASS EPIC-010"
> ```
>
> The glob `src/http/contract/**/*.test.ts` was the Proof and it collected none of the handlers, neither sweep and no part of the transport widening. Fourteen entries replace it, one per directory this epic writes plus the four test files it edits without adding.
>
> Hermetic coverage required beyond the Proof:
>
> - The `501` sweep calls every stubbed route and asserts, after each call, that no table gained a row.
> - Adding a stubbed route to the registry without a `501` handler fails the sweep.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 01-transport-carries-query-and-headers · RED for the query/header widening

**Cycle.** RED for Story 01 (`01-transport-carries-query-and-headers.md`), first Story in dispatch order — everything else in this EPIC waits on it. Story Verify path: `node --test src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/http/server/route.test.ts`.

**Test written.**

- file: `src/http/server/query.test.ts` (new) — suite: `src/http/server/query.test` — methods: empty querystring, single-key mapping, bytewise key ordering, empty value, percent-decoding, repeated-value preservation, never-throws — asserts `readQuery` parses a querystring into `Record<string, readonly string[]>` in bytewise key order, rejecting nothing.
- file: `src/http/server/single.test.ts` (new) — suite: `src/http/server/single.test` — methods: empty query, single-valued collapse, empty-string collapse, repeated-key throw, bytewise-first-offender throw, bytewise key ordering — asserts `singleValued` collapses a query map to `Record<string,string>` and throws `HttpError("invalid-request", …)` naming the bytewise-first repeated key.
- file: `src/http/server/dispatch.test.ts` (edited) — suite: `src/http/server/dispatch.test` — added methods: query-per-key, request-headers-lowercase, response-headers-applied, binary-body-and-content-type, headers-omitted-sets-nothing, repeated-query-key-unrefused, stubbed-route-ignores-query — asserts `HandlerContext.query`, `HandlerContext.headers` and `HandlerResult.headers` cross the dispatch boundary as the Story specifies, and that a stubbed route still answers `501` before any query is read.
- asserts: the transport reports every query value (no cardinality decision) and applies response headers before the body, without touching existing 501/binding/error behavior.

**RED proof.**

- command: `node --test src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/http/server/route.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/http/server/query.ts' imported from .../src/http/server/query.test.ts` (query.test.ts and single.test.ts fail outright on missing seams); `dispatch.test.ts:251` — `AssertionError: Expected values to be strictly deep-equal: + undefined - { limit: [ '5' ] }` (handler context carries no `query` yet).

- stub probe: `src/http/server/query.ts`, `src/http/server/single.ts` — clean (a throw-stub for each typechecked with no errors against my two test files; the five remaining `npm run typecheck` errors are all `HandlerContext.query`/`headers` not existing yet on `src/http/server/app.ts`, which is the software-engineer's seam to widen). Stubs were deleted after the probe.

**Open to Software Engineer.**

- `src/http/server/query.ts` (new): `export function readQuery(querystring: string): Readonly<Record<string, readonly string[]>>` — parses with `URLSearchParams`, preserves wire-order repeats, orders keys bytewise (`Buffer.compare`), throws nothing.
- `src/http/server/single.ts` (new): `export function singleValued(query: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, string>>` — collapses single-valued keys, throws `httpError("invalid-request", …)` naming the bytewise-first key carrying more than one value, imported from `../contract/errors.ts`.
- `src/http/server/app.ts`: widen `HandlerContext` with `query: Readonly<Record<string, readonly string[]>>` and `headers: Readonly<Record<string, string>>` (lowercase-keyed request headers); widen `HandlerResult` with an optional `headers?: Readonly<Record<string, string>>`.
- `src/http/server/dispatch.ts`: populate `query` via `readQuery`, populate `headers` from the request, and apply `result.headers` to the response (bytewise key order) before `context.body` is set. A stubbed route must still answer `501` before any of this runs.
- `test/helpers/app.ts`: export `drive(app, method, path)` per Story 01 section 4 (needed by later Stories 04/05, not by this Task's RED tests, but named here per the Story file).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-transport-carries-query-and-headers · widen HandlerContext/HandlerResult, add readQuery/singleValued

**Cycle.** GREEN for `src/http/server/query.test.ts`, `src/http/server/single.test.ts`, `src/http/server/dispatch.test.ts` (Story 01).
**Files changed.**

- `src/http/server/query.ts` (new) — `export function readQuery(querystring: string): Readonly<Record<string, readonly string[]>>` — parses with `URLSearchParams`, preserves wire-order repeats per key, orders keys bytewise via `Buffer.compare`, throws nothing.
- `src/http/server/single.ts` (new) — `export function singleValued(query): Readonly<Record<string, string>>` — collapses single-valued keys in bytewise key order, throws `httpError("invalid-request", ...)` naming the bytewise-first repeated key, imported from `../contract/errors.ts`.
- `src/http/server/app.ts` (edited) — widened `HandlerContext` with `query: Readonly<Record<string, readonly string[]>>` and `headers: Readonly<Record<string, string>>`; widened `HandlerResult` with optional `headers?: Readonly<Record<string, string>>`. No other line in the file touched.
- `src/http/server/dispatch.ts` (edited) — populates `query` via `readQuery(context.querystring)` and `headers` via a new private `readHeaders`, applies `result.headers` to `context.set(...)` in bytewise key order before `context.body` is set; imports `Buffer` from `node:buffer` and `readQuery` from `./query.ts`. The stubbed-route `501` throw at the top of the middleware is unchanged and still runs before any of this.

**Seam (GREEN).** `dispatch.test.ts`'s query/header/response-header/binary-body/omitted-header/repeated-key/stubbed-ignores-query assertions now read a populated `HandlerContext.query`/`headers` and an applied `HandlerResult.headers`, matching the Story's exact widened types and dispatch snippet; `query.test.ts` and `single.test.ts` import the two new modules directly with no koa involved.

**Refactor.** None named for this Task beyond the seam itself; no speculative abstraction added.

**Build check.**

- typecheck: 3 pre-existing errors surfaced by the widening (see Open below); no other errors. Both new files and the two edited files type-check clean in isolation.

**Open to Test Engineer.**

- `test/helpers/app.ts`: `drive(app, method, path)` per Story 01 section 4 is not implemented — `test/helpers/**` is outside my lane even though the prior TEST-ENGINEER turn named it. Needed before Stories 04/05, not before this Task's own tests.
- Three existing test files construct a `HandlerContext` object literal directly and now fail `tsc --noEmit` because `query`/`headers` are non-optional per the Story's exact type (Story 01 §2 declares both required, no `?`): `src/http/server/system/db.test.ts:101`, `src/http/server/system/health.test.ts:119`, `src/http/server/system/status.test.ts:110`. Each needs `query: {}, headers: {}` added to its literal. These are test files, so out of my lane to edit; making the fields optional instead would weaken the Story's declared type, which I will not do silently.

**Assumptions.**

- VERIFIED: `HandlerContext`/`HandlerResult` field shapes match Story 01 §2 verbatim (read `.agents/plan/stories/010-contract-completion/01-transport-carries-query-and-headers.md`).
- VERIFIED: `Buffer.compare` ordering pattern already used at `src/http/contract/registry.ts:36` and `src/http/contract/parity.ts:87`, reused identically here per the Story's own note.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 01-transport-carries-query-and-headers · confirm GREEN, then blocked opening Story 02

**Handoff verification gate.** SE's last turn cited "typecheck: 3 pre-existing errors surfaced by the widening ... no other errors" and named the exact three files/lines that needed a test-side fix (`src/http/server/system/{db,health,status}.test.ts`), correctly identifying them as outside its lane. Independently re-verified:

- command: `npm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`

**Cycle.** Confirm GREEN for Story 01 (`01-transport-carries-query-and-headers.md`). Two test-lane fixes were mine to make, both named by the SE as out of its lane:

- `src/http/server/system/db.test.ts`, `src/http/server/system/health.test.ts`, `src/http/server/system/status.test.ts` — added `query: {}, headers: {}` to each hand-built `HandlerContext` literal, matching the Story's non-optional widened type exactly as the SE flagged.
- `test/helpers/app.ts` — added `export function drive(app: TestApp, method: string, path: string): supertest.Test`, the Story §4 helper the prior RED turn named as owed before Stories 04/05 (`"DELETE"→app.del`, `"GET"→app.get`, `"POST"→app.post`, `"PUT"→app.put`, anything else throws `Error` naming the method, sends no body).

**Confirm-GREEN proof.**

- command: `node --test src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/http/server/route.test.ts src/http/server/system/db.test.ts src/http/server/system/health.test.ts src/http/server/system/status.test.ts`
- result: `tests 71`, `pass 71`, `fail 0`.
- `npm run typecheck` — clean, 0 errors (the three pre-existing errors the SE flagged are now resolved).

Story 01 is green end to end. Cycle advances.

**Cycle (next Task).** Attempted to open Story 02 (`02-event-list.md`) and write its RED tests. Blocked before writing any test — the contract Story 02 names as its exact, unedited dependency has shipped with a different shape than the Story quotes.

**Blocker found.**

- Story 02 §"The contract this story consumes" quotes `eventListRequest` with five `.optional()` filter fields plus `after: identity("event").optional()`, and an `eventListResponse` item schema requiring `occurredAt: z.number().int()`.
- The contract EPIC 009.5 actually shipped at `src/http/contract/event.ts` (built from the now-settled `.agents/plan/stories/009.5-contract-schemas/01-event-list-schemas.md`) is materially different:
  - Every filter field, including `after`, is `.nullable().default(null)`, not `.optional()` — `eventListRequest.parse(...)` always returns every key, `null` rather than absent, so `parsed.data` cannot be forwarded to `EventFilter` (`src/services/event/index.ts:25-33`, which is `subjectKind?: string` etc., no `null` member) without a translation step.
  - `after`/`subject` are plain `z.string().min(1).nullable()`, not `identity("event")`/`anyIdentity` — no identity-format check exists at the schema layer for `event.list`.
  - The response item schema (`eventView`) requires `createdAt: z.number().int()` and is `z.strictObject`, so a key named `occurredAt` is rejected outright. `RecordedEvent`/the Story's own `EventView` (`src/services/event/index.ts:14-22`, Story 02 §1) both name the field `occurredAt`.
- 009.5's Story 01 states this shape was a deliberate, settled decision ("`after` stays `z.string().min(1)` and is not `identity(\"event\")`... every other id in the contract is `z.string()`"; "the decode step belongs to EPIC 010, and this schema must make it a one-liner" — but the one-liner it describes, `eventListRequest.parse(ctx.query)`, still leaves the `null`-vs-`undefined` and `createdAt`-vs-`occurredAt` gaps unaddressed for the query/handler Story 02 specifies).
- Consequence: every literal assertion in Story 02's Verify section that depends on the quoted shapes is either unwritable as stated or would fail for a reason that has nothing to do with a missing seam — `eventListResponse.parse({ events: [first, second] })` with `occurredAt`-shaped fixtures fails against the real `eventView`; `listEvents`'s claimed pass-through ("the input passes through unchanged and no field is renamed... the return passes through unchanged too") is false against the real schemas, because a `null`→`undefined` and a `createdAt`↔`occurredAt` mapping are now required somewhere in the handler or query. Deciding where that mapping lives, and whether the response body's fixture is still "returned by identity" once a field is renamed, is a handler/query design decision the Story does not make and I may not make in its place.

**Action required (human).** One of:

1. Amend the shipped `src/http/contract/event.ts` (reopening a `done` EPIC 009.5 story) to match Story 02's literal quote — rename `createdAt`→`occurredAt`, switch the five filter fields and `after` from `.nullable().default(null)` to `.optional()`.
2. Amend Story 02 to consume the schema as shipped: update its "contract this story consumes" quote, redesign `list-event.ts`/the handler to map `null`→`undefined` for six fields before calling `listEvents` and map `occurredAt`→`createdAt` when building the response body, and rewrite every Verify assertion that currently assumes `.optional()` fields or an `occurredAt` response key.
3. Another reconciliation Ulrich prefers.

No test file was written or edited for Story 02 this turn; the two test-lane fixes above belong to confirming Story 01 GREEN and are unaffected by this blocker.

OPEN: 010-story-02-event-list — Story 02's quoted `eventListRequest`/`eventListResponse` contract (optional fields, `after: identity("event")`, response field `occurredAt`) does not match the shipped EPIC 009.5 schema at `src/http/contract/event.ts` (`nullable().default(null)` fields, plain `z.string()` for `after`/`subject`, response field `createdAt`). Reconciling requires a handler/query design decision (where a null→undefined and createdAt↔occurredAt translation lives) or a decision to reopen the built 009.5 story — both are human calls, not a test-engineer or software-engineer one.

END: TEST-ENGINEER

## Human — OPEN resolved: 010-story-02-event-list

RESOLVED: 010-story-02-event-list — Ulrich settled the contract reconciliation. `.agents/plan/stories/010-contract-completion/02-event-list.md` is amended and dispatch-ready; `index.md` B3 is closed.

Decision, binding:

1. The wire timestamp stays `createdAt`. `RecordedEvent` keeps `occurredAt`. The HANDLER renames it, not the query.
2. The six filter fields (`subjectKind`, `subject`, `type`, `actorKind`, `actor`, and `after` on the shared `cursorRequest`) move from `.nullable().default(null)` to `.optional()`. Story 02 section 1 performs that edit.
3. `after` and `subject` stay `z.string().min(1)`, not `identity("event")` / `anyIdentity`.

Story 02 now edits `src/http/contract/` — that is intended and is section 1 of the story.

Next turn is TEST-ENGINEER: open Story 02 and write its RED.

## TEST-ENGINEER — 02-event-list · RED for the contract cardinality flip, query, handler, migration and binding

**Cycle.** RED for Story 02 (`02-event-list.md`), now dispatch-ready per the human's resolution recorded above. Story Verify path: `node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/queries/system/read-migration-status.test.ts src/http/server/system/db.test.ts src/main.test.ts`. This story has no internal `### Task` breakdown — it is one dispatch-ready unit, same shape as Story 01 — so every test named in its Verify section is written in this one RED turn.

**Test written.**

- `src/http/contract/cursor.test.ts` (edited) — replaced `"defaults after to null when absent"` with `"omits after when absent"` and added `"keeps after when present"`, per the Story's exact two-case edit.
- `src/http/contract/event.test.ts` (edited) — `"defaults limit to 100 and after to null on an empty request"` → `"defaults limit to 100 and omits after on an empty request"`; `"has exactly the expected keys"` split into `"carries only limit on an empty request"` and `"carries every filter when every filter is sent"` (asserting `limit` parses to the **number** 25). Every other case in the file is untouched.
- `src/queries/event/list-event.test.ts` (new) — suite `"src/queries/event/list-event.test"` — a hand-written `EventLog` Mock (`append` throws, `list` records arguments and returns a fixed array) asserts `listEvents` forwards the filter byte for byte, forwards only what a sparse input carries, returns the mock's array by `assert.strictEqual` identity, returns `[]` untouched, and calls `list` with `transaction === undefined`.
- `src/http/server/event/list-event.test.ts` (new) — suite `"src/http/server/event/list-event.test"` — built on `createTestApp` with an injected fake `listEvents`, following `show-repository.test.ts`'s shape. Asserts the `200` body renames `occurredAt`→`createdAt` with no leftover `occurredAt` key, the body satisfies the real `eventListResponse`, the default request forwards exactly `{ limit: 100 }`, every filter round-trips with `limit` as a number, `limit` 501/0/abc and an empty `after` and `wait` each answer `400 invalid-request`, a repeated `type` answers `400` naming `type` (the `singleValued` path), an `after` matching no row still answers `200`, an empty result answers `200` with `{ events: [] }`, and the auth/origin refusals apply.
- `src/services/storage/migration-0004-event-indexes.test.ts` (new) — suite `"src/services/storage/migration-0004-event-indexes.test"` — built on `createMigratedStorage()`. Asserts the three index names (filtered `NOT LIKE 'sqlite_%'` — `event`'s TEXT `PRIMARY KEY` already carries a hidden `sqlite_autoindex_event_1`, confirmed empirically, so the Story's literal query is corrected the same way every other index-inventory test in this codebase already is), `migrations` holds four versioned entries, each of the three composite indexes is used by its `EXPLAIN QUERY PLAN` shape with no `USE TEMP B-TREE FOR ORDER BY`, and the unfiltered walk uses none of the three and no temp b-tree.
- `src/services/storage/migration-0002-graph-and-plan.test.ts` (edited) — the `"migrations holds exactly …"` case renamed and extended to include `migration0004EventIndexes`, per the Story's named blast radius.
- `src/services/storage/migration-0001-core-entities.test.ts`, `src/services/storage/migration-0003-execution-and-journal.test.ts` (edited, not named by the Story but necessary) — each carries an identical `"migrations holds exactly …"` assertion the Story's text missed; both are extended the same way or they fail for a reason unrelated to Story 02's contract. `migration-0003-execution-and-journal.test.ts` also carried `"the index inventory is exactly run_one_active"`, unscoped to `tbl_name`, which the new event indexes now populate — renamed and extended to `["event_actor", "event_subject", "event_type", "run_one_active"]` with an added `ORDER BY name` for determinism (the prior single-row query had no ordering need).
- `src/main.test.ts` (edited) — `pending` narrows to `["blob.show"]` per section 6; `event.list` fixture added with no parameter and `expect: 200`; the `"blob.show and event.list answer 501…"` test is narrowed to `"blob.show answers 501…"` and no longer calls `event.list` — the removed half is dead now that `event.list` is bound and fixture-covered by the first test in the file.
- asserts: the six-field cardinality flip (`.optional()`, no `null`), the query/handler boundary (`EventFilter`-shaped pass-through with no rename, `occurredAt`→`createdAt` rename only in the handler's format step), the three composite indexes and their use by the planner, and the daemon binding removing `event.list` from the unbound set.

**RED proof.**

- command: `node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/services/storage/migration-0001-core-entities.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/queries/system/read-migration-status.test.ts src/http/server/system/db.test.ts src/main.test.ts`
- `cursor.test.ts:41` — `AssertionError`, `true !== false` (`"after" in cursorRequest.parse({})` is still `true`, the field is still `.nullable().default(null)`).
- `event.test.ts:10` — same shape for `eventListRequest`; `event.test.ts:41` — `deepStrictEqual` shows all seven keys present instead of `["limit"]`.
- `src/queries/event/list-event.test.ts`, `src/http/server/event/list-event.test.ts` — `Error [ERR_MODULE_NOT_FOUND]` for `./list-event.ts` (query) and both `./list-event.ts` (handler) and `../../../queries/event/list-event.ts` (query re-export) — the seams do not exist yet.
- `src/services/storage/migration-0004-event-indexes.test.ts` — 5 of 6 cases fail for the right reason: `Error [ERR_MODULE_NOT_FOUND]` isn't the failure here (this file has no import of the missing module directly — see below), instead `"the three index names exist"` fails `deepStrictEqual([], ["event_actor","event_subject","event_type"])`, `"migrations holds four entries…"` fails `deepStrictEqual([1,2,3], [1,2,3,4])`, and the three per-filter plan assertions each fail with `SCAN event USING INDEX sqlite_autoindex_event_1` (the planner falls back to the hidden PK index because the composite indexes don't exist). The sixth case (`"the unfiltered read walks the primary key…"`) passes today because that assertion is true both before and after the migration — it is not a false-positive vacuous pass, it pins behavior identical either side of this story.
- `src/services/storage/migration-0001-core-entities.test.ts`, `migration-0002-graph-and-plan.test.ts`, `migration-0003-execution-and-journal.test.ts` — each fails outright: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../migration-0004-event-indexes.ts'`.
- `src/main.test.ts` — `"every routed operation answers and none resolves to the shared 501 handler"` fails: `AssertionError [ERR_ASSERTION]: event.list answered 501` (`notStrictEqual` at line 184) — the daemon has no `event.list` handler bound yet.
- Unaffected and green as the Story requires with no test edit: `coverage.test.ts`, `example.test.ts`, `openapi.test.ts` (55 passing across the three), `read-migration-status.test.ts`, `db.test.ts` — none references a count of applied migrations against the real `migrations` array, both use hand-built fixtures.

- stub probe: `src/queries/event/list-event.ts`, `src/http/server/event/list-event.ts`, `src/services/storage/migration-0004-event-indexes.ts` — clean. Wrote the three Story-declared signatures with `throw new Error("stub")` bodies, ran `npm run typecheck`: 0 errors. Deleted the three stubs, re-ran `npm run typecheck`: exactly 7 `TS2307` errors, one per import of the three not-yet-created modules across my five new/edited test files (`list-event.test.ts` ×2, `list-event.test.ts` (handler) ×2, `migration-0001/0002/0003-*.test.ts` ×3), no other error. Confirms my own test files type-check clean against the Story's declared shapes.

**Open to Software Engineer.**

- `src/http/contract/cursor.ts`, `src/http/contract/event.ts`, `src/http/contract/field-decisions.fixture.ts` — Story 02 §1: the six filter fields (`after`, `subjectKind`, `subject`, `type`, `actorKind`, `actor`) move from `.nullable().default(null)` to `.optional()`; `cursorRequestExample` and `eventListExamples.query` drop their `null`/`after` entries per the Story's exact literals; the six named `field-decisions.fixture.ts` rows flip `nullable=true` to `nullable=false`.
- `src/queries/event/list-event.ts` (new): `listEvents(dependencies: { events: EventLog }, input: ListEventInput): readonly EventView[]` — one-call pass-through to `dependencies.events.list(input)`, `EventView` keeps `occurredAt`, `ActorKind` re-exported. Imports `EventLog`/`EventFilter`/`ActorKind` from `../../services/event/index.ts` only.
- `src/http/server/event/list-event.ts` (new): `listEventHandler(dependencies: { listEvents: (input: ListEventInput) => readonly EventView[] }): Handler` — parse via `eventListRequest.safeParse(singleValued(context.query))`, throw `httpError("invalid-request", …)` on failure, map the result renaming `occurredAt`→`createdAt` in `eventView`'s declared key order, return `{ status: 200, body: { events } }`. Imports `ListEventInput`/`EventView`/`ActorKind` from `../../../queries/event/list-event.ts`, nothing from `src/services/`.
- `src/services/storage/migration-0004-event-indexes.ts` (new): `Migration` with `version: 4`, `name: "0004-event-indexes"`, the three named composite `CREATE INDEX` statements. Registered in `src/services/storage/migrations.ts` after `executionAndJournal`.
- `src/main.ts`: bind `"event.list": listEventHandler({ listEvents: (input) => listEvents({ events }, input) })` into the existing `handlers` object literal, reusing the already-constructed `events`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02-event-list · contract cardinality flip, query, handler, migration, binding

**Cycle.** GREEN for Story 02 (`02-event-list.md`), one dispatch-ready unit (no internal `### Task` breakdown), covering every RED test the last TEST-ENGINEER turn listed.

**Files changed.**

- `src/http/contract/cursor.ts` (edited) — `cursorRequest.after` moves from `z.string().min(1).nullable().default(null)` to `z.string().min(1).optional()`; `cursorRequestExample` drops `after`, typed `Readonly<{ limit: number }>`.
- `src/http/contract/event.ts` (edited) — the five `eventListRequest` filter fields move from `.nullable().default(null)` to `.optional()`; `eventListExamples.query` drops the five `null` entries and carries literal filter values (`subjectKind: "node"`, `subject: task_${U}`, `type: "node.state.changed"`, `actorKind: "daemon"`, `actor: "kanthord"`). No other line touched.
- `src/http/contract/field-decisions.fixture.ts` (edited) — the six `event.list.query` rows for `actor`, `actorKind`, `after`, `subject`, `subjectKind`, `type` flip `nullable=true` to `nullable=false`; `limit`'s row and every `required=` value untouched.
- `src/queries/event/list-event.ts` (new) — `listEvents(dependencies: ListEventDependencies, input: ListEventInput): readonly EventView[]`, one-call pass-through to `dependencies.events.list(input)`. `EventView` keeps `occurredAt`. `EventLog`/`ActorKind` imported from `../../services/event/index.ts` only (a service interface); `ActorKind` re-exported via `export type { ActorKind };` for the handler.
- `src/http/server/event/list-event.ts` (new) — `listEventHandler(dependencies: ListEventHandlerDependencies): Handler`. Parses `singleValued(context.query)` with `eventListRequest.safeParse`, throws `httpError("invalid-request", ...)` on failure, maps the query result renaming `occurredAt`→`createdAt` in `eventView`'s declared key order, returns `{ status: 200, body: { events } }`. Imports `ListEventInput`/`EventView` from `../../../queries/event/list-event.ts` only — nothing from `src/services/`.
- `src/services/storage/migration-0004-event-indexes.ts` (new) — `migration0004EventIndexes: Migration`, `version: 4`, `name: "0004-event-indexes"`, the three named composite `CREATE INDEX` statements verbatim from the Story.
- `src/services/storage/migrations.ts` (edited) — registers `migration0004EventIndexes` after `executionAndJournal` in the exported array.
- `src/main.ts` (edited) — added `import { listEventHandler } from "./http/server/event/list-event.ts";` and `import { listEvents } from "./queries/event/list-event.ts";`; bound `"event.list": listEventHandler({ listEvents: (input) => listEvents({ events }, input) })` into the `handlers` object literal directly after `"edge.list"`, reusing the already-constructed `events`. No edit to the `unimplemented` derivation.

**Seam (GREEN).** `cursor.test.ts`'s "omits after when absent" / "keeps after when present", `event.test.ts`'s cardinality-flip cases, `coverage.test.ts`'s fixture deep-equal and `example.test.ts`'s query-example parse now read the `.optional()` schemas and matching fixture/example literals. `src/queries/event/list-event.test.ts` and `src/http/server/event/list-event.test.ts` now resolve their two new modules and exercise the exact signatures the Story names. `migration-0004-event-indexes.test.ts` and the sibling `migrations holds …` assertions in `migration-000{1,2,3}` now see four registered migrations and the three composite indexes exist and are planner-used. `src/main.ts`'s `event.list` binding answers `200` instead of `501`, matching `main.test.ts`'s narrowed `pending` and new fixture.

**Refactor.** None named for this Task beyond the seam itself; no speculative abstraction added.

**Build check.**

- typecheck: `npm run typecheck` — exit 0, clean.
- lint: `npm run lint` — exit 0, clean (import-direction rules hold: the query imports only the `event` service interface, the handler imports only the query and `http/contract/`/`http/server/`).

**Assumptions.**

- VERIFIED: `event` table has no `occurred_at` column; `RecordedEvent.occurredAt` is derived from `identityTime(id)` in `src/services/event/sqlite.ts:57,113`, so the migration adds no column, matching the Story's "One migration, and it adds three indexes and no column" constraint.
- VERIFIED: `Handler` (`src/http/server/app.ts:35-37`) accepts a sync or async return, so the handler's synchronous body is valid without an `async` keyword, matching the Story's exact snippet.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 03-blob-show · RED for the media contract, Range, query, handler and binding

**Handoff verification gate.** SE's last turn cited `npm run typecheck` exit 0 and `npm run lint` exit 0 for Story 02. Independently re-verified:

- command: `npm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`

**Cycle.** Confirm GREEN for Story 02, then RED for Story 03 (`03-blob-show.md`), the next story in dispatch order (`02 → 03`). Story 03 has no internal `### Task` breakdown — one dispatch-ready unit, same shape as Story 02 — so every test its Verify section names is written in this one RED turn.

**Confirm-GREEN proof (Story 02).**

- command: `node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/services/storage/migration-0001-core-entities.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/queries/system/read-migration-status.test.ts src/http/server/system/db.test.ts src/main.test.ts`
- result: `tests 203`, `pass 203`, `fail 0`. Story 02 is green end to end.

**Test written.**

- `src/http/server/blob/range.test.ts` (new) — suite `"src/http/server/blob/range.test"` — one table-driven `it` per row of the Story's exact `header/size/result` table (18 rows), asserting `parseRange`.
- `src/queries/blob/show-blob.test.ts` (new) — suite `"src/queries/blob/show-blob.test"` — a hand-written `BlobStore` Mock (`put`/`hash` throw, `get` records its argument and returns a fixed record) asserts `showBlob` forwards the hash byte for byte with no transaction, returns the mock's record by `assert.strictEqual` identity, and returns `null` untouched.
- `src/http/server/blob/show-blob.test.ts` (new) — suite `"src/http/server/blob/show-blob.test"` — built on `createTestApp` with an injected fake `showBlob`, following `list-event.test.ts`'s (handler) shape. The fixture is `Buffer.from("0123456789")` with its real sha256 computed via `node:crypto`. Asserts the `200` body/four fixed headers, exact `{ hash }` forwarding including the `sha256:` prefix, `206` for three `Range` forms with the right `Content-Range`, `200` with no `content-range` for an unsatisfiable or unparseable `Range`, `404` naming the hash on a `null` record, `404` with `showBlob` never called for a malformed or uppercase-hex hash, the auth/origin refusals, and the zero-byte-blob edge cases.
- `src/http/contract/system.test.ts` (edited) — added `"blob.show declares application/octet-stream as its response media"` and `"no operation but blob.show declares a response media"`; the existing `"blob.show carries no response schema"` case is untouched, matching the Story's "not weakened" requirement.
- `src/http/contract/registry.test.ts` (edited) — added `"flags an entry declaring both response and responseMedia"`, a synthetic entry in the same shape as the eight existing fault-rule tests.
- `src/http/contract/openapi.test.ts` (edited) — replaced `"no routed operation but blob.show resolves to an empty response body"` (blob.show was previously the one exemption) with `"every routed operation resolves to a non-empty response body"` (no exemption, since blob.show now has content) plus a new `"blob.show declares an inline binary media type and no response component"` asserting the exact inline `{ type: "string", format: "binary" }` schema under `application/octet-stream` and that `success` carries no second key.
- `src/main.test.ts` (edited) — `pending` narrows to `[] as const`; added a `"blob.show"` fixture (`parameters: { hash: "sha256:" + "0".repeat(64) }`, `expect: 404`); replaced `"blob.show answers 501 as the exact remaining unbound set"` with `"no routed operation is left unbound"` (drops the now-false 501 assertion, keeps the residue-equals-pending check).
- asserts: `parseRange`'s eighteen documented cases; the query's exact-forwarding/identity/null contract; the handler's parse-invoke-format contract (media type, cache/etag headers, Range→206, malformed/uppercase hash→404, auth); the registry's new mutual-exclusion fault; the OpenAPI document's inline binary media type with no new component; and the daemon binding removing `blob.show` from the unbound set.

**RED proof.**

- command: `node --test src/http/server/blob/range.test.ts src/http/server/blob/show-blob.test.ts src/queries/blob/show-blob.test.ts src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/main.test.ts`
- `src/http/server/blob/range.test.ts`, `src/http/server/blob/show-blob.test.ts`, `src/queries/blob/show-blob.test.ts` — `Error [ERR_MODULE_NOT_FOUND]` for `./range.ts`, `./show-blob.ts` (handler) and `../../../queries/blob/show-blob.ts`, and `./show-blob.ts` (query) — the seams do not exist yet.
- `src/http/contract/system.test.ts:192` — `AssertionError`, `undefined !== 'application/octet-stream'` (`Operation.responseMedia` does not exist yet); `:199` — `deepStrictEqual([], ['blob.show'])`.
- `src/http/contract/registry.test.ts:149` — `deepStrictEqual([], ['response and responseMedia both declared'])` (no `registryFaults` rule yet).
- `src/http/contract/openapi.test.ts:347` — `AssertionError: blob.show has no content`; `:367` — `TypeError: Cannot read properties of undefined (reading 'application/octet-stream')` (the `operationObject` branch does not emit `responseMedia` content yet).
- `src/main.test.ts:168` — `AssertionError [ERR_ASSERTION]: blob.show answered 501` (`notStrictEqual` — the daemon has no `blob.show` handler bound yet). `"no routed operation is left unbound"` passes today (fixture-set completeness, independent of the seam — not a vacuous pass on the seam under test).
- Every other case across the seven files passes: 71 of 80 total tests pass, 9 fail, all nine for the reasons above.

- stub probe: `src/queries/blob/show-blob.ts`, `src/http/server/blob/range.ts`, `src/http/server/blob/show-blob.ts` — clean. Wrote the three Story-declared signatures with `throw new Error("stub")` bodies, ran `npm run typecheck`: 0 errors (two test-side `string | undefined` narrowing fixes made in my own files first). Deleted the three stubs, re-ran `npm run typecheck`: exactly 4 `TS2307` errors, one per import of the three not-yet-created modules across my three new test files, plus 3 pre-existing-shape errors on `responseMedia` (`registry.test.ts:159`, `system.test.ts:194,201`) that are the software-engineer's `Operation`/`registryFaults` seam, not a defect in my files.

**Open to Software Engineer.**

- `src/http/contract/operation.ts`: add `responseMedia?: string;` to `Operation`, after `response?: ZodType;`.
- `src/http/contract/registry.ts`: add a `registryFaults` rule — an entry with both `response !== undefined` and `responseMedia !== undefined` yields `{ operationId, reason: "response and responseMedia both declared" }`.
- `src/http/contract/system.ts`: add `responseMedia: "application/octet-stream",` to the `blob.show` entry only.
- `src/http/contract/openapi.ts`: inside the `routed` branch of `operationObject`, when `entry.responseMedia !== undefined`, give `success.content = { [entry.responseMedia]: { schema: { type: "string", format: "binary" } } }`. No component registered.
- `src/queries/blob/show-blob.ts` (new): `showBlob(dependencies: { blobs: BlobStore }, input: { hash: string }): BlobView | null` — one-call pass-through to `dependencies.blobs.get(input.hash)`. `BlobStore` from `../../services/blob/index.ts` only.
- `src/http/server/blob/range.ts` (new): `parseRange(header: string | undefined, size: number): { start: number; end: number } | null` — the eighteen-row table in Story 03 §5 is the exact spec.
- `src/http/server/blob/show-blob.ts` (new): `showBlobHandler(dependencies: { showBlob: (input: { hash: string }) => BlobView | null }): Handler` — the Story's exact parse/invoke/format snippet (§6): `404` on a malformed or non-lowercase hash via `blobHash.safeParse`, `404` on a `null` record, the four fixed headers, `parseRange` against `content.length`, `200` or `206` accordingly.
- `src/main.ts`: construct `const blobs = new SqliteBlobStore({ storage, clock });` after `const events = ...`, and bind `"blob.show": showBlobHandler({ showBlob: (input) => showBlob({ blobs }, input) })` into `handlers`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 03-blob-show · media contract, Range, query, handler, binding

**Cycle.** GREEN for Story 03 (`03-blob-show.md`), one dispatch-ready unit (no internal `### Task` breakdown), covering every RED test the last TEST-ENGINEER turn listed.

**Files changed.**

- `src/http/contract/operation.ts` (edited) — added `responseMedia?: string;` to `Operation`, immediately after `response?: ZodType;`.
- `src/http/contract/registry.ts` (edited) — added a `registryFaults` rule: an entry with both `response !== undefined` and `responseMedia !== undefined` pushes `{ operationId, reason: "response and responseMedia both declared" }`, placed after the existing `query-on-stubbed` rule inside the same per-entry loop.
- `src/http/contract/system.ts` (edited) — added `responseMedia: "application/octet-stream",` to the `blob.show` entry only; no other entry touched.
- `src/http/contract/openapi.ts` (edited) — inside `operationObject`'s `routed` branch, when `entry.responseMedia !== undefined`, `success.content` is set to `{ [entry.responseMedia]: { schema: { type: "string", format: "binary" } } }`; no component registered, so `components.schemas` is unaffected. The two fields are mutually exclusive by the new registry fault, so no precedence logic was needed.
- `src/queries/blob/show-blob.ts` (new) — `showBlob(dependencies: ShowBlobDependencies, input: { hash: string }): BlobView | null`, a one-call pass-through to `dependencies.blobs.get(input.hash)`. `BlobStore` imported from `../../services/blob/index.ts` only (a service interface); `BlobView` is a fresh type structurally identical to `BlobRecord`, so the return passes through unchanged with no cast.
- `src/http/server/blob/range.ts` (new) — `parseRange(header: string | undefined, size: number): ByteRange | null`, implementing the Story's eighteen-row table exactly: `undefined`/`size === 0` → `null`; regex `/^bytes=(\d*)-(\d*)$/` after `.trim()`; both sides empty → `null`; suffix form (`bytes=-n`) requires `Number.isSafeInteger(n) && n > 0`; prefix/full form requires `Number.isSafeInteger(start) && start < size`, and when `end` is present requires `Number.isSafeInteger(end) && start <= end`, clamping `end` to `size - 1`.
- `src/http/server/blob/show-blob.ts` (new) — `showBlobHandler(dependencies: ShowBlobHandlerDependencies): Handler`, the Story's exact parse/invoke/format snippet: `404 not-found` on a missing/invalid-shaped hash (`blobHash.safeParse`, imported from `../../../domain/blob.ts`) or a `null` record; the four fixed headers (`Accept-Ranges`, `Cache-Control: private, immutable, max-age=31536000`, `Content-Type: application/octet-stream`, `ETag` as the quoted stored hash); `parseRange(context.headers["range"], content.length)` drives `200` vs `206` with `Content-Range`.
- `src/main.ts` (edited) — added `import { showBlobHandler } from "./http/server/blob/show-blob.ts";` and `import { showBlob } from "./queries/blob/show-blob.ts";`; bound `"blob.show": showBlobHandler({ showBlob: (input) => showBlob({ blobs }, input) })` into the `handlers` object literal directly after `"event.list"`, reusing the already-constructed `blobs` (`const blobs = new SqliteBlobStore({ storage, clock });` already existed at this call site from Story's earlier composition-root wiring). No edit to the `unimplemented` derivation.

**Seam (GREEN).** `range.test.ts`'s eighteen table rows, `queries/blob/show-blob.test.ts`'s forward/identity/null-passthrough Mock assertions, and `http/server/blob/show-blob.test.ts`'s status/header/Range/hash-validation/auth assertions now resolve their three new modules and exercise the exact signatures the Story names. `system.test.ts`'s `responseMedia` assertions and `registry.test.ts`'s new mutual-exclusion fault now read the widened `Operation` type and the new fault rule. `openapi.test.ts`'s inline binary media type and non-empty-body assertions now read `operationObject`'s new branch. `main.test.ts`'s `pending = []` and the `blob.show` 404 fixture now resolve against the bound handler instead of `501`.

**Refactor.** None named for this Task beyond the seam itself; no speculative abstraction added.

**Build check.**

- typecheck: `npm run typecheck` — exit 0, clean.
- lint: `npm run lint` — exit 0, clean (import-direction rules hold: the query imports only the `blob` service interface, the handler imports only the query, `domain/blob.ts`, `http/contract/errors.ts` and its own sibling `range.ts`).

**Assumptions.**

- VERIFIED: ran `parseRange` directly against all eighteen table rows from Story 03 §5 via a standalone script (`node --input-type=module` importing the new module) — all eighteen match the Story's declared result exactly, including the `Number.isSafeInteger` overflow case and the empty-suffix (`bytes=-0`/`bytes=-`) cases.
- VERIFIED: `blobHash` (`src/domain/blob.ts:5`) is `z.string().regex(/^sha256:[0-9a-f]{64}$/)`, so a malformed or uppercase-hex path parameter fails `.safeParse` before `showBlob` is ever called, matching the Story's "404, `showBlob` never called" cases.
- VERIFIED: `main.ts` already constructed `const blobs = new SqliteBlobStore({ storage, clock });` from a prior turn's composition-root wiring (Story 02/earlier scaffolding), so this turn only added the handler binding, not the store construction.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 04/05 · stub sweep + post-mvp sweep (test-only), then Verification Gate

**Handoff verification gate.** SE's last turn cited `npm run typecheck` exit 0 and `npm run lint` exit 0 for Story 03. Independently re-verified:

- command: `npm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`

**Cycle.** Confirm GREEN for Story 03, then Stories 04 (`04-stub-sweep-writes-nothing.md`) and 05 (`05-post-mvp-404-sweep.md`), both dispatch-independent of the rest of the epic ("Depends on: nothing in this epic. Dispatch it in parallel with Story 01") and both explicitly test-only ("No production file changes"). Confirming both closes every Story in the EPIC, so this turn ends with the full Verification Gate and the IMPLEMENTATION_READY_FOR_REVIEW marker.

**Confirm-GREEN proof (Story 03).**

- command: `node --test src/http/server/blob/range.test.ts src/http/server/blob/show-blob.test.ts src/queries/blob/show-blob.test.ts src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/main.test.ts`
- result: `tests 110`, `pass 110`, `fail 0`. Story 03 is green end to end.

### Story 04 — the `501` sweep gains no row

Its own text states: "No production file changes. This story edits one test file and one test helper." `dispatch.ts`/`app.ts` already refuse a stubbed request before any handler runs, so the rewritten sweep is a **characterization test pinning already-shipped behavior**, not a RED test — a first-run pass is expected and is the Story's stated intent.

**Test written.**

- `test/helpers/database.ts` (edited) — added `tableCounts(storage: Storage): Readonly<Record<TableName, number>>`, iterating `Object.keys(rows)` in bytewise order (`Buffer.compare`), one `SELECT COUNT(*) AS n FROM "<table>"` per table inside one `storage.transact`. Imports `rows`/`TableName` from `src/domain/rows.ts`.
- `test/helpers/database.test.ts` (edited) — three new cases: `"reports every table name in bytewise order"`, `"reports 0 for every table except migration on a fresh database"` (asserting `migration` equals `migrations.length`, not a literal, per the Story's explicit note), `"one inserted event row moves event from 0 to 1 and no other entry"`.
- `src/http/server/dispatch.test.ts` (edited) — replaced `"every one of the thirty stubbed operations answers 501 from an empty handler map"` with the Story's exact two cases: `"every stubbed route answers 501 and writes no row"` (a witness bound to every `routed` operationId, driving all thirty `stubbed` paths via `drive`, asserting `501`/`not-implemented`/an unchanged `tableCounts` snapshot per call, `driven === 30`, `writes === 0`, and one final snapshot equality) and `"a routed route reaches the witness and writes a row"` (same witness/app, driving `GET /v1/health`, asserting `200`, `writes === 1`, `tableCounts(...).event === before.event + 1`). No other case in the file touched. `drive` (from `test/helpers/app.ts`, shipped in Story 01's confirm-GREEN turn) and the new `createMigratedStorage`/`tableCounts` are newly imported; no new production seam was needed.
- asserts: the EPIC's own wording — a stubbed request never reaches a bound handler, and no table gained a row — while the companion case proves the witness itself can write, so the zero-write result is not vacuous.

**Run result (first-run pass, as intended).**

- command: `node --test src/http/server/dispatch.test.ts test/helpers/database.test.ts`
- result: `tests 32`, `pass 32`, `fail 0`.

**Sensitivity proof (per the Story's own instruction — "one failure is proved by hand and then reverted").** Wrote a throwaway probe script (not committed, deleted after the check) that constructed `createApp` with the witness bound to every `routed` **and** `stubbed` operationId (removing the sweep's `entry.status === "routed"` filter), reusing the same `createApp` seam the sweep exercises. Result: `BindingError: incomplete transport binding: agent.list, attempt.show, ... ` (all thirty stubbed ids named), because `bindingOffenders` (`src/http/server/app.ts:105-129`) rejects any handler or `unimplemented` entry whose registry status is `stubbed`. This confirms the guard the sweep's `handlers` filter relies on is load-bearing. Probe script created and deleted this turn; `git status --porcelain` shows no stray file.

### Story 05 — the `post-mvp` `404` sweep

Also explicitly test-only: "No production file changes. This story adds cases to one test file." — `src/http/server/route.ts` already answers `404` for an unmatched path, so this is again a characterization sweep.

**Test written.**

- `src/http/server/route.test.ts` (edited) — added a module-scope `postMvp` (bytewise-sorted `readRouteMatrix()` filtered to `introducedIn === "post-mvp"`) and four cases: `"the proposal declares four post-mvp rows"` (pins the four ids and `method path` strings in order, and that `status === "deferred"` coincides exactly with `introducedIn === "post-mvp"` across the whole matrix), `"every post-mvp path answers 404 and never 501"` (drives each concrete path via `drive`, asserts `404`/`not-found`/the method-and-path message), `"a post-mvp row has no registry entry, and the matrix has no third kind of row"` (`findOperation` is `undefined` for each; `matrix.length === 57`, `routed+stubbed === 53`, `postMvp.length === 4`, and `53 + 4 === 57`), `"a post-mvp path is unreadable without the token"` (each path with no `Authorization` header answers `401`/`unauthenticated`, never `404`). Imports `createTestApp`/`drive` from `test/helpers/app.ts`, `readRouteMatrix` from `test/helpers/proposal.ts`, `findOperation` from `../contract/registry.ts` — all pre-existing exports, no new seam.

**Run result (first-run pass, as intended).**

- command: `node --test src/http/server/route.test.ts src/http/contract/parity.test.ts`
- result: `tests 20`, `pass 20`, `fail 0`.

**Sensitivity proof (per the Story's own instruction).** Added a fifth literal (`"zzz.fake.probe"`) to the expected id list in `"the proposal declares four post-mvp rows"`, re-ran: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal` naming the missing fifth entry, confirming the test fails on the deep-equal rather than passing with a shorter loop. Reverted the literal back to the four-entry list.

**Build check.**

- `npm run typecheck` — exit 0, clean, after both Stories' edits and after the revert.

**Open to Software Engineer.** None for Stories 04 or 05 — both are entirely test-lane with no production seam missing or changed. Every Story in this EPIC (01–05) is now implemented and confirmed green.

## Verification Gate

**Gate 1 — `npm run verify`.**

- command: `npm run verify`
- result: exit 0. `node --test` summary: `tests 2731`, `suites 308`, `pass 2731`, `fail 0`, `cancelled 0`, `skipped 0`. `eslint .` exit 0. `openapi.yaml` generated, validated and deleted. Migration/db verify: `kanthord: verify db status ok`.

**Gate 2 — EPIC Proof.**

- command:

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

- result: `tests 200`, `suites 14`, `pass 200`, `fail 0`, `cancelled 0`, `skipped 0`, followed by the verbatim final line `PASS EPIC-010`.

**Tasks closed.** 5 Stories complete (01-transport-carries-query-and-headers, 02-event-list, 03-blob-show, 04-stub-sweep-writes-nothing, 05-post-mvp-404-sweep) — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/event.test.ts src/http/server/query.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts src/http/server/app.test.ts src/http/server/blob/_.test.ts src/http/server/event/_.test.ts src/queries/blob/_.test.ts src/queries/event/_.test.ts test/helpers/database.test.ts src/main.test.ts) — "PASS EPIC-010"
- stories: 5/5 complete
- date: 2026-08-07
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 4 action:NO finding(s) recorded for the human.
BLOCKER: B1 (test-lane) src/services/storage/migration-0004-event-indexes.test.ts:57,73,89 — the three "index is used" EXPLAIN cases probe a hand-written `SELECT id FROM event WHERE … ORDER BY id ASC`. `SELECT id` alone is covered by all three indexes, so SQLite picks an index for reasons independent of the real read, and a dead index would still pass. Replace the three probe statements with the exact column list and trailing `LIMIT ?` that `src/services/event/sqlite.ts:91-96` emits — `SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event … ORDER BY id ASC LIMIT ?` — keeping both existing assertions (index name present; no `USE TEMP B-TREE FOR ORDER BY`). Do NOT import `SqliteEventLog`: the test stays inside `services/storage` per AGENTS.md. Story 02 §"migration-0004" line 348 is the cited spec.
BLOCKER: S1 (production-lane) src/queries/event/list-event.ts:3 — `export type { ActorKind };` is an orphan this change created. Story 02 added it so the handler could import it, but `src/http/server/event/list-event.ts:5-8` imports only `EventView` and `ListEventInput`. Delete the re-export and confirm typecheck and lint stay clean.
INFO: S2 action:NO — dispatch.test.ts:388-478 the companion case rebuilds its own storage/witness/handler map instead of sharing the sweep's, diverging from 04-stub-sweep-writes-nothing.md:86 ("Same witness and the same app"); ~30 lines of duplication bought in exchange for isolation. Human call.
INFO: S3 action:NO — route.test.ts:150-155 Case 4 re-writes the DELETE/GET/POST/PUT method switch locally because `drive` wraps only the authenticated TestApp methods, not `app.raw`. A `driveRaw` helper would remove it; that is a helper-API design call.
INFO: S4 action:NO — single.ts:20 `result[key] = values[0] as string` yields `undefined` typed as `string` for a zero-length value list. Unreachable today because `readQuery` never produces one.
INFO: S5 action:NO — migration-0004-event-indexes.test.ts has no EXPLAIN case carrying `AND id > ?`, although Story 02 gives the cursor as the whole reason each index ends in `id`. Worth adding once B1 lands.

## TEST-ENGINEER — review-blocker repair · B1 (migration-0004 EXPLAIN probes)

**Cycle.** Repair path for `AUTO_REVIEW: FAIL` blocker `B1` (test-lane), routed back to this loop. Not a Task in Story order — a regression fix on an already-confirmed-green Story's test file, per the reviewer's exact instruction.

**Test written.**

- `src/services/storage/migration-0004-event-indexes.test.ts` (edited) — the three "index is used" EXPLAIN cases (`"a subjectKind + subject filter is satisfied from event_subject"`, `"a type filter is satisfied from event_type"`, `"an actorKind + actor filter is satisfied from event_actor"`) now probe the exact column list and trailing `LIMIT ?` that `src/services/event/sqlite.ts:91-96` emits — `SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE … ORDER BY id ASC LIMIT ?` — instead of the narrower `SELECT id … ORDER BY id ASC` that any of the three indexes could satisfy for reasons unrelated to the real read path. Both existing assertions per case are unchanged: the named index appears in the plan, and no `USE TEMP B-TREE FOR ORDER BY` line appears. No other case in the file touched; the unfiltered-read and index-name-list cases are untouched, as the blocker did not name them.
- No import of `SqliteEventLog` added — the probe stays a hand-written SQL string inside `services/storage`, matching AGENTS.md's directory boundary and the blocker's explicit instruction.
- asserts: the real read query (Story 02 §"migration-0004", `src/services/event/sqlite.ts:91-96`) is the one that hits the index and avoids a sort — not a narrower proxy query that any index would satisfy regardless of correctness.

**Run result.**

- command: `node --test src/services/storage/migration-0004-event-indexes.test.ts`
- result: `tests 6`, `pass 6`, `fail 0` — all three repaired cases plus the three untouched cases pass against the widened, exact-column probe.
- command: `npm run typecheck` — exit 0, clean (test-only edit, no seam change).

**Open to Software Engineer.** None. This turn is test-lane only, per the blocker's routing; `S1` (`src/queries/event/list-event.ts:3`, the orphan `ActorKind` re-export) is explicitly out of scope for this turn and remains open for the software-engineer's next turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review-blocker repair · S1 (orphan ActorKind re-export)

**Cycle.** Repair path for `AUTO_REVIEW: FAIL` blocker `S1` (production-lane), routed back to this loop.

**Files changed.**

- `src/queries/event/list-event.ts` (edited) — removed `export type { ActorKind };`. `src/http/server/event/list-event.ts:5-8` imports only `EventView` and `ListEventInput` from this module, and no other production file imports `ActorKind` from `list-event.ts` (confirmed by grep across `src/`).

**Seam (GREEN).** No behavior change; deletes an orphan re-export the reviewer flagged, matching the file's actual consumers.

**Build check.**

- typecheck: exit 0
- lint: exit 0 (`eslint .`)

**Review blocker addressed.** `BLOCKER: S1 (production-lane) src/queries/event/list-event.ts:3 — export type { ActorKind }; is an orphan this change created. Story 02 added it so the handler could import it, but src/http/server/event/list-event.ts:5-8 imports only EventView and ListEventInput. Delete the re-export and confirm typecheck and lint stay clean.`

**Assumptions.**

- VERIFIED: no production file imports `ActorKind` from `src/queries/event/list-event.ts` — grep across `src/` for `from.*list-event` returned only `main.ts`, `http/server/event/list-event.ts` (imports `EventView`/`ListEventInput` only) and two test files.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirm GREEN after both review-blocker fixes (`B1` — the `migration-0004-event-indexes.test.ts` EXPLAIN probes now use the real column list and trailing `LIMIT ?`; `S1` — the orphan `export type { ActorKind };` removed from `src/queries/event/list-event.ts`), then run the full EPIC Verification Gate.

**Confirm-GREEN proof (both blocker fixes).**

- command: `node --test src/services/storage/migration-0004-event-indexes.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts`
- result: `tests 23`, `suites 3`, `pass 23`, `fail 0`, `cancelled 0`, `skipped 0`. Both blocker fixes hold: the three "index is used" EXPLAIN cases pass against the real `SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event … ORDER BY id ASC LIMIT ?` probe (B1), and `list-event.test.ts` (query) and `list-event.test.ts` (handler) both pass with no reference to `ActorKind` in either module (S1).
- command: `npm run typecheck` — exit 0, clean.
- command: `npm run lint` — exit 0, clean.

**EPIC verification gate.**

**Gate — `npm run verify`.**

- command: `npm run verify`
- result: exit 0. `node --test` summary: `tests 2731`, `suites 308`, `pass 2731`, `fail 0`, `cancelled 0`, `skipped 0`. `eslint .` exit 0. `openapi.yaml` generated, validated and deleted. Migration/db verify: `kanthord: verify db status ok`.

**Proof.**

- command:

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

- result: `tests 200`, `suites 14`, `pass 200`, `fail 0`, `cancelled 0`, `skipped 0`, followed by the verbatim final line `PASS EPIC-010`.

**Tasks closed.** 5 Stories complete (01-transport-carries-query-and-headers, 02-event-list, 03-blob-show, 04-stub-sweep-writes-nothing, 05-post-mvp-404-sweep) — no Story outstanding. Both reviewer blockers (`B1`, `S1`) from the prior `AUTO_REVIEW: FAIL` are repaired and independently re-verified this turn.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/event.test.ts src/http/server/query.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts src/http/server/app.test.ts src/http/server/blob/_.test.ts src/http/server/event/_.test.ts src/queries/blob/_.test.ts src/queries/event/_.test.ts test/helpers/database.test.ts src/main.test.ts) — "PASS EPIC-010"
- stories: 5/5 complete
- date: 2026-08-07
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: FAIL
BLOCKER: S2 — src/http/server/dispatch.test.ts:388-478. The companion case ("a routed route reaches the witness and writes a row") rebuilds its own storage, witness and handler map instead of sharing the sweep's. `.agents/plan/stories/010-contract-completion/04-stub-sweep-writes-nothing.md:86` says "Same witness and the same app". Extract one local builder (for example `buildWitnessApp()`) inside the file and have both the sweep case and the companion case use it, so the companion provably exercises the same witness whose silence the sweep depends on. Keep every assertion in both cases unchanged.
BLOCKER: S3 — src/http/server/route.test.ts:145-155 re-writes the `DELETE`->`del` method switch locally, because `drive` (test/helpers/app.ts:26-43) wraps only the authenticated TestApp methods and this case needs `app.raw`. Add `driveRaw(app: TestApp, method: string, path: string): supertest.Test` beside `drive` in `test/helpers/app.ts`, mapping the same four methods to `app.raw.del/get/post/put` and throwing the same `unsupported method: <method>` Error on anything else. Replace the local switch in the "a post-mvp path is unreadable without the token" case with `driveRaw`, keeping the `.set("Host", "kanthord.test")` call and both assertions unchanged. This is the duplication S3 of the story index set out to remove.

## TEST-ENGINEER — review-blocker repair · S2 + S3 (dispatch.test.ts witness sharing, route.test.ts driveRaw)

**Cycle.** Repair path for `HUMAN_REVIEW: FAIL` blockers `S2` and `S3`, both test-lane. No new Task in Story order — refactors of already-green tests, no assertion changes, no production source touched.

**Test written.**

- `src/http/server/dispatch.test.ts` (edited) — extracted a local `async function buildWitnessApp(temporary)` that builds the witness `Handler` (same insert statement, same write-counter closure) and the `createTestApp({ handlers })` bound to every `routed` operation, returning `{ app, writes: () => writes }`. Both `"every stubbed route answers 501 and writes no row"` and `"a routed route reaches the witness and writes a row"` now call `buildWitnessApp(temporary)` instead of each rebuilding its own storage/witness/handler map, so the companion case provably exercises the same witness the sweep's silence depends on, per `04-stub-sweep-writes-nothing.md:86` ("Same witness and the same app"). Every assertion in both cases is unchanged (`writes()` replaces the bare `writes` variable read, same equality checks).
- `test/helpers/app.ts` (edited) — added `driveRaw(app: TestApp, method: string, path: string): supertest.Test` beside `drive`, mapping `DELETE/GET/POST/PUT` to `app.raw.del/get/post/put` and throwing `unsupported method: <method>` on anything else, mirroring `drive`'s shape but against the unauthenticated `app.raw` surface.
- `src/http/server/route.test.ts` (edited) — imports `driveRaw` alongside `drive` and `createTestApp`; the `"a post-mvp path is unreadable without the token"` case now calls `driveRaw(app, row.method, path).set("Host", "kanthord.test")` instead of the local `DELETE -> del` method-name switch. Both assertions (`401`, `"unauthenticated"`) are unchanged.

**Run result.**

- command: `node --test src/http/server/dispatch.test.ts src/http/server/route.test.ts test/helpers/app.test.ts`
- result: `tests 39`, `suites 3`, `pass 39`, `fail 0`, `cancelled 0`, `skipped 0`. Both blocker fixes hold: the sweep and the companion routed-witness case in `dispatch.test.ts` both pass driving through `buildWitnessApp` (S2); `route.test.ts`'s post-mvp-unreadable case passes through `driveRaw` with no local method switch remaining (S3).
- command: `npm run typecheck` — exit 0, clean.

**Open to Software Engineer.** None. Both blockers were entirely test-lane; no production seam missing or changed.

## EPIC verification gate.

**Gate — `npm run verify`.**

- command: `npm run verify`
- result: exit 0. `node --test` summary: `tests 2731`, `suites 308`, `pass 2731`, `fail 0`, `cancelled 0`, `skipped 0`. `eslint .` exit 0. Migration/db verify: `kanthord: verify db status ok`.

**Proof.**

- command:

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

- result: `tests 200`, `suites 14`, `pass 200`, `fail 0`, `cancelled 0`, `skipped 0`, followed by the verbatim final line `PASS EPIC-010`.

**Tasks closed.** 5 Stories complete (01-transport-carries-query-and-headers, 02-event-list, 03-blob-show, 04-stub-sweep-writes-nothing, 05-post-mvp-404-sweep) — no Story outstanding. Both `HUMAN_REVIEW: FAIL` blockers (`S2`, `S3`) are repaired and independently re-verified this turn.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/event.test.ts src/http/server/query.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts src/http/server/app.test.ts src/http/server/blob/_.test.ts src/http/server/event/_.test.ts src/queries/blob/_.test.ts src/queries/event/_.test.ts test/helpers/database.test.ts src/main.test.ts) — "PASS EPIC-010"
- stories: 5/5 complete
- date: 2026-08-07
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: FAIL
BLOCKER: S5 — src/services/storage/migration-0004-event-indexes.test.ts has no EXPLAIN QUERY PLAN case carrying the cursor predicate `AND id > ?`, although Story 02 gives the cursor as the whole reason each index ends in `id` ("Every index ends in `id` so `ORDER BY id ASC` and `WHERE id > ?` are satisfied from the index rather than by a sort"). The three existing cases prove the ORDER BY half only. A future column reorder could keep the sort property while losing the seek, degrading paging to a scan-and-discard, and all three current cases would still pass.

Add three cases, one per index, each EXPLAINing the real statement shape `SqliteEventLog.list` builds when `filter.after` is set — the same column list and trailing `LIMIT ?` as the existing cases, with `AND id > ?` appended to the WHERE clause as `src/services/event/sqlite.ts:81-84` emits it. Assert on each that the plan line contains the parenthesised seek clause verbatim, because that clause is what proves the cursor is served by an index seek rather than applied after the fact. The exact strings, probed against the built schema this turn:

- subjectKind + subject + cursor -> line contains `event_subject (subject_kind=? AND subject_id=? AND id>?)`
- type + cursor -> line contains `event_type (type=? AND id>?)`
- actorKind + actor + cursor -> line contains `event_actor (actor_kind=? AND actor_id=? AND id>?)`

Also assert on each that no line contains `USE TEMP B-TREE FOR ORDER BY`, matching the three existing cases. Do NOT import SqliteEventLog — the test stays inside services/storage per AGENTS.md. Change no existing case.

## TEST-ENGINEER — review-blocker repair · S5 (cursor seek EXPLAIN cases)

**Cycle.** Repair path for `HUMAN_REVIEW: FAIL` blocker `S5`, test-lane. No production source touched.

**Test written.**

- `src/services/storage/migration-0004-event-indexes.test.ts` (edited) — added three cases, one per index, EXPLAINing the statement shape `SqliteEventLog.list` builds when `filter.after` is set (`src/services/event/sqlite.ts:81-84`), each with the real column list and trailing `LIMIT ?` matching the existing cases, plus `AND id > ?` appended to the WHERE clause:
  - `"a subjectKind + subject filter with a cursor is seeked from event_subject"` — asserts a plan line includes `event_subject (subject_kind=? AND subject_id=? AND id>?)`.
  - `"a type filter with a cursor is seeked from event_type"` — asserts a plan line includes `event_type (type=? AND id>?)`.
  - `"an actorKind + actor filter with a cursor is seeked from event_actor"` — asserts a plan line includes `event_actor (actor_kind=? AND actor_id=? AND id>?)`.
    Each also asserts no line includes `USE TEMP B-TREE FOR ORDER BY`, matching the three existing cases. No `SqliteEventLog` import added — the probe is a hand-written SQL string inside `services/storage`, per the blocker's instruction and AGENTS.md's directory boundary. Every existing case in the file is unchanged.
- asserts: the cursor predicate `id > ?` is served by an index seek (the parenthesised seek clause appears verbatim in the query plan), not applied after the fact by a scan-and-discard, for each of the three filter indexes.

**Run result.**

- command: `node --test src/services/storage/migration-0004-event-indexes.test.ts`
- result: `tests 9`, `pass 9`, `fail 0`, `cancelled 0`, `skipped 0` — the three new cursor-seek cases plus the six untouched cases all pass.
- command: `npm run typecheck` — exit 0, clean.

**Open to Software Engineer.** None. This turn is test-lane only; no production seam missing or changed.

## EPIC verification gate.

**Gate — `npm run verify`.**

- command: `npm run verify`
- result: exit 0. `node --test` summary: `tests 2734`, `suites 308`, `pass 2734`, `fail 0`, `cancelled 0`, `skipped 0`. `eslint .` exit 0. Migration/db verify: `kanthord: verify db status ok`.

**Proof.**

- command:

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

- result: `tests 200`, `suites 14`, `pass 200`, `fail 0`, `cancelled 0`, `skipped 0`, followed by the verbatim final line `PASS EPIC-010`.

**Tasks closed.** 5 Stories complete (01-transport-carries-query-and-headers, 02-event-list, 03-blob-show, 04-stub-sweep-writes-nothing, 05-post-mvp-404-sweep) — no Story outstanding. `HUMAN_REVIEW: FAIL` blocker `S5` is repaired and independently re-verified this turn.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/event.test.ts src/http/server/query.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts src/http/server/app.test.ts src/http/server/blob/_.test.ts src/http/server/event/_.test.ts src/queries/blob/_.test.ts src/queries/event/_.test.ts test/helpers/database.test.ts src/main.test.ts) — "PASS EPIC-010"
- stories: 5/5 complete
- date: 2026-08-07
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
