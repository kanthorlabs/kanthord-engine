# Story 02 — `event.list`

Epic: `.agents/plan/epics/010-contract-completion.md`
Depends on: Story 01 (it reads `HandlerContext.query` and calls `singleValued`). EPIC 009.5 authored `eventListRequest`, `eventView` and `eventListResponse`; this story amends the filter cardinality of that pair and authors neither from scratch.

`event.list` is `routed` at `src/http/contract/event.ts:60-72` and answers `501` today, because `src/main.ts:199-300` binds no handler. `SqliteEventLog.list` (`src/services/event/sqlite.ts:61-120`) already implements every filter and the cursor. This story amends the contract, then adds the query, the handler and the binding.

## The contract this story consumes

EPIC 009.5 shipped this pair. Section 1 below changes the six filter fields from `.nullable().default(null)` to `.optional()` and changes nothing else. After section 1 the two exports read exactly:

```ts
// src/http/contract/cursor.ts
export const cursorRequest = z.strictObject({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// src/http/contract/event.ts
export const eventListRequest = cursorRequest.extend({
  subjectKind: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  actorKind: z.enum(actorKinds).optional(),
  actor: z.string().min(1).optional(),
});

export const eventView = z.strictObject({
  id: z.string(),
  type: z.string(),
  subjectKind: z.string(),
  subjectId: z.string(),
  actorKind: z.enum(actorKinds),
  actorId: z.string(),
  payload: z.unknown(),
  createdAt: z.number().int(),
});

export const eventListResponse = z.strictObject({
  events: z.array(eventView),
});
```

Six decisions this fixes, each load-bearing for the tests below:

- **The wire timestamp is `createdAt`; the domain timestamp is `occurredAt`.** `eventView` names `createdAt`. `RecordedEvent` (`src/services/event/index.ts:14-22`) names `occurredAt`. **The handler renames it, not the query** — a handler does parse, invoke and format, and renaming a field to its wire name is formatting. Section 3 pins the exact map.
- **The six filter fields are `.optional()`, never `.nullable()`.** A query string cannot carry JSON `null`: `?after=null` arrives as the string `"null"`. Under `.optional()`, `eventListRequest.parse({})` returns exactly `{ limit: 100 }` — verified — so no key is present as `undefined` and the parse output is structurally `EventFilter` (`src/services/event/index.ts:25-33`). No `null`-to-`undefined` translation exists anywhere in this story.
- **`after` and `subject` are `z.string().min(1)`, not `identity("event")` or `anyIdentity`.** EPIC 009.5 settled this: every other id in the contract is `z.string()`. No route rejects a malformed cursor at the schema layer, and `?after=repo_…` is a valid request that matches no row.
- **`limit` defaults to 100 and caps at 500.** `docs/proposal/api/event.md:18` names `limit` and declares no bound. `.agents/plan/epics/009.5-contract-schemas.md:73-75` requires "a bounded positive integer" and names no number. These two numbers are the bound.
- **The response carries no cursor field.** `docs/proposal/api/event.md:18` — "`after` takes the **id** of the last event read". A client pages with the last id in `events`, so a `nextAfter` field would be a second authority for the same value.
- **`wait` is not declared, and the proposal agrees.** `docs/proposal/api/event.md` defers the long poll to phase 2. `eventListRequest` is strict, so `?wait=5` answers `400 invalid-request`, and that is the specified answer rather than a gap.

`tsconfig.json` does not set `exactOptionalPropertyTypes`, so zod's `{ x?: string | undefined }` assigns to `EventFilter`'s `{ x?: string }` — verified by compile. `parsed.data` therefore reaches `listEvents` with no cast and no rebuild.

## Change

### 1. `src/http/contract/` — the six filter fields become optional

Four sites, no other edit to the contract.

**`src/http/contract/cursor.ts:4`** — `after: z.string().min(1).nullable().default(null),` becomes `after: z.string().min(1).optional(),`.

**`src/http/contract/cursor.ts:8-11`** — `cursorRequestExample` drops `after`. Both the annotation and the value change:

```ts
export const cursorRequestExample: Readonly<{ limit: number }> = {
  limit: 100,
};
```

`cursorRequest` has exactly one consumer, `src/http/contract/event.ts:11`. No other operation moves.

**`src/http/contract/event.ts:11-17`** — the five filter fields drop `.nullable().default(null)` and take `.optional()`. `actorKind` keeps `z.enum(actorKinds)`. The `cursorRequest.extend(...)` form is unchanged.

**`src/http/contract/event.ts:34-42`** — `eventListExamples.query` drops the five `null` entries and carries literal filter values, so the published document demonstrates the filters:

```ts
query: {
  ...cursorRequestExample,
  subjectKind: "node",
  subject: `task_${U}`,
  type: "node.state.changed",
  actorKind: "daemon",
  actor: "kanthord",
},
```

`src/http/contract/example.test.ts:63-88` parses this example against the query schema, so a leftover `null` fails the suite.

**`src/http/contract/field-decisions.fixture.ts:7,8,9,11,12,13`** — six entries flip `nullable=true` to `nullable=false`, for `actor`, `actorKind`, `after`, `subject`, `subjectKind` and `type`. Line `10` (`limit`) already reads `nullable=false` and is not touched. `required=false` is unchanged on all seven: `src/http/contract/openapi.ts:95` hardcodes `required: false` for every query parameter, and `z.toJSONSchema(..., io: "input")` emits no `required` array for an all-optional object — verified. No `event.list.response` row moves.

**No other schema, operation, path or error code changes.** The registry counts of `src/http/contract/registry.test.ts:14-16` and `:29-38`, `parity.test.ts` in full, and `openapi.test.ts:74-80` and `:112-120` are untouched.

### 2. `src/queries/event/list-event.ts` (new)

```ts
export type ListEventDependencies = Readonly<{
  events: EventLog;
}>;

export type ListEventInput = Readonly<{
  subjectKind?: string;
  subject?: string;
  type?: string;
  actorKind?: ActorKind;
  actor?: string;
  after?: string;
  limit: number;
}>;

export type EventView = Readonly<{
  id: string;
  subjectKind: string;
  subjectId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: unknown;
  occurredAt: number;
}>;

export function listEvents(
  dependencies: ListEventDependencies,
  input: ListEventInput,
): readonly EventView[];
```

The body is one call: `return dependencies.events.list(input);`. `EventFilter` (`src/services/event/index.ts:25-33`) is structurally `ListEventInput` with `limit` optional, so the input passes through unchanged and no field is renamed. `RecordedEvent` (`:14-22`) is structurally `EventView`, so the return passes through unchanged too. **`EventView` keeps `occurredAt`** — this module is the domain side of the boundary and renames nothing.

`EventLog`, `EventFilter` and `ActorKind` are imported from `../../services/event/index.ts`. That is a service **interface**, which `eslint.config.js:117-129` allows a query to import. The query never names `SqliteEventLog`.

**`EventView` exists because a handler may not import a service.** `eslint.config.js:140-156` allows `http-server` to reach `domain`, `command`, `query`, `http-contract` and `http-server` only — a service interface is not in that list. A handler dependency typed `RecordedEvent` fails `npm run lint`. `ActorKind` is re-exported from this module (`export type { ActorKind };`) so the handler imports it from the query too.

`listEvents` is synchronous. `Transaction` is synchronous (`src/services/storage/index.ts:1-5`) and `connection.ts:90-101` rolls back on a returned promise. `src/queries/system/read-migration-status.ts:16-36` is the synchronous query shape to mirror; `list-repository.ts` is not, because it returns a `Promise` only to await a git call.

### 3. `src/http/server/event/list-event.ts` (new)

```ts
export type ListEventHandlerDependencies = Readonly<{
  listEvents: (input: ListEventInput) => readonly EventView[];
}>;

export function listEventHandler(
  dependencies: ListEventHandlerDependencies,
): Handler;
```

The body is parse, invoke, format, with no branch on a domain rule. The `map` is the format step and is the only place `occurredAt` becomes `createdAt`:

```ts
return (context) => {
  const parsed = eventListRequest.safeParse(singleValued(context.query));
  if (!parsed.success) {
    throw httpError("invalid-request", "the event filters are not valid");
  }
  const events = dependencies.listEvents(parsed.data).map((event) => ({
    id: event.id,
    type: event.type,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    actorKind: event.actorKind,
    actorId: event.actorId,
    payload: event.payload,
    createdAt: event.occurredAt,
  }));
  return { status: 200, body: { events } };
};
```

The key order of the mapped object matches `eventView`'s declaration order (`src/http/contract/event.ts:19-28`). The map renames exactly one field, drops none and adds none — `eventView` is a `z.strictObject`, so an extra key fails the response assertion in the handler test.

`singleValued` is `src/http/server/single.ts` from Story 01. `event.list` accepts no repeated query key, so it collapses the value lists first and lets the schema judge the rest. `singleValued` throws `400 invalid-request` on a repeat, naming the bytewise-first offender; the schema throws the same code on everything else.

`src/http/server/repository/list-repository.ts:14-15` is the list shape: the body is an object with one named key, never a bare array.

The handler imports `ListEventInput`, `EventView` and `ActorKind` from `../../../queries/event/list-event.ts` and imports **nothing** from `src/services/`. `src/http/server/repository/show-repository.ts:3` imports a query result type the same way, and `eslint.config.js:140-156` allows `http/server/` to reach `queries/` and not `services/`.

### 4. `src/services/storage/migration-0004-event-indexes.ts` (new)

`event` carries no index today; the only `CREATE INDEX` in the schema is `run_one_active` (`src/services/storage/migration-0003-execution-and-journal.ts:46`). Every filter this route ships is a full scan. One migration fixes it:

```ts
export const migration0004EventIndexes: Migration = {
  version: 4,
  name: "0004-event-indexes",
  statements: [
    "CREATE INDEX event_subject ON event (subject_kind, subject_id, id)",
    "CREATE INDEX event_type ON event (type, id)",
    "CREATE INDEX event_actor ON event (actor_kind, actor_id, id)",
  ],
};
```

Three composite indexes, not five single-column ones, and each ends in `id`:

- `event_subject` serves `subjectKind` alone and `subjectKind` with `subject`, which is the pair `docs/proposal/api/event.md:16` describes as the common read. A `subject` filter without `subjectKind` still scans, and that is accepted: a prefixed id already names its kind, so the pair is the shape a client sends.
- `event_type` serves the `type` filter.
- `event_actor` serves `actorKind` alone and `actorKind` with `actor`.
- **Every index ends in `id`** so `ORDER BY id ASC` and `WHERE id > ?` are satisfied from the index rather than by a sort. The cursor is the point of the route.
- The unfiltered read needs no index: `id` is the primary key and `ORDER BY id ASC` walks it.

Register it in `src/services/storage/migrations.ts:6-10`, after `migration0003`. The array is the migration order and the version is `4`.

**Two existing assertions move, and they are the whole blast radius:**

- `src/services/storage/migration-0002-graph-and-plan.test.ts:231-232` — `"migrations holds exactly coreEntities, graphAndPlan and executionAndJournal"`. Rename the test to name the fourth, and add it to the `assert.deepEqual` list in version order.
- `src/queries/system/read-migration-status.test.ts` and `src/http/server/system/db.test.ts` — any case asserting a count of applied migrations moves from three to four. Run both and move whatever fails; do not pre-emptively edit a case that passes.

`src/http/server/start.test.ts:150` asserts `migrations.length > 0` and needs no edit.

### 5. `src/main.ts` — bind it

**Use the semantic anchors below, not line numbers.**

`src/main.ts` already constructs `const events = new SqliteEventLog({ storage, ids });` inside the `serve` action (currently `:151`). Add to the `const handlers = { … }` object literal in the same scope (currently `:199-300`), in the position that keeps the object's existing grouping:

```ts
"event.list": listEventHandler({
  listEvents: (input) => listEvents({ events }, input),
}),
```

**No edit to the `unimplemented` list.** `const unimplemented = unimplementedFor(handlers);` (currently `src/main.ts:301`) derives it from the registry minus the keys of `handlers`, so binding the handler removes the id automatically.

### 6. `src/main.test.ts` — the pending constant shrinks

`src/main.test.ts:18` reads `const pending = ["blob.show", "event.list"] as const`. This story:

- changes it to `const pending = ["blob.show"] as const`,
- adds an `event.list` entry to the `fixtures` table with no parameter and `expect: 200`.

Story 03 empties the constant. **Story 02 and Story 03 both edit this literal and must not run concurrently** — see the index dispatch order.

## Constraints

- **The contract edit is limited to cardinality.** Section 1 changes `.nullable().default(null)` to `.optional()` on six fields and adjusts the two examples and the six fixture rows that follow from it. No field is renamed, added or removed; no type widens or narrows; `createdAt` stays `createdAt`.
- **One migration, and it adds three indexes and no column.** `event` exists at `src/services/storage/migration-0003-execution-and-journal.ts:146-154` and is not altered. A migration is append-only: `0003` is never edited, because a deployed database has already applied it.
- The migration count moves from three to four. `test/helpers/database.test.ts` in Story 04 pins it, and `src/queries/system/read-migration-status.ts` reports it — check `src/http/server/system/db.test.ts` and any test asserting three applied migrations.
- No new error code. The route answers `200`, or `400 invalid-request` from `singleValued` or the schema, or a transport refusal.
- No edit to `src/services/event/`. `list` at `src/services/event/sqlite.ts:61-120` already builds `WHERE id > ?` and `ORDER BY id ASC` and needs nothing, and `src/services/event/sqlite.test.ts` already covers it. This story proves the adapter and the wire, never the SQL.
- **No file under `src/queries/` or `src/http/server/` imports `src/services/event/sqlite.ts`.** Only `src/main.ts` names an implementation.
- The query re-sorts nothing in TypeScript. `ORDER BY id ASC` in the service is the only order.
- `payload` reaches the wire as the parsed object. `src/services/event/sqlite.ts:113` already calls `JSON.parse`, so the handler never re-parses and never re-stringifies.

## Verify

```bash
node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/queries/system/read-migration-status.test.ts src/http/server/system/db.test.ts src/main.test.ts
```

### `src/http/contract/cursor.test.ts` (edited)

Two cases change; every other case in the file is untouched and must still pass.

- `"defaults after to null when absent"` (`:41-43`) is replaced by `"omits after when absent"`: `assert.equal("after" in cursorRequest.parse({}), false)`.
- Add `"keeps after when present"`: `assert.equal(cursorRequest.parse({ after: "x" }).after, "x")`.
- `"throws on an empty after"` (`:45-47`) is unchanged and must still pass — `.min(1)` survives `.optional()`.

### `src/http/contract/event.test.ts` (edited)

Two cases change; every other case in the file is untouched and must still pass.

- `"defaults limit to 100 and after to null on an empty request"` (`:7-11`) becomes `"defaults limit to 100 and omits after on an empty request"`: `assert.equal(parsed.limit, 100)` and `assert.equal("after" in parsed, false)`.
- `"has exactly the expected keys"` (`:39-49`) becomes two cases:
  - `"carries only limit on an empty request"` — `assert.deepEqual(Object.keys(eventListRequest.parse({})), ["limit"])`.
  - `"carries every filter when every filter is sent"` — parse `{ subjectKind: "node", subject: "task_x", type: "t", actorKind: "daemon", actor: "a", after: "event_x", limit: "25" }` and assert `Object.keys(parsed).sort()` deep-equals `["actor", "actorKind", "after", "limit", "subject", "subjectKind", "type"]`, and `parsed.limit` is the **number** `25`.
- `"rejects wait"`, `"rejects limit 501"`, `"rejects an unknown actorKind"`, `"accepts actorKind human"`, `"rejects a repeated-parameter limit array"`, `"rejects an empty after"` and every `eventView` / `eventListResponse` case are unchanged and must still pass.

### `src/http/contract/coverage.test.ts` and `src/http/contract/example.test.ts` (unedited)

Both must pass with **no test edit**. `coverage.test.ts:286` deep-equals the fixture that section 1 updates, and `example.test.ts:63-88` parses the query example that section 1 updates. If either needs a code change beyond `field-decisions.fixture.ts`, section 1 did more than cardinality.

### `src/queries/event/list-event.test.ts` (new)

Suite name `"src/queries/event/list-event.test"`. **No SQLite and no `SqliteEventLog`.** A test reaches an implementation only in the capability it covers (`AGENTS.md`, Tests), and this test covers `src/queries/`, not `src/services/event/`. Filtering, cursor semantics and `occurredAt` decoding are already proved by `src/services/event/sqlite.test.ts`; re-proving them here is both a boundary violation and scope creep.

`listEvents` is a one-call adapter, so the test is a **Mock** of `EventLog` — a hand-written object implementing the interface, whose `append` throws if called and whose `list` records its arguments and returns a fixed two-element array.

The two fixture events are literal and use valid prefixed ULIDs, so nothing is minted at test time:

```ts
const first: EventView = {
  id: "event_01HZY8QF3M4N5P6R7S8T9V0W1A",
  subjectKind: "node",
  subjectId: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
  type: "node.created",
  actorKind: "daemon",
  actorId: "d1",
  payload: { a: 1, b: ["x"] },
  occurredAt: 1700000000000,
};
```

`second` is the same shape with id `…V0W1C`, `type: "node.blocked"` and `occurredAt: 1700000001000`.

- **The filter is forwarded byte for byte.** `listEvents({ events: mock }, input)` with every one of the seven fields set calls `mock.list` exactly once, and the recorded argument deep-equals `input`. No field is renamed, dropped or defaulted by the query.
- **A sparse input forwards only what it carries.** `{ limit: 100 }` records exactly `{ limit: 100 }`, so the query adds no `undefined` key.
- **The result is returned by identity.** `assert.strictEqual(listEvents(...), theArrayTheMockReturned)`. The query maps nothing, and in particular does not rename `occurredAt`.
- **An empty result returns `[]`**, not `null`.
- **`mock.list` is called with no transaction.** The second argument is `undefined`, so the query never opens or joins one.

**This file makes no assertion against `eventListResponse`.** The query's shape is not the wire shape — `EventView` carries `occurredAt` and `eventView` requires `createdAt` — so the schema obligation of `.agents/plan/epics/009.5-contract-schemas.md:37-40` is discharged by the handler test below, against a real response body.

### `src/http/server/event/list-event.test.ts` (new)

Suite name `"src/http/server/event/list-event.test"`. Built on `createTestApp({ handlers: { "event.list": listEventHandler({ listEvents }) } })` with an injected fake, following `src/http/server/repository/show-repository.test.ts:36-44`. The fake returns the `first` / `second` fixtures above.

- **`GET /v1/event` answers `200` and renames the timestamp.** The body deep-equals

  ```ts
  {
    events: [
      {
        id: "event_01HZY8QF3M4N5P6R7S8T9V0W1A",
        type: "node.created",
        subjectKind: "node",
        subjectId: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
        actorKind: "daemon",
        actorId: "d1",
        payload: { a: 1, b: ["x"] },
        createdAt: 1700000000000,
      },
      /* second, with createdAt 1700000001000 */
    ];
  }
  ```

  This is the rename assertion: `createdAt` carries the fixture's `occurredAt` value, and **no key named `occurredAt` appears anywhere in the body**.

- **The body satisfies the shipped schema.** `eventListResponse.safeParse(response.body).success` is `true`. `eventView` is strict, so this fails if the map leaks `occurredAt` or any other extra key.
- `GET /v1/event` with no query calls `listEvents` exactly once with **exactly** `{ limit: 100 }` — `assert.deepEqual` on the recorded argument, and `assert.equal("after" in recorded, false)`. This pins both the default and the absence.
- `GET /v1/event?subjectKind=node&subject=node_01HZY8QF3M4N5P6R7S8T9V0W1A&type=node.created&actorKind=daemon&actor=d1&after=event_01HZY8QF3M4N5P6R7S8T9V0W1A&limit=25` calls `listEvents` once with all seven fields, `limit` the **number** `25` and every other field a string.
- `GET /v1/event?limit=501` answers `400` with `error.code === "invalid-request"`. `?limit=0` answers `400`. `?limit=abc` answers `400`.
- `GET /v1/event?after=` answers `400` with `error.code === "invalid-request"`. An empty `after` fails `.min(1)`, which `.optional()` does not relax.
- `GET /v1/event?wait=5` answers `400` with `error.code === "invalid-request"`, because `eventListRequest` is strict. `docs/proposal/api/event.md` defers `wait` to phase 2 and specifies exactly this answer.
- `GET /v1/event?type=a&type=b` answers `400` with `error.code === "invalid-request"` and a message naming `type`. This is `singleValued`, not the schema.
- **`GET /v1/event?after=repo_01HZY8QF3M4N5P6R7S8T9V0W1A` answers `200`**, and `listEvents` receives `after` as that exact string. `after` is `z.string().min(1)` and no identity check exists at the schema layer; a cursor that matches no row is an empty page, not a refusal.
- An empty result answers `200` with `{ events: [] }`, never `404`.
- No token answers `401`; an `Origin` header answers `403`. Both come free from the middleware chain and are asserted once, matching `src/http/server/system/db.test.ts`.
- The handler reads neither `context.body` nor `context.parameters`.

### `src/services/storage/migration-0004-event-indexes.test.ts` (new)

Suite name `"src/services/storage/migration-0004-event-indexes.test"`. Built on `createMigratedStorage()`. Mirror `src/services/storage/migration-0003-execution-and-journal.test.ts`.

- The three index names exist: `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event' ORDER BY name` deep-equals `["event_actor", "event_subject", "event_type"]`.
- `migrations` holds four entries, versions `[1, 2, 3, 4]` in order, names `["0001-core-entities", "0002-graph-and-plan", "0003-execution-and-journal", "0004-event-indexes"]`.
- **Each index is used.** For each of the three filter shapes, `EXPLAIN QUERY PLAN` of the statement `SqliteEventLog.list` builds contains the index name. Assert on `subjectKind` + `subject`, on `type`, and on `actorKind` + `actor`. This is what stops a later column reorder from silently making an index dead.
- **The cursor is satisfied from the index, not by a sort.** The `EXPLAIN QUERY PLAN` output for those three shapes contains no `USE TEMP B-TREE FOR ORDER BY`.
- The unfiltered `ORDER BY id ASC` plan names no index and no temp B-tree: it walks the primary key.

### `src/main.test.ts` (edited)

- `pending` deep-equals `["blob.show"]`.
- The `event.list` fixture drives `GET /v1/event` against the started daemon and asserts `200`, not `501`.

`npm run verify` exits 0.

Proof: delivers the `src/http/contract/event.test.ts`, `src/http/server/event/*.test.ts` and `src/queries/event/*.test.ts` entries of the EPIC Proof block. `cursor.test.ts`, `coverage.test.ts` and `example.test.ts` are collected by `Gates: npm run verify`.
