# EPIC 032 - The Hono middleware chain - stories

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Prereq: EPIC 031 (sequence order).

The nine middleware concerns, rendering, dispatch, and composition run on Hono behind the unchanged Koa listener.

## Dispatch order

Run Stories 1 and 2 as standalone changes. Run Stories 3 through 16 as one coupled batch in this order:

1. Story 3
2. Story 4
3. Story 15
4. Stories 5 through 14 in numeric order
5. Story 16

Do not run a gate or create a commit between Stories 3 and 16. Story 15 precedes Story 5 because eight socket-driven test files need the bridge when their applications become Hono applications: `origin.test.ts`, `host.test.ts`, `preflight.test.ts`, `auth.test.ts`, `route.test.ts`, `authorize.test.ts`, `dispatch.test.ts` and `idempotency.test.ts`.

## Stories

- Story 1 - Add typed Hono variables and accessors -> `01-typed-variables-and-accessors.md`
- Story 2 - Seed the shared response header accumulator -> `02-header-accumulator.md`
- Story 3 - Move error envelopes to `app.onError` helpers -> `03-onerror-envelope.md`
- Story 4 - Materialize and render every non-error response -> `04-render-middleware.md`
- Story 5 - Port origin checks and CORS headers to Hono -> `05-origin-middleware.md`
- Story 6 - Port Host validation to Hono -> `06-host-middleware.md`
- Story 7 - Port preflight termination to Hono -> `07-preflight-middleware.md`
- Story 8 - Port actor resolution to Hono -> `08-auth-middleware.md`
- Story 9 - Port contract route matching to Hono -> `09-route-middleware.md`
- Story 10 - Port actor authorization to Hono -> `10-authorize-middleware.md`
- Story 11 - Add the gated and bounded JSON body parser -> `11-gated-body-parser.md`
- Story 12 - Move idempotency helpers to Fetch-native values -> `12-idempotency-fetch-helpers.md`
- Story 13 - Port idempotency reservation and replay to Hono -> `13-idempotency-middleware.md`
- Story 14 - Port terminal handler dispatch to Hono -> `14-dispatch-middleware.md`
- Story 15 - Bridge Hono through the retained Koa listener -> `15-koa-bridge.md`
- Story 16 - Compose the Hono chain and run the batch gate -> `16-create-app-composition.md`

## Facts (needed for implementation)

- EPIC 030 supplies the four parity tests that Story 16 must not edit. See `.agents/plan/stories/030-transport-inventory-and-parity-contract/index.md:27-34`.
- EPIC 031 supplies `HandlerResult`, `HandlerStatus`, `compareBytewise`, and `koa-body.ts`. See `.agents/plan/stories/031-fetch-native-response-model/02-result-union-and-all-producers-consumers.md:10-74`.
- Current middleware composition is in `src/http/server/app.ts:81-106`; `bodyParserForHandled` is at `src/http/server/app.ts:115-140`.
- Current Koa state types are in `src/http/server/origin.ts:11`, `auth.ts:30`, and `route.ts:7`. Stories 5, 8, and 9 delete them.
- Fetch `Headers` lower-cases names, sorts iteration by name, and joins duplicate values with `", "`. The chain uses one accumulator.
- `src/http/server/start.ts:11-38`, `src/main.ts:641-670`, `test/helpers/app.ts:108-174`, and `test/helpers/agent.ts:6-28` remain unchanged.
- Story 16 deletes EPIC 031's `src/http/server/koa-body.ts`. Ulrich removes its human-only eslint ignore after the batch, per EPIC 032 open item S5.
- The Proof owns 26 test files. Story 16 runs the complete block and must print `PASS EPIC-032`.
