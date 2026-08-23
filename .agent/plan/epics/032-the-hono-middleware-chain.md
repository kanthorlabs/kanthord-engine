# EPIC 032 — The hono middleware chain

Status: **draft**. It is the third epic of the 030–039 band, inside phase 1b. It runs after EPIC
030 and EPIC 031, and before any phase-2 epic. `S1` under `## Open items` is applied: `hono` 4.13.3
sits in `package.json` as of 2026-08-23, so the epic is no longer blocked.

**Human action required before execution.** Keep `@types/koa` and `@types/koa__cors` in
`package.json` until EPIC 035 completes. The koa middleware still typechecks while the port runs, so
an early removal breaks `npm run typecheck`. `scripts/lane-check.sh:41` locks the manifest, so no
story in this epic edits it.

## Goal

The nine middlewares and the composition function run on Hono. Behaviour does not change. Every
parity test of EPIC 030 passes unmodified.

The chain that ships:

| Order | Module                  | Concern                                       |
| ----- | ----------------------- | --------------------------------------------- |
| 1     | `server/headers.ts`     | seed the response header accumulator          |
| 2     | `server/render.ts`      | turn the `result` variable into a `Response`  |
| 3     | `server/origin.ts`      | the origin allow list and `Vary: Origin`      |
| 4     | `server/host.ts`        | the host allow list                           |
| 5     | `server/preflight.ts`   | answer an OPTIONS preflight with 204          |
| 6     | `server/auth.ts`        | resolve the actor                             |
| 7     | `server/route.ts`       | `matchRoute` against the contract registry    |
| 8     | `server/authorize.ts`   | the actor kind gate                           |
| 9     | `server/body.ts`        | the gated JSON body parse                     |
| 10    | `server/idempotency.ts` | the idempotency cache                         |
| 11    | `server/dispatch.ts`    | call the handler, write the `result` variable |

`app.onError` produces every error envelope. No middleware produces one.

## Non-goals

- **No listener change.** `src/http/server/start.ts` keeps its Koa signature until EPIC 034. This
  epic adds no adapter and opens no socket.
- **No test-harness change.** EPIC 033 owns the dual-level harness. This epic edits a unit test only
  where the module under test changes shape.
- **No Koa removal.** `koa` and `@koa/bodyparser` stay in `package.json`. EPIC 035 removes them.
- **No new operation, and no registry edit.** The contract of `src/http/contract/` is untouched.
- **No behaviour change.** One narrowing of the `Idempotency-Key` grammar is the single exception,
  and Decision 8 records it.

## Decisions

- **The registry stays the router.** `createApp` mounts one route, `app.all("*", ...)`, and
  `routeMiddleware` calls `matchRoute` from `src/http/contract/registry.ts:50`. Hono's router is not
  adopted. `AGENTS.md` makes a path a typed segment tuple owned by `http/contract/`. A Hono route
  table duplicates the registry and admits a free-form segment.

- **`app.onError` is the one owner of error production.** `envelopeMiddleware` is deleted.
  `materializeError` stays in `src/http/server/envelope.ts` as a pure function. `app.onError` calls
  it, calls `onInternalError` when `materialized.internal` is true, and returns the envelope
  `Response`. Hono calls `onError` once per request, so `onInternalError` fires exactly once for one
  internal error. `idempotency.ts` still calls `materializeError` to build the stored answer, and it
  re-throws. It produces no envelope.

- **`context.state` becomes Hono `Variables`, and every read goes through an accessor.** Hono types
  every variable as optional across the whole chain, so chain order is no longer implicit in the
  type. `src/http/server/variables.ts` declares one `Variables` type and two accessors.
  `demand(c, name)` throws `VariableError` when the variable is absent. `optional(c, name)` returns
  `undefined`. `optional` is permitted for `allowedOrigin`, `rawBody`, `body` and `result` only,
  because each is absent by design. A bare `c.get(...)` under `src/http/server/**` is a defect.

- **One header accumulator owns every response header.** `headersMiddleware` seeds a `Headers`
  instance into the `headers` variable. Every middleware writes into that instance. `render.ts` and
  `app.onError` both read it. No middleware calls `c.header(...)`, and no middleware writes to
  `c.res`. This keeps the CORS headers on an authentication failure, on a routing failure and on an
  internal error, without a dependency on how Hono merges a prepared header into a replaced
  response.

- **Body parsing keeps its gate.** `bodyParse` runs `await c.req.text()` and `JSON.parse` only when
  `match.operation.status !== "stubbed"` and `handlers[match.operation.operationId]` is defined.
  This reproduces `src/http/server/app.ts:115-140`. A `SyntaxError` maps to
  `httpError("invalid-request", "the request body is not valid json")`, by the same message. The
  parse writes the raw text into `rawBody` and the parsed value into `body`, because
  `fingerprint` needs the exact bytes the client sent.

- **Header order is application behaviour, and wire order is not asserted.** `dispatch.ts` and
  `idempotency-response.ts` keep the bytewise sort through `Buffer.compare`. A test asserts the
  header values and the duplicate-header semantics. No test asserts raw wire order, because Fetch
  `Headers`, an adapter and a proxy each normalise it.

- **`Vary: Origin` is appended, never overwritten.** `originMiddleware` calls
  `headers.append("vary", "Origin")` inside a `finally`, so a throw downstream still appends it.

- **The `Idempotency-Key` duplicate rule reads a Fetch `Headers`.** Node joins two headers of one
  name into one comma-separated value, and no public API recovers the count.
  `readIdempotencyKey` therefore takes a `Headers` and refuses a value that contains a comma, with
  the message `Idempotency-Key was supplied more than once`. A duplicate produces the message it
  produces today. A single key that contains a comma is now refused. No test in the tree accepts
  such a key, so every parity test of EPIC 030 passes unmodified.

- **`systemSchedule` stays in `src/http/server/app.ts`, and EPIC 035 moves it.**
  `setTimeout(...).unref()` is the one Node-only call in the chain. EPIC 035 splits the composition
  roots and moves it to `src/http/server/runtime/node/schedule.ts` in one step. A move inside this
  epic relocates the file twice. `createApp` keeps `dependencies.schedule ?? systemSchedule` as the
  default.

- **`bindingOffenders` and `unimplementedFor` do not change.** They read the registry only. They
  stay in `src/http/server/app.ts` at their current shape.

## Stories

Author with `/author`. The sequence below is the dependency order. Each story is one commit.

1. **The typed variables and the accessors.** Add `src/http/server/variables.ts`. Export the
   `Variables` type with `headers: Headers`, `match: RouteMatch`, `actor: ActorRow`,
   `allowedOrigin: string`, `rawBody: string`, `body: unknown` and `result: HandlerResult`. Export
   `AppEnv = { Variables: Variables }`. Export `class VariableError extends Error`. Export
   `demand(c, name)` and `optional(c, name)`. `demand` throws `VariableError` with the message
   `the ${name} variable is absent`. Add `variables.test.ts`, which asserts the throw by variable
   name.
2. **The header accumulator.** Add `src/http/server/headers.ts` with `headersMiddleware()`. It sets
   a new `Headers` into the `headers` variable, then calls `next`. Add `headers.test.ts`.
3. **The render middleware.** Add `src/http/server/render.ts` with `renderMiddleware()`. It calls
   `next`, reads `optional(c, "result")`, and returns a `Response` built from the `HandlerResult` of
   EPIC 031 and the `headers` accumulator. It handles the `json`, `bytes` and `empty` variants. A
   `bytes` variant carries a `Uint8Array`. An absent `result` renders 404 through
   `httpError("not-found", ...)`. Add `render.test.ts`.
4. **`app.onError` owns the envelope.** Edit `src/http/server/envelope.ts`. Delete
   `envelopeMiddleware` and `EnvelopeDependencies`. Keep `materializeError` and `Materialized`
   unchanged. Add `errorResponse(materialized, headers)`, which returns a JSON `Response` carrying
   every accumulator header. Rewrite `envelope.test.ts` for the two exported functions.
5. **`origin.ts` on Hono.** Rewrite `originMiddleware` against `Context<AppEnv>`. Read the origin
   through `c.req.header("origin")`. Keep the `origin-forbidden` refusal and its message. Write
   `Access-Control-Allow-Origin` into the accumulator. Write `Access-Control-Expose-Headers` when
   `c.req.method !== "OPTIONS"`. Set the `allowedOrigin` variable. Append `vary: Origin` in a
   `finally`. Delete `OriginState`.
6. **`host.ts` on Hono.** Rewrite `hostMiddleware` against `Context<AppEnv>`. Read the host through
   `c.req.header("host")`. Keep the absent-host refusal, the unlisted-host refusal, the two messages
   and the case-insensitive compare.
7. **`preflight.ts` on Hono.** Rewrite `preflightMiddleware`. It answers when `c.req.method` is
   `OPTIONS` and `optional(c, "allowedOrigin")` is defined. It writes `Access-Control-Allow-Methods`,
   `Access-Control-Allow-Headers` and `Access-Control-Max-Age` into the accumulator, sets the
   `result` variable to the `empty` variant with status 204, and does not call `next`. The three
   constant values do not change.
8. **`auth.ts` on Hono.** Rewrite `authMiddleware` against `Context<AppEnv>`. Keep `bearerToken`
   unchanged. Keep the empty-token branch that calls `resolveActor("")`. Keep both `unauthenticated`
   messages and the `internal-error` message. Write the `actor` variable. Delete
   `AuthenticatedState`.
9. **`route.ts` on Hono.** Rewrite `routeMiddleware`. Compute the pathname with
   `new URL(c.req.url).pathname`. Call `matchRoute(c.req.method, pathname)`. Keep the `not-found`
   refusal and its message. Write the `match` variable. Delete `RoutedState`, and export
   `RouteMatch` re-use from `variables.ts` instead.
10. **`authorize.ts` on Hono.** Rewrite `authorizeMiddleware`. Read `match` and `actor` through
    `demand`. Keep the `actor-forbidden` refusal and its message.
11. **The gated body parse.** Add `src/http/server/body.ts` with `bodyMiddleware(handlers)`. It
    implements the gate of Decision 5. Delete `bodyParserForHandled` from `src/http/server/app.ts`,
    and delete the `@koa/bodyparser` import there. Add `body.test.ts`, which asserts the 501 answer
    for invalid JSON on a `stubbed` operation.
12. **The idempotency helpers on Fetch types.** Edit `src/http/server/idempotency-key.ts` so that
    `readIdempotencyKey` takes a `Headers` and applies Decision 8. Delete `RawHeaderSource`. Edit
    `src/http/server/idempotency-response.ts` so that `headerSnapshot`, `captureAnswer` and
    `applyAnswer` take the `Headers` accumulator instead of a Koa `Context`. `applyAnswer` writes
    the `result` variable. Keep `VOLATILE_HEADERS` and the bytewise sort. Update
    `idempotency-key.test.ts` and `idempotency-response.test.ts` to build a `Headers`.
13. **`idempotency.ts` on Hono.** Rewrite the middleware against `Context<AppEnv>`. Read the key from
    `c.req.raw.headers`. Build the fingerprint from `c.req.method`, `new URL(c.req.url).pathname`,
    the search string without the leading `?`, and `optional(c, "rawBody") ?? ""`. Read the durable
    `importId` from the `body` variable. Capture and replay through the `result` variable. Keep
    every refusal code and message.
14. **`dispatch.ts` on Hono.** Rewrite `dispatchMiddleware` as the terminal handler. Keep both
    `not-implemented` refusals and their messages. Build the `HandlerContext` from `c.req`, the
    `body` variable and the `actor` variable. Keep `readHeaders` and its bytewise sort, sourced from
    `c.req.raw.headers`. Write the `result` variable. Delete the Koa status and body writes.
15. **`createApp` returns a Hono app.** Rewrite `src/http/server/app.ts`. `App` carries
    `app: Hono<AppEnv>`. `createApp` keeps the `BindingError` check first, then mounts the eleven
    entries of the Goal table in that order through `app.use("*", ...)`, with `dispatchMiddleware`
    as the handler of `app.all("*", ...)`. Set `app.onError`. Keep `cancelWaits`, `HandlerContext`,
    `Handler`, `AppDependencies`, `TransportSettings`, `BindingError`, `unimplementedFor` and
    `bindingOffenders`. Update `app.test.ts` for the new chain.

## Verification gate

Gates: `npm run verify`

Proof:

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
  src/http/server/app.test.ts \
  src/http/server/parity.test.ts \
  && echo "PASS EPIC-032"
```

`src/http/server/parity.test.ts` is the parity test EPIC 030 adds. It runs here unmodified.

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **Every EPIC 030 parity test passes unmodified.** No line of `src/http/server/parity.test.ts`
  changes in this epic. A diff of that file is a blocker.
- **Invalid JSON on a `stubbed` operation answers 501, not 400.** The body gate skips the parse, and
  `dispatchMiddleware` raises `not-implemented`. The same request against a routed operation with a
  handler answers 400 with the message `the request body is not valid json`.
- **CORS headers appear on an authentication failure, a routing failure and an internal error.**
  Each of the three carries `Access-Control-Allow-Origin` and `Vary: Origin`, asserted by exact
  value.
- **A preflight request bypasses authentication and route matching.** An OPTIONS request with an
  allowed Origin, no `Authorization` header and an unknown path answers 204. The test asserts that
  `resolveActor` and `matchRoute` are not called.
- **`onInternalError` fires exactly once for one internal error.** A handler that throws a plain
  `Error` produces one call, asserted by a counter. The same holds when the request carries an
  `Idempotency-Key`, because `idempotency.ts` re-throws and produces no envelope.
- **`Vary: Origin` is appended, not overwritten.** A response that already carries
  `Vary: Accept-Encoding` reports both values.
- **An accessor throws when a variable is absent.** `demand` is called directly with an empty
  context for `headers`, `match` and `actor`. Each throws `VariableError` and names the variable.
- **The bytewise header sort produces the same order.** A handler returns header names that include
  a non-ASCII character, and the applied order is asserted through `Buffer.compare`. The test
  asserts values and duplicate-header semantics, not raw wire order.
- **A duplicate `Idempotency-Key` is refused with the current message**, and a single key that
  contains a space is still accepted.
- **The idempotency fingerprint uses the raw request bytes.** Two bodies that parse to the same
  value but differ in whitespace produce two fingerprints.
- **Hermetic**: no network, no shared temporary directory, no wall clock. A test that needs time
  passes a `now` function and a fake `Schedule`.

## Open items

- S1 - status:OPEN - action:YES - add hono to package.json - the epic rewrites the chain on Hono,
  and an epic carries source-code edits only, so it cannot add the dependency -
  fix:add `"hono": "4.10.7"` to `dependencies` in `package.json`, run `npm install`, and commit
  `package.json` and `package-lock.json` - why:`scripts/lane-check.sh:44` denies `package.json` to
  every agent lane, so the epic deadlocks at story 1 without this change.
- S2 - status:OPEN - action:YES - keep the koa types until EPIC 035 - `@types/koa` still serves
  `src/http/server/start.ts`, which EPIC 034 owns - fix:no change now; remove `@types/koa`,
  `@types/koa__cors`, `koa`, `@koa/cors` and `@koa/bodyparser` in EPIC 035 - why:removing them here
  breaks the listener that this epic does not touch.
- **The `Idempotency-Key` narrowing is deliberate.** A single key that contains a comma is refused
  after this epic. The rule is recorded in Decision 8 and pinned by a test. EPIC 030 records it in
  the parity contract.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
