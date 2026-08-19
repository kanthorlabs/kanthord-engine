# Story 1 — `event.list` reads the tail

Epic: `.agent/plan/epics/026-event-tail-read.md`

## Change

### `src/http/contract/cursor.ts`

Replace the body of `cursorRequest` (lines 3-6) with exactly these four members, in this order:

```ts
export const cursorRequest = z.strictObject({
  after: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
```

Leave `cursorRequestExample` (lines 8-10) unchanged, including its `Readonly<{ limit: number }>` annotation.

### `src/services/event/index.ts`

In `EventFilter` (lines 26-34), add two members after `after?: string;` at line 32:

```ts
  before?: string;
  order?: "asc" | "desc";
```

Change nothing else in the file. `EventLog.list` keeps its signature.

### `src/queries/event/list-event.ts`

In `ListEventInput` (lines 7-15), add two members after `after?: string;` at line 13:

```ts
  before?: string;
  order?: "asc" | "desc";
```

`listEvents` at line 28-33 is unchanged.

### `src/services/event/sqlite.ts`

In `list`, immediately after the `filter.after` block that ends at line 91, add the upper bound:

```ts
if (filter.before !== undefined) {
  clauses.push("id < ?");
  parameters.push(filter.before);
}
```

At line 97, replace the hard-coded `" ORDER BY id ASC"` with a direction selected from `filter.order`, where an absent `order` reads `ASC`:

```ts
filter.order === "desc" ? " ORDER BY id DESC" : " ORDER BY id ASC";
```

The `LIMIT` append at lines 98-101 stays after the `ORDER BY`, so the limit applies to the ordered result. Add no index and no migration.

### `src/http/contract/event.ts`

In `eventListExamples.query` (lines 35-42), add `order: "asc",` immediately after the `...cursorRequestExample` spread at line 36. Change `eventListRequest`, `eventView` and `eventListResponse` in no way.

### `src/http/server/event/list-event.ts`

No change. The handler forwards `parsed.data` whole.

### `src/http/contract/field-decisions.fixture.ts`

Regenerate, never hand-edit:

```bash
node scripts/field-decisions-probe.mjs --write
```

The regenerated file must contain exactly two new rows, and only these two:

```
  "event.list.query#/properties/before required=false nullable=false enum=-",
  "event.list.query#/properties/order required=false nullable=false enum=asc,desc",
```

`before` lands immediately after the `after` row, `order` immediately after the `limit` row, because the file is sorted bytewise. Then re-run the probe with no flag; it must print `fixture in sync`.

## Constraints

- `order` carries `.default("asc")`. Every request that omits it parses to `asc` and returns the page it returned before this story.
- `after` and `before` are both **exclusive**. Together they select the open range `(after, before)`.
- An empty or inverted range answers `200` with an empty array. Add no comparison of the two ids and no refusal path.
- No index, no migration, no change to `migration-0004-event-indexes.ts`.
- No change to `eventListResponse` or `eventView`. Only the order of the array changes.
- `wait` is not part of this story. Do not add it and do not weaken the two tests that reject it.
- **`wait` must not exist yet.** EPIC 028 owns it and lands after this epic. If `src/http/contract/event.ts` already declares `wait`, stop and report: the epics landed out of order, and this story's quoted line numbers, the two "rejects wait" tests and the handler shape no longer match. Do not improvise the merge.
- Do not extend `src/http/contract/coverage.test.ts:528-545` or `:566` to `order` or `before`.

## Verify

Fixed ULIDs for every new test that needs a log. Ten ids, all sharing the timestamp prefix `01HZY8QF3M`, ascending by their last two characters:

```
event_01HZY8QF3M4N5P6R7S8T9V0WA1
event_01HZY8QF3M4N5P6R7S8T9V0WA2
event_01HZY8QF3M4N5P6R7S8T9V0WA3
event_01HZY8QF3M4N5P6R7S8T9V0WA4
event_01HZY8QF3M4N5P6R7S8T9V0WA5
event_01HZY8QF3M4N5P6R7S8T9V0WA6
event_01HZY8QF3M4N5P6R7S8T9V0WA7
event_01HZY8QF3M4N5P6R7S8T9V0WA8
event_01HZY8QF3M4N5P6R7S8T9V0WA9
event_01HZY8QF3M4N5P6R7S8T9V0WB0
```

### `src/http/contract/cursor.test.ts`

New tests:

- `cursorRequest.parse({})` deep-equals `{ order: "asc", limit: 100 }`.
- `cursorRequest.parse({ order: "desc" }).order` equals `"desc"`.
- `cursorRequest.parse({ order: "sideways" })` throws.
- `cursorRequest.parse({ order: "" })` throws.
- `"before" in cursorRequest.parse({})` is `false`.
- `cursorRequest.parse({ before: "x" }).before` equals `"x"`.
- `cursorRequest.parse({ before: "" })` throws.
- `cursorRequest.parse({ after: "a", before: "b" })` deep-equals `{ after: "a", before: "b", order: "asc", limit: 100 }`.

Existing tests at lines 7-54 stay and stay passing, unmodified.

### `src/http/contract/event.test.ts`

Amend two existing tests, exactly:

- Line 41 becomes `assert.deepEqual(Object.keys(eventListRequest.parse({})).sort(), ["limit", "order"]);`
- The sorted key list at lines 54-62 becomes `["actor", "actorKind", "after", "limit", "order", "subject", "subjectKind", "type"]`. The input at lines 45-53 is unchanged, so `order` appears from the default.

New tests:

- `eventListRequest.parse({})` has `order` equal to `"asc"`.
- `eventListRequest.parse({ order: "desc" }).order` equals `"desc"`.
- `eventListRequest.parse({ order: "sideways" })` throws.
- `eventListRequest.parse({ before: "" })` throws.
- `eventListRequest.parse({ after: "event_a", before: "event_b" })` carries both values.
- The existing "rejects wait" test at line 17 still passes, unchanged.

### `src/services/event/sqlite.test.ts`

Add a ten-event builder that mints the ten fixed ULIDs above in ascending order through `createMockIdGenerator`, and appends ten events in that order.

New tests, each asserting the exact returned id array:

- `list({ limit: 3 })` with no `order` returns `[A1, A2, A3]` — the three oldest, ascending. This is the compatibility assertion.
- `list({ order: "desc", limit: 3 })` returns `[B0, A9, A8]`, and `result[0].id` equals `B0`, the newest id in the log.
- `list({ before: A5 })` returns `[A1, A2, A3, A4]`. The boundary row `A5` is absent.
- `list({ after: A3, before: A7 })` returns `[A4, A5, A6]`.
- `list({ after: A7, before: A3 })` returns `[]`.
- `list({ after: A3, before: A3 })` returns `[]`.
- `list({ order: "asc" })` returns all ten ascending; `list({ order: "desc" })` returns all ten descending.
- Direction composes with every filter. Append the ten events so that exactly `A2`, `A4`, `A6`, `A8` carry `subjectKind: "node"`, `subjectId: "task_a"`, `type: "task.done"`, `actorKind: "daemon"`, `actorId: "daemon_a"`, and the other six carry `subjectKind: "run"`, `subjectId: "run_a"`, `type: "task.started"`, `actorKind: "human"`, `actorId: "human_a"`. Then `list({ subjectKind: "node", subject: "task_a", type: "task.done", actorKind: "daemon", actor: "daemon_a", order: "desc" })` returns `[A8, A6, A4, A2]`, and the same filter with `limit: 2` returns `[A8, A6]`.
- `order` absent emits `ORDER BY id ASC`, asserted through the returned order over a log whose insert order and id order differ: mint with `ulids` in the order `[A3, A1, A2]`, append three events, and assert `list({}).map((event) => event.id)` equals `[A1, A2, A3]`.

Every existing test in the file stays and stays passing, unmodified.

### `src/queries/event/list-event.test.ts`

New tests:

- The "forwards every field byte for byte" input gains `before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0"` and `order: "desc"`, and the recorded filter still deep-equals the input.
- `listEvents({ events }, { limit: 100, order: "desc" })` records a filter deep-equal to `{ limit: 100, order: "desc" }` — the query adds no default of its own.

### `src/http/server/event/list-event.test.ts`

Amend two existing assertions, exactly:

- Line 90 becomes `assert.deepEqual(recorded, { limit: 100, order: "asc" });`. The `"after" in recorded === false` assertion at line 91 stays.
- The deep-equal at lines 104-112 gains `order: "asc",`.

New tests, through `createTestApp`:

- `GET /v1/event?order=desc&before=event_01HZY8QF3M4N5P6R7S8T9V0WB0&after=event_01HZY8QF3M4N5P6R7S8T9V0WA1&limit=25` records a filter deep-equal to `{ after: "event_01HZY8QF3M4N5P6R7S8T9V0WA1", before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0", order: "desc", limit: 25 }`.
- `GET /v1/event?order=sideways` answers `400`, `response.body.error.code` equals `"invalid-request"`, and `Object.hasOwn(response.body.error, "details")` is `false`.
- `GET /v1/event?before=` answers `400` with code `"invalid-request"`.
- `GET /v1/event?after=event_...A7&before=event_...A3` answers `200` with `{ events: [] }` when the query returns `[]`. No refusal.

### `src/http/contract/openapi.test.ts`

Amend the name list at line 398 to `["actor", "actorKind", "after", "before", "limit", "order", "subject", "subjectKind", "type"]`. The `parameter.in === "query"` and `parameter.required === false` loop at lines 400-403 stays and must pass for all nine.

New assertion in the same test file: the `order` parameter's schema carries `enum` deep-equal to `["asc", "desc"]`.

### `src/http/contract/example.test.ts`

`example.test.ts` only proves that a query example parses, and `order` carries a default, so the file passes whether or not the example names `order`. Add one exact assertion so the EPIC's "the published example names the parameter" requirement is actually proved. Put it in `src/http/contract/event.test.ts` (which already imports from `./event.ts`) rather than in `example.test.ts`, which is registry-driven and names no single operation:

```ts
it("the query example names order", () => {
  assert.equal(
    (eventListExamples.query as Readonly<Record<string, unknown>>).order,
    "asc",
  );
});
```

Add `eventListExamples` to the import at `src/http/contract/event.test.ts:4`.

### `src/http/contract/coverage.test.ts`

No source edit. It passes because the fixture was regenerated.

### Commands

```bash
node --test src/http/contract/cursor.test.ts \
  src/http/contract/event.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/openapi.test.ts \
  src/services/event/sqlite.test.ts \
  src/queries/event/list-event.test.ts \
  src/http/server/event/list-event.test.ts
node scripts/field-decisions-probe.mjs
```

The publish check must assert the parameter names, not only that publishing did not throw, and it must remove its own directory:

```bash
OUT="$(mktemp -d)"
node scripts/publish-contract.ts "$OUT"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import YAML from "yaml";
  const doc = YAML.parse(readFileSync(process.argv[1] + "/features/event.yaml", "utf8"));
  const names = doc.paths["/v1/event"].get.parameters.map((p) => p.name);
  const expected = ["actor","actorKind","after","before","limit","order","subject","subjectKind","type"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("features/event.yaml parameters are " + JSON.stringify(names));
  }
  const order = doc.paths["/v1/event"].get.parameters.find((p) => p.name === "order");
  if (order.required !== false) throw new Error("order.required is not false");
  if (JSON.stringify(order.schema.enum) !== JSON.stringify(["asc","desc"])) {
    throw new Error("order.schema.enum is " + JSON.stringify(order.schema.enum));
  }
  if (order.schema.default !== "asc") throw new Error("order.schema.default is not asc");
  console.log("PASS features/event.yaml");
' "$OUT"
rm -rf "$OUT"
```

`npm run verify` exits 0.

Proof: `PASS EPIC-026` for `src/http/contract/cursor.test.ts`, `src/http/contract/event.test.ts`, `src/http/contract/coverage.test.ts`, `src/http/contract/example.test.ts`, `src/http/contract/openapi.test.ts`, `src/services/event/sqlite.test.ts`, `src/queries/event/list-event.test.ts` and `src/http/server/event/list-event.test.ts`, plus Hermetic coverage "The event tail" bullets 1 to 9 and bullet 11.

Bullet numbering of "The event tail", counted from `.agent/plan/epics/026-event-tail-read.md`:

1. no `order` returns the three oldest ascending — the compatibility assertion.
2. `order=desc&limit=3` returns the three newest descending, first id is the newest.
3. `before=<fifth id>` returns the four oldest, boundary row absent.
4. `after=<third>&before=<seventh>` returns the fourth, fifth and sixth.
5. inverted and equal bounds both answer `200` with an empty array.
6. `order=desc` composes with every filter.
7. `order=sideways` is `400 invalid-request` with no `details`.
8. `cursorRequest.parse({})` and the emitted `event.list.query` `order` row.
9. `order` absent emits `ORDER BY id ASC`.
10. the CLI sends `--order` and `--before` — **Story 2 owns this one.**
11. a publish carries `before` and `order` in `features/event.yaml`.

**The `PASS EPIC-026` marker does not discriminate between this story and Story 2**, because `src/cli/event/list.test.ts` is in the Proof block and passes unchanged until Story 2 adds its assertions. The bullet list above is what discriminates. Do not read a printed `PASS EPIC-026` as evidence that the epic is complete.
