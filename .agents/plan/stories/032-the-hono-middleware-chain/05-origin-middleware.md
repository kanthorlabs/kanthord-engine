# Story 5 - origin.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 15. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/origin.ts:1-38` against `Context<AppEnv>` and Hono `Next`.
- Keep `OriginDependencies`, the exact-value allow-list `Set`, and `EXPOSED_HEADERS = "etag, accept-ranges, content-range"`.
- Delete `OriginState`.
- Read the request origin with `c.req.header("origin")`.
- If the origin is present and absent from the allow list, throw `httpError("origin-forbidden", `the Origin header ${origin} is outside the allow list`)` before any CORS header write.
- Demand the header accumulator.
- For an allowed origin, set `Access-Control-Allow-Origin`, set `Access-Control-Expose-Headers` when `c.req.method !== "OPTIONS"`, and write `allowedOrigin`.
- Append `vary: Origin` before `next()` for both an allowed origin and an absent origin.
- Await `next()` once. Delete the current `finally` block.
- Rewrite the local Hono fixture in `src/http/server/origin.test.ts:1-325`.
- Preserve all existing allow-list, method, canonicalization, `Referer`, expose-header, credential-header, and `Vary` merge table cases.
- Assert that allowed and absent origins carry exact `Vary: Origin` values.
- Assert that an allowed origin preserves `Access-Control-Allow-Origin` and `Vary: Origin` on downstream 401, 404, and 500 responses.
- Assert that `origin-forbidden` carries neither `Access-Control-Allow-Origin` nor `Vary`.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then `originMiddleware(dependencies)`, all through `hono.use("*", ...)`.
- Mount the reached marker as `hono.all("*", (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`. It returns no `Response`; `renderMiddleware` builds the answer.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Compare origins case-sensitively and without normalization.
- Write every response header before `next()`.
- Do not call `c.header`, write `c.res`, or build an envelope.
- Keep `Access-Control-Allow-Credentials` absent.

## Verify

- Run `node --test src/http/server/origin.test.ts` after the coupled batch lands.
- The existing origin matrix passes with exact CORS values and error survival.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/origin.test.ts` line.
- Proof: delivers the CORS-on-failure and origin-forbidden coverage bullets.
