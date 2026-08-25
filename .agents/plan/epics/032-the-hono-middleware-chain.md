# EPIC 032 — The hono middleware chain

Status: **draft**. It is the third epic of the 030–039 band, inside phase 1b. It runs after EPIC
030 and EPIC 031, and before any phase-2 epic. `hono` 4.13.3 sits in `package.json` as of
2026-08-23.

**Human action required before execution.** One manifest fact must hold, and
`scripts/lane-check.sh:41` locks the manifest, so no story in this epic edits it.

- `@types/koa` and `@types/koa__cors` stay in `package.json` until EPIC 035 completes. The koa
  listener and the koa bridge still typecheck while the port runs.

`npm install` has run. `node_modules/hono` holds 4.13.3 and `node_modules/@hono/node-server` holds
2.1.1 as of 2026-08-23, and `package-lock.json` did not move. Story 15 imports
`getRequestListener` from `@hono/node-server`. EPIC 034 owns `serve` and the listener itself.

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

One further file ships beside the chain. `server/koa-bridge.ts` serves the Hono app from the Koa
listener through `@hono/node-server`, so `start.ts`, `main.ts` and the test helpers do not change in
this epic.

## Non-goals

- **No listener change.** `src/http/server/start.ts` keeps its Koa signature until EPIC 034. This
  epic opens no socket and writes no adapter of its own. `koa-bridge.ts` is the one seam, it holds
  four statements, and Decision 12 bounds it.
- **No test-harness change.** EPIC 033 owns the dual-level harness. `test/helpers/app.ts` and
  `test/helpers/agent.ts` keep their Koa types. This epic edits a unit test only where the module
  under test changes shape.
- **No Koa removal.** `koa` and `@koa/bodyparser` stay in `package.json`. EPIC 035 removes them.
- **No new operation, and no registry edit.** The contract of `src/http/contract/` is untouched.
- **No behaviour change.** Decision 8 and Decision 13 record the two narrow exceptions, and each one
  is pinned by a test.

## Decisions

- **1. The registry stays the router.** `createApp` mounts one route, `app.all("*", ...)`, and
  `routeMiddleware` calls `matchRoute` from `src/http/contract/registry.ts:50`. Hono's router is not
  adopted. `AGENTS.md` makes a path a typed segment tuple owned by `http/contract/`. A Hono route
  table duplicates the registry and admits a free-form segment.

- **2. Hono catches an error at the frame that throws, and that fixes the shape of every
  middleware.** `compose` wraps each middleware call in its own `try`. When a middleware throws, the
  frame that called it catches, sets `c.error`, calls `app.onError`, assigns the returned `Response`
  to `c.res`, and returns to its caller as if the call succeeded. Four rules follow, and they are
  binding.

  - A `try/catch` around `await next()` never observes a downstream error. A middleware that must
    observe a failure reads `c.error` after `next()` returns.
  - A middleware that returns a `Response` after `next()` returns is discarded, because `c.res` is
    already assigned and `c.finalized` is true.
  - A middleware that **throws** after `next()` returns calls `app.onError` a second time and
    replaces the answer. No middleware in the chain throws after `next()` returns while `c.error` is
    defined.
  - `app.onError` fires once per failing request, so `onInternalError` fires once for one internal
    error.

  `envelopeMiddleware` is deleted. `materializeError` stays in `src/http/server/envelope.ts` as a
  pure function. `app.onError` calls `errorValue`, materializes that value, calls `onInternalError`
  with that value when `materialized.internal` is true, and returns the envelope `Response`.

- **3. Every response header is written before `next()`.** `app.onError` builds the error `Response`
  at the frame that threw, so a header written after `next()` returns never reaches an error answer.
  No middleware writes a header in a `finally` block, and no middleware writes a header after
  `next()` returns.

- **4. `context.state` becomes Hono `Variables`, and every read goes through an accessor.** Hono
  types a declared variable as present, but its runtime getter returns `undefined` before a writer
  runs. Chain order is therefore not enforced by the type. `src/http/server/variables.ts` declares
  one `Variables` type and two accessors.

  `demand<Name extends keyof Variables>(c: Context<AppEnv>, name: Name): Variables[Name]` throws
  `VariableError` when the variable is absent. `optional<Name extends OptionalVariable>(c:
Context<AppEnv>, name: Name): Variables[Name] | undefined` returns `undefined` for an absent value.
  `OptionalVariable` is the private union `"allowedOrigin" | "rawBody" | "body" | "result" |
"replay"`. A bare `c.get(...)` under `src/http/server/**` is a defect.

- **5. One header accumulator owns every response header.** `headersMiddleware` seeds a `Headers`
  instance into the `headers` variable. Every middleware writes into that instance. `render.ts` and
  `app.onError` both read it. No middleware calls `c.header(...)`, and no middleware writes to
  `c.res`. This keeps the CORS headers on an authentication failure, on a routing failure and on an
  internal error.

  A Fetch `Headers` lower-cases every name, sorts its own iteration by name, and joins a duplicate
  value with `", "`. Response header order is therefore the accumulator's order, and one test pins
  that order against `compareBytewise` over the lower-cased names. An explicit sort stays only where
  the order is otherwise unobservable: `readHeaders` in `dispatch.ts`, which builds the plain object
  the handler reads, and `captureAnswer`, which builds a stored array.

- **6. Body parsing keeps its gate, and the gate is exact.** `bodyMiddleware` reproduces
  `bodyParserForHandled` at `src/http/server/app.ts:115-140` and `@koa/bodyparser` with
  `enableTypes: ["json"]`. The rules, in order:

  1. The method must be `POST`, `PUT` or `PATCH`. For any other method the middleware writes neither
     `body` nor `rawBody`, and both stay absent.
  2. The operation must carry a handler: `match.operation.status !== "stubbed"` and
     `handlers[match.operation.operationId] !== undefined`. Otherwise it writes neither variable.
  3. The `content-type` header, with any trailing `;` removed, must name one of six media types:
     `application/json`, `application/json-patch+json`, `application/vnd.api+json`,
     `application/csp-report`, `application/reports+json`, `application/scim+json`. The compare
     ignores case and ignores every parameter, so `application/json; charset=utf-8` matches.
     Otherwise the middleware writes `body` as `{}` and leaves `rawBody` absent.
  4. The middleware reads the text with `await c.req.text()` and writes it into `rawBody`.
  5. An empty text writes `body` as `{}`.
  6. A text whose first character after any run of `\x20`, `\x09`, `\x0a` or `\x0d` is neither `[`
     nor `{` is refused with `httpError("invalid-request", "the request body is not valid json")`.
     A scalar body such as `1` or `"a"` therefore answers 400.
  7. `JSON.parse` produces `body`. A `SyntaxError` is refused with the same code and the same
     message.

  `bodyParserForHandled` and the `@koa/bodyparser` import leave `src/http/server/app.ts`.

- **7. A replay is not a `HandlerResult`, and its body holds exact response bytes.** `HandlerResult`
  of EPIC 031 admits 200, 204, 206 and 304 only, and a replay carries the stored status, which
  includes 400, 409 and 500. `variables.ts` therefore declares a second variable,
  `replay: StoredAnswer`. `idempotency.ts` writes `replay`, never `result`. `render.ts` reads
  `replay` first.

  `StoredAnswer.body` becomes `string | Uint8Array | null`. A JSON result and an error envelope store
  the exact string from `JSON.stringify`. A bytes result stores its `Uint8Array`. An empty result
  stores `null`. `render.ts` exports `MaterializedResult = Readonly<{ status: HandlerStatus; body:
string | Uint8Array | null }>` and `materializeResult(result: HandlerResult, operation: Operation,
headers: Headers): MaterializedResult`. The function writes the default content type when absent
  and returns the exact status and body in that stored form. An unreserved response calls it from
  `renderMiddleware`. A reserved response calls it once from `idempotencyMiddleware`, captures the
  returned body, and writes that `StoredAnswer` into `replay`; render then uses those captured bytes
  instead of serializing the `HandlerResult` again. A replay writes each stored header into the
  accumulator with `set`, then constructs `new Response(answer.body, { status: answer.status,
headers })`.

  `JSON.stringify` returning `undefined` throws `TypeError("the handler result is not json
serializable")`. A `JSON.stringify` exception propagates unchanged. Both become the generic 500
  envelope through `app.onError`.

  A Fetch `Headers` cannot hold two values for one name, so `StoredAnswer.headers` becomes
  `readonly (readonly [string, string])[]`, one joined value per name. `captureAnswer` takes the
  exact stored body type. `answerBytes` counts a string by its UTF-8 byte length, a `Uint8Array` by
  `byteLength`, and `null` as zero bytes. It then adds the UTF-8 byte length of the serialized header
  tuples. `applyAnswer` is deleted; the write of the `replay` variable replaces it.

- **8. `renderMiddleware` builds every non-error response, and it never throws over an error.** It
  calls `next`, then applies four rules in order.

  1. `c.error !== undefined`: return nothing. `app.onError` already owns the answer.
  2. `optional(c, "replay")` is defined: apply the stored headers with `set`, then return a
     `Response` from its exact stored body, status and the accumulator.
  3. `optional(c, "result")` is defined: call `materializeResult`, then return a `Response` from its
     exact body, status and the accumulator. The `json` variant serializes with `JSON.stringify` and
     sets `application/json; charset=utf-8`. The `bytes` variant keeps its `Uint8Array` and sets the
     matched operation's `responseMedia`. The `empty` variant uses `null` and sets no content type.
     Each default applies only when the accumulator does not carry `content-type`, so a handler
     header still wins.
  4. Neither is defined: throw
     `httpError("internal-error", "the transport produced no result")`. The shipped chain never
     reaches this rule, because `preflightMiddleware` and `dispatchMiddleware` each write `result`
     or throw.

- **9. `Vary: Origin` is appended before `next()`, and a refused origin carries none.**
  `originMiddleware` calls `headers.append("vary", "Origin")` after the allow-list check and before
  `next()`. An allowed origin and an absent origin each carry it. The `origin-forbidden` refusal
  throws before the append and carries neither `Access-Control-Allow-Origin` nor `Vary`, which is
  row P11 of the EPIC 030 parity contract. Decision 3 forbids the `finally` block that
  `src/http/server/origin.ts:34` uses today.

- **10. `idempotency.ts` observes `c.error`, and it produces no envelope.** After `next()` returns
  the middleware branches once.

  - `c.error` is defined: unwrap it through `errorValue`, build the stored answer from
    `materializeError`, serialize the envelope body with `JSON.stringify`, settle the reservation
    with `classifyOutcome` over the materialized status and the materialized `internal` flag, and
    return. It re-throws nothing, because `app.onError` already produced the answer.
  - `c.error` is absent: demand `result`. In a `try` that covers only `materializeResult`, call it
    once. Capture that exact stored body, settle with `classifyOutcome` over the result status and
    `internal: false`, then write the captured `StoredAnswer` into `replay` for render.
  - `materializeResult` throws: catch that local failure, call `materializeError`, set
    `content-type` to `application/json; charset=utf-8` when absent, serialize the envelope once for
    storage, settle with its status and internal flag, and rethrow the original failure. This catch
    does not wrap `await next()`. `app.onError` emits the same deterministic envelope.

  `indeterminate` remains retained. A second identical request replays its stored 500 and does not
  run the handler again. This is the existing `IdempotencyStore` rule; this epic does not change it.

  The `try/catch` of `src/http/server/idempotency.ts:132-165` is deleted, because Decision 2 makes it
  dead.

- **11. The `Idempotency-Key` duplicate rule reads a Fetch `Headers`.** Node joins two headers of one
  name into one comma-separated value, and no public API recovers the count.
  `readIdempotencyKey` therefore takes a `Headers` and refuses a value that contains a comma, with
  the message `Idempotency-Key was supplied more than once`. A duplicate produces the message it
  produces today. A single key that contains a comma is now refused. No test in the tree accepts
  such a key, so every parity test of EPIC 030 passes unmodified.

- **12. A Koa bridge keeps the listener and the harness unchanged, and `@hono/node-server` is the
  bridge.** `App` carries `app: Koa` and `hono: Hono<AppEnv>`.
  `src/http/server/koa-bridge.ts` exports `koaFromHono(hono: Hono<AppEnv>): Koa`, a Koa app with one
  middleware over `getRequestListener`. It holds four statements and no branch:

  ```ts
  export function koaFromHono(hono: Hono<AppEnv>): Koa {
    const listener = getRequestListener(hono.fetch, {
      overrideGlobalObjects: false,
      hostname: BRIDGE_HOSTNAME,
    });
    const app = new Koa();
    app.use(async (context) => {
      context.respond = false;
      await listener(context.req, context.res);
    });
    return app;
  }
  ```

  Nothing is hand-written, because `@hono/node-server` 2.1.1 already owns the request-and-response
  bridge that EPIC 034 ships. Four properties carry the parity contract, and each one is a property
  of the package rather than of this epic.

  1. **A path segment is never decoded.** The listener builds the request URL from the raw request
     target, so `%2F` and `%zz` reach `matchRoute` intact.
  2. **`content-length` is exact.** The listener reads a non-chunked response body to completion and
     sets `content-length` from the byte total when the `Response` carries none. A 204 and a 304 carry
     a `null` body, so each answers with no `content-length` and no `content-type`.
  3. **The raw request bytes survive.** `c.req.text()` returns the bytes the client sent, whitespace
     included, so the idempotency fingerprint of Decision 10 stays stable.
  4. **The request body is streamed, and no method passes one that must not.** The listener owns that
     rule, and it drains an unread body.

  Two options are mandatory. `overrideGlobalObjects: false` stops the package from replacing
  `global.Request` and `global.Response`, which is a process-wide effect that no hermetic suite may
  carry. `hostname` names the fallback URL authority the listener uses when the request carries no
  `Host` header, so such a request reaches Hono instead of receiving a bare 400. It does not
  synthesize a `Host` request header. Therefore `new URL(c.req.url).host` is `BRIDGE_HOSTNAME`, while
  `c.req.header("host")` remains `undefined`. `hostMiddleware` answers the existing
  `host-forbidden` envelope with `the request carried no Host header`. `BRIDGE_HOSTNAME` is
  `kanthord.invalid`.

  After this epic, `koa-bridge.ts` is the one file under `src/http/server/**` that imports a `koa`
  value. `start.ts` and `app.ts` import the `Koa` type only. Every other file under the tree imports
  `koa` no more. EPIC 034 replaces both callers with `serve` and `getRequestListener` directly, and
  the file then has no caller.

- **13. The 1 MiB request body limit moves into `bodyMiddleware`.** `@koa/bodyparser` caps a JSON
  body at 1 MiB through `co-body`, and the overflow answers 500 with the internal-error envelope. No
  test in the tree names that limit and no EPIC 030 parity row covers it. The cap cannot move to the
  listener: `@hono/node-server` caps no body and `node:http` exposes no body-size option, so EPIC 034
  has no site for it. `bodyMiddleware` is the one place the product reads a request body, so it
  carries the cap as an eighth rule. `BODY_LIMIT_BYTES = 1_048_576`, and the exact contract is:

  1. Read `content-length` from `c.req.raw.headers` and parse it with `Number`. When it parses to a
     finite integer above `BODY_LIMIT_BYTES`, refuse before reading one byte. A header that is
     absent, non-numeric, negative or duplicated is not a refusal on its own, because rule 2 still
     applies and a lying header therefore cannot bypass the cap.
  2. Read the body through `c.req.raw.body`, a `ReadableStream<Uint8Array>`, with `getReader()`.
     Accumulate the chunks and sum `chunk.byteLength`. Refuse at the first chunk whose running sum
     exceeds `BODY_LIMIT_BYTES`. Count bytes, never `String.length`, because one character is up to
     four bytes.
  3. On refusal, stop pulling and throw `new Error("request body exceeds the limit")`. Do **not**
     call `reader.cancel()`. `@hono/node-server` sets `autoCleanupIncoming` to `true` by default
     (`dist/index.mjs:995`) and drains the unread remainder on response close for every method except
     GET and HEAD (`:1011`, `:852`) — exactly the methods this middleware reads — so the socket does
     not stall. The thrown value is not an `HttpError`, so `materializeError` maps it to the generic
     500 internal-error envelope and `onInternalError` reports it once. That is the answer `co-body`
     produces today.
  4. Decode the concatenated bytes once, with `new TextDecoder().decode(...)`. That string is
     `rawBody`, and `JSON.parse` runs on it. The middleware reads the stream exactly once, so no
     later reader meets a consumed body.
  5. A body of exactly `BODY_LIMIT_BYTES` is accepted. The refusal is strictly above the cap.

- **14. `systemSchedule` stays in `src/http/server/app.ts`, and EPIC 035 moves it.**
  `setTimeout(...).unref()` is the one Node-only call in the chain. EPIC 035 splits the composition
  roots and moves it to `src/http/server/runtime/node/schedule.ts` in one step. A move inside this
  epic relocates the file twice. `createApp` keeps `dependencies.schedule ?? systemSchedule` as the
  default.

- **16. A mixed-case result header name changes its emitted position, and no product answer moves.**
  Koa emits a result header under the exact name the handler returns, so the write order of
  `dispatch.ts` is the wire order, and `X-B` precedes `X-a` today. The accumulator lower-cases every
  name, so `x-a` precedes `x-b` after this epic. The four headers of
  `src/http/server/blob/show-blob.ts` are the only result headers in the product, and each one
  capitalizes identically, so lower-casing preserves their relative order and no answer moves. The
  EPIC 031 gate row that asserts the emitted order uses `X-B`, `X-a` and `X_c`, so story 14 restates
  that row on lower-case names. `dispatch.test.ts` is the test of a module this epic rewrites, so the
  edit is in scope, and the four EPIC 030 parity files stay untouched.

- **15. `bindingOffenders` and `unimplementedFor` do not change.** They read the registry only. They
  stay in `src/http/server/app.ts` at their current shape.

- **17. Non-`Error` handler failures keep their Koa behavior.** Hono calls `app.onError` only for an
  `Error`. `envelope.ts` therefore exports `ThrownValueError`, which extends `Error` and carries the
  original `readonly value: unknown`, and `errorValue(error: Error): unknown`, which returns that
  value or the input error. Its constructor is `constructor(value: unknown)` and its message is
  `a non-Error value was thrown`.
  `dispatchMiddleware` catches only the handler invocation and throws the original `Error` or a new
  `ThrownValueError` for any other value. `app.onError` and `idempotencyMiddleware` call
  `errorValue` before `materializeError`. `onInternalError` receives the original value. A string
  and `undefined` therefore produce the generic 500 envelope and one callback with the exact thrown
  value, as they do before the port.

## Stories

Author with `/author`. The sequence below is the dependency order. Stories 1 and 2 are standalone
commits. Stories 3 through 16 are one coupled implementation batch and one commit. Run no gate and
create no commit between Stories 3 and 16. Story 16 runs the batch gate after every edit lands.

1. **The typed variables and the accessors.** Add `src/http/server/variables.ts`. Import
   `RouteMatch` from `src/http/contract/registry.ts` and `StoredAnswer` from
   `src/http/server/idempotency-response.ts`. Export the `Variables` type with `headers: Headers`,
   `match: RouteMatch`, `actor: ActorRow`, `allowedOrigin: string`, `rawBody: string`,
   `body: unknown`, `result: HandlerResult` and `replay: StoredAnswer`. Export
   `AppEnv = { Variables: Variables }`. Export `class VariableError extends Error`. Export
   `demand(c, name)` and `optional(c, name)`. `demand` throws `VariableError` with the message
   `the ${name} variable is absent`. Add `variables.test.ts`, which asserts the throw by variable
   name. Export no route type: `RouteMatch` keeps its single home in the contract.
2. **The header accumulator.** Add `src/http/server/headers.ts` with `headersMiddleware()`. It sets
   a new `Headers` into the `headers` variable, then calls `next`. Add `headers.test.ts`.
3. **`app.onError` owns the envelope.** Edit `src/http/server/envelope.ts`. Delete
   `envelopeMiddleware` and `EnvelopeDependencies`. Keep `materializeError` and `Materialized`
   unchanged. Add `errorResponse(materialized: Materialized, headers: Headers): Response`. It sets
   `application/json; charset=utf-8` only when `content-type` is absent, serializes the body with
   `JSON.stringify`, and returns a `Response` with the materialized status and accumulator. Add
   `ThrownValueError` and `errorValue` with Decision 17's exact contracts. Rewrite
   `envelope.test.ts` for `materializeError`, `errorResponse`, `ThrownValueError` and `errorValue`.
4. **The render middleware.** Add `src/http/server/render.ts` with `renderMiddleware()`. It
   implements the four rules of Decision 8. Export `materializeResult` with Decision 7's exact
   status, body, content-type and serialization rules. It reads the `HandlerResult` variants of
   EPIC 031, where a `bytes` variant carries a `Uint8Array`. Add `render.test.ts`, which covers the
   four rules, all three result variants, replayed JSON and bytes, handler content-type precedence,
   unserializable JSON, and a set `c.error` that render leaves alone.
5. **`origin.ts` on Hono.** Rewrite `originMiddleware` against `Context<AppEnv>`. Read the origin
   through `c.req.header("origin")`. Keep the `origin-forbidden` refusal and its message. Write
   `Access-Control-Allow-Origin` into the accumulator. Write `Access-Control-Expose-Headers` when
   `c.req.method !== "OPTIONS"`. Set the `allowedOrigin` variable. Append `vary: Origin` before
   `next`, per Decision 9. Delete `OriginState`.
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
   refusal and its message. Write the `match` variable. Delete `RoutedState`.
10. **`authorize.ts` on Hono.** Rewrite `authorizeMiddleware`. Read `match` and `actor` through
    `demand`. Keep the `actor-forbidden` refusal and its message.
11. **The gated body parse.** Add `src/http/server/body.ts` with `bodyMiddleware(handlers)`. It
    implements the seven rules of Decision 6, and the 1 MiB cap of Decision 13 as the eighth. Export
    `BODY_LIMIT_BYTES = 1_048_576`. Delete `bodyParserForHandled` from `src/http/server/app.ts`, and
    delete the `@koa/bodyparser` import there. Add `body.test.ts`, which covers each of the eight
    rules by exact status and exact message. The cap adds three cases: a `content-length` one
    byte above the cap is refused before the body is read; a chunked body with no `content-length`
    that crosses the cap is refused at the crossing; and a body of exactly `BODY_LIMIT_BYTES` is
    accepted and parses. The two refusals answer the 500 internal-error envelope and report once.
12. **The idempotency helpers on Fetch types.** Edit `src/http/server/idempotency-key.ts` so that
    `readIdempotencyKey` takes a `Headers` and applies Decision 11. Delete `RawHeaderSource`. Edit
    `src/http/server/idempotency-response.ts`: set `StoredAnswer.body` to
    `string | Uint8Array | null`, narrow `StoredAnswer.headers` to
    `readonly (readonly [string, string])[]`, take the `Headers` accumulator in `headerSnapshot` and
    `captureAnswer` instead of a Koa `Context`, and delete `applyAnswer`. Keep `VOLATILE_HEADERS` and
    the `compareBytewise` sort. Edit `answerBytes` in `src/http/server/idempotency-store.ts` to apply
    Decision 7's exact body-byte rules. Update `idempotency-key.test.ts`,
    `idempotency-response.test.ts` and `idempotency-store.test.ts` for these exact shapes.
13. **`idempotency.ts` on Hono.** Rewrite the middleware against `Context<AppEnv>`. Read the key from
    `c.req.raw.headers`. Build the fingerprint from `c.req.method`, `new URL(c.req.url).pathname`,
    the search string without the leading `?`, and `optional(c, "rawBody") ?? ""`. Read the durable
    `importId` from the `body` variable. Settle through the `c.error` branch of Decision 10. Apply
    Decision 10's local materialization `try/catch`. Write the `replay` variable for a replay, a
    joined answer and the captured original answer. Keep every refusal code and message. Add a
    keyed unserializable JSON case: both requests answer the same generic 500, the handler runs
    once, and one indeterminate record remains.
14. **`dispatch.ts` on Hono.** Rewrite `dispatchMiddleware` as the terminal handler. Keep both
    `not-implemented` refusals and their messages. Build the `HandlerContext` from `c.req`, the
    `body` variable and the `actor` variable. Keep `readHeaders` and its `compareBytewise` sort,
    sourced from `c.req.raw.headers`. Append every result header into the accumulator, sorted with
    `compareBytewise`, so case-different duplicate names join in that source order and
    `captureAnswer` sees the joined value. Write the `result` variable. Delete the Koa status
    and body writes. Apply Decision 17 around the handler invocation. Restate the emitted-order row
    of `dispatch.test.ts` on lower-case names, per Decision 16. Add table cases where a handler
    throws a string and `undefined`; each answers the generic 500 envelope, reports once, and
    reports the exact thrown value.
15. **The Koa bridge. Dispatch this story before story 6.** `src/http/server/host.test.ts` and
    `src/http/server/idempotency.test.ts` build their application directly and reach a real socket
    through `loopbackAgent`, which takes a `Koa`. From story 6 onward each builds a `Hono`
    application, so each wraps it with `loopbackAgent(koaFromHono(hono))`. That wrap is the shape
    EPIC 034 story 3 replaces, and it does not exist until this story lands. The story number stays
    15 because EPIC 034 and the Proof below name it; only the dispatch order moves.

    Add `src/http/server/koa-bridge.ts` with `koaFromHono` and `BRIDGE_HOSTNAME`, per Decision 12.
    Add `koa-bridge.test.ts`, which drives a one-route Hono app through
    `createServer(koaFromHono(hono).callback())` on an unref'd loopback socket. It holds
    **exactly 6 cases**, one per line below, and EPIC 034 story 4 deletes the file and asserts that
    the pass count falls by exactly that number.

    1. a `%2F` path and a `%zz` path each reach the route intact
    2. a `Uint8Array` answer carries the exact `content-length` and the exact bytes
    3. a 204 answer carries neither `content-length` nor `content-type`
    4. a POST body reaches `c.req.text()` with its whitespace intact
    5. `global.Request` and `global.Response` are the same references before and after
       `koaFromHono` runs, asserted by identity
    6. an HTTP/1.0 request that carries no `Host` header reaches the route; assert
       `new URL(c.req.url).host === BRIDGE_HOSTNAME` and `c.req.header("host") === undefined`

16. **`createApp` returns both apps.** Rewrite `src/http/server/app.ts`. `App` carries `app: Koa` and
    `hono: Hono<AppEnv>`. `createApp` keeps the `BindingError` check first, then mounts the eleven
    entries of the Goal table in that order through `app.use("*", ...)`, with `dispatchMiddleware`
    as the handler of `app.all("*", ...)`. Set `app.onError`: call `errorValue`, materialize that
    value, call `onInternalError` once with that value only when `internal` is true, then return
    `errorResponse`. Build `app` with `koaFromHono`. Keep
    `cancelWaits`, `HandlerContext`, `Handler`, `AppDependencies`, `TransportSettings`,
    `BindingError`, `unimplementedFor` and `bindingOffenders`. Delete
    `src/http/server/koa-body.ts`, which this change orphans, because `render.ts` builds the
    `Response` and the bridge writes the bytes. `start.ts`, `main.ts`, `test/helpers/app.ts` and
    `test/helpers/agent.ts` do not change. Update `app.test.ts` for the new chain.

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
  src/http/server/koa-bridge.test.ts \
  src/http/server/app.test.ts \
  src/http/server/app.handler-result.test.ts \
  src/http/server/app.parity-body.test.ts \
  src/http/server/app.parity-cors.test.ts \
  src/http/server/app.parity-path.test.ts \
  && echo "PASS EPIC-032"
```

The last four files are the parity tests EPIC 030 adds. They run here unmodified.

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **Every EPIC 030 parity test passes unmodified.** No line of `app.handler-result.test.ts`,
  `app.parity-body.test.ts`, `app.parity-cors.test.ts` or `app.parity-path.test.ts` changes in this
  epic. A diff of any of the four is a blocker.
- **Invalid JSON on a `stubbed` operation answers 501, not 400.** The body gate skips the parse, and
  `dispatchMiddleware` raises `not-implemented`. The same request against a routed operation with a
  handler answers 400 with the message `the request body is not valid json`.
- **Each of the seven body rules is asserted.** A `GET` leaves `body` absent. A `text/plain` POST and
  a POST with no `content-type` reach the handler with `{}` and leave `rawBody` absent. An empty
  JSON body reaches the handler with `{}` and sets `rawBody` to the empty string. The scalar bodies
  `1` and `"a"` each answer 400 with the invalid-json message. `application/json; charset=utf-8`
  parses.
- **CORS headers appear on an authentication failure, a routing failure and an internal error.**
  Each of the three carries `Access-Control-Allow-Origin` and `Vary: Origin`, asserted by exact
  value. This is the mechanism test for Decision 3: a header written after `next()` returns would
  fail it.
- **An `origin-forbidden` refusal carries neither `Access-Control-Allow-Origin` nor `Vary`**, matching
  row P11 of EPIC 030.
- **A preflight request bypasses authentication and route matching.** An OPTIONS request with an
  allowed Origin, no `Authorization` header and an unknown path answers 204. The test asserts that
  `resolveActor` is not called. The unknown path is the route oracle: if `routeMiddleware` runs, it
  throws `not-found`, so the exact 204 response proves that route matching did not run.
- **`onInternalError` fires exactly once for one internal error.** A handler that throws a plain
  `Error` produces one call, asserted by a counter. The same holds when the request carries an
  `Idempotency-Key`.
- **Non-`Error` handler failures keep the same envelope and report value.** Table cases throw a
  string and `undefined`. Each answers the generic 500 envelope, calls `onInternalError` once, and
  passes the exact thrown value to that callback.
- **`idempotency.ts` stores a failed answer.** A handler that throws an `HttpError` with a
  replayable status under an `Idempotency-Key` settles the reservation, and the second request with
  the same key replays the stored status and the stored body. A handler that throws a plain `Error`
  settles as indeterminate, and the second request replays the stored 500. The test asserts one
  handler call and one retained record. This is the mechanism test for Decision 10: a `try/catch`
  around `next()` would fail it.
- **Stored bodies are exact response bodies.** A JSON result stores its `JSON.stringify` string, a
  bytes result stores an equal `Uint8Array`, and an empty result stores `null`. Replay tests assert
  the exact body bytes and exact content type for all three. `answerBytes` is asserted for a UTF-8
  string, a byte array, and `null`. A stateful `toJSON` case asserts one serialization and exact
  first-response versus replay bytes. A keyed serialization failure settles as indeterminate;
  its second request replays the same generic 500 and does not run the handler again.
- **`render.ts` leaves an error answer alone.** A request that fails downstream answers with the
  error envelope, not with a 404 and not with a rendered result.
- **An accessor throws when a variable is absent.** `demand` is called directly with an empty
  context for `headers`, `match` and `actor`. Each throws `VariableError` and names the variable.
- **The bytewise order of the response headers is asserted, and every name is a valid header
  name.** A Fetch `Headers` refuses a non-ASCII name, so the emitted-order test uses valid token
  names, and it asserts the accumulator order equals the `compareBytewise` order of the lower-cased
  names. The discriminating names are already lower-case and differ in the separator byte, for
  example `x-a`, `x-b` and `x_c`, because `-` is `0x2D` and `_` is `0x5F`. The EPIC 031 example
  `X-B`, `X-a`, `X_c` does not discriminate here, and Decision 16 records why. `bytewise.test.ts` of
  EPIC 031 keeps the non-ASCII ordering proof, which needs no header. The test asserts values and
  duplicate-header semantics, not raw wire order.
- **A duplicate `Idempotency-Key` is refused with the current message**, and a single key that
  contains a space is still accepted.
- **The idempotency fingerprint uses the raw request bytes.** Two bodies that parse to the same
  value but differ in whitespace produce two fingerprints.
- **The bridge does not decode a path segment.** A request whose path parameter holds `%2F` and a
  request whose path parameter holds `%zz` each reach `matchRoute` intact, driven through
  `app.callback()`.
- **The bridge sets an exact `content-length`.** A blob read through the bridge answers the stored
  bytes with a `content-length` computed from the fixture length, and a 204 carries no
  `content-length`.
- **The bridge patches no global.** `global.Request` and `global.Response` are the same references
  before and after `koaFromHono` runs, asserted by identity. This is the mechanism test for
  `overrideGlobalObjects: false`, and case 5 of `src/http/server/koa-bridge.test.ts` owns it.
- **A request with no `Host` header answers the `host-forbidden` envelope.** The two halves have two
  owners. Case 6 of `src/http/server/koa-bridge.test.ts` proves the URL authority is
  `BRIDGE_HOSTNAME` and the request header remains absent. `src/http/server/app.test.ts` proves the
  request then reaches `hostMiddleware` and answers the envelope whose message is
  `the request carried no Host header`, not a bare 400.
- **Hermetic**: no network, no shared temporary directory, no wall clock. A test that needs time
  passes a `now` function and a fake `Schedule`.

## Open items

- S1 - status:FIXED - action:YES - add hono to package.json - fix:`"hono": "4.13.3"` sits in
  `dependencies` as of 2026-08-23 - why:`scripts/lane-check.sh:44` denies `package.json` to every
  agent lane.
- S2 - status:FIXED - action:YES - run `npm install` - `node_modules/hono` was absent while
  `package.json` and `package-lock.json` both named 4.13.3. Verified installed on 2026-08-23:
  `npm ls` reports `hono@4.13.3` and `@hono/node-server@2.1.1`, both resolved in
  `package-lock.json:2671` and `:4883`, and the manifest matches HEAD with no pending change. -
  fix:none remaining. - why:story 1 fails on an unresolved import, and no agent lane may touch the
  manifest.
- S3 - status:OPEN - action:YES - keep the koa types until EPIC 035 - `@types/koa` serves
  `start.ts` and `koa-bridge.ts` - fix:no change now; remove `@types/koa`, `@types/koa__cors`,
  `koa`, `@koa/cors` and `@koa/bodyparser` in EPIC 035 - why:removing them here breaks the listener
  and the bridge that this epic keeps.
- S4 - status:OPEN - action:YES - expand EPIC 030 and EPIC 031 before this epic runs -
  `.agents/plan/stories/030-transport-inventory-and-parity-contract/` and
  `.agents/plan/stories/031-fetch-native-response-model/` do not exist - fix:run `/author` on EPIC
  030 and EPIC 031, and land both, before `/work` opens EPIC 032 - why:this epic consumes the EPIC
  031 `HandlerResult` variants, `compareBytewise` and the four EPIC 030 parity files by name.
- S5 - status:OPEN - action:YES - drop the EPIC 031 `node:buffer` exception - story 16 deletes
  `src/http/server/koa-body.ts`, and the EPIC 031 S1 eslint block names that file in its `ignores`
  array. - fix:remove `"src/http/server/koa-body.ts"` from the `ignores` array of the
  `src/http/server/**/*.ts` block in `eslint.config.js`, after story 16 lands. Keep the `node:buffer`
  group. - why:`scripts/lane-check.sh:47-49` denies every `*.config.*` path to every agent lane, and
  an exception that outlives its file bans nothing.
- S6 - status:FIXED - action:YES - no epic deleted `koa-bridge.ts` - EPIC 034 story 1 and story 3
  replace both callers with `serve` and `getRequestListener`, and neither EPIC 034 nor EPIC 035 named
  the file for deletion - fix:EPIC 034 story 4 now deletes the file and its test, drops `app: Koa`
  from `App`, and updates the three call sites - why:the file exists for the Koa listener alone, and
  EPIC 035 story 4 asserts that no file under `src/` names koa.
- **The `Idempotency-Key` narrowing is deliberate.** A single key that contains a comma is refused
  after this epic. Decision 11 records it and a test pins it. EPIC 030 records it in the parity
  contract.
- **The prototype-poisoning refusal does not survive the port, and the 1 MiB body limit does.**
  `co-body` caps a JSON body at 1 MiB, and `@hapi/bourne` refuses a `__proto__` key with a 400.
  `JSON.parse` creates an own `__proto__` property and pollutes no prototype, so that loss carries no
  risk. Decision 13 keeps the body limit, in `bodyMiddleware` and not in the listener, because the
  listener has no site for it. EPIC 034 records the same handoff under its own Open items.
- **A request target with a dot segment is resolved, and a percent escape is not.**
  `@hono/node-server` passes a target that holds `%`, `..` or `.` through `new URL`, which resolves
  the dot segment and leaves every percent escape alone. Koa's `context.path` resolves neither. No
  route matches a dot segment either way, so both answer 404. Rows P16 and P17 of EPIC 030 cover the
  percent escapes that matter, and the probe of story 15 pins them.
- **This epic deletes `koa-body.ts`, and that supersedes one EPIC 031 note.** EPIC 031 states that
  EPIC 034 replaces the file and EPIC 035 deletes it. Story 16 orphans it two epics earlier, because
  `render.ts` builds the `Response` and the bridge writes the bytes. The EPIC 031 S2 note about the
  `node:buffer` eslint exception therefore applies at EPIC 032, not at EPIC 035.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
