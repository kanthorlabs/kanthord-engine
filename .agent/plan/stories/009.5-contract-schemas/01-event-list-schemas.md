# Story 01 — `event.list` request and response, and the one cursor shape

Epic: `.agent/plan/epics/009.5-contract-schemas.md`

## Change

### 1. Export the actor kinds from the domain

`src/domain/event.ts:11` is `actorKind: z.enum(["human", "daemon"]),`. Add above `eventRow`:

```ts
export const actorKinds = ["human", "daemon"] as const;
export type ActorKind = (typeof actorKinds)[number];
```

Replace `:11` with `actorKind: z.enum(actorKinds),`.

### 2. New file `src/http/contract/cursor.ts` — the one cursor declaration

```ts
import { z } from "zod";

export const cursorRequest = z.strictObject({
  after: z.string().min(1).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
```

This file is the only place in `src/http/contract/` that declares `after` or `limit`.

**`limit` must be `z.coerce.number()`, not `z.number()`.** A query value arrives from koa as a string, and
`z.number()` rejects `"100"`, so a plain `z.number()` makes every client request with an explicit `limit` a
`400`. Verified against the installed zod 4.4.3:

| input   | `z.coerce.number().int().min(1).max(500).default(100)` |
| ------- | ------------------------------------------------------ |
| absent  | `100`                                                  |
| `"100"` | `100`                                                  |
| `500`   | `500`                                                  |
| `"501"` | reject                                                 |
| `"0"`   | reject                                                 |
| `"1.5"` | reject                                                 |
| `"abc"` | reject                                                 |

The emitted JSON Schema is unaffected: `{ default: 100, type: "integer", minimum: 1, maximum: 500 }`, so the
published contract still declares an integer and `z.coerce` is a decode concession rather than a contract
widening.

`after` stays `z.string().min(1)` and is **not** `identity("event")`. `docs/proposal/api/event.md:18` makes it
the id of the last event read, but `eventView.id` is `z.string()` and every other id in the contract is
`z.string()` (`credential.ts:17`, `project.ts:15`, `repository.ts:64`). Tightening `after` alone would make the
cursor stricter than the id it echoes. A malformed `after` is a `404`/empty page for EPIC 010 to answer, not a
schema rejection.

### 3. New request, view and response in `src/http/contract/event.ts`

The file is 12 lines with no zod today. Add above `export const event`:

```ts
import { z } from "zod";

import { actorKinds } from "../../domain/event.ts";
import { cursorRequest } from "./cursor.ts";

export const eventListRequest = cursorRequest.extend({
  subjectKind: z.string().min(1).nullable().default(null),
  subject: z.string().min(1).nullable().default(null),
  type: z.string().min(1).nullable().default(null),
  actorKind: z.enum(actorKinds).nullable().default(null),
  actor: z.string().min(1).nullable().default(null),
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

`subjectKind` and `subject` stay open strings. `docs/proposal/api/event.md:16` requires one filter to serve a
node, a run, a repository, a candidate and every later subject kind, and `src/domain/event.ts:8` is
`z.string()` for the same reason. `eventListRequest` declares **no `wait`**, and `eventListResponse` declares
**no cursor field**.

### 4. `Operation` gains a `query` slot

`src/http/contract/operation.ts:19-28` currently ends:

```ts
  successStatus?: number;
  request?: ZodType;
  response?: ZodType;
}>;
```

Insert `query?: ZodType;` immediately before `request?: ZodType;`. `query` is the query string, `request` is
the body. A `GET` never declares `request`.

### 5. Bind the schemas

`src/http/contract/event.ts:5-11`, the `event.list` entry, gains two lines after `status: "routed",`:

```ts
    query: eventListRequest,
    response: eventListResponse,
```

### 6. `openapi.ts` renders `query` as query parameters

`src/http/contract/openapi.ts:77-85` today is:

```ts
const parameters = parameterNames(entry.path);
if (parameters.length > 0) {
  operation.parameters = parameters.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}
```

Replace with: build `pathParameters` exactly as above, then, when `entry.query !== undefined`, append one
entry per key of `entry.query`, with the keys sorted bytewise by `compareBytewise` (`openapi.ts:136`):

```ts
{
  name,
  in: "query",
  required: false,
  schema: <the JSON Schema of that one field>,
}
```

Take each field's JSON Schema from `z.toJSONSchema(entry.query, { target: "openapi-3.0", io: "input" })` and
read its `properties[name]`. Assign `operation.parameters` only when the combined array is non-empty. Path
parameters come first, in declared order; query parameters follow in bytewise name order. `required` is
`false` for every query parameter, because every field carries a default.

`query` registers **no** component. Only `request` and `response` do.

### 7. `query` is legal on a routed operation only

`src/http/contract/registry.ts:118` `registryFaults(entries)` returns a `RegistryFault` per structural defect
and `registry.test.ts:117` asserts `registryFaults(registry) === []`. It ignores every schema field today, so a
synthetic entry with `status: "stubbed"` and a `query` passes. Add one fault reason, `"query-on-stubbed"`,
raised when `entry.status === "stubbed" && entry.query !== undefined`. Follow the existing `RegistryFault`
shape at `:116` and the one-test-per-reason pattern at `registry.test.ts:215-431`.

Add to `src/http/contract/registry.test.ts`:

- `"event.list is the only operation with a query schema"` —
  `registry.filter((entry) => entry.query !== undefined).map((entry) => entry.operationId)` deep-equals
  `["event.list"]`.
- one `registryFaults` test that a synthetic stubbed entry carrying `query` yields exactly the
  `"query-on-stubbed"` fault.

### 8. Update the pinned counts

- `src/http/contract/registry.test.ts:78-115`: the `response` list gains `event.list` in bytewise position and
  the count moves 21 → 22. The `request` list and its count of 7 do **not** change — `event.list` declares
  `query`, not `request`.
- `src/http/contract/openapi.test.ts:205`: the component list gains `event.list.response` in bytewise position
  and the count moves 29 → 30. Update the test name from `twenty-nine` to `thirty`.
- `src/http/contract/openapi.test.ts:74` (47 paths) and `:112` (53 operations) do **not** change. `/v1/event`
  is already registered.

## Constraints

- `limit: 501` is a parse failure, never a silent clamp. `.max(500)` gives that.
- `limit` absent yields `100`; `after` absent yields `null`.
- Do not add `wait` to any schema.
- Do not add a `nextAfter`, `hasMore` or `total` field to the response.
- Do not change `status` on `event.list`. It stays `routed` and answers through EPIC 010.
- `cursorRequest.extend(...)` must not redeclare `after` or `limit`.
- No handler, command or query in this story.
- **The decode step belongs to EPIC 010, and this schema must make it a one-liner.** EPIC 010's handler passes
  koa's `ctx.query` object straight to `eventListRequest.parse(...)`. Two consequences this story must honour,
  so EPIC 010 needs no schema change:
  - Every numeric field is `z.coerce`, because `ctx.query` values are strings.
  - A repeated parameter gives koa an array, for example `?limit=1&limit=2` yields `["1","2"]`. `z.coerce.number()`
    rejects an array, and a `z.string()` field rejects one too, so a repeated parameter is a `400` by
    construction. Assert that rather than adding array handling.
  - An empty value, `?after=`, yields `""`, which `.min(1)` rejects as a `400`. That is intended: an absent
    cursor is the parameter omitted, never the parameter blank.

## Verify

- `node --test src/http/contract/cursor.test.ts` — new file. Asserts, for both the number and the string form
  of every numeric input, because a query value arrives as a string: `limit` defaults to 100 when absent;
  `limit: 500` and `limit: "500"` parse to `500`; `limit: "100"` parses to `100`; `limit: 501` and
  `limit: "501"` throw; `limit: 0` and `limit: "0"` throw; `limit: 1.5` and `limit: "1.5"` throw;
  `limit: "abc"` throws; `after` defaults to `null`; `after: ""` throws; an unknown key throws.
- `node --test src/http/contract/event.test.ts` — new file. Asserts: `eventListRequest` defaults `limit` to
  100 and `after` to `null` on `{}`; rejects `{ limit: 501 }`; rejects `{ wait: 5 }`; rejects
  `{ actorKind: "robot" }`; accepts `{ actorKind: "human" }`; rejects `{ limit: ["1", "2"] }` and
  `{ after: "" }`, which are the repeated-parameter and empty-value forms koa produces; `eventListRequest` has
  exactly the keys
  `["actor","actorKind","after","limit","subject","subjectKind","type"]`; `eventListResponse` parses
  `{ events: [] }`; `eventListResponse` rejects `{ events: [], nextAfter: "x" }`; `eventView` rejects an
  unknown key; `eventView` requires `createdAt` and rejects a non-integer for it; `eventListResponse` has
  exactly one key, `events`.
- `node --test src/http/contract/registry.test.ts` — the amended `response` list of 22 passes, the
  `query`-only-on-`event.list` assertion passes, and the `"query-on-stubbed"` fault test passes. Then add
  `query: eventListRequest` to a stubbed entry and confirm `registryFaults(registry)` is non-empty. Revert.
- `node --test src/http/contract/openapi.test.ts` — the amended component list of 30 passes; the existing
  `:242` internal-ref test and `:269` `SwaggerParser.validate` test pass; the `:261` byte-identical render
  test passes.
- `node --test src/http/contract/openapi.test.ts` gains one test: `/v1/event`.get `parameters` deep-equals the
  seven query parameters in bytewise name order, each with `in: "query"` and `required: false`, and
  `/v1/event`.get has **no** `requestBody`.
- `node --test src/domain/event.test.ts` — existing assertions pass with `z.enum(actorKinds)`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
