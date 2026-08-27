# Story 8 - auth.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 7. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/auth.ts:1,25-56` against `Context<AppEnv>` and Hono `Next`.
- Keep `bearerToken` at `src/http/server/auth.ts:6-23` byte-for-byte unchanged.
- Keep `AuthDependencies` unchanged and delete `AuthenticatedState`.
- For an empty configured token, call `resolveActor("")`, throw `httpError("internal-error", "the database holds no actor row")` when absent, set `actor`, then await `next()`.
- Otherwise, read `c.req.header("authorization")` and parse it with `bearerToken`.
- If parsing returns `null`, throw `httpError("unauthenticated", "no bearer token")`.
- Resolve the exact parsed token once. If absent, throw `httpError("unauthenticated", "the bearer token is not valid")`.
- Set the exact returned actor and await `next()` once.
- Rewrite the Hono fixture in `src/http/server/auth.test.ts:1-264`.
- Preserve the complete bearer parser table and every existing route-independent, resolver, configured-token, empty-token, exact-state, and exact-call-count assertion.
- In the terminal `next`, call `demand(c, "actor")`; assert strict identity with the resolver's actor.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then `authMiddleware(dependencies)`, all through `hono.use("*", ...)`.
- Mount the reached marker as `hono.all("*", (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`. It returns no `Response`; `renderMiddleware` builds the answer.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Do not trim or normalize bearer token contents.
- Do not add crypto or registry dependencies.
- Keep the empty-token branch independent of the request Authorization header.
- Do not call `resolveActor` more than once per request.

## Verify

- Run `node --test src/http/server/auth.test.ts` after the coupled batch lands.
- The parser table and all three exact refusal messages pass unchanged.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/auth.test.ts` line.
