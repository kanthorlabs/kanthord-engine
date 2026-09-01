# EPIC 030 — Transport inventory and parity contract

Status: **draft**. It opens the 030–039 band inside phase 1b. It sits after EPIC 029 and before any
phase-2 epic. It changes no behaviour. It writes down what the transport does today, and it pins
every behaviour EPIC 032 must reproduce on Hono.

## Goal

The Koa chain of `src/http/server/` carries behaviour that no test names. EPIC 032 replaces that
chain. A replacement with no pinned behaviour is a rewrite, not a port.

This epic produces two artifacts.

1. A parity contract in `docs/proposal/phase-1/transport.md`, stated as product behaviour. It names
   no framework.
2. A test for every row of that contract. Every test passes against the current Koa stack, before
   any Hono code exists.

The parity surface, one row per behaviour, with the test that pins it:

| #   | Behaviour                                                                                     | Pinned by                                                      |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P1  | A routed operation with a bound handler parses a malformed body as `400`                      | `dispatch.test.ts:93`, `register-provider.test.ts:110` (exist) |
| P2  | A stubbed operation with a malformed body answers `501` and parses nothing                    | `dispatch.test.ts:93` (exists)                                 |
| P3  | A routed POST with no body reaches the handler with an empty object body                      | `app.parity-body.test.ts`                                      |
| P4  | A routed POST with `text/plain` reaches the handler with an empty object body                 | `app.parity-body.test.ts`                                      |
| P5  | A routed POST with a zero-length body reaches the handler with an empty object body           | `app.parity-body.test.ts`                                      |
| P6  | A routed operation with no bound handler answers `501` and parses nothing                     | `app.parity-body.test.ts`                                      |
| P7  | CORS headers survive an authentication failure                                                | `app.test.ts:151`, `app.test.ts:248` (exist)                   |
| P8  | CORS headers survive a routing failure                                                        | `app.parity-cors.test.ts`                                      |
| P9  | CORS headers survive an internal error                                                        | `app.parity-cors.test.ts`                                      |
| P10 | CORS headers survive a handler refusal                                                        | `app.parity-cors.test.ts`                                      |
| P11 | `Vary: Origin` is present on every answer the chain completes, and absent on a refused origin | `app.parity-cors.test.ts`                                      |
| P12 | A preflight bypasses authentication                                                           | `app.test.ts:209` (exists)                                     |
| P13 | A preflight bypasses route matching                                                           | `app.test.ts:220` (exists)                                     |
| P14 | The `Host` check runs before the preflight answer                                             | `app.test.ts:184` (exists)                                     |
| P15 | An `OPTIONS` with no `Origin` is not a preflight                                              | `app.test.ts:264` (exists)                                     |
| P16 | A path segment is never percent-decoded                                                       | `app.parity-path.test.ts`                                      |
| P17 | A malformed percent escape in a path segment reaches route matching intact                    | `app.parity-path.test.ts`                                      |
| P18 | A duplicate request header reaches the handler joined with `", "`                             | `app.parity-path.test.ts`                                      |
| P19 | Request header names reach the handler sorted bytewise and lower-cased                        | `app.parity-path.test.ts`                                      |
| P20 | Response header names are written bytewise sorted                                             | `dispatch.test.ts:352` (exists)                                |
| P21 | Every handler result uses a status from the frozen set `[200, 206]`                           | `app.handler-result.test.ts`                                   |
| P22 | Exactly one handler sets response headers, and it is the blob handler                         | `app.handler-result.test.ts`                                   |
| P23 | A JSON result serializes as `application/json`                                                | `app.handler-result.test.ts`                                   |
| P24 | A `Buffer` result serializes as bytes with an exact `Content-Length`                          | `app.handler-result.test.ts`                                   |
| P25 | The one empty-body answer in the product is the `204` preflight                               | `app.handler-result.test.ts`                                   |

An existing row needs no new test. This epic adds the tests for P3–P6, P8–P11, P16–P19 and P21–P25.

## Non-goals

- **No Hono.** This epic adds no dependency and imports no new package. EPIC 031 opens the fetch
  native response model.
- **No behaviour change.** A test that fails against the current stack is a defect in the test, not
  a defect in the transport. Every added test passes on Koa first.
- **No refactor of the middleware chain.** `createApp` at `src/http/server/app.ts:73` keeps its ten
  middlewares in their current order. EPIC 032 reorders nothing either.
- **No new handler and no new route.** The registry is untouched.
- **No test-helper rewrite.** `test/helpers/app.ts` and `test/helpers/agent.ts` keep their Koa types.
  EPIC 033 lands the dual-level harness.

## Decisions

- **The parity contract is product behaviour, and it lives in the proposal.** A rule that lives only
  in a test file is a rule the next transport loses. `docs/proposal/phase-1/transport.md` describes
  behaviour and names no framework today. The contract keeps that property.

- **The empty request body is an empty object.** A routed POST with no body, with a non-JSON content
  type, or with a zero-length body reaches the handler with `body` equal to `{}`. Each handler
  already validates its own body through zod, so an empty object produces the handler's own `400`.
  The transport produces no `400` of its own for an absent body.

- **A body is parsed only for a routed operation that has a bound handler.** `bodyParserForHandled`
  at `src/http/server/app.ts:115` makes the parse conditional. A `stubbed` operation and a routed
  operation with no bound handler both answer `501` with the body untouched.

- **CORS headers are set before the chain runs, and an error never clears them.** `originMiddleware`
  writes `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers` before it calls the rest
  of the chain, and `envelopeMiddleware` wraps it from outside. So an allowed origin keeps its
  headers on a `401`, a `404`, a `409` and a `500`. The one answer with no allow-origin header is an
  `origin-forbidden` refusal, because the origin middleware itself throws before it writes.

- **`Vary: Origin` covers every answer the chain completes.** `originMiddleware` writes it in a
  `finally` block at `src/http/server/origin.ts:34`, so it is present on an allowed origin and on a
  missing origin. A refused origin throws at `src/http/server/origin.ts:21` before that `try`, so
  the `origin-forbidden` refusal carries neither `Access-Control-Allow-Origin` nor `Vary`. That is
  the one answer with no `Vary`, and EPIC 032 reproduces it.

- **A path segment is never percent-decoded.** Route matching splits the raw path on `/` and
  compares the literal segment. A `%2F` inside a path parameter reaches the handler as the four
  characters `%2F`, and a malformed escape such as `%zz` reaches route matching intact. The epic
  pins the current answer.

- **A duplicate request header is joined with `", "`.** `readHeaders` at
  `src/http/server/dispatch.ts:51` joins an array value with `", "` and sorts the names bytewise.
  Node lower-cases every request header name before that. The handler therefore sees one string per
  name.

- **The handler result surface is frozen by an enumerated table.** 44 files under
  `src/http/server/*/*.ts` export a `Handler`. The inventory test holds one row per file with that
  file's sorted status list. A new handler, a removed handler and a changed status each fail the
  test. The distinct status set across the whole tree is `[200, 206]`.

- **Exactly one handler sets response headers.** `src/http/server/blob/show-blob.ts:38` returns a
  Node `Buffer` with four headers on the `200`, and a fifth `Content-Range` on the `206`. No other
  handler sets a header.

- **No handler produces an empty body.** Every one of the 44 handlers returns a body value. The one
  empty-body answer in the product is the `204` preflight, and `preflightMiddleware` writes it. A
  status other than `200`, `206` and `204` comes from a thrown `HttpError` and carries the error
  envelope of `src/http/server/envelope.ts`.

- **Every added test drives the whole chain through `createTestApp`.** A middleware-level test
  proves one middleware. A parity test proves the chain, and the chain is what EPIC 032 replaces.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **The proposal states the parity contract.** Add one section, `## The request and response
contract`, to `docs/proposal/phase-1/transport.md`, after `## Browser access` and before `## A
held request`. State P3 to P6 as the body rule, P8 to P11 as the browser-defence rule, P16 to P19
   as the path and header rule, and P21 to P25 as the answer rule. Name no framework and no source
   file. No code.
2. **The handler result inventory.** Add `src/http/server/app.handler-result.test.ts`. Hold a frozen
   table of 44 rows, one per file under `src/http/server/*/*.ts` that declares `: Handler`, each row
   a repository-relative path and a sorted status list. Assert the scanned set of files equals the
   table by exact deep equality, so a new file and a removed file both fail. Assert the union of the
   status lists equals `[200, 206]`. Assert `blob/show-blob.ts` is the one file that declares a
   `headers` property on a result. Drive `createTestApp` three times: a JSON handler answers `200`
   with `content-type` `application/json; charset=utf-8`; the blob handler answers `200` with
   `content-type` `application/octet-stream` and an exact `content-length`; the same handler with a
   `Range` header answers `206` with an exact `content-range`. Assert the `204` preflight carries an
   empty response text and no `content-length` header.
3. **Body-parsing parity.** Add `src/http/server/app.parity-body.test.ts`. Bind one recording
   handler for `repository.register` and assert the recorded `body` is `{}` for a POST with no body
   sent, for a POST with `Content-Type: text/plain` and the payload `hello`, and for a POST with
   `Content-Type: application/json` and a zero-length payload. Assert `POST /v1/project`, the routed
   `project.create` with no bound handler, answers `501` `not-implemented` and records no call, with
   a malformed payload and with a valid one.
4. **CORS parity.** Add `src/http/server/app.parity-cors.test.ts`. Configure
   `allowedOrigins: ["http://localhost:8080"]`. Assert `Access-Control-Allow-Origin` equals that
   origin and `Access-Control-Expose-Headers` equals `etag, accept-ranges, content-range` on: a
   `401` with no token, a `404` for an unmatched path, a `500` from a handler that throws a plain
   `Error`, and a `409` from a handler that throws an `HttpError`. Assert `Vary` equals `Origin` on
   each of those four, on a `200`, and on a request with no `Origin` header. Assert the `403`
   `origin-forbidden` refusal carries neither `Access-Control-Allow-Origin` nor `Vary`.
5. **Path and header parity.** Add `src/http/server/app.parity-path.test.ts`. Bind one recording
   handler for `blob.show`. Assert a `GET /v1/blob/aa%2Fbb` records the `hash` parameter as the
   literal `aa%2Fbb`. Assert a `GET /v1/blob/aa%zz` matches the route and records the `hash`
   parameter as the literal `aa%zz`, so a malformed escape produces no transport error. Send
   `X-Kanthord-Client` as the array `["one", "two"]`, because superagent `.set` called twice
   overwrites the value; assert the handler records `one, two`. On that same request, assert the
   recorded header names deep-equal the literal
   `["accept-encoding", "authorization", "connection", "host", "x-kanthord-client"]`, and on the two
   `%2F` and `%zz` requests assert they deep-equal the literal
   `["accept-encoding", "authorization", "connection", "host"]`.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/server/app.test.ts \
  src/http/server/app.handler-result.test.ts \
  src/http/server/app.parity-body.test.ts \
  src/http/server/app.parity-cors.test.ts \
  src/http/server/app.parity-path.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/envelope.test.ts \
  src/http/server/origin.test.ts \
  src/http/server/host.test.ts \
  src/http/server/preflight.test.ts \
  src/http/server/auth.test.ts \
  src/http/server/authorize.test.ts \
  src/http/server/route.test.ts \
  src/http/server/query.test.ts \
  src/http/server/blob/show-blob.test.ts \
  src/http/server/blob/range.test.ts \
  src/http/server/credential/register-provider.test.ts \
  src/http/server/idempotency.test.ts \
  src/http/server/idempotency-key.test.ts \
  src/http/server/idempotency-response.test.ts \
  test/helpers/app.test.ts \
  test/helpers/agent.test.ts \
  && echo "PASS EPIC-030"
```

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **Every added test passes on the current Koa stack.** No production file under `src/` changes in
  stories 2 to 5. `git diff --name-only` for each of those four commits names one `.test.ts` file.
- **The inventory table matches the tree by exact deep equality.** A test run after a handler file
  is added fails, and the failure names the new file. Prove it with a temporary file the test
  removes, or with a scan of a fixture directory. Never with a network call.
- **P19 asserts the header-name list as a value.** The recorded names are compared against the
  literal array by deep equality, never against a sortedness predicate and never against a count.
- **The inventory asserts a value, never a count alone.** The status union is compared against the
  literal `[200, 206]`, and the header-setting file is compared against the literal
  `src/http/server/blob/show-blob.ts`.
- **Each parity test drives the full chain through `createTestApp`.** No parity test calls a
  middleware factory directly.
- **The blob byte assertions are exact.** `content-length` and `content-range` are compared as
  strings against values computed from the fixture length, not against a regular expression.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git
  configuration.** `createTestApp` already injects `now` and `schedule`; every added test keeps the
  injected values. A test that needs a remote uses the loopback fixture of EPIC 005.
- **The proposal section names no framework.** A grep of `docs/proposal/phase-1/transport.md` for
  `koa`, `hono` and `express` returns nothing, case-insensitive.

## Open items

- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b, and EPIC 029 set that precedent. The
  whole 030–039 band carries the same exemption.
- **Percent-decoding is incidental, and the epic pins the current answer.** No layer decodes a path
  segment. A blob hash and a ULID contain no character that needs an escape, so no route depends on
  decoding today. The behaviour is therefore untested rather than decided. P16 and P17 record the
  current answer so a Hono port cannot change it by accident. A decision to decode is
  separate, and no epic declares it.
- **The P19 header-name list carries three names the test client supplies.**
  `accept-encoding`, `connection` and `host` come from supertest, not from the product. The literal
  is still the right oracle, because a value assertion beats a predicate and the list is
  deterministic for the pinned client. EPIC 033 replaces the harness, so EPIC 033 updates the
  literal.
- **The `", "` join for a duplicate request header is incidental.** Node already collapses most
  duplicate headers, and the join in `readHeaders` covers the rest. No handler reads a header that a
  client sends twice. P18 pins the current answer.
- **The empty-object body for an absent request body is incidental.** The body parser produces `{}`,
  and every handler's zod schema then refuses it with the handler's own `400`. A transport that
  produces `undefined` gives the same status through a different message. P3 to P5 pin the recorded
  `body` by exact equality with `{}`, and assert no message text.
- **The `charset=utf-8` suffix on a JSON response is incidental.** It comes from the framework's
  content negotiation, not from a product rule. P23 pins the current string so EPIC 032 either
  reproduces it or changes it deliberately.
