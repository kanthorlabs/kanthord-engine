# Story 7 - preflight.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 6. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/preflight.ts:1-27` against `Context<AppEnv>` and Hono `Next`.
- Keep these constants unchanged:

  ```ts
  const ALLOWED_METHODS = "DELETE, GET, POST, PUT";
  const ALLOWED_HEADERS =
    "authorization, content-type, idempotency-key, if-none-match, x-kanthord-client";
  const MAX_AGE = "86400";
  ```

- A request is a preflight only when `c.req.method === "OPTIONS"` and `optional(c, "allowedOrigin") !== undefined`.
- For all other requests, await `next()` once.
- For a preflight, demand the accumulator and set the three existing access-control headers.
- Set `result` to `{ kind: "empty", status: 204 }` and return without calling `next()`.
- Rewrite the Hono fixture and response projection in `src/http/server/preflight.test.ts:1-198`.
- Preserve the existing exact 204 response, disallowed-origin, OPTIONS-without-Origin, GET, missing request-method, path-independence, and method-list cases.
- In the bypass test, use an allowed origin, no Authorization header, and an unknown path. Assert 204, an empty body, no content type, and zero `resolveActor` calls.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then the variadic middleware list each case supplies, all through `hono.use("*", ...)`.
- Keep `originMiddleware(dependencies)` ahead of `preflightMiddleware()` in every case that needs `allowedOrigin`.
- Mount the reached marker as `hono.all("*", (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`. It returns no `Response`; `renderMiddleware` builds the answer.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so `answerOf` and every existing supertest assertion stay as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Do not inspect `Access-Control-Request-Method`.
- Do not authenticate or route-match an admitted preflight.
- Do not write status or body directly on the Hono context.
- Do not call `next()` after setting the result.

## Verify

- Run `node --test src/http/server/preflight.test.ts` after the coupled batch lands.
- The unknown-path oracle answers exact 204 and records zero actor resolutions.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/preflight.test.ts` line.
- Proof: delivers "A preflight request bypasses authentication and route matching."
