# Story 01 — the transport carries a query string and response headers

Epic: `.agent/plan/epics/010-contract-completion.md`

`HandlerContext` (`src/http/server/app.ts:21-25`) carries `operation`, `parameters` and `body` and nothing else. `HandlerResult` (`src/http/server/app.ts:27`) carries `status` and `body` and nothing else. `event.list` reads five query filters and a cursor, and `blob.show` reads a `Range` request header and writes `Content-Type`, `ETag`, `Cache-Control`, `Accept-Ranges` and `Content-Range`. Neither is expressible today. This story widens the two types and nothing else. It adds no route and no handler.

## Change

### 1. `src/http/server/query.ts` (new)

```ts
export function readQuery(
  querystring: string,
): Readonly<Record<string, readonly string[]>>;
```

- Parse with `new URLSearchParams(querystring)`.
- Every key maps to **every** value it carried, in wire order. `?a=1&a=2` yields `{ a: ["1", "2"] }`; `?a=1` yields `{ a: ["1"] }`; `?a=` yields `{ a: [""] }`; an empty querystring yields `{}`.
- Keys are inserted in **bytewise order** through `Buffer.compare(Buffer.from(a), Buffer.from(b))`, so two requests with the same pairs in a different order produce the same object.
- `readQuery` **decides no cardinality and rejects nothing.** It throws no error and imports no `httpError`.

**The transport carries the values and the operation's schema owns cardinality.** A first draft made a repeated key `400` for every route, present and future. That is a policy EPIC 010 has no need to set: it would force any later operation that legitimately repeats a key to change `readQuery` rather than its own schema. The transport reports what arrived; each operation decides what it accepts.

### 1b. `src/http/server/single.ts` (new)

The one helper an operation uses when it accepts no repeated key:

```ts
export function singleValued(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, string>>;
```

- A key with exactly one value maps to that value.
- A key with more than one throws `httpError("invalid-request", \`the query parameter ${name} appeared more than once\`)`, naming the **bytewise-first** offender so two duplicates produce one deterministic message.
- Keys are inserted in bytewise order.

`event.list` calls it (Story 02). No other route calls it today, and a later route that wants a repeated key simply does not.

`httpError` is imported from `../contract/errors.ts`. Neither `query.ts` nor `single.ts` imports koa.

### 2. `src/http/server/app.ts:21-31` — the two widened types

Replace `src/http/server/app.ts:21-31` with:

```ts
export type HandlerContext = Readonly<{
  operation: Operation;
  parameters: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

export type HandlerResult = Readonly<{
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

export type Handler = (
  context: HandlerContext,
) => HandlerResult | Promise<HandlerResult>;
```

`headers` on the context is the **request** headers, lowercase-keyed. `headers` on the result is optional and defaults to no header. Both remain `Record<string, string>`; no array value crosses either boundary.

Nothing else in `app.ts` changes. `bindingOffenders` (`:90-117`), the middleware order (`:50-59`) and `bodyParserForHandled` (`:63-88`) are untouched.

### 3. `src/http/server/dispatch.ts:29-35` — populate and apply

Replace the handler call and the two assignments at `src/http/server/dispatch.ts:29-35` with:

```ts
const result = await handler({
  operation: match.operation,
  parameters: match.parameters,
  query: readQuery(context.querystring),
  headers: readHeaders(context.headers),
  body: context.request.body,
});
context.status = result.status;
for (const name of Object.keys(result.headers ?? {}).sort((a, b) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)),
)) {
  context.set(name, (result.headers ?? {})[name] as string);
}
context.body = result.body;
```

`readHeaders` is a private function in `dispatch.ts`:

```ts
function readHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const value = headers[name];
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}
```

Fixed rules, so no build-time choice remains:

- **Header keys are already lowercase.** `node:http` lowercases every incoming header name. No handler re-cases a key.
- **An array-valued request header is joined with `", "`.** That is the one form `node:http` produces, and joining keeps the boundary type a plain string.
- **A response header is applied before the body.** `context.set` runs above `context.body = result.body`, so Koa cannot overwrite an explicit `Content-Type` when it infers one from the body.
- **Response header names are applied to `context.set` in bytewise order.** This makes the middleware's own sequence of calls deterministic. It does **not** claim a deterministic wire-byte order: Koa and `node:http` add `content-length`, `date` and `connection` on their own, so no test asserts the full header order and none may.
- **`readQuery` runs inside dispatch, not as its own middleware, and it cannot fail.** A `stubbed` route must answer `501` whatever its query string says, and dispatch throws the `501` at `:16-21` before this line. Because `readQuery` rejects nothing, the ordering is belt and braces rather than the only guard — `singleValued` is what can throw, and it runs inside a handler, which is already after the `501`.

### 4. `test/helpers/app.ts` — one exported `drive`

Stories 04 and 05 each sweep the registry or the proposal matrix by method, and both need the same mapping. Export it once here rather than copying it twice:

```ts
export function drive(
  app: TestApp,
  method: string,
  path: string,
): supertest.Test;
```

- `"DELETE"` → `app.del`, `"GET"` → `app.get`, `"POST"` → `app.post`, `"PUT"` → `app.put`.
- Any other method throws a plain `Error` naming it. The four are the closed set of `src/http/contract/operation.ts:5`.
- It sends no body. A caller that wants one chains `.send(...)` on the returned test.

`TestApp` is already exported at `test/helpers/app.ts:25-32`. This is the S3 fix: `reservePort` is duplicated five times across the suite for want of exactly this, and Stories 04 and 05 would have made a sixth and seventh copy of a different helper.

### 5. `Buffer` is imported

`dispatch.ts` and `query.ts` each add `import { Buffer } from "node:buffer";`. `src/http/contract/registry.ts:36` and `src/http/contract/parity.ts:87` already use the same comparator.

## Constraints

- No existing handler is edited. Every handler in `src/http/server/system/`, `repository/`, `credential/` and `project/` reads only the fields it already read; the two added context fields are additive and the added result field is optional.
- No middleware is added, removed or reordered. `src/http/server/app.ts:50-59` stays byte-identical.
- `readQuery` throws nothing. `singleValued` throws `HttpError` and never returns a partial result; `envelopeMiddleware` (`src/http/server/envelope.ts:16-19`) maps it to `400 invalid-request`.
- Koa's `context.path` excludes the query string (`src/http/server/route.test.ts:46-51`), so `matchRoute` is unaffected by any query parameter.
- No `Operation` field changes here. `src/http/contract/` is untouched by this story.

## Verify

```bash
node --test src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/http/server/route.test.ts
```

### `src/http/server/query.test.ts` (new)

Suite name `"src/http/server/query.test"`. Direct unit tests on `readQuery`, no koa.

- `readQuery("")` deep-equals `{}`.
- `readQuery("type=node.created&limit=10")` deep-equals `{ type: ["node.created"], limit: ["10"] }`.
- `readQuery("b=2&a=1")` and `readQuery("a=1&b=2")` both produce `Object.keys(...)` deep-equal to `["a", "b"]`. This is the bytewise-order assertion.
- `readQuery("after=")` deep-equals `{ after: [""] }`.
- `readQuery("subject=node_01HZ%3Ax")` decodes to `{ subject: ["node_01HZ:x"] }`.
- `readQuery("a=1&a=2")` deep-equals `{ a: ["1", "2"] }` and **throws nothing**. Wire order is preserved.
- `readQuery` never throws for any input in this file.

### `src/http/server/single.test.ts` (new)

Suite name `"src/http/server/single.test"`. Direct unit tests on `singleValued`.

- `singleValued({})` deep-equals `{}`.
- `singleValued({ a: ["1"], b: ["2"] })` deep-equals `{ a: "1", b: "2" }`.
- `singleValued({ a: [""] })` deep-equals `{ a: "" }`.
- `singleValued({ a: ["1", "2"] })` throws an `HttpError` with `code === "invalid-request"`, `status === 400`, and a message containing `a`.
- `singleValued({ b: ["1", "2"], a: ["1", "2"] })` throws naming `a`, not `b`. This is the bytewise-first assertion.
- `Object.keys(singleValued({ b: ["2"], a: ["1"] }))` deep-equals `["a", "b"]`.

### `src/http/server/dispatch.test.ts` (edited)

Keep every existing case. `src/http/server/dispatch.test.ts:196-249` already asserts the handler receives `operation` and `parameters`; extend that block and add:

- A handler bound to `system.health` receives `query` deep-equal to `{ limit: ["5"] }` for `GET /v1/health?limit=5`, and `{}` for `GET /v1/health`.
- The same handler receives `headers["host"]` equal to the test host and `headers["authorization"]` starting with `Bearer `. Assert on those two keys only; do not deep-equal the whole map, because `node:http` adds `connection` and `accept-encoding`.
- A handler returning `{ status: 200, body: "ok", headers: { "X-B": "2", "X-A": "1" } }` yields `response.headers["x-a"] === "1"` and `response.headers["x-b"] === "2"`. Assert the two **values** only. Do not assert their position among the response headers — `node:http` adds its own and the order is not the handler's to fix.
- A handler returning `{ status: 200, body: Buffer.from([1, 2, 3]), headers: { "Content-Type": "application/octet-stream" } }` yields `response.headers["content-type"]` matching `/application\/octet-stream/` and a body of exactly three bytes. Use `.buffer()` on the supertest request so the body is not parsed as text.
- A handler omitting `headers` sets no extra header: the response still answers `200` and `response.headers["x-a"]` is `undefined`.
- `GET /v1/health?a=1&a=2` reaches the handler with `query` deep-equal to `{ a: ["1", "2"] }` and answers `200`. The transport refuses nothing; `system.health` reads no query.
- **`GET /v1/run?a=1&a=2` answers `501`.** `run.list` is `stubbed` (`docs/proposal/api/execution.md:13`), so nothing about the query string is examined before the `501`.
- The existing 501 sweep at `src/http/server/dispatch.test.ts:288-310` stays green unchanged. Story 04 rewrites it; this story must not.

### `src/http/server/app.test.ts` and `src/http/server/route.test.ts`

Unchanged in substance, and must stay green. `app.test.ts:160-165` and `dispatch.test.ts:182-194` pin twenty-one unimplemented ids, computed by `unimplementedFor({ "system.health", "system.db" })` from the registry (`test/helpers/app.ts:16-23`). This story binds no handler and adds no operation, so both stay **21**.

`npm run verify` exits 0.

Proof: contributes `src/http/server/query.test.ts`, `src/http/server/single.test.ts` and the `src/http/server/dispatch.test.ts` edits. Neither is inside the EPIC Proof glob — see B1 in the index, which widens the Proof.
