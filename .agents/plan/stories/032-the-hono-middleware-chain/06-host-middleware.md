# Story 6 - host.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 5. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/host.ts:1-27` against `Context<AppEnv>` and Hono `Next`.
- Keep `HostDependencies` and lower-case every configured host once when the middleware is created.
- Read only `c.req.header("host")`.
- If absent, throw `httpError("host-forbidden", "the request carried no Host header")`.
- If its lower-case value is absent from the allow list, throw `httpError("host-forbidden", `the Host header ${host} is outside the allow list`)`.
- Await `next()` once for an admitted host.
- Rewrite the Hono application fixture in `src/http/server/host.test.ts:1-171` and drive it through `loopbackAgent(koaFromHono(hono))`.
- Preserve all existing allowed, unlisted, case-insensitive, port, trailing-dot, multiple-entry, empty-list, forwarded-host, and non-leaking message cases.
- Keep the current Supertest-generated host case distinct from the missing-Host case that Story 16 adds.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then `hostMiddleware(dependencies)`, all through `hono.use("*", ...)`.
- Mount the reached marker as `hono.all("*", (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`. It returns no `Response`; `renderMiddleware` builds the answer.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Ignore `X-Forwarded-Host`.
- Keep ports and trailing dots significant.
- Do not synthesize a Host header from the request URL.
- Do not change `test/helpers/agent.ts`.

## Verify

- Run `node --test src/http/server/host.test.ts` after the coupled batch lands.
- Every admitted and refused host retains its exact status and message.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/host.test.ts` line.
- Proof: Story 16 adds the missing-Host full-chain assertion.
