# Story 2 — The contract declares the wait

Epic: `.agents/plan/epics/028-event-long-poll.md`

## Change

### `src/http/contract/event.ts`

In `eventListRequest` (lines 11-17), add one member as the **last** member of the extension object, after `actor` at line 16:

```ts
    wait: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? Number.NaN : value,
      z.coerce.number().int().min(0).max(60).optional(),
    ),
```

`z.coerce` because every query value arrives as a string, exactly as `limit` does in `src/http/contract/cursor.ts:9`. `.min(0)` admits `wait=0`. `.max(60)` is the schema ceiling of D6. `.optional()` with no `.default()`, so an absent `wait` stays absent from the parse result.

The `z.preprocess` guard refuses an empty value. `z.coerce.number()` turns `""` into `0`, so `?wait=` would otherwise parse as "answer at once" instead of a refusal. The guard maps an empty or whitespace-only string to `NaN`, and `.int()` then refuses it. The guard changes no rendered schema: `z.toJSONSchema(eventListRequest, { target: "openapi-3.0", io: "input" })` renders `properties.wait` as `{"type":"integer","minimum":0,"maximum":60}` with or without it, so `src/http/contract/field-decisions.fixture.ts` and `src/http/contract/openapi.test.ts` see the same shape either way.

Add `wait` to `eventListRequest`. Do not add it to `cursorRequest`.

In `eventListExamples.query` (lines 35-43), add one entry as the **last** entry, after `actor: "kanthord"` at line 42:

```ts
      wait: 5,
```

The value is the number `5`, not the string `"5"`. `src/http/contract/example.test.ts:76-79` parses the example through `eventListRequest`, and `:204-211` requires the example to round-trip through `JSON.parse(JSON.stringify(...))`.

Change nothing else in the file. `eventView`, `eventListResponse` and the `operations([...])` entry at lines 63-76 are untouched. `allowedActors` stays `["human"]`.

### `src/http/contract/field-decisions.fixture.ts`

Regenerate, never hand-edit:

```bash
node scripts/field-decisions-probe.mjs --write
```

The diff must be exactly one added line, inserted between the `type` row at line 54 and the `response` row at line 55:

```
  "event.list.query#/properties/wait required=false nullable=false enum=-",
```

If the diff carries any other line, stop — something else changed.

## Constraints

- Add no member to `cursorRequest` and no key to `cursorRequestExample`. `cursorRequestExample` is typed `Readonly<{ limit: number }>` at `src/http/contract/cursor.ts:12-14` and stays that type.
- Do not give `wait` a `.default()`. A defaulted `wait` would appear in every parse result and would break `src/http/contract/event.test.ts:45-50`, which asserts an empty request carries exactly `["limit", "order"]`.
- Do not change the maximum from 60. The configured daemon maximum is Story 6 and it is a separate, lower bound.
- Add no new `z.enum(...)`. `src/http/contract/coverage.test.ts:145-215` requires every enum argument to be an identifier imported from `domain/`.
- Touch no other operation. `src/http/contract/registry.test.ts:187-194` asserts `event.list`, `node.list` and `provider.catalog` are the only operations with a query schema, and that stays true.

## Verify

### `src/http/contract/event.test.ts`

Replace the test at lines 22-24 in full. It reads today:

```ts
it("rejects wait", () => {
  assert.throws(() => eventListRequest.parse({ wait: 5 }));
});
```

Replace it with:

```ts
it("accepts wait as a number and as a string", () => {
  assert.equal(eventListRequest.parse({ wait: 5 }).wait, 5);
  assert.equal(eventListRequest.parse({ wait: "5" }).wait, 5);
});
```

Add these tests immediately after it:

- `eventListRequest.parse({ wait: 0 }).wait` equals `0`.
- `eventListRequest.parse({ wait: "0" }).wait` equals `0`.
- `eventListRequest.parse({ wait: 60 }).wait` equals `60`.
- `assert.throws(() => eventListRequest.parse({ wait: 61 }))`.
- `assert.throws(() => eventListRequest.parse({ wait: "61" }))`.
- `assert.throws(() => eventListRequest.parse({ wait: -1 }))`.
- `assert.throws(() => eventListRequest.parse({ wait: 1.5 }))`.
- `assert.throws(() => eventListRequest.parse({ wait: "abc" }))`.
- `assert.throws(() => eventListRequest.parse({ wait: "" }))`.
- `assert.throws(() => eventListRequest.parse({ wait: ["1", "2"] }))` — the repeated-parameter array shape, mirroring the `limit` test at lines 37-39.
- `assert.equal("wait" in eventListRequest.parse({}), false)` — an absent `wait` stays absent.
- `Object.keys(eventListRequest.parse({ wait: 5 })).sort()` deep-equals `["limit", "order", "wait"]`.
- The query example names the wait, mirroring the `order` test at lines 101-106:

```ts
it("the query example names wait", () => {
  assert.equal(
    (eventListExamples.query as Readonly<Record<string, unknown>>).wait,
    5,
  );
});
```

Leave the tests at lines 45-50 and 52-73 byte-identical. Neither sends `wait`, so both stay true.

### `src/http/contract/openapi.test.ts`

In the test `renders event.list query parameters in bytewise name order with no request body` (line 392), add `"wait"` as the **last** entry of the expected name list at lines 402-412, after `"type"`:

```ts
      "type",
      "wait",
```

`w` sorts after `t`, so `wait` is last. The loop at lines 414-417 asserting every parameter is `in: "query"` and `required: false` needs no change, because `wait` is optional.

Change nothing else in the test.

### `src/http/contract/example.test.ts`

No edit. `event.list` is already in the query-example list at lines 62-68, and the parse at lines 76-79 now validates `wait: 5`. Confirm it still passes.

### `src/http/server/event/list-event.test.ts`

**This story must invert one handler test, or it cannot pass its own gate.** The test at lines 183-189 reads today:

```ts
it("wait answers 400 because the schema is strict", async () => {
  const app = await handlerApp(() => []);
  const response = await app.get("/v1/event?wait=5");

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid-request");
});
```

Once `wait` is a declared member the parse succeeds, the handler answers `200`, and that assertion fails. Replace the test in full with the behaviour this story actually ships — the schema accepts `wait`, and the handler does not yet act on it:

```ts
it("wait parses and the handler still answers at once", async () => {
  const app = await handlerApp(() => [first]);
  const response = await app.get("/v1/event?wait=5");

  assert.equal(response.status, 200);
  assert.equal(response.body.events.length, 1);
});

it("wait 61 answers 400 at the schema", async () => {
  const app = await handlerApp(() => []);
  const response = await app.get("/v1/event?wait=61");

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid-request");
});
```

Story 5 replaces the first of these two with the waiting behaviour. The second stays as it is for the rest of the epic.

Change nothing else in this file. Story 5 owns every other edit to it.

### `src/http/contract/coverage.test.ts`

No edit. Confirm it passes after the fixture is regenerated. In particular:

- lines 528-545 assert `after:` and `limit:` appear in `cursor.ts` only. `wait:` is not in that name list, so adding `wait:` to `event.ts` is legal. **Do not extend that test to `wait`.**
- lines 547-575 compare only the names `after` and `limit` against `cursorRequest`. Leave the name list unchanged.

### Commands

```bash
node --test \
  src/http/contract/event.test.ts \
  src/http/contract/cursor.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/event/list-event.test.ts
```

`npm run verify` exits 0.

Proof: `PASS EPIC-028` for `src/http/contract/event.test.ts` and `src/http/contract/example.test.ts`. Delivers the Hermetic coverage bullet "The maximum is a refusal, not a clamp" for its first clause only — `wait=61` refused at the schema. The second clause, `wait=45` against a configured maximum of 30, is Story 5.
