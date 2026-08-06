# Story 02 — `event.list`

Epic: `.agent/plan/epics/010-contract-completion.md`
Depends on: Story 01 (it reads `HandlerContext.query`). EPIC 009.5 authors `eventListRequest` and `eventListResponse`; this story authors neither.

`event.list` is `routed` at `src/http/contract/event.ts:5-11` and answers `501` today, because `src/main.ts:193-256` binds no handler. `SqliteEventLog.list` (`src/services/event/sqlite.ts:61-120`) already implements every filter and the cursor. This story adds the query, the handler and the binding.

## The contract this story consumes

EPIC 009.5 owns `src/http/contract/event.ts`. This story requires exactly these two exports, and edits neither. See B3 in the index.

```ts
export const eventListRequest = z.strictObject({
  subjectKind: z.string().min(1).optional(),
  subject: anyIdentity.optional(),
  type: z.string().min(1).optional(),
  actorKind: z.enum(["human", "daemon"]).optional(),
  actor: z.string().min(1).optional(),
  after: identity("event").optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const eventListResponse = z.strictObject({
  events: z.array(
    z.strictObject({
      id: identity("event"),
      subjectKind: z.string(),
      subjectId: anyIdentity,
      type: z.string(),
      actorKind: z.enum(["human", "daemon"]),
      actorId: z.string(),
      payload: z.unknown(),
      occurredAt: z.number().int(),
    }),
  ),
});
```

Four decisions this fixes, each load-bearing for the tests below:

- **`limit` defaults to 100 and caps at 500.** `docs/proposal/api/event.md:18` names `limit` and declares no bound. `.agent/plan/epics/009.5-contract-schemas.md:73-75` requires "a bounded positive integer" and names no number. These two numbers are the bound.
- **`z.coerce` is on `limit` only.** Every other filter arrives as a string and stays one.
- **The response carries no cursor field.** `docs/proposal/api/event.md:18` — "`after` takes the **id** of the last event read". A client pages with the last id in `events`, so a `nextAfter` field would be a second authority for the same value.
- **`wait` is not declared, and the proposal now agrees.** `docs/proposal/api/event.md` defers the long poll to phase 2: a phase-1 client polls the cursor on its own timer. `eventListRequest` is a `z.strictObject`, so `?wait=5` answers `400 invalid-request`, and that is the specified answer rather than a gap.

## Change

### 1. `src/queries/event/list-event.ts` (new)

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

The body is one call: `return dependencies.events.list(input);`. `EventFilter` (`src/services/event/index.ts:25-33`) is structurally `ListEventInput` with `limit` optional, so the input passes through unchanged and no field is renamed. `RecordedEvent` is structurally `EventView`, so the return passes through unchanged too.

`EventLog`, `EventFilter` and `ActorKind` are imported from `../../services/event/index.ts`. That is a service **interface**, which `eslint.config.js:117-129` allows a query to import. The query never names `SqliteEventLog`.

**`EventView` exists because a handler may not import a service.** `eslint.config.js:140-156` allows `http-server` to reach `domain`, `command`, `query`, `http-contract` and `http-server` only — a service interface is not in that list. A handler dependency typed `RecordedEvent` fails `npm run lint`. `ActorKind` is re-exported from this module (`export type { ActorKind };`) so the handler imports it from the query too.

`listEvents` is synchronous. `Transaction` is synchronous (`src/services/storage/index.ts:1-5`) and `connection.ts:90-101` rolls back on a returned promise. `src/queries/system/read-migration-status.ts:16-36` is the synchronous query shape to mirror; `list-repository.ts` is not, because it returns a `Promise` only to await a git call.

### 2. `src/http/server/event/list-event.ts` (new)

```ts
export type ListEventHandlerDependencies = Readonly<{
  listEvents: (input: ListEventInput) => readonly EventView[];
}>;

export function listEventHandler(
  dependencies: ListEventHandlerDependencies,
): Handler;
```

The body is parse, invoke, format, with no branch on a domain rule:

```ts
return (context) => {
  const parsed = eventListRequest.safeParse(singleValued(context.query));
  if (!parsed.success) {
    throw httpError("invalid-request", "the event filters are not valid");
  }
  const events = dependencies.listEvents(parsed.data);
  return { status: 200, body: { events } };
};
```

`singleValued` is `src/http/server/single.ts` from Story 01. `event.list` accepts no repeated query key, so it collapses the value lists first and lets the schema judge the rest. `singleValued` throws `400 invalid-request` on a repeat; the schema throws the same code on everything else.

`src/http/server/repository/list-repository.ts:14-15` is the list shape: the body is an object with one named key, never a bare array.

The handler imports `ListEventInput`, `EventView` and `ActorKind` from `../../../queries/event/list-event.ts` and imports **nothing** from `src/services/`. `src/http/server/repository/show-repository.ts:3` imports a query result type the same way, and `eslint.config.js:140-156` allows `http/server/` to reach `queries/` and not `services/`.

### 3. `src/services/storage/migration-0004-event-indexes.ts` (new)

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

### 4. `src/main.ts` — bind it

**Use the semantic anchors below, not line numbers.** EPICs 008 and 009 are unbuilt and both edit `src/main.ts` heavily, so every line number in that file is stale by the time this story runs.

`src/main.ts` already constructs `const events = new SqliteEventLog({ storage, ids });` inside the `serve` action (currently `:144`). Add to the `const handlers = { … }` object literal in the same scope (currently `:193-256`), in the position that keeps the object's existing grouping:

```ts
"event.list": listEventHandler({
  listEvents: (input) => listEvents({ events }, input),
}),
```

**No edit to the `unimplemented` list.** The `const unimplemented = registry…` block that follows the handlers object (currently `src/main.ts:257-260`) derives it from the registry minus the keys of `handlers`, so binding the handler removes the id automatically.

### 5. `src/main.test.ts` — the pending constant shrinks

`.agent/plan/stories/009-cli-and-composition-root/07-composition-root-asserted-complete.md:77` writes `const pending = ["blob.show", "event.list"] as const`. This story:

- changes it to `const pending = ["blob.show"] as const`,
- adds an `event.list` entry to the `fixtures` table with no parameter and `expect: 200`.

Story 03 empties the constant. **Story 02 and Story 03 both edit this literal and must not run concurrently** — see the index dispatch order.

## Constraints

- **One migration, and it adds three indexes and no column.** `event` exists at `src/services/storage/migration-0003-execution-and-journal.ts:146-154` and is not altered. A migration is append-only: `0003` is never edited, because a deployed database has already applied it.
- The migration count moves from three to four. `test/helpers/database.test.ts` in Story 04 pins it, and `src/queries/system/read-migration-status.ts` reports it — check `src/http/server/system/db.test.ts` and any test asserting three applied migrations.
- No new error code. The route answers `200`, or `400 invalid-request` from the schema, or a transport refusal.
- No edit to `src/services/event/`. `list` at `src/services/event/sqlite.ts:61-120` already builds `WHERE id > ?` and `ORDER BY id ASC` and needs nothing, and `src/services/event/sqlite.test.ts` already covers it. This story proves the adapter and the wire, never the SQL.
- **No file under `src/queries/` or `src/http/server/` imports `src/services/event/sqlite.ts`.** Only `src/main.ts` names an implementation.
- No edit to `src/http/contract/`. EPIC 009.5 owns both schemas.
- The query re-sorts nothing in TypeScript. `ORDER BY id ASC` in the service is the only order.
- `payload` reaches the wire as the parsed object. `src/services/event/sqlite.ts:113` already calls `JSON.parse`, so the handler never re-parses and never re-stringifies.

## Verify

```bash
node --test src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/queries/system/read-migration-status.test.ts src/http/server/system/db.test.ts src/main.test.ts
```

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
- **The result is returned by identity.** `assert.strictEqual(listEvents(...), theArrayTheMockReturned)`. The query maps nothing.
- **An empty result returns `[]`**, not `null`.
- **`mock.list` is called with no transaction.** The second argument is `undefined`, so the query never opens or joins one.
- **`eventListResponse.parse({ events: [first, second] })` succeeds.** This is the obligation `.agent/plan/epics/009.5-contract-schemas.md:37-40` places on the epic that implements a handler: a schema authored ahead of its handler is a prediction until one test validates a real response against it. The fixtures are the shape `EventView` declares, so this assertion couples the query's result type to the 009.5 schema.

### `src/http/server/event/list-event.test.ts` (new)

Suite name `"src/http/server/event/list-event.test"`. Built on `createTestApp({ handlers: { "event.list": listEventHandler({ listEvents }) } })` with an injected fake, following `src/http/server/repository/show-repository.test.ts:36-44`.

- `GET /v1/event` answers `200`, the body deep-equals `{ events: [...] }` holding the fake's return, and `eventListResponse.safeParse(response.body).success` is `true`.
- `GET /v1/event` with no query calls `listEvents` exactly once with `{ limit: 100 }`. This pins the default.
- `GET /v1/event?subjectKind=node&subject=node_01HZY8QF3M4N5P6R7S8T9V0W1A&type=node.created&actorKind=daemon&actor=d1&after=event_01HZY8QF3M4N5P6R7S8T9V0W1A&limit=25` calls `listEvents` once with all seven fields, `limit` the **number** `25` and every other field a string.
- `GET /v1/event?limit=501` answers `400` with `error.code === "invalid-request"`. `?limit=0` answers `400`. `?limit=abc` answers `400`.
- `GET /v1/event?wait=5` answers `400` with `error.code === "invalid-request"`, because `eventListRequest` is strict. `docs/proposal/api/event.md` defers `wait` to phase 2 and specifies exactly this answer.
- `GET /v1/event?type=a&type=b` answers `400` with `error.code === "invalid-request"` and a message naming `type`. This is `singleValued`, not the schema.
- `GET /v1/event?after=repo_01HZY8QF3M4N5P6R7S8T9V0W1A` answers `400`: `after` is an `event` identity, not any identity.
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

Proof: contributes `src/queries/event/list-event.test.ts` and `src/http/server/event/list-event.test.ts`. Neither is inside the EPIC Proof glob — see B1 in the index.
