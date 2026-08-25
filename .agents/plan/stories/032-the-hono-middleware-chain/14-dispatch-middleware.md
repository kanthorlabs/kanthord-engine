# Story 14 - dispatch.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 13. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/dispatch.ts:1-63` as the terminal Hono handler for `AppEnv`.
- Keep `DispatchDependencies` and private `readHeaders`.
- Demand `match` first.
- For a stubbed operation, keep `httpError("not-implemented", `${operationId} ships in ${introducedIn}`)`.
- For a routed operation without a handler, keep `httpError("not-implemented", `${operationId} is not implemented yet`)`.
- Build `HandlerContext` with the exact matched operation and parameters, `readQuery(new URL(c.req.url).search.slice(1))`, `readHeaders(c.req.raw.headers)`, `optional(c, "body")`, and demanded `actor`.
- Change `readHeaders` to `readHeaders(headers: Headers)` and keep only its `compareBytewise` key order. A Fetch `Headers` already lower-cases every name and joins duplicate values, so the array-joining branch goes.
- Wrap only the handler invocation in `try/catch`.
- If the handler throws an `Error`, rethrow it unchanged. Otherwise throw `new ThrownValueError(value)`.
- Demand the response header accumulator after the handler returns.
- Sort `Object.keys(result.headers ?? {})` with `compareBytewise` and append each source value to the accumulator in that order.
- Store the exact handler result as `result` and return without writing status, body, `c.res`, or a response.
- Rewrite direct Koa fixtures in `src/http/server/dispatch.test.ts:1-539` as Hono fixtures. Preserve all existing binding, context, async, stubbed, routed, write-count, and error cases.
- Keep `BindingError` tests on `createApp`; Story 16 preserves the check before construction.
- Restate the result-header order test with source insertion order `X_c: "underscore"`, `X-a: "lower-a"`, `X-B: "b"`, then `X-A: "upper-A"`.
- Assert accumulator entries equal `[["x-a", "upper-A, lower-a"], ["x-b", "b"], ["x_c", "underscore"]]`.
- The late `X-A` source entry sorts before `X-a`; this assertion fails when dispatch skips `compareBytewise`.
- Keep the binary result fixture on `blob.show` and assert exact `Uint8Array` bytes and operation media type through render.
- Add table rows where a handler throws `"failure"` and `undefined`.
- For each row, assert status 500, exact generic envelope, one `onInternalError` call, and strict equality with the original thrown value.
- Keep the plain `Error` row and assert one callback.
- Preserve `a stubbed route carrying a malformed JSON body answers 501` at `src/http/server/dispatch.test.ts:93-106`; assert the exact `node.abandon ships in phase-2` message.
- Keep `src/http/server/query.test.ts`, `single.test.ts`, and `invalid-request.test.ts` unchanged and run them as ordering regression guards.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then one seeding middleware that sets the `match`, `actor` and `body` variables each case names, all through `hono.use("*", ...)`.
- Mount `dispatchMiddleware({ handlers })` as the sole `hono.all("*", ...)` terminal handler.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Invoke exactly one handler.
- Catch no failure outside the handler invocation.
- Append result headers before storing `result`.
- Do not call `c.header`, write `c.res`, or materialize a result.
- Do not change handler context query or request-header ordering.

## Verify

- Run:

  ```bash
  node --test \
    src/http/server/dispatch.test.ts \
    src/http/server/query.test.ts \
    src/http/server/single.test.ts \
    src/http/server/invalid-request.test.ts
  ```

- Handler context, header order, exact refusals, and non-`Error` callback values pass.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the four named test lines.
- Proof: delivers the bytewise response-header and non-`Error` failure bullets.
