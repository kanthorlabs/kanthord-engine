# Story 13 - idempotency.ts on Hono

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 12. Coupled with Stories 3 through 16.

## Change

- Rewrite `src/http/server/idempotency.ts:1-169` against `Context<AppEnv>` and Hono `Next`.
- Keep `IdempotencyDependencies`, `IdempotencyStore`, settings, and the `middleware` plus `store` return contract.
- Demand `match`, read the key from `c.req.raw.headers`, and preserve key validation before policy bypass.
- Preserve every existing absent-key, `none`, durable, zero-TTL, saturation, mismatch, replay, joined, timeout, and reserved branch in that order.
- Read durable `importId` from `optional(c, "body")`. Keep strict equality and `Idempotency-Key must equal importId`.
- Build the fingerprint from `c.req.method`, `new URL(c.req.url).pathname`, `new URL(c.req.url).search.slice(1)`, and `optional(c, "rawBody") ?? ""`.
- Demand `actor` and preserve the current `recordKey` fields.
- Demand the header accumulator and take `headerSnapshot(headers)` immediately before the reserved request calls `next()`.
- For `replay` and joined answers, write the exact answer to `replay` and return. Do not construct a response.
- For a reserved request, await `next()` without a wrapping `try/catch`.
- After `next()`, if `c.error` is defined, unwrap it with `errorValue`, materialize it, serialize the envelope once with `JSON.stringify`, capture that exact string and current accumulator headers, classify with the materialized status and `internal`, settle, and return.
- Otherwise, demand `result` and enter a `try` that covers only `materializeResult(result, match.operation, headers)`.
- On success, capture the exact materialized body, classify with `internal: false`, settle, and write the captured answer to `replay`.
- If materialization throws, preserve that exact failure. Unwrap it only for error materialization, set `application/json; charset=utf-8` when content type is absent, serialize the generic or declared envelope once, capture and settle it with the materialized status and `internal`, then throw the original failure.
- Delete the current downstream `try/catch` at `src/http/server/idempotency.ts:132-165` and every call to `applyAnswer`.
- Rewrite the Hono fixture in `src/http/server/idempotency.test.ts:1-1293`.
- Wrap socket entry points with `koaFromHono`; keep the raw duplicate-header request at socket level.
- Preserve all existing memory, actor isolation, concurrent join, timeout, TTL, saturation, durable import, and refusal cases with exact codes and messages.
- Change the old comma-key acceptance to duplicate refusal. Keep the interior-space acceptance.
- Add raw-body fingerprint rows whose JSON values are equal but whose whitespace differs. Assert two distinct fingerprints through a mismatch response.
- Add exact replay rows for JSON text, `Uint8Array`, and null bodies. Assert first and replay status, content type, and bytes.
- Add a stateful `toJSON` result. Assert one serialization, one handler call, and byte-identical first and replay answers.
- Preserve the replayable `HttpError` case. Assert one handler call and exact stored status and body on the second request.
- Preserve the plain `Error` indeterminate case. Assert one callback, one handler call, one retained record, and the same generic 500 on replay.
- Add a keyed unserializable JSON result. Send two identical requests. Assert the same generic 500, exact `application/json; charset=utf-8`, one handler call, one callback, and one retained indeterminate record.

## Test fixture

- Replace the `envelopeMiddleware`-topped Koa fixture with `new Hono<AppEnv>()`.
- Set `hono.onError((error, c) => errorResponse(materializeError(errorValue(error)), demand(c, "headers")))`. Keep the `onInternalError` counter each existing case already injects.
- Mount `headersMiddleware()` first, then `renderMiddleware()`, then `routeMiddleware()`, `bodyMiddleware(bound)`, the actor-seeding middleware the fixture already holds, and the idempotency middleware in that order, all through `hono.use("*", ...)`.
- Build `bound` as a map from every operation id the fixture drives, `project.create` and `repository.inspect`, to the counting terminal handler, so the body gate admits the request.
- Mount the counting terminal as `hono.all("*", ...)`. It increments the call count and writes `result`; it returns no `Response`.
- Drive the fixture through `loopbackAgent(koaFromHono(hono))`, so every existing supertest assertion stays as written.
- Import `koaFromHono` from `./koa-bridge.ts`, which Story 15 adds before this story runs.

## Constraints

- Never catch `await next()`.
- Never create an envelope response in this middleware.
- Materialize and serialize each successful or failed reserved answer once.
- Keep indeterminate records replayable to identical requests.
- Use injected `now` and `schedule`; remove any wall-clock watchdog from changed fixtures.
- Do not edit the durable storage contract.

## Verify

- Run `node --test src/http/server/idempotency.test.ts` after the coupled batch lands.
- All old reservation outcomes pass. Exact body replay, one-time serialization, downstream errors, and serialization failure pass.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/idempotency.test.ts` line.
- Proof: delivers the failed-answer, exact-body, fingerprint, duplicate-key, and one-callback idempotency bullets.
