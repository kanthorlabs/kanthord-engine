# Story 10 - authorize.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 9. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/authorize.ts:1-22` against `Context<AppEnv>` and Hono `Next`.
- Delete imports of `AuthenticatedState` and `RoutedState`.
- Demand `match` and `actor` in that order.
- If `match.operation.allowedActors` excludes `actor.kind`, throw `httpError("actor-forbidden", `${match.operation.operationId} does not admit actor kind ${actor.kind}`)`.
- Await `next()` once for an admitted actor.
- Rewrite direct Koa fixtures in `src/http/server/authorize.test.ts:1-196` as Hono fixtures.
- Preserve every existing harness admission, harness refusal, human admission, stub precedence, no-write, malformed-body precedence, and no-idempotency-reservation case.
- Keep real temporary SQLite only in the existing no-write case. Keep the injected `now` and schedule fakes.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then `routeMiddleware()`, `authMiddleware(dependencies)` and `authorizeMiddleware()` in that order, for each case that builds its chain directly, all through `hono.use("*", ...)`.
- Mount the reached marker as `hono.all("*", (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`. It returns no `Response`; `renderMiddleware` builds the answer.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Authorize before body parsing, idempotency reservation, and dispatch.
- Do not inspect a request body or an idempotency key.
- Keep the exact actor-forbidden message.
- Do not change registry actor lists.

## Verify

- Run `node --test src/http/server/authorize.test.ts` after the coupled batch lands.
- Refused actors cause no handler call, no write, no parse failure, and no reservation.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/authorize.test.ts` line.
