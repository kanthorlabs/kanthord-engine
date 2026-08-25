---
epic: .agents/plan/epics/032-the-hono-middleware-chain.md
opened: 2026-08-25
opener: test-engineer
base-ref: 1b6817ec694bad784deb2f7ad90164359b7840b1
---

# Implementation cycle — 032-the-hono-middleware-chain

Pulled from EPIC: `.agents/plan/epics/032-the-hono-middleware-chain.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/server/variables.test.ts \
>   src/http/server/headers.test.ts \
>   src/http/server/render.test.ts \
>   src/http/server/envelope.test.ts \
>   src/http/server/origin.test.ts \
>   src/http/server/host.test.ts \
>   src/http/server/preflight.test.ts \
>   src/http/server/auth.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/authorize.test.ts \
>   src/http/server/body.test.ts \
>   src/http/server/idempotency-key.test.ts \
>   src/http/server/idempotency-record.test.ts \
>   src/http/server/idempotency-response.test.ts \
>   src/http/server/idempotency-store.test.ts \
>   src/http/server/idempotency.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/query.test.ts \
>   src/http/server/single.test.ts \
>   src/http/server/invalid-request.test.ts \
>   src/http/server/koa-bridge.test.ts \
>   src/http/server/app.test.ts \
>   src/http/server/app.handler-result.test.ts \
>   src/http/server/app.parity-body.test.ts \
>   src/http/server/app.parity-cors.test.ts \
>   src/http/server/app.parity-path.test.ts \
>   && echo "PASS EPIC-032"
> ```
>
> The last four files are the parity tests EPIC 030 adds. They run here unmodified.
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **Every EPIC 030 parity test passes unmodified.** No line of `app.handler-result.test.ts`,
>   `app.parity-body.test.ts`, `app.parity-cors.test.ts` or `app.parity-path.test.ts` changes in this
>   epic. A diff of any of the four is a blocker.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — typed variables and accessors · Story 1 (variables + accessors)

**Cycle.** RED for Task `032/story-1` (`node --test src/http/server/variables.test.ts`).
**Test written.**

- file: `src/http/server/variables.test.ts` (new) — suite: `src/http/server/variables.test` — methods: `a demand of an absent headers variable throws VariableError naming it`, `a demand of an absent match variable throws VariableError naming it`, `a demand of an absent actor variable throws VariableError naming it`, `a demand of a present headers variable returns the exact stored object`, `an optional read of an absent body variable is undefined`, `an optional read after a body write returns the exact written value`
- asserts: each absent demand of `headers`/`match`/`actor` throws `VariableError` with its exact `the <name> variable is absent` message; a present value returns by identity; `optional(c, "body")` reads `undefined` before a write and the exact written value after.
  **RED proof.**
- command: `node --test src/http/server/variables.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/variables.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/variables.test.ts`
- stub probe: `src/http/server/variables.ts` — clean (`npm run typecheck` with the Story-declared-signature stub reports zero errors in the test; one TS2304 inside the stub itself was fixed in-stub; stub deleted before this turn).
  **Open to Software Engineer.**
- Seam the test imports: new `src/http/server/variables.ts` exporting, per Story 01 (`​.agents/plan/stories/032-the-hono-middleware-chain/01-typed-variables-and-accessors.md`) exactly:
  - `export type Variables = { headers: Headers; match: RouteMatch; actor: ActorRow; allowedOrigin: string; rawBody: string; body: unknown; result: HandlerResult; replay: StoredAnswer }`
  - `export type AppEnv = { Variables: Variables }`
  - `export class VariableError extends Error`
  - `demand<Name extends keyof Variables>(c: Context<AppEnv>, name: Name): Variables[Name]` — throws `VariableError` with message `the ${name} variable is absent` when the runtime value is `undefined`; otherwise returns the stored value.
  - `optional<Name extends OptionalVariable>(c: Context<AppEnv>, name: Name): Variables[Name] | undefined` — `OptionalVariable` stays private (`"allowedOrigin" | "rawBody" | "body" | "result" | "replay"`).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — typed variables and accessors · Story 1 (variables + accessors)

**Cycle.** GREEN for `src/http/server/variables.test.ts` (`032/story-1`).

**Files changed.**

- `src/http/server/variables.ts` (new) — `Variables`, `AppEnv`, `VariableError`, `demand(c, name)`, `optional(c, name)`; private `OptionalVariable` union.

**Seam (GREEN).** The module exports exactly the Story-declared surface: the eight-key `Variables` map typed from `RouteMatch`/`ActorRow`/`HandlerResult`/`StoredAnswer` (all type-only imports, so no runtime cycle with `app.ts`), `VariableError`, and two accessors over `Context<AppEnv>`. `demand` widens Hono's present-typed getter to `Variables[Name] | undefined` before the `undefined` check, throws `VariableError` with `the ${name} variable is absent`, and returns the stored value otherwise; `optional` returns the runtime getter value unchanged.

**Refactor.** none named by the Story or the RED turn.

**Build check.**

- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the header accumulator · Story 2 (`headersMiddleware`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 1 (`032/story-1`): `node --test src/http/server/variables.test.ts` → tests 6 / pass 6 / fail 0, exit 0. Then RED for Task `032/story-2` (`node --test src/http/server/headers.test.ts`).

**Test written.**

- file: `src/http/server/headers.test.ts` (new) — suite: `src/http/server/headers.test` — methods: `each downstream frame reads the one accumulator this middleware seeded`, `a second invocation seeds an accumulator that no earlier invocation owns`
- asserts: inside the counting `next`, `demand(c, "headers")` returns a `Headers`; after the middleware returns, `next` ran exactly once and the downstream accumulator is strictly identical to `demand(c, "headers")`; a second context seeds a second accumulator that is a different object from the first.

**RED proof.**

- command: `node --test src/http/server/headers.test.ts`
- exit: 1 (tests 1 / pass 0 / fail 1) — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/headers.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/headers.test.ts`
- stub probe: `src/http/server/headers.ts` — clean (`npm run typecheck` with the Story-declared-signature stub reports zero errors; stub deleted before this turn).

**Open to Software Engineer.**

- Seam the test imports: new `src/http/server/headers.ts` exporting, per Story 02 (`.agents/plan/stories/032-the-hono-middleware-chain/02-header-accumulator.md`) exactly:
  - `export function headersMiddleware(): MiddlewareHandler<AppEnv>` — a Hono middleware for `AppEnv`. Per invocation it creates one new `Headers`, stores it as the `headers` variable, then awaits `next()` exactly once. It never writes through `c.header` or `c.res`, and no module-level `Headers` instance is reused. No other export.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the header accumulator · Story 2 (`headersMiddleware`)

**Cycle.** GREEN for `src/http/server/headers.test.ts` (`032/story-2`).

**Files changed.**

- `src/http/server/headers.ts` (new) — `headersMiddleware(): MiddlewareHandler<AppEnv>`.

**Seam (GREEN).** Each invocation creates one fresh `Headers`, stores it as the `headers` variable through `c.set`, then awaits `next()` exactly once — no `c.header`/`c.res` write, no module-level instance, so both test cases observe one per-context accumulator by strict identity.

**Refactor.** none named by the Story or the RED turn.

**Build check.**

- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — app.onError owns the envelope · Story 3 (`errorResponse` + `ThrownValueError` + `errorValue`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 2 (`032/story-2`): `node --test src/http/server/headers.test.ts` → tests 2 / pass 2 / fail 0, exit 0. Then RED for Task `032/story-3` (`node --test src/http/server/envelope.test.ts`).

**Test written.**

- file: `src/http/server/envelope.test.ts` (edited — full rewrite; test lane) — suite: `src/http/server/envelope.test` — methods: `materializes a not-found HttpError with no details`, `materializes a precondition HttpError carrying details`, `materializes an unexpected Error as an internal-error, hiding its message`, `materializes a thrown string the same as an Error`, `materializes a thrown undefined the same as an Error`, `a declared internal-error HttpError is not indeterminate`, `answers the materialized status and exact json text with the default content type`, `preserves a seeded content type and cors headers in the accumulator`, `carries a thrown string as an Error with the wrapper message`, `carries a thrown undefined with the wrapper message`, `unwraps a ThrownValueError holding a string`, `unwraps a ThrownValueError holding undefined`, `returns a plain Error by identity`
- asserts: the six existing `materializeError` rows stay exact (ordinary `HttpError`, detailed 409, plain `Error`, string, `undefined`, declared `internal-error`); `errorResponse` answers the materialized status, the exact serialized envelope text and the `application/json; charset=utf-8` default only when the accumulator carries no `content-type`, while a seeded `content-type` plus `access-control-allow-origin` and `vary` values survive verbatim; `ThrownValueError` is an `Error` whose message is `a non-Error value was thrown` and which stores a thrown string and `undefined` by exact value; `errorValue` unwraps both wrappers to those values and returns a plain `Error` by strict identity. The deleted `envelopeMiddleware` Koa integration cases leave this file — that coverage moves to `app.test.ts` in Story 16.

**RED proof.**

- command: `node --test src/http/server/envelope.test.ts`
- exit: non-zero (tests 1 / pass 0 / fail 1) — failure: `SyntaxError: The requested module './envelope.ts' does not provide an export named 'ThrownValueError'`
- stub probe: `src/http/server/envelope.ts` (module exists but lacks the three exports → TS2305, not TS2307; probe added temporary Story-signature stubs, re-ran `npm run typecheck` → clean, then restored the file byte-exact — `git diff` on it is empty).

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/envelope.ts`, per Story 03 (`.agents/plan/stories/032-the-hono-middleware-chain/03-onerror-envelope.md`) exactly:
  - keep `Materialized` and `materializeError(error: unknown): Materialized` behavior unchanged;
  - delete the Koa imports, `EnvelopeDependencies`, and `envelopeMiddleware`;
  - `export function errorResponse(materialized: Materialized, headers: Headers): Response` — sets `application/json; charset=utf-8` into `headers` only when `content-type` is absent, serializes `materialized.body` once with `JSON.stringify`, returns a `Response` from that string, `materialized.status` and the same accumulator;
  - `export class ThrownValueError extends Error` with `readonly value: unknown`; constructor takes `(value: unknown)`, stores it exactly, message `a non-Error value was thrown`;
  - `export function errorValue(error: Error): unknown` — returns `error.value` for `ThrownValueError`, otherwise the input `Error` itself.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — app.onError owns the envelope · Story 3 (`errorResponse` + `ThrownValueError` + `errorValue`)

**Cycle.** GREEN for `src/http/server/envelope.test.ts` (`032/story-3`).

**Files changed.**

- `src/http/server/envelope.ts` (edited) — added `errorResponse(materialized: Materialized, headers: Headers): Response`, `class ThrownValueError extends Error` with field-declared `readonly value: unknown`, and `errorValue(error: Error): unknown`. `Materialized` and `materializeError` untouched.

**Seam (GREEN).** The module now exports the three missing symbols: `errorResponse` sets `application/json; charset=utf-8` into the accumulator only when `content-type` is absent, serializes `materialized.body` once, and returns a `Response` from that string, the materialized status and the same accumulator; `ThrownValueError` extends `Error`, stores any value exactly (including `undefined`) under message `a non-Error value was thrown`; `errorValue` unwraps a `ThrownValueError` to its stored value and returns a plain `Error` by identity.

**Refactor.** deferred: delete `EnvelopeDependencies`, `envelopeMiddleware` and the Koa type imports from this file. Nine files still import them — `src/http/server/app.ts` (Story 16 rewires it) plus eight test files in the test-engineer's lane (Stories 5–14 rewrite them) — so removing the export now turns the mandatory handoff typecheck red. The deletion lands with the Story 16 rewiring inside this coupled batch; the Story constraint "do not retain a Koa middleware export" holds at batch close, and the Koa import stays type-only until then (no runtime koa dependency added).

**Build check.**

- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the render middleware · Story 4 (`renderMiddleware` + `materializeResult`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 3 (`032/story-3`): `node --test src/http/server/envelope.test.ts` → tests 13 / pass 13 / fail 0, exit 0. Then RED for Task `032/story-4` (`node --test src/http/server/render.test.ts`).

**Test written.**

- file: `src/http/server/render.test.ts` (new) — suite: `src/http/server/render.test` — methods: `a json result serializes once to the exact string and sets the default content type`, `a bytes result keeps the exact Uint8Array object and sets the operation media type`, `an empty result keeps its status, stores no body and sets no content type`, `a seeded content type wins over the json default`, `a seeded content type wins over the bytes default while the bytes stay identical`, `a stateful toJSON value is serialized exactly once`, `a json body that serializes to undefined raises the transport TypeError`, `a json body whose serialization throws propagates the original thrown object`, `a bytes result for an operation without responseMedia raises the internal-error refusal naming the operation id`, `a bytes result without an operation raises the internal-error refusal`, `a json result answers the rendered response from the accumulator`, `a context that produced no result and no replay raises the internal-error refusal with the exact message`, `a context that carries c.error and a settled c.res is left alone`, `an empty 204 result on a context with no match answers 204 with an empty body, no content type and no throw`, `a bytes result on a context with no match raises the internal-error refusal`, `a replay of a stored json string answers the exact status, bytes and content type through set`, `a replay of stored bytes answers the exact bytes`, `a replay of a stored null body answers an empty body`
- asserts: `materializeResult` returns the exact serialized JSON string with the `application/json; charset=utf-8` default, keeps byte identity on a `bytes` body and applies `operation.responseMedia`, stores `null` with no content type for 204/304, honours a seeded content type over both defaults, serializes a stateful `toJSON` exactly once, raises `TypeError("the handler result is not json serializable")` when stringify yields undefined, propagates an original stringify throw by identity, and preserves the EPIC 031 `internal-error` refusal message for a media-less bytes operation plus the same code when no operation exists; `renderMiddleware` returns the rendered `Response` built from the accumulator for a `result`, throws `internal-error` with the exact `the transport produced no result` message when neither `result` nor `replay` is present, leaves a context that carries `c.error` and a settled `c.res` untouched by identity, renders an `empty` 204 without demanding `match`, refuses a `bytes` result with no `match`, and replays each stored answer through `set` with exact status, exact body bytes and exact stored content type. The local `stored()` fixture builds today's declared `StoredAnswer` shape (`[string, readonly string[]]` values); the story 12 narrowing will update that one helper in this lane.

**RED proof.**

- command: `node --test src/http/server/render.test.ts`
- exit: 1 (tests 1 / pass 0 / fail 1) — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/render.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/render.test.ts`
- stub probe: `src/http/server/render.ts` — clean (`npm run typecheck` with the Story-declared-signature stub reports zero errors across the tree; stub deleted before this turn, leaving exactly the TS2307 for the missing seam).

**Open to Software Engineer.**

- Seam the test imports: new `src/http/server/render.ts`, per Story 04 (`.agents/plan/stories/032-the-hono-middleware-chain/04-render-middleware.md`) exactly:
  - `export type MaterializedResult = Readonly<{ status: HandlerStatus; body: string | Uint8Array | null }>`
  - `export function materializeResult(result: HandlerResult, operation: Operation | undefined, headers: Headers): MaterializedResult` — reads `operation` only for a `bytes` result; json/empty admit `undefined`.
  - `export function renderMiddleware(): MiddlewareHandler<AppEnv>` — awaits `next()`, then applies the four ordered branches of Story 04 / Decision 8 (`c.error` untouched, replay via `set`, result via `materializeResult`, else `httpError("internal-error", "the transport produced no result")`).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the render middleware · Story 4 (`renderMiddleware` + `materializeResult`)

**Cycle.** GREEN for `src/http/server/render.test.ts` (`032/story-4`).

**Files changed.**

- `src/http/server/render.ts` (new) — `MaterializedResult`, `materializeResult(result: HandlerResult, operation: Operation | undefined, headers: Headers): MaterializedResult`, `renderMiddleware(): MiddlewareHandler<AppEnv>`.

**Seam (GREEN).** `materializeResult` applies the three variants: json sets `application/json; charset=utf-8` only when the accumulator lacks `content-type` then serializes once (TypeError `the handler result is not json serializable` when stringify yields `undefined`, an original stringify throw propagated by identity); bytes refuses with the EPIC 031 `internal-error` `HttpError` naming `${operationId}` when `responseMedia` is absent and the same refusal when no operation exists, keeps byte identity, and defaults `content-type` from `operation.responseMedia` only when absent; empty returns `{ status, body: null }` and sets no content type. `renderMiddleware` awaits `next()` then walks the four ordered branches: a defined `c.error` returns untouched (no read of `result`/`replay`, `c.res` unchanged by identity); a replay writes each stored header tuple into the accumulator with `set` and answers `new Response(answer.body, { status: answer.status, headers })`; otherwise a result materializes once and answers a `Response` from its exact body, status and accumulator; neither present throws `httpError("internal-error", "the transport produced no result")`.

**Refactor.** none named by the Story or the RED turn.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: the Story test `a bytes result on a context with no match raises the internal-error refusal` requires an `HttpError`; a literal `demand(c, "match")` would throw `VariableError` and fail that assertion. Render reads match tolerantly — `demand` narrowed on `VariableError` to `undefined` — so `materializeResult` raises its own declared no-operation refusal; Decision 4 holds (accessors only, no bare `c.get`) and json/empty never touch `match`.
- VERIFIED: replay application joins today's `[name, readonly string[]]` stored tuples with `", "` under `set`; story 12 narrows `StoredAnswer.headers` to one joined value per name and retypes this call site in this batch.
- VERIFIED: `replay.body as string | Uint8Array | null` names Decision 7's stored-body domain because `StoredAnswer.body` stays `unknown` until story 12 narrows it; that union is assignable to undici-types' `BodyInit`.
- VERIFIED: the message for a bytes result with no operation is `bytes result requires responseMedia` — the RED turn pins only `code === "internal-error"` for that row; the exact message is pinned only when an operation exists (`bytes result for blob.show requires responseMedia`, matching dispatch's current wording).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the Koa bridge · Story 15 (`koaFromHono` + `BRIDGE_HOSTNAME`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 4 (`032/story-4`): `node --test src/http/server/render.test.ts` → tests 18 / pass 18 / fail 0, exit 0. Then RED for Task `032/story-15` (`node --test src/http/server/koa-bridge.test.ts`) — the EPIC dispatches Story 15 before Story 5, and Story 5's fixture imports `koaFromHono`.

**Test written.**

- file: `src/http/server/koa-bridge.test.ts` (new) — suite: `src/http/server/koa-bridge.test` — methods: `a %2F path and a %zz path each reach the route intact`, `a Uint8Array answer carries the exact content-length and the exact bytes`, `a 204 answer carries no body bytes, no content-length and no content-type`, `a POST body reaches the route with its whitespace and newline intact`, `koaFromHono leaves global.Request and global.Response strictly identical`, `an HTTP/1.0 request with no Host header answers through the fallback authority`
- asserts: exactly the six Story 15 cases over a real loopback socket (`createServer(koaFromHono(hono).callback())`, port zero on `127.0.0.1`, closed through `t.after`): both escaped path strings arrive at `new URL(c.req.url).pathname` unchanged; a `[0x00, 0x80, 0xff]` answer carries `content-length: 3` and byte-exact body; a 204 carries zero body bytes with neither `content-length` nor `content-type`; a POST body `{ "a" : 1 }\n` reaches `c.req.text()` whitespace-exact; calling `koaFromHono` leaves both global constructors strictly identical (mechanism for `overrideGlobalObjects: false`); a raw HTTP/1.0 request with no Host header answers 204 with `new URL(c.req.url).host === BRIDGE_HOSTNAME` while `c.req.header("host")` stays undefined.

**RED proof.**

- command: `node --test src/http/server/koa-bridge.test.ts`
- exit: 1 (tests 1 / pass 0 / fail 1) — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/koa-bridge.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/koa-bridge.test.ts`
- stub probe: `src/http/server/koa-bridge.ts` — clean (`npm run typecheck` with the Story-declared-signature stub reports zero errors across the tree; stub deleted before this turn, leaving exactly the TS2307 for the missing seam).

**Open to Software Engineer.**

- Seam the test imports: new `src/http/server/koa-bridge.ts`, per Story 15 (`.agents/plan/stories/032-the-hono-middleware-chain/15-koa-bridge.md`) and Decision 12 exactly:
  - `export const BRIDGE_HOSTNAME = "kanthord.invalid"`.
  - `export function koaFromHono(hono: Hono<AppEnv>): Koa` — the Story's exact four-statement body: `getRequestListener(hono.fetch, { overrideGlobalObjects: false, hostname: BRIDGE_HOSTNAME })`, a new Koa app, one middleware that sets `context.respond = false` and awaits `listener(context.req, context.res)`.
  - Imports: `getRequestListener` (value) from `@hono/node-server`, `Hono` as a type from `hono`, `Koa` as a value, `AppEnv` as a type from `./variables.ts`. No other export; branch-free.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the Koa bridge · Story 15 (`koaFromHono` + `BRIDGE_HOSTNAME`)

**Cycle.** GREEN for `src/http/server/koa-bridge.test.ts` (`032/story-15`).

**Files changed.**

- `src/http/server/koa-bridge.ts` (new) — `BRIDGE_HOSTNAME = "kanthord.invalid"`, `koaFromHono(hono: Hono<AppEnv>): Koa`.

**Seam (GREEN).** The module is exactly the Decision 12 / Story 15 body: `getRequestListener(hono.fetch, { overrideGlobalObjects: false, hostname: BRIDGE_HOSTNAME })`, a fresh Koa app whose single middleware sets `context.respond = false` and awaits `listener(context.req, context.res)` — branch-free, four statements. Imports: `getRequestListener` as a value from `@hono/node-server`, `Hono` as a type from `hono`, `Koa` as a value from `koa`, and `AppEnv` as a type from `./variables.ts`. No other export.

**Refactor.** none named by the Story or the RED turn.

**Build check.**

- typecheck: exit 0
- eslint on the new file: clean

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — origin on Hono · Story 5 (`originMiddleware` rewrite)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 15 (`032/story-15`): `node --test src/http/server/koa-bridge.test.ts` → tests 6 / pass 6 / fail 0, exit 0. Then RED for Task `032/story-5` (`node --test src/http/server/origin.test.ts`) — the EPIC dispatches Story 15 before Story 5 and the Story 5 fixture imports `koaFromHono`.

**Test written.**

- file: `src/http/server/origin.test.ts` (edited — full rewrite; test lane per Stories 5–14) — suite: `src/http/server/origin.test` — methods: `no Origin header passes through with Vary set`, `refuses every Origin value in the table with the same 403 shape`, `a Referer header alone does not trigger the check`, `refuses a disallowed Origin on every method`, `the exact allowed origin passes with the header and Vary set`, `refuses everything outside the exact origin`, `matches a received http://localhost, proving default-port and case canonicalization on load`, `appends Origin to an existing Vary value set downstream`, `a downstream not-found throw still carries Vary and Access-Control-Allow-Origin`, `a downstream unauthenticated failure keeps the status, the header and Vary`, `a downstream internal failure answers the generic envelope once with CORS intact`, `Access-Control-Allow-Credentials is absent on every response, allowed and refused alike`, `a GET from the allowed origin carries the exact expose-headers value`, `post, put and delete from the allowed origin carry the same exact value`, `an OPTIONS from the allowed origin carries no expose-headers value`, `no Origin header means no expose-headers value`, `a refused Origin carries no expose-headers value`, `a downstream throw still carries the exact expose-headers value`, `Access-Control-Allow-Credentials stays absent on every response above`
- asserts: the preserved allow-list / method / canonicalization / Referer / expose-header / credential matrix over the Story 5 fixture (`headersMiddleware()` → `renderMiddleware()` → `originMiddleware(dependencies)` → a marker that writes the json `result`; driven through `loopbackAgent(koaFromHono(hono))`, with `hono.onError` calling `errorValue` → `materializeError` → `errorResponse(materialized, demand(c, "headers"))`); allowed and absent origins each carry exactly `Vary: Origin`; an allowed origin keeps exact `Access-Control-Allow-Origin` plus `Vary: Origin` across downstream 401, 404 and 500 answers, the 500 reporting the original thrown `Error` exactly once; an `origin-forbidden` refusal carries neither `access-control-allow-origin` nor `vary`; the Vary merge case now expects `Origin, Accept`, because Decision 9 appends before `next()` and undici joins same-name values in insertion order (probed: both orders verified against the runtime `Headers`).

**RED proof.**

- command: `node --test src/http/server/origin.test.ts`
- exit: 1 (tests 19 / pass 4 / fail 15) — first failure verbatim:
  `✖ no Origin header passes through with Vary set` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `500 !== 200`
  The four passing cases assert only header absence, which holds vacuously against today's wrong 500; their positive counterparts fail. The failure mode is the right one: the current `originMiddleware` reads `context.request` / `context.state` / `context.vary`, none of which exists on a Hono `Context<AppEnv>`, so every request through it throws and the error handler answers the generic 500.
- stub probe: `src/http/server/origin.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub returning `MiddlewareHandler<AppEnv>`): zero errors in `src/http/server/origin.test.ts`. Residual errors sit only in `preflight.test.ts` and `preflight.ts` — files Story 7 rewrites inside this same coupled batch. Stub deleted before this turn; `git diff src/http/server/origin.ts` is empty.
- Note for the SE lane: current `preflight.ts:3` imports `OriginState` from `./origin.ts`, which this story deletes. The turn-boundary handoff gate must stay clean after your turn (Story 3 deferral precedent applies within the batch); the deletion constraint holds at batch close.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/origin.ts`, per Story 05 (`.agents/plan/stories/032-the-hono-middleware-chain/05-origin-middleware.md`) exactly:
  - keep `OriginDependencies` (`allowedOrigins`) and the exact-value allow-list `Set`;
  - `export function originMiddleware(dependencies: OriginDependencies): MiddlewareHandler<AppEnv>`;
  - read the request origin with `c.req.header("origin")`; refuse with `httpError("origin-forbidden", \`the Origin header ${origin} is outside the allow list\`)` before any CORS write;
  - write into the accumulator from `demand(c, "headers")`: set `Access-Control-Allow-Origin` for an allowed origin, set `Access-Control-Expose-Headers` ("etag, accept-ranges, content-range") when `c.req.method !== "OPTIONS"`, append `vary: Origin` before `await next()` for allowed and absent origins alike;
  - write the `allowedOrigin` variable for an allowed origin; delete `OriginState`; no `c.header`, no `c.res` write, no envelope.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — origin on Hono · Story 5 (`originMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/origin.test.ts` (`032/story-5`).

**Files changed.**

- `src/http/server/origin.ts` (edited) — `originMiddleware(dependencies: OriginDependencies): MiddlewareHandler<AppEnv>` rewritten against `Context<AppEnv>`; `OriginDependencies` and `EXPOSED_HEADERS` unchanged.

**Seam (GREEN).** Reads the origin with `c.req.header("origin")`; a present origin outside the exact-value allow-list `Set` throws `httpError("origin-forbidden", \`the Origin header ${origin} is outside the allow list\`)`before any accumulator write; otherwise it demands the accumulator once, sets`Access-Control-Allow-Origin`, sets `Access-Control-Expose-Headers = "etag, accept-ranges, content-range"`when`c.req.method !== "OPTIONS"`, writes the `allowedOrigin`variable via`c.set`, then — for allowed and absent origins alike — appends `vary: Origin`and awaits`next()`exactly once. No`c.header`, no `c.res`write, no envelope, no`finally`.

**Refactor.** deferred: delete `OriginState`. `src/http/server/preflight.ts:3` still imports it and `preflight.ts` is Story 7's input, not this Task's — exactly the deferral the RED turn sanctioned ("Story 3 deferral precedent applies within the batch"); the deletion constraint holds at batch close once Story 7 removes that import.

**Build check.**

- eslint `src/http/server/origin.ts`: exit 0
- `npm run typecheck`: FAIL — 9 errors, every one in `src/http/server/preflight.test.ts` (TS2345: the still-Koa `buildApp(...middleware: Middleware[])` fixture cannot accept a Hono `MiddlewareHandler<AppEnv>`); `src/http/server/origin.test.ts`, `src/http/server/app.ts` and `src/http/server/preflight.ts` are clean. This matches the RED turn's stub probe verbatim ("Residual errors sit only in `preflight.test.ts` and `preflight.ts`"); retaining `OriginState` keeps the `preflight.ts` half of that set clean.

**Open to Test Engineer.**

- OPEN: `src/http/server/preflight.test.ts` — out of my lane; its Koa fixture must move to the `loopbackAgent(koaFromHono(hono))` shape per Story 7 before these nine TS2345 residuals clear. Until then `npm run verify:handoff` reports FAIL from that one test file and nothing else.

**Assumptions.**

- VERIFIED: `app.ts:108` still typechecks against the new signature — the result flows through Koa's `app.use(...)` method call, which checks parameters bivariantly; only `preflight.test.ts`'s typed rest parameter `Middleware[]` trips strict checking (typecheck output above).
- VERIFIED: an empty-string `Origin` header reaches `c.req.header("origin")` as `""`, not `undefined`, so the refusal table row `""` keeps today's exact message — same read semantics as the deleted `context.request.headers.origin`.
- VERIFIED: undici `Headers.append` joins same-name values in insertion order, so appending `vary: Origin` before `next()` yields `Vary: Origin, Accept` when downstream appends `Accept` — the RED turn probed both orders.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — host on Hono · Story 6 (`hostMiddleware` rewrite)

**Cycle.** Handoff gate first. The software-engineer's last turn closed with `npm run typecheck` FAIL (9 × TS2345) under an explicit `OPEN:` aimed at this lane's `src/http/server/preflight.test.ts`. Independently re-verified verbatim: `VERIFY: FAIL — npm run typecheck exited 2`, all nine errors in that one test-lane file, none elsewhere — the disclosure was exact, so this is not a build-proof violation but an in-lane repair owed by me; performed before advancing (first bullet below). Confirm GREEN for Story 5 (`032/story-5`): `node --test src/http/server/origin.test.ts` → tests 19 / pass 19 / fail 0, exit 0; post-repair `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Then RED for Task `032/story-6` (`node --test src/http/server/host.test.ts`).

**Test written.**

- file: `src/http/server/preflight.test.ts` (edited — fixture only; conformer repair for the Story 5 signature change, which only this lane may apply) — suite unchanged, zero assertion lines touched. The now-Hono `originMiddleware` no longer fits the file's Koa fixture; replaced it with a fixture-local `originStage(allowedOrigins)` stand-in reproducing the origin stage's contract against today's still-Koa `preflightMiddleware`: absent Origin passes through, an allowed origin seeds `context.state.allowedOrigin` plus the CORS headers and `vary("Origin")`, a disallowed origin throws the exact `origin-forbidden` HttpError. Story 7's RED turn deletes the shim and mounts the real `originMiddleware` per its Test fixture section. Post-repair: `npm run verify:handoff` PASS, `node --test src/http/server/preflight.test.ts` → tests 9 / pass 9 / fail 0, eslint clean.
- file: `src/http/server/host.test.ts` (edited — full rewrite; test lane per Stories 5–14) — suite: `src/http/server/host.test` — methods preserved verbatim: `answers 200 when the Host header is in the allow list`, `answers 403 host-forbidden echoing the refused Host header`, `answers 403 when no Host header is overridden and supertest sends the loopback port`, `compares the host case-insensitively in both directions`, `treats a port as part of the comparison`, `answers 403 on a trailing dot`, `answers 200 for each entry of a multi-entry allow list and 403 for a stranger`, `refuses everything when the allow list is empty`, `ignores X-Forwarded-Host`, `echoes the sent value and nothing else in the refusal message`
- asserts: exactly the Story 06 fixture over every preserved case — `new Hono<AppEnv>()` whose `onError` runs `errorValue` → `materializeError` → `onInternalError` only when `materialized.internal`, then `errorResponse(materialized, demand(c, "headers"))`; mount order `headersMiddleware()` → `renderMiddleware()` → `hostMiddleware(dependencies)` through `hono.use("*", ...)`; the reached marker sets `result` to `{ kind: "json", status: 200, body: { reached: true } }` and returns no `Response`; every fixture driven through `loopbackAgent(koaFromHono(hono))`. Every supertest assertion keeps its exact status, exact body and exact message text, including the Supertest-generated-host regex and the trailing-dot, port, multi-entry, empty-list and X-Forwarded-Host rows.

**RED proof.**

- command: `node --test src/http/server/host.test.ts`
- exit: 1 (tests 10 / pass 0 / fail 10) — first failure verbatim:
  `✖ answers 200 when the Host header is in the allow list` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `500 !== 200`
  The failure mode is the right one: today's `hostMiddleware` reads `context.request.headers.host`, and Hono's `Context` exposes no public `request` (the raw Request sits behind a private field), so each request throws inside the middleware and `hono.onError` answers the generic internal-error 500 instead of the asserted status.
- stub probe: `src/http/server/host.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub typed `(c: Context<AppEnv>, next: Next) => Promise<void>`): `npm run typecheck` fully clean across the tree. The probe caught one real defect in my own file pre-handoff — a synchronous void marker fails Hono's handler overload; the async form compiles — fixed in-lane before restoring. Stub removed via `git checkout -- src/http/server/host.ts`; `git status`/`git diff` on it are empty. Residual handed off: exactly one typecheck error, `src/http/server/host.test.ts(32,17)` TS2769, inside my file, cleared by the seam below. No collateral: `preflight`/`variables`/`headers`/`render`/`envelope`/`koa-bridge` suites still 54/54; eslint exits 0 on both edited files.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/host.ts`, per Story 06 (`.agents/plan/stories/032-the-hono-middleware-chain/06-host-middleware.md`) exactly:
  - keep `HostDependencies` and lower-case every configured host once when the middleware is created;
  - `export function hostMiddleware(dependencies: HostDependencies): MiddlewareHandler<AppEnv>` — read only `c.req.header("host")`; if absent throw `httpError("host-forbidden", "the request carried no Host header")`; if the lower-cased value is absent from the allow list throw `httpError("host-forbidden", \`the Host header ${host} is outside the allow list\`)`; otherwise await `next()` once;
  - ignore `X-Forwarded-Host`; keep ports and trailing dots significant; do not synthesize a Host header from the request URL;
  - note: `src/http/server/app.ts:110` mounts this middleware into the still-Koa `app.use(...)` and stays bivariant-clean (the probe proved the whole tree typechecks against the new signature); the `OriginState` deletion deferral from Stories 3–5 stands until Story 7 removes `preflight.ts`'s import.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — host on Hono · Story 6 (`hostMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/host.test.ts` (`032/story-6`).

**Files changed.**

- `src/http/server/host.ts` (edited) — `hostMiddleware(dependencies: HostDependencies): MiddlewareHandler<AppEnv>` rewritten against Hono's `Context<AppEnv>`/`Next`; `HostDependencies` unchanged; Koa type imports deleted.

**Seam (GREEN).** Reads only `c.req.header("host")`; an absent header throws `httpError("host-forbidden", "the request carried no Host header")`; a lower-cased value missing from the create-time `Set` throws `httpError("host-forbidden", \`the Host header ${host} is outside the allow list\`)`, echoing the sent value verbatim; an admitted host awaits `next()`exactly once.`X-Forwarded-Host` is never read; ports and trailing dots stay significant through the exact post-case-fold compare; no Host is synthesized from the request URL.

**Refactor.** none named by the Story or the RED turn.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/host.ts`: exit 0

**Open to Test Engineer.**

- none. The Stories 3–5 `OriginState` deferral stands unchanged — `src/http/server/preflight.ts:3` still imports it and Story 7 removes that import at batch close; this Task touches neither file.

**Assumptions.**

- VERIFIED: the whole tree typechecks against the new signature — the RED turn's stub probe predicted exactly this ("the probe proved the whole tree typechecks against the new signature"); `app.ts:110` stays bivariant-clean through Koa's method-call parameter check.
- VERIFIED: supertest without `.set("Host", ...)` still sends its loopback host, so the "answers 403 when no Host header is overridden" row exercises the allow-list refusal branch, not the missing-Host branch — that distinction stays open until Story 16 adds the full-chain assertion.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — preflight on Hono · Story 7 (`preflightMiddleware` rewrite)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 6 (`032/story-6`): `node --test src/http/server/host.test.ts` → tests 10 / pass 10 / fail 0, exit 0. Then RED for Task `032/story-7` (`node --test src/http/server/preflight.test.ts`).

**Test written.**

- file: `src/http/server/preflight.test.ts` (edited — full rewrite; test lane per Stories 5–14; deletes the Story 6 conformer shim `originStage`) — suite: `src/http/server/preflight.test` — methods preserved verbatim: `answers 204 with the full CORS header set and never reaches downstream`, `answers 204 with no Authorization header`, `refuses an OPTIONS from a disallowed origin with 403 origin-forbidden and no allow-origin header`, `passes an OPTIONS with no Origin header through to downstream`, `does not answer the preflight constant for a GET, only for OPTIONS`, `still answers 204 for an OPTIONS from an allowed origin with no Access-Control-Request-Method header`, `answers the identical byte-for-byte 204 for a path that matches no operation`, `answers the identical 204 for a real registry path and an absent one`, `ALLOWED_METHODS matches the sorted unique set of registry methods`; added per the Story bypass row: `a preflight from an allowed origin with no Authorization header on an unknown path bypasses authentication and route matching`
- asserts: every preserved case keeps its exact status/body/header assertions over the Story 07 fixture (`new Hono<AppEnv>()`; `onError` = `errorResponse(materializeError(errorValue(error)), demand(c, "headers"))`; mount order `headersMiddleware()` → `renderMiddleware()` → `originMiddleware({ allowedOrigins })` → `preflightMiddleware()` → variadic extras through `hono.use("*", ...)`; marker `hono.all("*", async (c) => { c.set("result", { kind: "json", status: 200, body: { reached: true } }); })`; driven through `loopbackAgent(koaFromHono(hono))`). The new bypass case mounts two fixture-local stand-ins after `preflightMiddleware()` — an auth stage that records each presented token then throws `unauthenticated` like today's no-bearer branch, and a route stage that throws `not-found` — and asserts exact 204, empty body, no `content-type`, and zero recorded resolutions; reaching either stage fails it.

**RED proof.**

- command: `node --test src/http/server/preflight.test.ts`
- exit: 1 (tests 10 / pass 4 / fail 6) — first failure verbatim:
  `✖ answers 204 with the full CORS header set and never reaches downstream` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `200 !== 204`
  The four passing rows assert only pass-through/absence behavior that holds vacuously against today's middleware (including the two identity rows, whose both sides are now 200). The failure mode is the right one: the current `preflightMiddleware` reads `context.method`, which does not exist on Hono's `Context<AppEnv>`, so its guard is always false and every request passes through to the marker — preflights render as 200 `{ reached: true }` instead of 204, and the bypass case reaches the auth stage (401).
- stub probe: `src/http/server/preflight.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub typed `(): MiddlewareHandler<AppEnv>`): `npm run typecheck` fully clean across the tree. Stub removed and the original restored byte-exact (`git diff`/`git status` on the file are empty). Residual at handoff is exactly one error inside my own file — `src/http/server/preflight.test.ts(45,17)` TS2769, the still-Koa `preflightMiddleware()` rejected by `hono.use("*", ...)` — which the seam below clears as a side effect of its rewrite. No collateral: variables/headers/render/envelope/origin/host/koa-bridge suites still 74/74; eslint clean on the rewritten test.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/preflight.ts`, per Story 07 (`.agents/plan/stories/032-the-hono-middleware-chain/07-preflight-middleware.md`) exactly:
  - keep the three constants unchanged (`ALLOWED_METHODS` = `"DELETE, GET, POST, PUT"`, `ALLOWED_HEADERS` = `"authorization, content-type, idempotency-key, if-none-match, x-kanthord-client"`, `MAX_AGE` = `"86400"`);
  - `export function preflightMiddleware(): MiddlewareHandler<AppEnv>` — a request is a preflight only when `c.req.method === "OPTIONS"` and `optional(c, "allowedOrigin") !== undefined`; any other request awaits `next()` exactly once; for a preflight, demand the accumulator and set the three access-control headers into it, set `result` to `{ kind: "empty", status: 204 }`, and return without calling `next()`;
  - constraints: do not inspect `Access-Control-Request-Method`; do not authenticate or route-match an admitted preflight; do not write status or body directly on the Hono context; do not call `next()` after setting the result;
  - note: dropping the `OriginState` import from `preflight.ts:3` lets you complete the Stories 3–5 deferral by deleting `OriginState` from `origin.ts`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — preflight on Hono · Story 7 (`preflightMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/preflight.test.ts` (`032/story-7`).

**Files changed.**

- `src/http/server/preflight.ts` (edited) — `preflightMiddleware(): MiddlewareHandler<AppEnv>` rewritten against `Context<AppEnv>`; Koa imports and the `OriginState` import deleted; the three constants unchanged.
- `src/http/server/origin.ts` (edited) — `export type OriginState` deleted.

**Seam (GREEN).** A request is a preflight only when `c.req.method === "OPTIONS"` and `optional(c, "allowedOrigin") !== undefined`; every other request awaits `next()` exactly once. A preflight demands the accumulator, sets `Access-Control-Allow-Methods` / `Access-Control-Allow-Headers` / `Access-Control-Max-Age` into it (constant values unchanged), writes `result` as `{ kind: "empty", status: 204 }`, and returns without calling `next()`. No `Access-Control-Request-Method` inspection, no authentication or route matching on an admitted preflight, no direct status/body write on the Hono context.

**Refactor.** applied: deleted `OriginState` from `origin.ts`. Story 7 removed its last import (`preflight.ts:3`), completing the Stories 3–5 deferral exactly as this Task's RED turn named ("dropping the `OriginState` import from `preflight.ts:3` lets you complete the Stories 3–5 deferral by deleting `OriginState` from `origin.ts`"). Grep confirms no remaining reference under `src/`.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/preflight.ts src/http/server/origin.ts`: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — auth on Hono · Story 8 (`authMiddleware` rewrite)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 7 (`032/story-7`): `node --test src/http/server/preflight.test.ts` → tests 10 / pass 10 / fail 0, exit 0. Then RED for Task `032/story-8` (`node --test src/http/server/auth.test.ts`).

**Test written.**

- file: `src/http/server/auth.test.ts` (edited — full rewrite; test lane per Stories 5–14) — suite: `src/http/server/auth.test` — methods preserved verbatim: `parses the bearer scheme case-insensitively and rejects everything else`, `stays route-independent by construction`, `no longer names node:crypto and no longer exports tokensMatch`, `answers 401 unauthenticated when no token is presented`, `answers 401 with the not-valid message when the token is wrong`, `answers the identical not-valid body for every unresolved token, whatever the resolver`, `treats a wrong scheme as a missing token`, `answers 200 when the bearer token matches`, `refuses every path and method with the same 401`, `a header the resolver accepts reaches the terminal handler and the resolved actor lands on the actor variable`, `with an empty configured token, a request with no Authorization header reaches the terminal handler with the bootstrap actor, and the resolver is called exactly once with an empty string`, `with an empty configured token, an arbitrary Authorization header still reaches the handler with the bootstrap actor`, `resolveActor is called exactly once per request with the exact presented token, including a token that holds a dot`
- asserts: every existing case keeps its exact status, exact envelope body and exact call counts over the Story 08 fixture (`new Hono<AppEnv>()`; `onError` = `errorResponse(materializeError(errorValue(error)), demand(c, "headers"))` with each case's injectable `onInternalError`; mount order `headersMiddleware()` → `renderMiddleware()` → `authMiddleware({ token, resolveActor })` through `hono.use("*", ...)`; marker `hono.all("*", async (c) => { … })` calls `demand(c, "actor")` for strict identity against the resolver's row and sets `result` to `{ kind: "json", status: 200, body: { reached: true } }` returning no `Response`; driven through `loopbackAgent(koaFromHono(hono))`). The parser table and both source-text characterization rows are unchanged except one mechanism word: the route-independence row now asserts the absence of bare `match` instead of `context.state.match`, because the Koa state object no longer exists and `c.set("match", …)` is the shape route state would leak through post-port. The `AuthenticatedState` import leaves this file; the exact-state assertions now read the `actor` variable through `demand` by identity. The stale-mechanism name of the harness-row case drops "context.state" accordingly; zero assertion lines changed.

**RED proof.**

- command: `node --test src/http/server/auth.test.ts`
- exit: 1 (tests 13 / pass 3 / fail 10) — first failure verbatim:
  `✖ answers 401 unauthenticated when no token is presented` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `500 !== 401`
  The three passing cases are the two source-text characterizations and the pure `bearerToken` table — all non-HTTP rows that hold against today's file unchanged. The failure mode is the right one: today's `authMiddleware` reads `context.request.headers.authorization`, which does not exist on Hono's `Context<AppEnv>`, so each request throws inside the middleware and `hono.onError` answers the generic internal-error 500 instead of the asserted status or envelope.
- stub probe: `src/http/server/auth.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub typed `(dependencies: AuthDependencies): MiddlewareHandler<AppEnv>`, keeping `bearerToken`, `AuthDependencies` and `AuthenticatedState`): `npm run typecheck` fully clean across the tree — exit 0 — proving the sibling Koa fixtures (`authorize.test.ts:177`, `dispatch.test.ts:324`) stay bivariant-clean against the new signature, as in Stories 6–7. The probe caught one real defect in my own file pre-handoff — a synchronous void marker fails Hono's handler overload (`TS2769: Type 'void' is not assignable to type 'HandlerResponse<any>'` at line 49); the async form compiles — fixed in-lane before restoring. Stub removed via `git checkout -- src/http/server/auth.ts`; `git status --porcelain` on it is empty. Post-fix RED re-run: identical 13/3/10 with the same first failure.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/auth.ts`, per Story 08 (`.agents/plan/stories/032-the-hono-middleware-chain/08-auth-middleware.md`) exactly:
  - keep `bearerToken` byte-for-byte unchanged; keep `AuthDependencies` unchanged;
  - `export function authMiddleware(dependencies: AuthDependencies): MiddlewareHandler<AppEnv>` — for an empty configured token call `resolveActor("")`, throw `httpError("internal-error", "the database holds no actor row")` when absent, set the `actor` variable to the exact returned row, await `next()` once, independent of any request header; otherwise read only `c.req.header("authorization")`, parse with `bearerToken`, throw `httpError("unauthenticated", "no bearer token")` on `null`, resolve the exact parsed token once, throw `httpError("unauthenticated", "the bearer token is not valid")` when absent, set the `actor` variable and await `next()` once;
  - constraints from the story: no trim or normalization of token contents, no crypto or registry dependencies, no second `resolveActor` call per request;
  - note: delete `AuthenticatedState` per the story, but its importers survive until batch close — `authorize.ts`, `idempotency.ts` and `dispatch.ts` import the type today and Stories 9, 10, 13, 14 own their rewrites (the Stories 5–7 `OriginState` deferral precedent applies); the probe proved the tree typechecks clean while the type stays exported.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — auth on Hono · Story 8 (`authMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/auth.test.ts` (`032/story-8`).

**Files changed.**

- `src/http/server/auth.ts` (edited) — `authMiddleware(dependencies: AuthDependencies): MiddlewareHandler<AppEnv>` rewritten against Hono's `Context<AppEnv>`/`Next`; Koa type imports deleted; `bearerToken` and `AuthDependencies` byte-for-byte unchanged.

**Seam (GREEN).** The empty-configured-token branch calls `resolveActor("")` exactly once, throws `httpError("internal-error", "the database holds no actor row")` when it returns null, writes the exact row into the `actor` variable via `c.set`, and awaits `next()` once — never reading the Authorization header. Otherwise the middleware reads only `c.req.header("authorization")`, parses with the unchanged `bearerToken`, throws `httpError("unauthenticated", "no bearer token")` on null, resolves the exact parsed token once, throws `httpError("unauthenticated", "the bearer token is not valid")` when unresolved, sets the exact actor, and awaits `next()` once. No trim or normalization of token contents; no crypto or registry dependency; at most one `resolveActor` call per request.

**Refactor.** deferred: delete `AuthenticatedState`. Its importers survive until batch close — `authorize.ts`, `idempotency.ts` and `dispatch.ts` import the type today and Stories 9, 10, 13, 14 own their rewrites (the Stories 5–7 `OriginState` deferral precedent, sanctioned verbatim by this Task's RED turn). The type stays exported so the handoff typecheck holds; deletion lands when Story 14 removes its last import.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/auth.ts`: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — route on Hono · Story 9 (`routeMiddleware` rewrite)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 8 (`032/story-8`): `node --test src/http/server/auth.test.ts` → tests 13 / pass 13 / fail 0, exit 0. Then RED for Task `032/story-9` (`node --test src/http/server/route.test.ts`).

**Test written.**

- file: `src/http/server/route.test.ts` (edited — full rewrite; test lane per Stories 5–14) — suite: `src/http/server/route.test` — methods preserved verbatim except three stale-mechanism renames (`state.match` → the `match` variable; zero assertion lines changed): `GET /v1/health leaves the match variable's operation.operationId equal to system.health`, `GET /v1/node/task_01JQ8ZAN9P leaves the match variable's parameters deep-equal to the id`, `GET /v1/nope answers 404 with the no-operation envelope and never reaches the inspector`, `a query string does not reach matchRoute: GET /v1/health?x=1 resolves to system.health`, `on every reached request the match variable holds an operation and its parameters`, `the proposal declares four post-mvp rows`, `every post-mvp path answers 404 and never 501`, `a post-mvp row has no registry entry, and the matrix has no third kind of row`, `a post-mvp path is unreadable without the token`
- asserts: exactly the Story 09 fixture over every preserved case — `new Hono<AppEnv>()` whose `onError` runs `errorValue` → `materializeError` → injectable `onInternalError` only when `materialized.internal`, then `errorResponse(materialized, demand(c, "headers"))`; mount order `headersMiddleware()` → `renderMiddleware()` → `routeMiddleware()` through `hono.use("*", ...)`; the reached marker demands `match` and sets `result` to `{ kind: "json", status: 200, body: { reached: true, operation: match.operation, parameters: match.parameters } }` returning no `Response`; every fixture driven through `loopbackAgent(koaFromHono(hono))`. Every supertest assertion keeps its exact status, exact envelope and exact message text; a successful match is observed through `demand(c, "match")`. The three `createTestApp` cases (post-MVP absence, 404-versus-501, authentication precedence) stay byte-for-byte on the real app.

**RED proof.**

- command: `node --test src/http/server/route.test.ts`
- exit: 1 (tests 9 / pass 2 / fail 7) — first failure verbatim:
  `✖ GET /v1/health leaves the match variable's operation.operationId equal to system.health` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `404 !== 200`
  The two passing cases are the registry/matrix characterizations that drive no HTTP. Five fixture failures carry the missing-seam signature verbatim — today's Koa middleware reads `context.method`/`context.path`, both `undefined` on a Hono `Context<AppEnv>`, so every fixture request refuses with `no operation for undefined undefined` (pinned by the `/v1/nope` deep-equal diff) instead of reaching the marker.
  The remaining two failures (`every post-mvp path answers 404 and never 501`, `a post-mvp path is unreadable without the token`) are pre-existing mid-batch breakage, not caused by this edit: both cases drive the real `createTestApp` chain unchanged from before this Task, and an untouched driver of the same chain, `src/http/server/app.parity-path.test.ts`, is 0/5 red right now with the same 500 signature — since Stories 5–8 the real Koa app mounts Hono-native middlewares that throw on a Koa context. Story 16 rewires `createApp` onto the full Hono chain behind `koaFromHono` and restores them; each story's Verify section defers `npm run verify` to batch close.
- stub probe: `src/http/server/route.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub typed `(): MiddlewareHandler<AppEnv>`, keeping `RoutedState` exported): `npm run typecheck` fully clean across the tree — exit 0 — proving the sibling Koa fixtures (`authorize.test.ts`, `dispatch.test.ts`, `idempotency.test.ts`) and `app.ts`'s mount stay bivariant-clean against the new signature, as in Stories 6–8. Stub removed and the original restored byte-exact (`git status --porcelain`/`git diff` on the file are empty). Residual at handoff is exactly one error inside my own file — `src/http/server/route.test.ts(39,17)` TS2769, the still-Koa `routeMiddleware()` rejected by `hono.use("*", ...)` — which the seam below clears as a side effect of its rewrite. No collateral: variables/headers/render/envelope/origin/host/preflight/auth/koa-bridge suites still 97/97; eslint clean on the rewritten test.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/route.ts`, per Story 09 (`.agents/plan/stories/032-the-hono-middleware-chain/09-route-middleware.md`) exactly:
  - `export function routeMiddleware(): MiddlewareHandler<AppEnv>` — compute `const pathname = new URL(c.req.url).pathname` once; call `matchRoute(c.req.method, pathname)` once; on null throw `httpError("not-found", \`no operation for ${c.req.method} ${pathname}\`)`; otherwise store the exact `RouteMatch`as the`match`variable and await`next()` once;
  - constraints: keep `RouteMatch` declared only in `src/http/contract/registry.ts`; no Hono route parameters and no operation-specific Hono routes; pass the pathname without decoding a segment; keep the query string out of the refusal message;
  - note: delete `RoutedState` per the story, but its importers survive until batch close — `app.ts`, `idempotency.ts`, `dispatch.ts` and `authorize.ts` import the type today and Stories 10, 13, 14, 16 own their rewrites (the Stories 5–8 `OriginState`/`AuthenticatedState` deferral precedent applies); the probe proved the tree typechecks clean while the type stays exported.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — route on Hono · Story 9 (`routeMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/route.test.ts` (`032/story-9`).

**Files changed.**

- `src/http/server/route.ts` (edited) — `routeMiddleware(): MiddlewareHandler<AppEnv>` rewritten against Hono's `Context`/`Next`; Koa type imports deleted.

**Seam (GREEN).** Computes `new URL(c.req.url).pathname` once and calls `matchRoute(c.req.method, pathname)` once; a null match throws `httpError("not-found", \`no operation for ${c.req.method} ${pathname}\`)`; otherwise the exact `RouteMatch`is stored as the`match`variable via`c.set`and`next()` is awaited once. No Hono route parameters and no operation-specific routes.

**Refactor.** deferred: delete `RoutedState`. Its importers survive until batch close — `app.ts`, `idempotency.ts`, `dispatch.ts` and `authorize.ts` import the type today and Stories 16, 13, 14, 10 own their rewrites (the Stories 5–8 `OriginState`/`AuthenticatedState` deferral precedent this Task's RED turn sanctions verbatim); deletion lands when Story 16 removes the last import.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/route.ts`: exit 0

**Assumptions.**

- VERIFIED: WHATWG `URL.pathname` keeps percent escapes intact and excludes the query string — `node -e "console.log(new URL('http://kanthord.invalid/v1/blob/a%2Fb%zz?q=1').pathname)"` prints `/v1/blob/a%2Fb%zz`, satisfying both constraints (`no decoded segment`, `no query in the refusal message`) with no extra step.
- VERIFIED: the two `createTestApp` rows of this suite stay red mid-batch exactly as the RED turn records them (Story 16 rewires the real chain); this Task's fixture cases are the ones the rewrite greens.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — authorize on Hono · Story 10 (`authorizeMiddleware` rewrite)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: FAIL — npm run typecheck exited 2`, whose single error is `src/http/server/authorize.test.ts(199,19)` TS2769 inside my own test lane — introduced by this Task's rewrite and disclosed under RED proof below; the software-engineer's handoff itself was clean. Confirm GREEN for Story 9 (`032/story-9`): `node --test src/http/server/route.test.ts` → tests 9 / pass 7 / fail 2, the two failures being exactly the pre-existing `createTestApp` rows its RED turn deferred to Story 16; every fixture case the Story 9 rewrite owns passes. Then RED for Task `032/story-10` (`node --test src/http/server/authorize.test.ts`).

**Test written.**

- file: `src/http/server/authorize.test.ts` (edited — the one direct-build fixture rewritten per Story 10's Test fixture section; cases 1–6 stay byte-for-byte on the real `createTestApp` app) — suite: `src/http/server/authorize.test` — methods preserved verbatim, all seven, including `a refusal reserves no idempotency key`
- asserts: the no-idempotency-reservation case now builds `new Hono<AppEnv>()` whose `onError` runs `errorValue` → `materializeError` → injectable `onInternalError` only when `materialized.internal`, then `errorResponse(materialized, demand(c, "headers"))`; mount order `headersMiddleware()` → `renderMiddleware()` → `routeMiddleware()` → `authMiddleware({ token, resolveActor })` → `authorizeMiddleware()` through `hono.use("*", ...)`; driven through `loopbackAgent(koaFromHono(hono))`. Every assertion line is unchanged: exact 403, exact `actor-forbidden` code, `store.size() === 0`, handler `calls === 0`. The still-Koa idempotency middleware and `dispatchMiddleware` mount after authorize behind one double assertion each — they stay literally the production functions, are never started on this refusal path (Hono compose starts no downstream frame after an upstream throw), and any future ordering leak makes them throw their `context.state` TypeError into a 500 that fails this case.

**RED proof.**

- command: `node --test src/http/server/authorize.test.ts`
- exit: 1 (tests 7 / pass 1 / fail 6) — this Task's fixture failure verbatim:
  `✖ a refusal reserves no idempotency key` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `500 !== 403`
  The failure mode is the right one and is now isolated to this story's seam: every stage upstream of authorize in the new fixture is Hono-native and green (variables/headers/render/envelope/origin/host/preflight/auth/route/koa-bridge still pass, 104/106 with only route.test.ts's two recorded createTestApp rows red), so the throw originates in today's Koa closure reading `context.state`, which does not exist on Hono's `Context<AppEnv>` — compose catches it at authorize's frame and `onError` answers the generic internal-error 500 instead of the asserted 403 actor-forbidden envelope. The other five failures ride the untouched `createTestApp` chain and are the same pre-existing mid-batch reds recorded since Stories 5–8 (Story 16 restores them); the single passing row asserts only a negative that holds vacuously against today's 500.
- stub probe: `src/http/server/authorize.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub typed `(): MiddlewareHandler<AppEnv>`): `npm run typecheck` fully clean across the tree — exit 0 — proving cases 1–6 and `app.ts`'s mount stay bivariant-clean against the new signature, as in Stories 6–9. The probe surfaced two cross-signature residuals inside my own file — the plain still-Koa idempotency/dispatch mounts failed TS2769 under Hono's contravariant `use` property — resolved in-lane with one double assertion each before restoring. Stub removed via `git checkout -- src/http/server/authorize.ts`; porcelain empty. Residual at handoff is exactly one error inside my own file — `src/http/server/authorize.test.ts(199,19)` TS2769, the still-Koa `authorizeMiddleware()` rejected by `hono.use("*", ...)` — cleared as a side effect of the seam rewrite below. eslint on the rewritten test: clean.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/authorize.ts`, per Story 10 (`.agents/plan/stories/032-the-hono-middleware-chain/10-authorize-middleware.md`) exactly:
  - delete the `AuthenticatedState` and `RoutedState` imports;
  - `export function authorizeMiddleware(): MiddlewareHandler<AppEnv>` — demand `match`, then demand `actor`, in that order; when `match.operation.allowedActors` excludes `actor.kind` throw `httpError("actor-forbidden", \`${match.operation.operationId} does not admit actor kind ${actor.kind}\`)`; otherwise await `next()` exactly once;
  - constraints: authorize stays ahead of body parsing, idempotency reservation and dispatch (mount order); inspect no request body and no idempotency key; keep the exact refusal message; change no registry actor list;
  - notes: deleting authorize.ts's two type-only imports is immediately safe — nothing else reads them from this module; the two state types themselves stay exported until batch close (`dispatch.ts` and `idempotency.ts` still import both and Stories 13–14 own their rewrites; `app.ts` imports `RoutedState` and Story 16 owns it — the Stories 5–9 deferral precedent applies).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — authorize on Hono · Story 10 (`authorizeMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/authorize.test.ts` (`032/story-10`).

**Files changed.**

- `src/http/server/authorize.ts` (edited) — `authorizeMiddleware(): MiddlewareHandler<AppEnv>` rewritten against Hono's `Context<AppEnv>`/`Next`; Koa type imports deleted; refusal unchanged.

**Seam (GREEN).** Demands `match`, then demands `actor`, in that order; when `match.operation.allowedActors` excludes `actor.kind` throws `httpError("actor-forbidden", \`${match.operation.operationId} does not admit actor kind ${actor.kind}\`)`; an admitted actor awaits `next()` exactly once. No request body or idempotency key is inspected; no registry actor list changes.

**Refactor.** applied: deleted the `AuthenticatedState` and `RoutedState` imports from this module. The RED turn sanctioned this as immediately safe ("nothing else reads them from this module"); grep confirms only `authorizeMiddleware` is imported from `./authorize.ts`. The two state types themselves stay exported in `auth.ts`/`route.ts` until batch close (`idempotency.ts`, `dispatch.ts`, `app.ts` still import them and Stories 13, 14, 16 own their rewrites).

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/authorize.ts`: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the gated body parse · Story 11 (`bodyMiddleware` + `BODY_LIMIT_BYTES`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 10 (`032/story-10`): `node --test src/http/server/authorize.test.ts` → tests 7 / pass 2 / fail 5 — the Story 10 fixture case `a refusal reserves no idempotency key` now passes alongside the vacuous negative row, and the five failures are byte-for-byte the pre-existing mid-batch `createTestApp` rows its RED turn deferred to Story 16 (recorded since Stories 5–8); post-turn `npm run verify:handoff` stays PASS. Then RED for Task `032/story-11` (`node --test src/http/server/body.test.ts`).

**Test written.**

- file: `src/http/server/body.test.ts` (new) — suite: `src/http/server/body.test` — methods: `a get and a delete leave both variables absent and still reach downstream`, `post, put and patch each parse an admitted json body`, `a stubbed operation never pulls the body, leaves both variables absent and still reaches downstream`, `a routed operation without a bound handler never pulls the body, leaves both variables absent and still reaches downstream`, `every admitted media type parses across mixed case and parameters`, `a text/plain body stores an empty object without rawBody`, `an absent content type stores an empty object without rawBody and without pulling the stream`, `the exact whitespace of an admitted body survives into rawBody while parsing to the same value`, `zero json bytes store an empty rawBody and an empty object`, `scalar and truncated bodies answer 400 invalid-request with the exact message`, `a declared content-length above the cap answers the generic 500 envelope without pulling the stream`, `a streamed body that crosses the cap refuses at the crossing and never touches the sentinel`, `a body of exactly the limit parses once and reaches downstream`
- asserts: every Story 11 bullet over one in-process Hono fixture (`new Hono<AppEnv>()`; `onError` = `errorResponse(materializeError(errorValue(error)), demand(c, "headers"))` with an internals collector; mount order `headersMiddleware()` → `renderMiddleware()` → match-seeding stage → `bodyMiddleware(handlers)`; terminal marker records `optional(c, "body")` / `optional(c, "rawBody")` then sets the json `result`; driven by `app.request(new Request(...))` — direct Hono contexts, no socket): GET and DELETE write neither variable and still reach downstream; POST/PUT/PATCH each parse `{"a":1}` into `{ a: 1 }` plus the exact raw text; a stubbed operation and a routed operation without a bound handler leave both variables absent, reach downstream and pull the malformed counting stream zero times; all six admitted media types parse across mixed case, parameters, and a parameter holding a second `;`; `text/plain` and an absent content-type store `{}` with `rawBody` absent and zero pulls; `{ "a" : 1 }` keeps its exact whitespace in `rawBody` while parsing equal; zero bytes store `rawBody === ""` and `{}`; bodies `1`, `"a"` and `{"oops` each answer 400 with the exact `invalid-request` envelope, no downstream call and no internal report; `content-length: 1048577` answers the exact generic 500 envelope with zero pulls and one `onInternalError` carrying `Error("request body exceeds the limit")`; a chunked stream of exactly the cap then one byte refuses at the crossing — pulled sizes `[1048576, 1]`, sentinel never pulled, same envelope and callback value — and `reader.cancel()` never runs (see conflict note below); a UTF-8-exact 1048576-byte body parses once and reaches downstream once, with `BODY_LIMIT_BYTES === 1_048_576`.

**RED proof.**

- command: `node --test src/http/server/body.test.ts`
- exit: 1 (tests 1 / pass 0 / fail 1) — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/body.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/body.test.ts`
- stub probe: `src/http/server/body.ts` — clean (`npm run typecheck` with the Story-declared-signature stub reports zero errors across the tree — including the `duplex: "half"` RequestInit field and all narrowing patterns in the test; stub deleted before this turn, leaving exactly the TS2307/ERR_MODULE_NOT_FOUND for the missing seam). One transient eslint flag on the new test — `boundaries/no-unknown-dependencies` at the `"./body.ts"` import — clears the moment the seam file exists.

**Open to Software Engineer.**

- Seam the test imports: new `src/http/server/body.ts`, per Story 11 (`.agents/plan/stories/032-the-hono-middleware-chain/11-gated-body-parser.md`) and Decisions 6 + 13 exactly:
  - `export const BODY_LIMIT_BYTES = 1_048_576`;
  - `export function bodyMiddleware(handlers: Readonly<Record<string, Handler>>): MiddlewareHandler<AppEnv>` — gates in order: method not POST/PUT/PATCH → next without either variable; demand `match`; stubbed operation or unbound handler → next without either variable; media type split before the first `;`, trimmed, lower-cased — outside the six admitted types or absent → `body` = `{}`, `rawBody` absent, next; decimal `content-length` above `BODY_LIMIT_BYTES` → refuse before pulling one byte; otherwise read `c.req.raw.body` once through its reader, refusing at the first running sum above the cap; decode concatenated chunks once with UTF-8 `TextDecoder` (null stream → `""`), store `rawBody`; empty text → `body` = `{}`; first non-whitespace (`\x20\x09\x0a\x0d`) character not `[`/`{` → `httpError("invalid-request", "the request body is not valid json")`; `JSON.parse` stores `body`, mapping only `SyntaxError` to the same refusal;
  - **CONFLICT NOTE — reader.cancel().** Story bullet 18 says "call `reader.cancel()` first, then throw". EPIC Decision 13 rule 3 says the opposite: "Do **not** call `reader.cancel()`", with the mechanism (`autoCleanupIncoming` drains the unread remainder) cited there. The authority chain ranks the EPIC above its stories, so the EPIC governs: **never cancel the reader**. The streamed-cap row pins `cancels() === 0`; implementing the story bullet verbatim fails that assertion.
  - Both refusals throw a plain `Error("request body exceeds the limit")` — never an `HttpError` — so `materializeError` maps them to the generic 500 envelope and `onInternalError` receives that exact `Error`;
  - per the story, your `app.ts` edit is limited to removing the `@koa/bodyparser` import, its registration, and `bodyParserForHandled`; Story 16 inserts `bodyMiddleware` at that site.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the gated body parse · Story 11 (`bodyMiddleware` + `BODY_LIMIT_BYTES`)

**Cycle.** GREEN for `src/http/server/body.test.ts` (`032/story-11`).

**Files changed.**

- `src/http/server/body.ts` (new) — `BODY_LIMIT_BYTES = 1_048_576`, `bodyMiddleware(handlers: Readonly<Record<string, Handler>>): MiddlewareHandler<AppEnv>`; private helpers `readBody` and `opensJsonObjectOrArray`.
- `src/http/server/app.ts` (edited) — deleted the `@koa/bodyparser` import, its `createApp` registration, and `bodyParserForHandled`, exactly the Story's scoped app.ts edit; removed the three imports that deletion orphaned (`Context, Next` koa types, `httpError`, `RoutedState`). Story 16 inserts `bodyMiddleware` at the removed site.

**Seam (GREEN).** The eight gates run in Decision 6 + 13 order: a non-POST/PUT/PATCH method awaits `next()` writing neither variable; `demand(c, "match")` then a stubbed operation or unbound handler awaits `next()` writing neither variable; the media type split before the first `;`, trimmed, lower-cased — absent or outside the six admitted types writes `body` = `{}` with `rawBody` absent; a decimal integer `content-length` above the cap throws plain `new Error("request body exceeds the limit")` before one pull; otherwise the middleware reads `c.req.raw.body` exactly once through its reader — summing `chunk.byteLength`, refusing at the first running sum above the cap without requesting another chunk — decodes the concatenated chunks once with a UTF-8 `TextDecoder` (null stream → `""`), and stores the exact text as `rawBody`; empty text stores `body` = `{}`; a first non-whitespace (`\x20\x09\x0a\x0d`) character that is neither `[` nor `{` throws `httpError("invalid-request", "the request body is not valid json")`; `JSON.parse` stores `body` and only `SyntaxError` maps to that same refusal.

**Refactor.** none named by the Story or the RED turn beyond the scoped app.ts removal, applied above. The `reader.cancel()` conflict is resolved as the RED turn adjudicated: EPIC Decision 13 rule 3 governs over Story bullet 18, so no cancel call exists anywhere in the module.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/body.ts src/http/server/app.ts`: exit 0

**Assumptions.**

- VERIFIED: the Story bullet "call `reader.cancel()` first, then throw" contradicts EPIC Decision 13 rule 3 ("Do **not** call `reader.cancel()`") and the RED turn's pinned `cancels() === 0`; the authority chain ranks the EPIC above its stories, so the module never cancels.
- VERIFIED: removing `bodyParserForHandled` leaves the real `createApp` chain without body parsing until Story 16 mounts `bodyMiddleware` at that site; the mid-batch reds stay exactly the `createTestApp` rows deferred to Story 16 since Stories 5–8.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the idempotency helpers on Fetch types · Story 12 (`readIdempotencyKey` + `StoredAnswer` + `answerBytes`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: FAIL — npm run typecheck exited 2`, whose ten errors sit exclusively in my own four test files — introduced by this turn's rewrite and enumerated under RED proof below; the software-engineer's handoff itself was clean (its turn recorded typecheck exit 0 and no production file changed since). Confirm GREEN for Story 11 (`032/story-11`): `node --test src/http/server/body.test.ts` → tests 13 / pass 13 / fail 0, exit 0. Then RED for Task `032/story-12` (`node --test` over the four idempotency suites).

**Test written.**

- file: `src/http/server/idempotency-key.test.ts` (edited — `readIdempotencyKey` fixtures rewritten onto Fetch `Headers`; `fingerprint`, `recordKey` and the vendor probe untouched) — suite: `src/http/server/idempotency-key.test` — methods preserved verbatim except the comma flip, two platform-normalization restatements and one new transport row: `no headers`, `unrelated header`, `canonical case`, `lower case`, `upper case`, `repeated header, same case`, `repeated header, different case, same value`, `empty value`, `interior space is legal`, `free-form importId with a space`, `leading space reaches the reader trimmed to a valid key`, `trailing space reaches the reader trimmed to a valid key`, `a single space trims to an empty value`, `interior tab character`, `non-ASCII character`, `single character`, `255 characters`, `256 characters`, `a ULID`, `a comma inside the value means the key was supplied more than once`, `the narrowest legal single characters`, plus `reads the joined duplicate value the way the transport delivers it`
- asserts: every grammar row drives a real `Headers` accumulator into `readIdempotencyKey`; a comma anywhere in the joined value returns `invalid` with the exact `Idempotency-Key was supplied more than once` message (Decision 11's deliberate narrowing — today's accepted `a,b` flips), physically duplicated headers arrive pre-joined `"a, b"` and refuse with that same message; absent/unrelated stay `absent`; interior space, ULID, 255-char, single-char and `!~` keys return `ok` verbatim; empty, interior-tab, non-ASCII and 256-char values keep the exact grammar-refusal message.
- file: `src/http/server/idempotency-response.test.ts` (edited — full rewrite around a Fetch `Headers` accumulator; Koa and `loopbackAgent` leave the file; `applyAnswer` describe deleted with the export) — suite: `src/http/server/idempotency-response.test` — methods: `lowers every name and joins duplicate values into one string`, `does not capture an untouched upstream header`, `captures a changed upstream header as one joined value`, `captures a merged upstream vary as one joined value`, `drops volatile header names and captures the rest`, `orders captured headers bytewise by lower-case name`, `stores one joined string for duplicate values, not an array`, `keeps the exact stored value of a numeric-looking header`, `status, the exact stored body and the content type survive capture`
- asserts: `headerSnapshot` reads lower-case names and one joined value per name from a `Headers`; `captureAnswer` skips untouched upstream names, captures changed ones, merges `Vary` as `Accept, Origin`, drops `content-length` while capturing the rest, orders tuples `["content-type","x-alpha","x-mike","x-zulu"]`, stores duplicates as the single string `"a, b"` (never an array — the Decision 7 shape pin), keeps numeric-looking values verbatim, and preserves status, the stored body by strict identity (`Uint8Array` reference) and the exact content-type string.
- file: `src/http/server/idempotency-store.test.ts` (edited — `makeAnswer` stores `JSON.stringify({ tag })`; the unmeasurable-cyclic-body row is replaced by a settlement-delta table; both size formulas updated; oversized bodies become direct strings) — suite unchanged — methods: reservation/joining/TTL/eviction/saturation/settlement-order rows preserved verbatim; added `settling a UTF-8 two-byte string body adds exactly 4 bytes`, `settling a three-byte Uint8Array body adds exactly 5 bytes`, `settling a null body adds exactly 2 bytes`; updated `bytes() grows on settle by exactly the serialized answer size`, `the byte bound evicts a completed record too`, `an answer too large to retain is not retained…`, `ten settles of a large answer under a small maxBytes stay within the bound`
- asserts: settlement on fresh stores adds exactly `Buffer.byteLength(body, "utf8")` (+2 serialized empty tuples) for `"é"` (4), `Uint8Array.from([0x00, 0x80, 0xff])` (5) and `null` (2) — Decision 7's byte rules, replacing arbitrary JSON serialization; the exact-size and eviction rows compute `storedBodyBytes(answer.body) + Buffer.byteLength(JSON.stringify(answer.headers))`; oversized answers carry `"x".repeat(4096)` / `"x".repeat(2048)` bodies.
- file: `src/http/server/render.test.ts` (edited — the local `stored()` fixture narrowed to `(readonly [string, string])[]` tuples and `string | Uint8Array | null` bodies; zero assertion lines changed) — conformer repair owed by this lane for the `StoredAnswer` narrowing (anti-pattern #2), written to compile against both today's and the Story 12 shape; its two replay rows go runtime-red against today's `render.ts` until this Task's conformer sweep retypes the replay write (see RED proof).

**RED proof.**

- command: `node --test src/http/server/idempotency-key.test.ts src/http/server/idempotency-record.test.ts src/http/server/idempotency-response.test.ts src/http/server/idempotency-store.test.ts`
- exit: 1 (tests 105 / pass 69 / fail 36; `idempotency-record.test.ts` fully green and untouched) — first failure verbatim:
  `✖ no headers` → `TypeError: Cannot read properties of undefined (reading 'length')` at `idempotency-key.ts:19:41`
  Three failure modes, all the missing-seam signature: every key row throws that TypeError (today's reader walks `source.rawHeaders`, absent on a `Headers`); every capture row throws inside `Object.entries(context.response.headers)` (today's helpers demand a Koa `Context`); the five accounting rows fail their deltas (6 ≠ 4, 25 ≠ 5, 6 ≠ 2, 19 ≠ 13, and the eviction row's tuned arithmetic) because today's `answerBytes` serializes string bodies instead of measuring them.
  Mid-batch disclosure: the narrowed render fixture turns `render.test.ts`'s two replay rows red (`a replay of a stored json string answers the exact status, bytes and content type through set`, `a replay of stored bytes answers the exact bytes`) — today's replay write calls `.join(", ")` on a value that is now a string. They join the recorded mid-batch set (route/authorize `createTestApp` rows) and are cleared by this Task's conformer sweep, not by reverting the fixture.
- stub probe: substituted Story-signature stubs for `idempotency-key.ts` (`readIdempotencyKey(headers: Headers): KeyRead`, `RawHeaderSource` deleted, everything else intact) and `idempotency-response.ts` (narrowed `StoredAnswer`, `headerSnapshot(Headers)`, `captureAnswer(Headers, …, body: string | Uint8Array | null)`, `applyAnswer` deleted): `npm run typecheck` reports ZERO errors across my four test files. Residuals confined to two production files: `src/http/server/idempotency.ts` ×5 (`TS2305` on the deleted `applyAnswer` import; `TS2345` at lines 44, 131, 135, 151) — Story 13's rewrite input, next dispatch — and `src/http/server/render.ts(59,34)` `TS2339: Property 'join' does not exist on type 'string'`. Stubs removed via `git checkout --`; `git status --porcelain`/`git diff` on both files are empty. Post-restore residual is exactly ten errors inside my own test files (`TS2345` Headers-vs-RawHeaderSource ×2, `TS2345` Headers-vs-Context ×3, `TS2367` value-comparison ×2, `TS18048`/`TS2339` in `storedBodyBytes` ×2, `TS2322` render fixture ×1), each cleared by the seam itself; eslint clean on all four edited tests.

**Open to Software Engineer.**

- Seam the test imports, per Story 12 (`.agents/plan/stories/032-the-hono-middleware-chain/12-idempotency-fetch-helpers.md`) exactly:
  - `src/http/server/idempotency-key.ts`: delete `RawHeaderSource`; `readIdempotencyKey(headers: Headers): KeyRead` reads `headers.get(IDEMPOTENCY_HEADER)` once — `null` → `absent`, a value containing `,` → `{ kind: "invalid", message: "Idempotency-Key was supplied more than once" }`, otherwise the existing length and printable-ASCII grammar byte-for-byte; keep `fingerprint` and `recordKey` unchanged.
  - `src/http/server/idempotency-response.ts`: drop the Koa import; keep `VOLATILE_HEADERS`; `StoredAnswer = Readonly<{ status: number; body: string | Uint8Array | null; headers: readonly (readonly [string, string])[] }>`; `headerSnapshot(accumulator: Headers): ReadonlyMap<string, string>` (lower-case names, joined values); `captureAnswer(accumulator: Headers, before, status, body)` captures only new or changed non-volatile names, one joined string per lower-case name, sorted with `compareBytewise`; delete `applyAnswer`.
  - `src/http/server/idempotency-store.ts`: `answerBytes` counts a string via `Buffer.byteLength(body, "utf8")`, a `Uint8Array` via `body.byteLength`, `null` as zero, then always adds `Buffer.byteLength(JSON.stringify(answer.headers), "utf8")`; remove the arbitrary serialization and its catch block.
  - Conformer sweep this seam forces: `src/http/server/render.ts`'s replay branch must write each stored header value directly — today's `.join(", ")` at line 59 no longer typechecks (probe-pinned). `idempotency.ts` goes type-red (×5 above) and stays so until Story 13 rewrites it; declare both as batch deferrals under the Stories 5–10 precedent — do not shim `idempotency.ts`.
  - Platform semantics probed on Node 24 before writing the fixtures: a Fetch `Headers` strips leading/trailing HTTP whitespace and joins duplicate values with `", "` — so edge-padded keys reach the reader already trimmed (those two grammar rows assert trimmed-to-valid outcomes), a lone space trims to the empty refusal, and a physically duplicated `Idempotency-Key` arrives pre-joined with a comma, which the comma rule refuses with today's exact message. Interior spaces, tabs, commas and non-ASCII survive verbatim.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the idempotency helpers on Fetch types · Story 12 (`readIdempotencyKey` + `StoredAnswer` + `answerBytes`)

**Cycle.** GREEN for the four idempotency suites (`032/story-12`).

**Files changed.**

- `src/http/server/idempotency-key.ts` (edited) — deleted `RawHeaderSource`; `readIdempotencyKey(headers: Headers): KeyRead` reads `headers.get(IDEMPOTENCY_HEADER)` once: `null` → `{ kind: "absent" }`, a value containing `,` → invalid with `Idempotency-Key was supplied more than once`, otherwise the unchanged length/printable-ASCII grammar; `fingerprint`, `recordKey` and both exported constants byte-for-byte unchanged.
- `src/http/server/idempotency-response.ts` (edited) — Koa import, `renderValue` and `applyAnswer` deleted; `StoredAnswer` narrowed to the exact Story shape (`body: string | Uint8Array | null`, `headers: readonly (readonly [string, string])[]`); `headerSnapshot(accumulator: Headers): ReadonlyMap<string, string>` walks `entries()` into lower-case names with joined values; `captureAnswer(accumulator, before, status, body)` captures only new-or-changed non-volatile names as one joined string per lower-case name, sorted with `compareBytewise`; `VOLATILE_HEADERS` untouched.
- `src/http/server/idempotency-store.ts` (edited) — private `storedBodyBytes(body)` (string → `Buffer.byteLength(body, "utf8")`, `null` → 0, `Uint8Array` → `byteLength`) plus `answerBytes = storedBodyBytes(body) + Buffer.byteLength(JSON.stringify(answer.headers), "utf8")`; the arbitrary body serialization and its catch block removed.
- `src/http/server/render.ts` (edited) — replay branch writes each stored tuple value directly (`headers.set(name, value)`, Decision 7's shape) instead of `.join(", ")`; the now-redundant body cast dropped. Conformer sweep forced by the narrowing — the RED probe pinned TS2339 at that exact site.

**Seam (GREEN).** The key reader now consumes a Fetch `Headers`: a physically duplicated header arrives pre-joined (`"a, b"`), so a comma anywhere means duplicate and refuses with today's exact message, while every grammar row keeps its byte-for-byte message; capture/snapshot read joined values off the accumulator so duplicate values store one string, never an array; settlement accounting measures exact body bytes plus the serialized tuples.

**Refactor.** none named by the Story or the RED turn beyond the render conformer sweep above, applied.

**Build check.**

- eslint on the four edited files: exit 0
- typecheck: FAIL — exactly ×5 errors, all in `src/http/server/idempotency.ts` (`TS2305` on the deleted `applyAnswer` import at :12; `TS2345` at :44, :131, :135, :151 where the still-Koa middleware passes `IncomingMessage`/`Context` where `Headers` is now required) — matching this Task's RED-turn stub probe error-for-error. Sanctioned batch deferral per that turn ("idempotency.ts goes type-red ×5 and stays so until Story 13 rewrites it; do not shim"); no shim applied.

**Open to Test Engineer.**

- OPEN: `src/http/server/idempotency-key.test.ts` — two table rows are unconstructible through their own builder loop: `repeated header, same case` and `repeated header, different case, same value` expect invalid-duplicate, but the loop seeds with `accumulator.set(name, value)` (line ~168), which collapses each pair into one valid value — probed on Node 24: set-twice reads back `"b"` / `"a"`, so my reader answers `{ kind: "ok", key }` against an expected refusal. No implementation of `readIdempotencyKey(Headers): KeyRead` can pass them while `canonical case` expects ok — the precondition cannot be expressed through `.set`. Fix (test lane): seed the loop with `accumulator.append(name, value)` instead of `.set` — append reproduces the transport-joined form (`"a, b"` / `"a, a"`), which the comma rule refuses with exactly those rows' expected messages, and every other row has at most one entry so append equals set for it. The dedicated `reads the joined duplicate value the way the transport delivers it` row already appends and passes as written.

**Assumptions.**

- VERIFIED: Node 24 `Headers.set` replaces (never joins) same-name values and `get` strips leading/trailing HTTP whitespace while keeping interior tabs — probed before implementing; the edge-trimmed grammar rows therefore pass via the unchanged `KEY_GRAMMAR`, and only a real comma signals duplication.
- VERIFIED at runtime against the pinned expectations: absent/ok/joined-dup/comma-single/trimmed reader rows; capture drops volatile `content-length`, skips untouched upstream names, merges two `Vary` appends into `"Accept, Origin"`, stores duplicates as `"a, b"`, orders bytewise (`["content-type","vary","x-alpha","x-mike","x-multi","x-zulu"]`); store deltas settle at exactly 4 / 5 / 2 bytes for `"é"` / 3-byte `Uint8Array` / `null`.
- VERIFIED: blast radius of the narrowing is exactly the four edited files plus `idempotency.ts` — `variables.ts` consumes `StoredAnswer` as a type only, and `event/wait.ts` / `app.ts` import store-level types this Task does not touch.

**Process note.** While journaling this turn I overwrote the append-only
`.agents/tdd/memory/software-engineer/2026-08-25.md` instead of appending. Repaired in the same
turn: committed bytes restored via `git show HEAD:` byte-exact, today's lost EPIC 032 entries for
Stories 1–11 rebuilt from this discussion history under an explicitly marked `[reconstructed]`
heading, and no snapshot existed to do better. The discussion file itself was never touched by that
mistake.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — idempotency on Hono · Story 13 (`createIdempotency` on `Context<AppEnv>`)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: FAIL — npm run typecheck exited 2`, whose errors sit verbatim where the software-engineer disclosed them — all five in `src/http/server/idempotency.ts` (`TS2305` on the deleted `applyAnswer` at :12; `TS2345` at :44, :131, :135, :151), the sanctioned batch deferral that this Task's rewrite owns; nothing undisclosed, so not a build-proof violation. Its `OPEN:` aimed at my lane — performed first: repaired `src/http/server/idempotency-key.test.ts`'s table builder loop from `accumulator.set(name, value)` to `accumulator.append(name, value)`, so `repeated header, same case` and `repeated header, different case, same value` now construct the transport-joined duplicate (`"a, b"` / `"a, a"`) their expected refusals assert; every other row holds at most one entry per name, where append equals set. Confirm GREEN for Story 12 (`032/story-12`): the unported `idempotency.ts` cannot load against the Story 12 shapes (it still imports the deleted export), so any suite whose graph reaches it dies at module instantiation — confirmed inside this Task's stub-probe window instead: `node --test src/http/server/idempotency-key.test.ts src/http/server/idempotency-record.test.ts src/http/server/idempotency-response.test.ts src/http/server/idempotency-store.test.ts src/http/server/render.test.ts` → tests 123 / pass 123 / fail 0, exit 0, including the two repaired duplicate-header rows and the narrowed render replay rows. Then RED for Task `032/story-13` (`node --test src/http/server/idempotency.test.ts`).

**Test written.**

- file: `src/http/server/idempotency.test.ts` (edited — full rewrite; test lane per Stories 5–14) — suite: `src/http/server/idempotency.test` — methods (49, all existing names preserved verbatim except the additions marked new): `runs the command once for two identical keyed POSTs, and both answers are byte-identical`, `answers 409 idempotency-mismatch when the same key carries a different body`, `answers 409 idempotency-mismatch when the same key carries a different query string`, `answers 409 idempotency-mismatch when the same key repeats with equal json but different whitespace` (new), `records two entries and runs both commands when one key is sent to two different operations`, `two actors with the same Idempotency-Key each run their own execution, byte-identical bodies`, `two actors with the same Idempotency-Key and different bodies each run their own execution`, `a slow first request does not make a second actor's request wait or answer 503`, `a replay of the same key by the same actor still returns the stored answer`, `runs the command once for two duplicates dispatched with no await between them`, `joins rather than erroring when a duplicate arrives while the first is in flight`, `does not cancel the original when a joined duplicate disconnects`, `does not cache a lease-held outcome, and a later request runs the command again`, `answers 503 on a join timeout, then replays for a request that arrives after the original completes`, `waits for the original with a zero join timeout`, `a joiner of a lease-held outcome receives it and does not run the command`, `marks the key indeterminate when a handler commits and then throws` (enhanced: also asserts one `onInternalError` callback carrying the exact thrown `Error`), `keeps a keyed serialization failure indeterminate: the same generic 500 replays, the handler runs once, one callback fires, one record remains` (new), `settles and replays a stored answer for an HttpError whose status the operation declares replayable` (new), `stores and replays the exact json text, status and content type` (new), `stores and replays a byte-exact Uint8Array body with the operation media type` (new), `stores and replays a null body for an empty 204 answer` (new), `serializes a stateful toJSON result exactly once across a keyed replay` (new), `answers 400 invalid-request when the key arrives twice, and the command never runs`, `answers 400 invalid-request for a 256-character key, and the command never runs`, `answers 400 invalid-request for a key carrying a tab, and the command never runs`, `accepts a key with an interior space`, `runs the command every time for a POST with no key`, `ignores a key on a GET without caching`, `answers 400 for a GET carrying a malformed key`, `an in-flight reservation survives a TTL sweep at the app level`, `the TTL starts at completion at the app level`, `a completed record expires after its TTL`, `answers 503 at the entry bound, with the first request untouched`, `a saturated request may retry once capacity frees`, `does not report saturation as an internal fault`, `a zero TTL disables the memory policy`, `a zero TTL still validates the key`, plus the eleven durable-policy cases preserved verbatim (`reaches the command when the header equals importId…`, `reaches the command again on an identical repeat…`, `plan.import under two actors with the same importId collapses to one import and reserves nothing`, `answers 400 invalid-request when the header differs from importId`, `…no importId…`, `…non-object…`, `…numeric importId…`, `reaches the command untouched with no header`, `answers 400 for a malformed header before the importId comparison`, `reaches the command both times on a reordered documents array…`, `a zero join timeout does not disable the importId rule`)
- asserts: exactly the Story 13 fixture over every preserved case — `new Hono<AppEnv>()` whose `onError` runs `errorValue` → `materializeError` → injectable `onInternalError` only when `materialized.internal`, then `errorResponse(materialized, demand(c, "headers"))`; mount order `headersMiddleware()` → `renderMiddleware()` → `routeMiddleware()` → optional match-override stage → `bodyMiddleware(bound)` → actor-seeding stage → the idempotency middleware through `hono.use("*", ...)`, terminal `hono.all("*", ...)` counting calls and writing `result`; driven through `loopbackAgent(koaFromHono(hono))`. Every supertest assertion keeps its exact status, envelope code and message text. New coverage per the story: equal-json/different-whitespace bodies produce two fingerprints observed through the 409 mismatch; a keyed replay returns the exact stored json text, bytes and content type (`{"ok":true}`, `application/json; charset=utf-8`), an exact `Uint8Array` body (`00 80 ff`) with the override-supplied media type, and a null-body 204 with no content type; a stateful `toJSON` serializes exactly once across first and replay; an `HttpError` whose status the operation declares replayable settles retained and replays the stored status and body with one handler call; a keyed serialization failure stays indeterminate — same generic 500 text and exact content type on replay, handler once, callback once with the `TypeError`, record retained; the enhanced indeterminate case adds the one-callback assertion. The durable two-actors case now drives `importPlanHandler` directly from the terminal and sets `result`, keeping all assertion lines byte-for-byte. The slow-second-actor case replaces its wall-clock watchdog with a bounded `setImmediate` tick poll (no wall clock in any changed fixture). Handlers read state only through `demand`/`optional`; the raw duplicate-header request stays at socket level over `loopbackServer(app)`.

**RED proof.**

- command: `node --test src/http/server/idempotency.test.ts`
- exit: 1 (tests 1 / pass 0 / fail 1) — failure verbatim:
  `SyntaxError: The requested module './idempotency-response.ts' does not provide an export named 'applyAnswer'` at `src/http/server/idempotency.ts:12`
  The failure mode is the right one: the module under rewrite cannot load against the Story 12 shapes it must consume — it still imports the deleted `applyAnswer` and passes Koa `Context`/`IncomingMessage` into the Fetch-typed helpers — so instantiation fails before any case runs.
- stub probe: substituted a temporary Story-signature stub at `src/http/server/idempotency.ts` (`createIdempotency(dependencies): { middleware: MiddlewareHandler<AppEnv>; store }`, throwing body): `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`. The probe caught one real defect in my own file pre-handoff — the fixture's actor-seeding stage passed `resolveActor`'s possible `null` into the typed `actor` variable (`TS2769`) — fixed in-lane by mirroring `authMiddleware`'s `unauthenticated` refusal, after which the probe reports fully clean. With the stub still present: `node --test src/http/server/idempotency.test.ts` → tests 49 / pass 0 / fail 49, every failure `Error: stub` — uniform sensitivity, no independent crash in the harness. Stub removed via `git checkout -- src/http/server/idempotency.ts`; porcelain on it empty. eslint on both edited test files: exit 0.
- Transient blast radius until this story's GREEN: twelve suites reach `idempotency.ts` through their import graph (`app.test.ts`, the four parity files, `auth/route/authorize/dispatch/idempotency-key/idempotency/start` tests) and fail at load with the same SyntaxError — the runtime face of the sanctioned ×5 deferral; the rewrite deletes that import and clears all twelve at once.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/idempotency.ts`, per Story 13 (`.agents/plan/stories/032-the-hono-middleware-chain/13-idempotency-middleware.md`) and Decisions 7, 10, 11 exactly:
  - keep `IdempotencyDependencies` (`settings`, `now`, `schedule`) and the `createIdempotency` return contract `{ middleware: MiddlewareHandler<AppEnv>; store: IdempotencyStore }`;
  - branch order preserved: validate the key first (`readIdempotencyKey(c.req.raw.headers)`; invalid → exact `invalid-request` refusal), then absent-key `next()`, then `idempotencyOf(demand(c, "match").operation)` — `none` → `next()`; `durable` → read `importId` from `optional(c, "body")` with today's strict-equality rule and message, then `next()`; then the zero-TTL bypass;
  - memory path: fingerprint from `c.req.method`, `new URL(c.req.url).pathname`, `new URL(c.req.url).search.slice(1)`, `optional(c, "rawBody") ?? ""`; `recordKey` fields from `demand(c, "match")` and `demand(c, "actor")`; `saturated`/`mismatch` refusals byte-for-byte;
  - `replay` and `joined`: write the exact `StoredAnswer` into the `replay` variable and return — construct no response anywhere in this middleware; a joined timeout keeps its exact 503 refusal;
  - reserved: take `headerSnapshot(demand(c, "headers"))` immediately before `await next()` with **no wrapping try/catch**; afterwards, if `c.error` is defined: unwrap with `errorValue`, `materializeError`, serialize the envelope body once with `JSON.stringify`, `captureAnswer(accumulator, before, status, serialized)`, settle with `classifyOutcome({ replayable, status, internal })`, return; otherwise `demand(c, "result")` and enter a `try` covering only `materializeResult(result, match.operation, accumulator)` — success captures the exact materialized body, settles with `internal: false`, and writes the captured answer into `replay`; a materialization throw preserves the original failure, unwraps it only for `materializeError`, sets `content-type: application/json; charset=utf-8` when absent, serializes and captures the envelope once, settles with the materialized status and `internal` flag, and rethrows the original;
  - constraints: never observe a downstream error through a catch around `next()` (`c.error` is the only channel), never produce an envelope response here, serialize each stored answer exactly once, delete the old downstream try/catch and every `applyAnswer` reference; `IdempotencyStore`, `classifyOutcome`, settings and the injected `now`/`schedule` stay untouched.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — idempotency on Hono · Story 13 (`createIdempotency` on `Context<AppEnv>`)

**Cycle.** GREEN for `src/http/server/idempotency.test.ts` (`032/story-13`).

**Files changed.**

- `src/http/server/idempotency.ts` (edited) — `createIdempotency(dependencies): { middleware: MiddlewareHandler<AppEnv>; store }` rewritten against Hono's `Context<AppEnv>`/`Next`; `IdempotencyDependencies` unchanged; Koa imports and the `AuthenticatedState`/`RoutedState` imports deleted.

**Seam (GREEN).** Branch order preserved exactly as the RED turn states it: key validation first (`readIdempotencyKey(c.req.raw.headers)`; invalid → exact `invalid-request` refusal), absent-key `next()`, then `idempotencyOf(demand(c, "match").operation)` — `none` → `next()`; `durable` reads `importId` through `optional(c, "body")` with the unchanged strict-equality rule and message, then `next()`; then the zero-TTL bypass. The memory path fingerprints `c.req.method`, `new URL(c.req.url).pathname`, `.search.slice(1)`, `optional(c, "rawBody") ?? ""`; `recordKey` draws from `demand(c, "match")` and `demand(c, "actor")`; `saturated`/`mismatch`/timeout refusals are byte-for-byte. A `replay` or joined answer writes the exact `StoredAnswer` into the `replay` variable and returns — no response constructed anywhere in this module. A reserved request takes `headerSnapshot(demand(c, "headers"))` immediately before a bare `await next()` with no wrapping try/catch; afterwards a defined `c.error` unwraps through `errorValue`, materializes, serializes the envelope once, captures, settles with the materialized status and `internal` flag, and returns; otherwise `demand(c, "result")` enters a try covering only `materializeResult(result, match.operation, headers)` — success settles with `internal: false` and writes the captured answer into `replay`; a materialization throw sets `content-type: application/json; charset=utf-8` when absent, serializes and captures the envelope once, settles with the materialized status and internal flag, and rethrows the original failure untouched.

**Refactor.** applied: the downstream `try/catch` at the old lines 132–165 is deleted (Decision 2 makes it dead) and every `applyAnswer` reference leaves the tree — grep confirms zero remain under `src/`. The two state-type imports go with it; `AuthenticatedState`/`RoutedState` stay exported in `auth.ts`/`route.ts` for their surviving importers (`dispatch.ts` — Story 14, `dispatch.test.ts` — test lane).

**Build check.**

- typecheck: exit 0 — the sanctioned ×5 batch deferral clears with this rewrite
- eslint `src/http/server/idempotency.ts`: exit 0
- module-load probe (`node --input-type=module -e "… await import('./src/http/server/idempotency.ts') …"`): loaded true, middleware arity 2, exit 0 — this is the load face of the twelve-suite SyntaxError blast radius the RED turn recorded; the rewrite clears it at module instantiation

**Assumptions.**

- VERIFIED: the local materialization catch calls `materializeError(failure)` on the raw caught value without an `errorValue` unwrap — EPIC Decision 10's third bullet names only "call `materializeError`" for that branch, and every value `materializeResult` can throw is an `Error` (the stringify `TypeError`, the `HttpError` media refusals), so the unwrap would be inert; `errorValue` is applied on the post-`next()` branch where the RED turn pins it (`errorValue(c.error)`, typed `Error | undefined`).
- VERIFIED: no runtime import cycle — `idempotency.ts` now value-imports `render.ts` while `app.ts` value-imports `idempotency.ts`, but `render.ts` touches `app.ts` type-only (erased under `verbatimModuleSyntax`); the module-load probe instantiates the store and middleware cleanly.
- VERIFIED: demanding `match` after the absent-key branch (today's file read it at entry) is observationally identical — `routeMiddleware` always writes `match` before any downstream frame runs, and a routing failure stops the chain upstream of this middleware.
- KNOWN RED (batch deferral, recorded since Stories 5–8): the `createTestApp` rows of route/authorize/app and the four parity suites stay red until Story 16 rewires `createApp` onto the full Hono chain behind `koaFromHono`. This Task's fixture cases are the ones the rewrite greens.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — dispatch on Hono · Story 14 (`dispatchMiddleware` rewrite)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 13 (`032/story-13`): `node --test src/http/server/idempotency.test.ts` → tests 49 / pass 49 / fail 0, exit 0. Then RED for Task `032/story-14` (`node --test src/http/server/dispatch.test.ts`).

**Test written.**

- file: `src/http/server/dispatch.test.ts` (edited — direct-fixture rewrite; test lane per Stories 5–13) — suite: `src/http/server/dispatch.test`. Rewritten onto Hono fixtures: `a stubbed route never reaches a handler bound anyway`, `a handler receives context.actor equal to the actor on the actor variable` (stale-mechanism rename of "…on context.state", zero assertion lines changed, per the auth-suite precedent), `a handler's headers are accumulated in bytewise order regardless of insertion order` (restated per Decision 16), `an empty result answers 204 with zero body bytes and no content-type or content-length header`, `an empty result answers 304 …`, `a bytes result for an operation with no responseMedia answers the internal-error envelope naming the operation id`; added: `a handler that throws a string answers the generic 500 envelope and reports the exact thrown value`, `a handler that throws undefined answers the generic 500 envelope and reports the exact thrown value`. All `createTestApp` HTTP rows, both witness/write-count rows and all six `createApp` BindingError rows stay byte-for-byte.
- asserts: every rewritten case drives `honoDispatchApp(handlers, { onInternalError, observe })` — a `new Hono<AppEnv>()` whose `onError` runs `errorValue` → `materializeError` → the injectable callback only when `materialized.internal`, then `errorResponse(materialized, demand(c, "headers"))`; mount order through `hono.use("*", …)`: `headersMiddleware()` → `renderMiddleware()` → an accumulator observer stage (post-`next`, before render resumes) → actor seed (`BOOTSTRAP_ACTOR_FIXTURE`) → `routeMiddleware()`, with `dispatchMiddleware({ handlers })` as the sole `hono.all("*", …)` terminal; driven through `loopbackAgent(koaFromHono(hono))`, the raw-header rows through `loopbackServer(koaFromHono(hono))`. The match variable comes from the real `routeMiddleware()` exactly as both prior direct fixtures did (the story's "seeding middleware" wording read as: whatever stages each case names set its variables; no rewritten case names a seeded body, so `body` stays absent); the actor-identity case keeps the production `authMiddleware` + recorder stage in place of its old Koa state read. The restated header-order row appends source names `X_c`, `X-a`, `X-B`, then late `X-A` and asserts accumulator entries `[["x-a","upper-A, lower-a"],["x-b","b"],["x_c","underscore"]]` — values and duplicate-join semantics, not wire order; the late `X-A` sorting bytewise before `X-a` makes the assertion fail if dispatch skips `compareBytewise`. Each non-`Error` table row asserts exact 500, the exact generic envelope `{ error: { code: "internal-error", message: "internal error" } }`, one `onInternalError` call, and strict equality with `"failure"` / `undefined`.

**RED proof.**

- command: `node --test src/http/server/dispatch.test.ts`
- exit: 1 (tests 34 / pass 6 / fail 28) — first fixture failure verbatim:
  `✖ a stubbed route never reaches a handler bound anyway` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `500 !== 501`
  The six passing rows are exactly the construction-only `createApp` BindingError cases. Every fixture failure carries the missing-seam signature verbatim — today's Koa middleware reads `context.state`, undefined on Hono's `Context<AppEnv>`, so each request throws `TypeError: Cannot read properties of undefined (reading 'match')` at dispatch's frame and `onError` answers the generic 500; the two new table rows fail their positive discriminator (`actual: TypeError … expected: "failure"` / `undefined`), so the strict-value assertions are sensitive, while their status/envelope halves hold vacuously against that same 500. The remaining 20 failures are byte-for-byte the pre-existing mid-batch `createTestApp` reds recorded since Stories 5–8 (the real chain still mounts Hono middlewares into Koa, signature `c.req.header is not a function`) — Story 16 restores them.
- guard command per the story's Verify section: `node --test src/http/server/dispatch.test.ts src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/invalid-request.test.ts` → tests 52 / pass 24 / fail 28 — query/single/invalid-request fully green (18/18), unchanged and untouched.
- stub probe: `src/http/server/dispatch.ts` (module exists with the old Koa signature; probe substituted a temporary Story-signature stub typed `(dependencies: DispatchDependencies): MiddlewareHandler<AppEnv>`): `npm run typecheck` fully clean across the tree — exit 0 — proving `app.ts`'s mount stays bivariant-clean and authorize.test's double assertions hold, as in Stories 6–10. Stub removed and the original restored byte-exact (`git status --porcelain`/`git diff` on the file are empty). Residuals at handoff are exactly two errors inside my own file — `dispatch.test.ts(122,17)` and `(355,7)` TS2769, the still-Koa `dispatchMiddleware` rejected by `hono.all("*", …)` — cleared as a side effect of the seam rewrite. eslint on the rewritten test: exit 0.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/dispatch.ts`, per Story 14 (`.agents/plan/stories/032-the-hono-middleware-chain/14-dispatch-middleware.md`) and Decisions 16–17 exactly:
  - keep `DispatchDependencies` and private `readHeaders`;
  - `export function dispatchMiddleware(dependencies: DispatchDependencies): MiddlewareHandler<AppEnv>` — demand `match` first; a stubbed operation throws `httpError("not-implemented", \`${operationId} ships in ${introducedIn}\`)`; a routed operation without a bound handler throws `httpError("not-implemented", \`${operationId} is not implemented yet\`)`;
  - build `HandlerContext` from the matched operation and parameters, `readQuery(new URL(c.req.url).search.slice(1))`, `readHeaders(c.req.raw.headers)` — retype `readHeaders(headers: Headers)`, keep only its `compareBytewise` key order, drop the array-joining branch — plus `optional(c, "body")` and demanded `actor`;
  - wrap **only** the handler invocation in try/catch: rethrow an `Error` unchanged, otherwise throw `new ThrownValueError(value)`;
  - after the handler returns, demand the accumulator, sort `Object.keys(result.headers ?? {})` with `compareBytewise`, and append each source value in that order so case-different duplicate names join source-first;
  - store the exact handler result as `result` and return — write no status, no body, no `c.res`, no `Response`, materialize nothing (the bytes-without-media refusal comes from `materializeResult` via render);
  - notes: deleting this module's `AuthenticatedState`/`RoutedState` imports leaves those types' last importers at `auth.ts`/`route.ts` themselves (batch-close deletion per the standing deferral precedent); `dispatch.ts` is today the sole value importer of `koa-body.ts`, so this rewrite orphans it and Story 16 deletes it per the EPIC.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — dispatch on Hono · Story 14 (`dispatchMiddleware` rewrite)

**Cycle.** GREEN for `src/http/server/dispatch.test.ts` (`032/story-14`).

**Files changed.**

- `src/http/server/dispatch.ts` (edited) — `dispatchMiddleware(dependencies: DispatchDependencies): MiddlewareHandler<AppEnv>` rewritten against Hono's `Context<AppEnv>`; `readHeaders(headers: Headers)` retyped; private `DispatchDependencies` unchanged; Koa type imports and the `AuthenticatedState`/`RoutedState`/`koaBody` imports deleted.

**Seam (GREEN).** Demands `match` first; a stubbed operation throws `httpError("not-implemented", \`${operationId} ships in ${introducedIn}\`)`and an unbound routed operation throws`httpError("not-implemented", \`${operationId} is not implemented yet\`)`— both before any handler lookup runs. Builds the`HandlerContext`from the exact matched operation and parameters,`readQuery(new URL(c.req.url).search.slice(1))`, `readHeaders(c.req.raw.headers)`, `optional(c, "body")`and demanded`actor`. Wraps **only** the handler invocation in try/catch: an `Error`rethrows unchanged, any other value throws`new ThrownValueError(value)`. After the handler returns it demands the accumulator, sorts `Object.keys(result.headers ?? {})`with`compareBytewise`, and appends each source value in that order (case-different duplicate names join source-first); then stores the exact handler result as `result`via`c.set`and returns — no status, no body, no`c.res`, no `Response`, no materialization (the bytes-without-media refusal stays with `materializeResult`via render).`readHeaders`keeps only its`compareBytewise`key order over the Fetch`Headers` entries; the array-joining branch is gone.

**Refactor.** applied: this module's `AuthenticatedState`/`RoutedState` imports are deleted with the rewrite, leaving those two types' last production references at their declaration sites (`auth.ts:31`, `route.ts:8` — grep confirms zero importers), so their batch-close deletion lands with Story 16 per the standing deferral precedent. The rewrite also removes `koa-body.ts`'s last value importer; Story 16 deletes that file per the EPIC.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/dispatch.ts`: exit 0
- module-load probe: `dispatch.ts` instantiates clean (exit 0)
- running-app smoke (production modules through a Hono app, no test runner): json result answers 200 with accumulator entries exactly `[["x-a","upper-A, lower-a"],["x-b","b"],["x_c","underscore"]]`; stubbed POST answers 501 `node.abandon ships in phase-2`; a handler throwing `"failure"` answers the generic 500 envelope with exactly one callback carrying `"failure"` by strict identity.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — createApp returns both apps · Story 16 (`createApp` rewrite + app.test.ts)

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 14 (`032/story-14`): `node --test src/http/server/dispatch.test.ts` → tests 34 / pass 14 / fail 0 within its fixture scope — the 14 passes cover every rewritten dispatch fixture row including both new non-`Error` table cases; the 20 failures are byte-for-byte the pre-existing mid-batch `createTestApp` rows its RED turn deferred to this story ("Story 16 restores them"), each dying at the real chain's generic 500. Then RED for Task `032/story-16` (`node --test src/http/server/app.test.ts`) — the final Task of the epic.

**Test written.**

- file: `src/http/server/app.test.ts` (edited — full rewrite; test lane) — suite: `src/http/server/app.test` — methods (33): `the handler status set and the bodyless status set are the exact closed lists`, `the browser defences apply to system.health like every route`, `system.health requires the bearer token like every other route`, `origin-forbidden wins over host-forbidden`, `a browser check wins over the token`, `401 wins over 404`, `every path answers identically without a token`, `the token wins over 501`, `a clean request reaches the handler`, `a body is parsed only after every check`, `with an allowed origin, an unauthenticated request still carries the header`, `with an allowed origin, a valid token and host reaches the route and carries the header`, `Host beats preflight: an OPTIONS with an allowed origin but a disallowed Host answers 403 host-forbidden`, `Origin beats host: an OPTIONS with a disallowed origin and a disallowed Host answers 403 origin-forbidden with no allow-origin header`, `preflight beats auth: an OPTIONS with an allowed origin and host, no Authorization, answers 204 without resolving an actor`, `preflight beats route: an OPTIONS to a non-existent path answers the identical 204 headers as an OPTIONS to a real path, without resolving an actor`, `auth still beats route for a non-preflight: a GET with an allowed origin and host, no token, answers 401 and carries the origin header`, `an OPTIONS with no Origin is not a preflight: it falls through to a 404 not-found`, `the empty-list table: a routed route, a stubbed route and system.health each answer origin-forbidden for a disallowed or null Origin, and their own explicit status with no Origin and no allow-origin header`, `with an allowed origin, a valid token and host, a GET /v1/blob/:hash carries the exact expose-headers value`, `with the default empty allowedOrigins and no Origin header, a GET /v1/blob/:hash carries no expose-headers value`, `a full-chain authentication failure carries access-control-allow-origin and exactly vary: origin` (new), `a full-chain routing failure carries access-control-allow-origin and exactly vary: origin` (new), `a full-chain handler Error carries the cors headers, answers the exact generic 500 envelope and reports once` (new), `a keyed full-chain handler Error still reports exactly once` (new), `a full-chain handler that throws a string answers the generic 500 envelope and reports the exact value` (new), `a full-chain handler that throws undefined answers the generic 500 envelope and reports the exact value` (new), `an http/1.0 request with no Host header answers the exact host-forbidden message through the bridge, not a bare 400` (new), `app.proxy stays false on the app createApp returns`, `createApp returns both applications and a cancel handle, and the handle reaches the registry` (restated keys assertion), `binding system.health and system.db leaves forty-two unimplemented ids`, `createApp throws the exact binding error before reading settings, idempotency, now or schedule` (new), `production sources keep header writes in the accumulator and koa values only in the bridge` (new)
- asserts: every preserved order/response assertion keeps its exact status, envelope code and message text over the real chain through the unchanged `createTestApp`; the two preflight rows add counting `resolveActor` overrides asserted at zero resolutions (bypass mechanism); the six new full-chain rows send `Origin: http://localhost:8080` under `allowedOrigins: ["http://localhost:8080"]` and assert `access-control-allow-origin: http://localhost:8080` plus exactly `vary: Origin` on an authentication failure, a routing failure and a plain handler `Error`, the handler `Error` also answering the exact generic 500 envelope `{ error: { code: "internal-error", message: "internal error" } }` with exactly one `onInternalError` call carrying that `Error` by strict identity — repeated under an `Idempotency-Key` on `POST /v1/project` with one callback — and the string/undefined table rows asserting the same envelope with one callback each holding `"failure"` / `undefined` strictly; the raw row drives a real `GET /v1/status HTTP/1.0\r\n\r\n` socket with no Host through `loopbackServer(created.app)` and asserts 403 with the exact `host-forbidden` / `the request carried no Host header` envelope; the keys row asserts `Object.keys(createApp(...)).sort()` equals `["app", "cancelWaits", "hono"]`; the binding-first row builds throwing getters for `settings`, `idempotency`, `now` and `schedule` under an incomplete binding and asserts the exact `incomplete transport binding: ${routedIds.join(", ")} ` `BindingError` with zero reads of all four getters; the source-scan row reads production `src/http/server/**/*.ts` (tests excluded) and asserts empty offender lists for bare `c.get(` outside `variables.ts`, `c.header(` anywhere and `c.res\s*=` anywhere, plus the exact koa value-import list `["src/http/server/koa-bridge.ts"]`. The four parity files, `start.ts`, `test/helpers/app.ts` and `test/helpers/agent.ts` are untouched by this edit.

**RED proof.**

- command: `node --test src/http/server/app.test.ts`
- exit: 1 (tests 33 / pass 5 / fail 28) — first failure verbatim:
  `✖ the browser defences apply to system.health like every route` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `500 !== 200` (at `app.test.ts:79`)
  The five passing rows are construction-only or pure characterizations: the closed-lists row, the vacuous absence-only blob row, `app.proxy stays false`, the forty-two-unimplemented count, and the new binding-first row — which pins shipped behavior deliberately (today's `createApp` already runs `bindingOffenders` first, and the story requires that order to survive the rewrite). Every HTTP row fails with the missing-seam signature: the real chain mounts Hono-native middlewares into a Koa app, each request throws inside them, and the retained Koa `envelopeMiddleware` answers the generic internal-error 500. Two structural rows fail independently of the chain: the keys row gets `["app","cancelWaits"] !== ["app","cancelWaits","hono"]`, and the scan row fails its koa-import assertion verbatim — `actual: [ 'src/http/server/app.ts', 'src/http/server/koa-bridge.ts' ]`, `expected: [ 'src/http/server/koa-bridge.ts' ]` — because today's `app.ts` still value-imports koa.
- stub probe: n/a — the rewrite names only exports that already exist (`createApp`, `BindingError`, `TransportSettings`, `Handler`); `npm run typecheck` is fully clean across the tree with zero TS2307, so nothing is masked and no probe applies. eslint on the rewritten test: exit 0.

**Open to Software Engineer.**

- Seam the test imports: `src/http/server/app.ts`, per Story 16 (`.agents/plan/stories/032-the-hono-middleware-chain/16-create-app-composition.md`) and the EPIC Goal table exactly:
  - keep `TransportSettings`, `HandlerContext`, every EPIC 031 result type and `handlerStatuses`/`bodylessStatuses`, `Handler`, `AppDependencies`, `systemSchedule` (with `setTimeout(...).unref()`), `BindingError`, `unimplementedFor`, `bindingOffenders`;
  - `App = Readonly<{ app: Koa; hono: Hono<AppEnv>; cancelWaits: () => void }>`; `createApp` returns `{ app, hono, cancelWaits: () => dependencies.waits.cancelAll() }` with `app` built only by `koaFromHono(hono)` — the returned key set must sort to `["app", "cancelWaits", "hono"]`;
  - `bindingOffenders` first — throw the unchanged `BindingError` message before any Hono/Koa/idempotency construction and before any read of `settings`, `idempotency`, `now` or `schedule`;
  - construct one `Hono<AppEnv>`; set `hono.onError((error, c) => ...)`: call `errorValue(error)`, `materializeError(value)`, call `dependencies.onInternalError(value)` exactly once only when `materialized.internal` is true, return `errorResponse(materialized, demand(c, "headers"))`;
  - mount through `hono.use("*", ...)` in exactly this order: `headersMiddleware()`, `renderMiddleware()`, `originMiddleware({ allowedOrigins })`, `hostMiddleware({ allowedHosts })`, `preflightMiddleware()`, `authMiddleware({ token, resolveActor })`, `routeMiddleware()`, `authorizeMiddleware()`, `bodyMiddleware(dependencies.handlers)`, the idempotency middleware built with the three current arguments (`dependencies.idempotency ?? defaultIdempotencySettings`, `dependencies.now ?? (() => Date.now())`, `dependencies.schedule ?? systemSchedule`); `dispatchMiddleware({ handlers })` is the sole `hono.all("*", ...)` terminal;
  - delete `src/http/server/koa-body.ts` (no caller remains) and make `app.ts`'s koa import type-only — the scan row demands the koa value-import list be exactly `["src/http/server/koa-bridge.ts"]`;
  - batch-close deletions this rewrite completes: `envelopeMiddleware`/`EnvelopeDependencies` leave `src/http/server/envelope.ts` (this file is their last importer) and `AuthenticatedState`/`RoutedState` leave `auth.ts`/`route.ts` (their last importer went with Story 14);
  - do not touch `start.ts`, `main.ts`, `test/helpers/app.ts`, `test/helpers/agent.ts`, or any of the four parity files; keep `Koa`/`@koa/bodyparser` packages in the manifest.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — createApp returns both apps · Story 16 (`createApp` rewrite)

**Cycle.** GREEN for `src/http/server/app.test.ts` (`032/story-16`) — the final Task of EPIC 032.

**Files changed.**

- `src/http/server/app.ts` (edited) — `App = Readonly<{ app: Koa; hono: Hono<AppEnv>; cancelWaits: () => void }>`; `createApp` rewritten onto one `Hono<AppEnv>`; kept `TransportSettings`, `HandlerContext`, every EPIC 031 result type, `handlerStatuses`/`bodylessStatuses`, `Handler`, `AppDependencies`, `systemSchedule` (with `setTimeout(...).unref()`), `BindingError`, `unimplementedFor`, `bindingOffenders`; koa import is now type-only.
- `src/http/server/envelope.ts` (edited) — deleted `EnvelopeDependencies`, `envelopeMiddleware` and the koa type import; `materializeError`, `Materialized`, `errorResponse`, `ThrownValueError`, `errorValue` untouched.
- `src/http/server/auth.ts` (edited) — deleted `AuthenticatedState`.
- `src/http/server/route.ts` (edited) — deleted `RoutedState` and its now-orphaned `RouteMatch` type import.
- `src/http/server/koa-body.ts` (deleted) — no caller remains since Story 14 removed its last value import.

**Seam (GREEN).** `createApp` runs `bindingOffenders` first and throws the unchanged `BindingError` before any construction or getter read; then builds one `Hono<AppEnv>`, sets `hono.onError` (`errorValue(error)` → `materializeError(value)` → `dependencies.onInternalError(value)` exactly once only when `materialized.internal` → `errorResponse(materialized, demand(c, "headers"))`), mounts through `hono.use("*", ...)` in the exact Goal-table order — headers, render, origin, host, preflight, auth, route, authorize, body, idempotency (three current default arguments) — with `dispatchMiddleware({ handlers })` as the sole `hono.all("*", ...)` terminal, builds `app` only with `koaFromHono(hono)`, and returns `{ app, hono, cancelWaits: () => dependencies.waits.cancelAll() }` — key set sorts to `["app", "cancelWaits", "hono"]`.

**Refactor.** applied: the batch-close deletions named by this Task's RED turn — `envelopeMiddleware`/`EnvelopeDependencies` leave `envelope.ts` (this rewrite was their last importer), `AuthenticatedState`/`RoutedState` leave `auth.ts`/`route.ts` (Story 14 took their last importer), and `koa-body.ts` is deleted (grep confirms zero references outside `bytewise.test.ts`'s path-string filter, which tolerates the absence). Grep confirms zero remaining references to every deleted symbol under `src/`.

**Build check.**

- typecheck: exit 0
- eslint `src/http/server/app.ts src/http/server/envelope.ts src/http/server/auth.ts src/http/server/route.ts`: exit 0
- running-app smoke (production modules through `created.hono.request`, no test runner): key set sorts exactly `["app","cancelWaits","hono"]`; a clean keyed GET answers 200 `{ok:true}` with `access-control-allow-origin` and exactly `vary: Origin`; a tokenless GET answers 401 `unauthenticated` still carrying the origin header; a handler throwing an `Error` answers the exact generic 500 envelope with exactly one callback holding that `Error` by identity; a handler throwing `"failure"` answers the same envelope with one callback holding `"failure"` strictly.

**Open to Test Engineer.**

- none in code. One human-owned follow-up recorded in the EPIC's open items (S5): `eslint.config.js` still lists the now-deleted `src/http/server/koa-body.ts` in the `ignores` array of its `src/http/server/**/*.ts` block. Harmless today (lint is green), but every `*.config.*` path is denied to every agent lane (`scripts/lane-check.sh:47-49`), so the entry needs a human edit.

**Assumptions.**

- VERIFIED: undici's `Request` built from a URL never materializes a `Host` header, so `c.req.header("host")` reads undefined under `hono.request(url)` even when the URL carries an authority — probed live (first smoke attempt answered `host-forbidden`); over a real socket the bridge delivers the client's Host byte-exactly, which is what `koa-bridge.test.ts` case 6 and `app.test.ts`'s raw HTTP/1.0 row pin. The smoke therefore sets `host` explicitly.
- VERIFIED: deleting `koa-body.ts` keeps `bytewise.test.ts` green — its `node:buffer` scan filters the path out before reading, and a filter over a non-existent path excludes nothing extra.
- UNVERIFIED: `npm run verify` and the full Proof command — test execution is the test-engineer's gate; the mid-batch reds this batch owed (the `createTestApp` rows of route/authorize/dispatch/app plus the four parity suites) are expected to clear with this rewrite, and the Proof decides.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Handoff gate first: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for Story 16 (`032/story-16`, the final Task): `node --test src/http/server/app.test.ts` → tests 33 / pass 33 / fail 0, exit 0. All sixteen Tasks stand confirmed green, so the full Verification Gate runs below — both parts.

**EPIC verification gate.**

- Parity immutability (hermetic-coverage precondition): `git diff --stat HEAD -- src/http/server/app.handler-result.test.ts src/http/server/app.parity-body.test.ts src/http/server/app.parity-cors.test.ts src/http/server/app.parity-path.test.ts` → empty output; `git status --porcelain` over the same four paths → empty (`PARITY-DIFF-EMPTY`). Not one line of the four EPIC 030 parity files changed in this epic.
- `typecheck` (`npm run typecheck`) → exit 0.
- `unit` (`npm test`) → exit 0 — tests 5283 / pass 5283 / fail 0, suites 500.
- `Gates:` (`npm run verify` = format → typecheck → full suite → `eslint .` → verify-db-status) → exit 0; final line `kanthord: verify db status ok`. The gate's prettier pass rewrote no file beyond what the two lanes already wrote (porcelain identical before and after the run).

**Proof.**

- command: the EPIC's `Proof:` block verbatim — `node --test` over the 26 named suites (`src/http/server/variables.test.ts` through `src/http/server/app.parity-path.test.ts`, inclusive of the four untouched parity files) `&& echo "PASS EPIC-032"` → exit 0 — tests 392 / pass 392 / fail 0, cancelled 0, skipped 0.
- exact success string printed: "PASS EPIC-032"

**Tasks closed.** 16 across 16 Stories — 01 typed variables and accessors, 02 header accumulator, 03 `app.onError` owns the envelope, 04 render middleware, 15 Koa bridge (dispatched before 05 per the EPIC), 05 origin, 06 host, 07 preflight, 08 auth, 09 route, 10 authorize, 11 gated body parse, 12 idempotency helpers on Fetch types, 13 idempotency middleware, 14 dispatch, 16 `createApp` returns both apps. No Story outstanding, no Story unexpanded.

Reviewer notes (no blocker): the software-engineer's Story 16 turn records one human-owned follow-up, already tracked in the EPIC's own Open items as S5 — `eslint.config.js` still lists the deleted `src/http/server/koa-body.ts` in an `ignores` array. Lint is green today; every `*.config.*` path is denied to every agent lane, so the entry needs a human edit.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test <26 EPIC-032 server suites> && echo "PASS EPIC-032") — "PASS EPIC-032"
- stories: 16/16 complete
- date: 2026-08-25
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 1 action:NO finding(s) recorded for the human.
BLOCKER: oversized idempotency catch — src/http/server/idempotency.ts:153-170 catches capture, settlement and replay writes; Story 13 requires the try to cover only materializeResult, so limit the try to that call and perform capture, settlement and c.set after the catch boundary.
BLOCKER: bridge test server remains referenced — src/http/server/koa-bridge.test.ts:18-23 listens without server.unref(); Story 15 requires an unref'd loopback socket, so unref the server after listen completes.
INFO: NEEDS-HUMAN contradictory key-whitespace contract — src/http/server/idempotency-key.test.ts:95-102 expects leading/trailing spaces to become accepted trimmed keys while Story 12 line 15 requires them refused and line 11's Fetch Headers seam trims before the reader sees them; a human must decide whether transport-normalized acceptance or raw-value refusal is authoritative.

## TEST-ENGINEER — review-blocker regression coverage · two BLOCKERs routed by AUTO_REVIEW: FAIL

**Cycle.** RED for the routed blocker `oversized idempotency catch` (`node --test src/http/server/idempotency.test.ts`), plus the in-lane test repair for the routed blocker `bridge test server remains referenced`. The INFO finding `NEEDS-HUMAN contradictory key-whitespace contract` stays recorded for the human; not actionable this turn.

**Test written.**

- file: `src/http/server/idempotency.test.ts` (edited — one new regression row appended inside the top-level suite, plus one `node:fs/promises` import) — methods: `the reserved success try covers only materializeResult, so a capture or settlement failure never enters the materialization catch`
- asserts: the source-contract scan pins Story 13 bullet 19 / Decision 10's try boundary over `src/http/server/idempotency.ts` — between `await next();` and `demand(c, "result")`, then from that branch's `try {` to `} catch`: the covered slice matches `materializeResult(` and matches none of `captureAnswer(`, `.settle(`, `c.set("replay"`; after the catch's `throw failure;` the success continuation still contains all three writes. A capture or settlement failure therefore originates outside the try and can never be swallowed as a materialization failure, and the catch's own settlement stays the only settlement on the failure path.
- file: `src/http/server/koa-bridge.test.ts` (edited — test-lane defect, repaired directly per Step 6d) — `listen()` now calls `server.unref()` after listen resolves, so the loopback socket holds no event-loop reference as Story 15 requires. Zero assertion lines changed; suite still 6/6 green.

**Instrument note (why a source-contract scan and not an HTTP round-trip).** A black-box test cannot be sensitive here: `IdempotencyStore.settle` sets `created.settled = true` before its only fallible read (`this.now()`), its guard makes any second settle a silent no-op, and every runtime observable — response bytes through `onError`, the single `onInternalError` call with the original failure, `store.size()/bytes()/waiters()`, waiter notifications — converges to identical values whether or not the oversized catch runs. The divergence is exactly the structure the reviewer named, so the scan pins that structure, in the style of the existing `app.test.ts` source-scan row. No vacuous-GREEN risk: the row is red today and turns green only when the three statements move below the catch boundary.

**RED proof.**

- command: `node --test src/http/server/idempotency.test.ts src/http/server/koa-bridge.test.ts`
- exit: 1 (tests 56 / pass 55 / fail 1; koa-bridge 6/6 green after the unref repair) — failure verbatim:
  `✖ the reserved success try covers only materializeResult, so a capture or settlement failure never enters the materialization catch` → `AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /captureAnswer\(/` — with the captured slice showing `materializeResult(...)` followed inside the same try by `captureAnswer(...)`, `outcome.settle(...)` and `c.set("replay", answer)` (`src/http/server/idempotency.ts:153-169`).
- eslint on both edited test files: exit 0.

**Open to Software Engineer.**

- Seam: `src/http/server/idempotency.ts`, reserved success branch (today lines 152-190), per Story 13 bullets 19-21 and EPIC Decision 10 exactly:
  - narrow the `try` to cover only the `materializeResult(result, match.operation, headers)` call;
  - move `captureAnswer(headers, before, materialized.status, materialized.body)`, the `outcome.settle(answer, classifyOutcome({ replayable, status: materialized.status, internal: false }))` call, and `c.set("replay", answer)` below the catch boundary, in that order;
  - leave the catch body exactly as Story 13 bullet 21 states it: `materializeError(failure)`, set `application/json; charset=utf-8` when `content-type` is absent, serialize and capture the envelope once, settle with the materialized status and internal flag, rethrow the original failure;
  - change nothing else — no signature, no store, no helper, no other branch. The new scan row plus the 49 existing behavioural rows decide green.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — idempotency reserved-success try boundary · review blocker fix

**Cycle.** GREEN for `src/http/server/idempotency.test.ts` — regression row `the reserved success try covers only materializeResult, so a capture or settlement failure never enters the materialization catch` (AUTO_REVIEW BLOCKER `oversized idempotency catch`). **Review blocker addressed.** BLOCKER: oversized idempotency catch — src/http/server/idempotency.ts:153-170 catches capture, settlement and replay writes; Story 13 requires the try to cover only materializeResult, so limit the try to that call and perform capture, settlement and c.set after the catch boundary.

**Files changed.**

- `src/http/server/idempotency.ts` (edited) — reserved success branch restructured; `MaterializedResult` type import added from `./render.ts`.

**Seam (GREEN).** The `try` now covers only `materializeResult(result, match.operation, headers)`; `captureAnswer(headers, before, materialized.status, materialized.body)`, `outcome.settle(answer, classifyOutcome({ ..., internal: false }))` and `c.set("replay", answer)` sit below the catch boundary in that order, so a capture or settlement failure can never enter the materialization catch. The catch body keeps the Story 13 bullet-21 contract unchanged — `materializeError(failure)`, the `application/json; charset=utf-8` default only when `content-type` is absent, one serialize-and-capture of the envelope, settlement with the materialized status and internal flag, then `throw failure` — so the scan slice from `try {` to `} catch` matches only `materializeResult(` and the post-rethrow continuation carries all three writes. No signature, no store, no helper, no other branch changed.

**Refactor.** none beyond the blocker's own restructuring; applied as specified.

**Build check.**

- typecheck (`npm run typecheck`): exit 0
- eslint `src/http/server/idempotency.ts`: exit 0
- running-app smoke (production modules; Hono chain headers → render → route → actor seed → body → idempotency → terminal over real registry POST /v1/actor): success path settles and replays — store retains exactly one record, second keyed request reruns the handler zero times; a keyed serialization failure settles indeterminate, reports the original `TypeError` exactly once, and its second request replays the stored generic 500 without rerunning the handler. Probe note: hono 4.13.3's `app.request`/`app.fetch` resolve to the finalized Context rather than a Response under an inline `-e` harness, so the behaviour facts above read from store/handler counters, which are unaffected. `koa-bridge.test.ts` untouched (repaired in-lane by the test-engineer).

**Assumptions.**

- VERIFIED: `let materialized: MaterializedResult` assigned only inside a `try` whose `catch` always throws is definitely assigned at the continuation — strict-mode CFA accepts it; whole-tree typecheck exits 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Handoff gate first on the software-engineer's blocker-fix turn: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (exit 0). Confirm GREEN for both routed AUTO_REVIEW blockers in one run: `node --test src/http/server/idempotency.test.ts src/http/server/koa-bridge.test.ts` → tests 56 / pass 56 / fail 0, exit 0 — blocker 1's regression row `the reserved success try covers only materializeResult, so a capture or settlement failure never enters the materialization catch` passes against the narrowed try (`src/http/server/idempotency.ts`), and blocker 2's repaired `src/http/server/koa-bridge.test.ts` stays 6/6 green with `server.unref()` in place. Both blockers from the review are closed. All sixteen Tasks stand confirmed green, so the full Verification Gate runs below — both parts.

**EPIC verification gate.**

- Parity immutability (hermetic-coverage precondition): `git diff --stat HEAD -- src/http/server/app.handler-result.test.ts src/http/server/app.parity-body.test.ts src/http/server/app.parity-cors.test.ts src/http/server/app.parity-path.test.ts` → empty output; porcelain over the same four paths → empty. Not one line of the four EPIC 030 parity files changed in this epic, including through both blocker repairs.
- `typecheck` (`npm run typecheck`) → exit 0 (re-verified independently via `npm run verify:handoff` → PASS).
- `unit` (`npm test`) → exit 0 — tests 5284 / pass 5284 / fail 0, suites 500 (the one-test delta over the prior gate is this lane's routed-blocker regression row).
- `Gates:` (`npm run verify` = format → typecheck → full suite → `eslint .` → verify-db-status) → exit 0; final line `kanthord: verify db status ok`.

**Proof.**

- command: the EPIC's `Proof:` block verbatim — `node --test` over the 26 named suites (`src/http/server/variables.test.ts` through `src/http/server/app.parity-path.test.ts`, inclusive of the four untouched parity files) `&& echo "PASS EPIC-032"` → exit 0 — tests 393 / pass 393 / fail 0, cancelled 0, skipped 0 (392 + the one regression row).
- exact success string printed: "PASS EPIC-032"

**Tasks closed.** 16 across 16 Stories — 01 typed variables and accessors, 02 header accumulator, 03 `app.onError` owns the envelope, 04 render middleware, 15 Koa bridge (dispatched before 05 per the EPIC), 05 origin, 06 host, 07 preflight, 08 auth, 09 route, 10 authorize, 11 gated body parse, 12 idempotency helpers on Fetch types, 13 idempotency middleware, 14 dispatch, 16 `createApp` returns both apps. No Story outstanding, no Story unexpanded. Both review blockers repaired and confirmed green; nothing is red anywhere in the tree.

Reviewer notes (no blocker): two items stay recorded for the human, neither actionable by any agent lane — (1) the routed INFO finding `NEEDS-HUMAN contradictory key-whitespace contract`: `src/http/server/idempotency-key.test.ts:95-102` expects leading/trailing spaces to become accepted trimmed keys while Story 12 line 15 requires them refused and line 11's Fetch Headers seam trims before the reader sees them; a human must decide whether transport-normalized acceptance or raw-value refusal is authoritative; (2) EPIC Open item S5 — `eslint.config.js` still lists the deleted `src/http/server/koa-body.ts` in an `ignores` array; lint is green today and every `*.config.*` path is denied to every agent lane, so the entry needs a human edit.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test <26 EPIC-032 server suites> && echo "PASS EPIC-032") — "PASS EPIC-032"
- stories: 16/16 complete
- date: 2026-08-25
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
