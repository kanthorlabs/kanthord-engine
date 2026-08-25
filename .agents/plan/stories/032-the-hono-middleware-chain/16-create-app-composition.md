# Story 16 - createApp returns both applications

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Stories 5 through 15. Final story in the coupled batch.

## Change

### Composition

- Rewrite the framework imports and `createApp` body at `src/http/server/app.ts:1-21,66-113`.
- Keep `TransportSettings`, `HandlerContext`, every result type from EPIC 031, `Handler`, `AppDependencies`, `systemSchedule`, `BindingError`, `unimplementedFor`, and `bindingOffenders`.
- Keep `systemSchedule` at `src/http/server/app.ts:60-64`, including `setTimeout(...).unref()`.
- Change `App` to carry `app: Koa`, `hono: Hono<AppEnv>`, and `cancelWaits: () => void`.
- Run `bindingOffenders` first. If any offender exists, throw the same `BindingError` before constructing Hono, Koa, or idempotency state.
- Construct one `Hono<AppEnv>` and one idempotency middleware. Pass all three current arguments of `src/http/server/app.ts:104-108`: `settings: dependencies.idempotency ?? defaultIdempotencySettings`, `now: dependencies.now ?? (() => Date.now())`, and `schedule: dependencies.schedule ?? systemSchedule`.
- Mount these ten middleware entries through `hono.use("*", ...)` in this exact order:

  1. `headersMiddleware()`
  2. `renderMiddleware()`
  3. `originMiddleware({ allowedOrigins: dependencies.settings.allowedOrigins })`
  4. `hostMiddleware({ allowedHosts: dependencies.settings.allowedHosts })`
  5. `preflightMiddleware()`
  6. `authMiddleware({ token: dependencies.settings.token, resolveActor: dependencies.resolveActor })`
  7. `routeMiddleware()`
  8. `authorizeMiddleware()`
  9. `bodyMiddleware(dependencies.handlers)`
  10. the idempotency middleware

- Mount `dispatchMiddleware({ handlers: dependencies.handlers })` as the sole `hono.all("*", ...)` terminal handler.
- Set `hono.onError((error, c) => ...)`.
- In that callback, call `errorValue(error)`, then `materializeError(value)`, then call `dependencies.onInternalError(value)` exactly once only when `materialized.internal` is true.
- Return `errorResponse(materialized, demand(c, "headers"))`.
- Build `app` only with `koaFromHono(hono)` and return `{ app, hono, cancelWaits: () => dependencies.waits.cancelAll() }`.
- Delete EPIC 031's `src/http/server/koa-body.ts` because no caller remains.

### Application tests

- Rewrite framework-specific fixtures in `src/http/server/app.test.ts:1-402` while preserving every existing order and response assertion.
- Assert `Object.keys(createApp(...)).sort()` equals `["app", "cancelWaits", "hono"]`.
- Keep the Koa bridge `app.proxy === false` assertion.
- Preserve the existing observable precedence cases for origin, host, preflight, authentication, routing, authorization, body parsing, and dispatch.
- Add full-chain CORS cases with `allowedOrigins: ["http://localhost:8080"]` for an authentication failure, a route failure, and a plain handler `Error`.
- Send `Origin: http://localhost:8080` in all three cases. Assert `Access-Control-Allow-Origin: http://localhost:8080` and `Vary: Origin` exactly.
- Assert the plain handler `Error` calls `onInternalError` exactly once. Repeat with `Idempotency-Key` and assert one callback.
- Add full-chain table rows for a handler throwing a string and `undefined`. Assert exact generic 500 envelopes and exact callback values.
- Add a raw HTTP/1.0 no-Host request through `loopbackServer(app)`. Assert status 403 and exact message `the request carried no Host header`, not a bare 400.
- Preserve preflight-before-authentication and preflight-before-route assertions with zero actor resolution.
- Preserve every existing `BindingError` offender-order assertion.
- Add a binding-first case with an incomplete binding and throwing getters for `settings`, `idempotency`, `now`, and `schedule`.
- Assert the exact `BindingError` and zero reads from all four getters.

### Regression fences

- Do not edit `src/http/server/app.handler-result.test.ts`, `app.parity-body.test.ts`, `app.parity-cors.test.ts`, or `app.parity-path.test.ts`.
- Use the unchanged `app.handler-result.test.ts` blob rows to assert exact blob bytes, computed `content-length`, and bodyless 204 headers through the full bridge.
- Do not edit `src/http/server/start.ts:1-38`, `src/main.ts:641-670`, `test/helpers/app.ts:108-174`, or `test/helpers/agent.ts:6-28`.
- Confirm no production file under `src/http/server/**` imports a Koa value except `koa-bridge.ts`; `app.ts` and `start.ts` use type-only Koa imports.
- Add an `app.test.ts` source scan over production `src/http/server/**/*.ts`, excluding tests.
- Exclude only `variables.ts` from the `\bc\.get\(` scan. Assert exact empty offender lists for bare `c.get` elsewhere, `\bc\.header\(` everywhere, and `\bc\.res\s*=` everywhere.
- In the same scan, collect non-type imports from `"koa"`. Assert the exact repository-relative list equals `["src/http/server/koa-bridge.ts"]`.

## Constraints

- Keep the contract registry as the only router. Mount only `"*"` in Hono.
- Keep every header write before downstream execution.
- Build every error envelope only in `hono.onError`.
- Keep the listener, composition root, and shared test harness unchanged.
- Permit bare `c.get` only inside the two accessors in `variables.ts`.
- Keep Koa and body-parser packages in the manifest. EPIC 035 removes them.
- Do not edit contract registry data or add an operation.
- Keep every changed test hermetic. Use loopback only, inject `now`, use fake `Schedule`, and use private temporary directories where SQLite is required.

## Verify

- Run the complete EPIC Proof verbatim:

  ```bash
  node --test \
    src/http/server/variables.test.ts \
    src/http/server/headers.test.ts \
    src/http/server/render.test.ts \
    src/http/server/envelope.test.ts \
    src/http/server/origin.test.ts \
    src/http/server/host.test.ts \
    src/http/server/preflight.test.ts \
    src/http/server/auth.test.ts \
    src/http/server/route.test.ts \
    src/http/server/authorize.test.ts \
    src/http/server/body.test.ts \
    src/http/server/idempotency-key.test.ts \
    src/http/server/idempotency-record.test.ts \
    src/http/server/idempotency-response.test.ts \
    src/http/server/idempotency-store.test.ts \
    src/http/server/idempotency.test.ts \
    src/http/server/dispatch.test.ts \
    src/http/server/query.test.ts \
    src/http/server/single.test.ts \
    src/http/server/invalid-request.test.ts \
    src/http/server/koa-bridge.test.ts \
    src/http/server/app.test.ts \
    src/http/server/app.handler-result.test.ts \
    src/http/server/app.parity-body.test.ts \
    src/http/server/app.parity-cors.test.ts \
    src/http/server/app.parity-path.test.ts \
    && echo "PASS EPIC-032"
  ```

- The command prints `PASS EPIC-032`.
- Run `git diff --exit-code -- src/http/server/app.handler-result.test.ts src/http/server/app.parity-body.test.ts src/http/server/app.parity-cors.test.ts src/http/server/app.parity-path.test.ts` against the EPIC 031 baseline. It exits 0.
- Run `npm run verify`; it exits 0.
- Proof: delivers the `src/http/server/app.test.ts`, `app.handler-result.test.ts`, and three parity-test lines.
- Proof: delivers `PASS EPIC-032` and every full-chain coverage bullet.
- Proof: Stories 1 through 16 jointly deliver the hermetic coverage bullet; Story 16 verifies it through `npm run verify`.
