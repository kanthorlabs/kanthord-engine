# Story 9 - route.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 8. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/route.ts:1-24` against `Context<AppEnv>` and Hono `Next`.
- Delete `RoutedState`.
- Compute `const pathname = new URL(c.req.url).pathname` once.
- Call `matchRoute(c.req.method, pathname)` once.
- If no route matches, throw `httpError("not-found", `no operation for ${c.req.method} ${pathname}`)`.
- Store the exact `RouteMatch` as `match`, then await `next()` once.
- Rewrite the Hono fixtures in `src/http/server/route.test.ts:1-153`.
- Preserve the health match, parameter extraction, exact 404, query exclusion, route-state, post-MVP absence, 404-versus-501, and authentication-precedence cases.
- Observe a successful match through `demand(c, "match")` and assert the exact operation and parameters.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then `routeMiddleware()`, all through `hono.use("*", ...)`.
- Mount the reached marker as `hono.all("*", (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`. It returns no `Response`; `renderMiddleware` builds the answer.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Keep `RouteMatch` declared only in `src/http/contract/registry.ts:45-48`.
- Do not use Hono route parameters or register operation-specific Hono routes.
- Pass the URL pathname without decoding a path segment.
- Do not include the query string in the refusal message.

## Verify

- Run `node --test src/http/server/route.test.ts` after the coupled batch lands.
- Exact matches, parameters, and 404 messages pass unchanged.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/route.test.ts` line.
- Proof: the unchanged EPIC 030 path parity test remains the raw-path guard.
