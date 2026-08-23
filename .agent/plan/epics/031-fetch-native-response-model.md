# EPIC 031 — The fetch-native response model

Status: **draft**. It sits after EPIC 030 in the sequence, inside phase 1b. It is the second epic of
the 030-039 band that replaces Koa with Hono. It changes no response body, so it lands before the
Hono swap of EPIC 032 and it stays on Koa.

## Goal

A handler declares what it returns. `HandlerResult` at `src/http/server/app.ts:38`, whose
`body: unknown` sits at `app.ts:40`, becomes a discriminated union of three variants: JSON, bytes and
empty. After this epic a `Response` is constructed from a `HandlerResult` with no framework guessing,
and the transport contract names no Node type.

The shape the tree ships:

| Variant | Field   | Type         | Status   | Content type                      |
| ------- | ------- | ------------ | -------- | --------------------------------- |
| `json`  | `body`  | `unknown`    | 200, 206 | `application/json; charset=utf-8` |
| `bytes` | `bytes` | `Uint8Array` | 200, 206 | the operation `responseMedia`     |
| `empty` | none    | none         | 204, 304 | none                              |

## Non-goals

- **No Hono.** EPIC 032 swaps the framework. This epic runs on Koa and keeps every middleware in
  place.
- **No middleware change.** `auth`, `authorize`, `envelope`, `host`, `idempotency`, `origin`,
  `preflight` and `route` are untouched. The error path of `envelope.ts:15-28` keeps its own
  `Materialized` shape, because an error never travels as a `HandlerResult`.
- **No new operation.** The registry of `src/http/contract/` gains no entry and loses none.
- **No change to a response body's contents.** Only the declaration of the shape changes. Every byte
  a client reads today is the byte it reads after this epic.
- **No change to the idempotency replay store.** `StoredAnswer` at
  `src/http/server/idempotency-response.ts:3-7` captures from the Koa context, not from a
  `HandlerResult`.
- **No removal of `Buffer.byteLength`.** `src/http/server/idempotency-key.ts:55`,
  `idempotency-key.ts:57` and `idempotency-store.ts:61-113` measure a UTF-8 length through the global
  `Buffer`. They import nothing, so no import rule reaches them. A size budget is not an ordering
  rule, and EPIC 034 owns the runtime split that replaces them. This epic removes the comparison
  only.

## Decisions

- **The result is a discriminated union of three variants.** A `Response` forbids a body on 204 and
  on 304. Koa tolerates one today, so the rule lives nowhere. The `empty` variant makes the rule
  explicit:

  ```ts
  export type JsonResult = Readonly<{
    kind: "json";
    status: BodyStatus;
    body: unknown;
    headers?: Readonly<Record<string, string>>;
  }>;

  export type BytesResult = Readonly<{
    kind: "bytes";
    status: BodyStatus;
    bytes: Uint8Array;
    headers?: Readonly<Record<string, string>>;
  }>;

  export type EmptyResult = Readonly<{
    kind: "empty";
    status: BodylessStatus;
    headers?: Readonly<Record<string, string>>;
  }>;

  export type HandlerResult = JsonResult | BytesResult | EmptyResult;
  ```

- **The status set is closed, and the variant rule is type-level.** `app.ts` declares
  `handlerStatuses = [200, 204, 206, 304] as const` and `bodylessStatuses = [204, 304] as const`.
  `BodylessStatus` is the second set. `BodyStatus` is `Exclude<HandlerStatus, BodylessStatus>`, which
  is `200 | 206`. A body-bearing variant with 204 therefore fails `npm run typecheck`, and an `empty`
  variant with 200 fails the same way. The rule runs in both directions: 204 and 304 take `empty`
  only, and `empty` takes 204 and 304 only. A new status is a decision, not an accident, because it
  needs an edit to `handlerStatuses`.

- **No handler produces 204 or 304 today, and the variant still ships.** `docs/proposal/api/system.md:82`
  states that `blob.show` ignores `If-None-Match` and never returns 304. The `preflight` middleware
  answers 204 for a CORS preflight, and it never reaches a handler. The `empty` variant is proved at
  the dispatch seam with a stub handler.

- **Bytes are `Uint8Array`, never a Node `Buffer`.** A Worker runtime has no `Buffer`, so a `Buffer`
  must not appear in the transport contract. `src/http/server/blob/show-blob.ts:1` drops its
  `node:buffer` import and builds `Uint8Array.from(record.content)`. `parseRange` at
  `src/http/server/blob/range.ts` takes a number and returns numbers, so it is unchanged, and
  `subarray` on a `Uint8Array` has the same semantics `show-blob.ts:42` relies on today.

- **One adapter file holds the Koa conversion.** Koa serializes a value that is not a `Buffer`, not a
  string and not a stream as JSON, so a raw `Uint8Array` assigned to `context.body` corrupts a blob
  read. `src/http/server/koa-body.ts` is the single file that converts a `HandlerResult` to a Koa
  body. It imports `node:buffer` and it returns `Buffer.from(result.bytes.buffer,
result.bytes.byteOffset, result.bytes.byteLength)` for the `bytes` variant. EPIC 032 story 16 orphans
  and deletes the file, because `render.ts` builds the `Response` and the bridge writes the bytes
  (`.agent/plan/epics/032-the-hono-middleware-chain.md:419-422`). Every other file under
  `src/http/server/` imports `node:buffer` no more.

- **The bytewise comparison moves to `src/http/server/bytewise.ts`.** `AGENTS.md` requires bytewise
  ordering, and six files under `src/http/server/` reach `Buffer` for that one comparison, at nine
  sites: `dispatch.ts:43`, `dispatch.ts:56`, `query.ts:13`, `single.ts:9`, `invalid-request.ts:38`,
  `invalid-request.ts:45`, `invalid-request.ts:52`, `idempotency-response.ts:49` and
  `idempotency-key.ts:69`. Four of the six import `node:buffer`; `idempotency-response.ts` and
  `idempotency-key.ts` read the global and import nothing, so an import rule alone does not reach
  them. The helper exports `compareBytewise(left: string, right: string): number`. It encodes each
  side with one
  module-level `TextEncoder` and compares the two byte arrays: the first differing byte decides, and a
  prefix sorts first. `TextEncoder` emits the same UTF-8 bytes `Buffer.from(value)` emits, so the
  order is identical. A test with non-ASCII names proves the order against the values
  `Buffer.compare` produces today.

- **Content type comes from the variant and the operation, never from a framework default.** The
  `json` variant sets `Content-Type: application/json; charset=utf-8`, which is the exact value Koa
  emits today and the value `idempotency-response.test.ts:44` pins. The `bytes` variant sets
  `Operation.responseMedia`. The registry already refuses an entry that declares both `response` and
  `responseMedia` (`src/http/contract/registry.ts:248-251`), so exactly one source names the type. A
  `bytes` result for an operation with no `responseMedia` is a binding defect: `dispatch.ts` throws
  `httpError("internal-error", ...)` naming the operation id. The `empty` variant sets no content
  type. A header the handler returns still wins, because `dispatch.ts` applies the result headers
  after the variant default.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit, and each
story leaves `npm run verify` green on its own.

1. **A bytewise helper with no `Buffer`.** Add `src/http/server/bytewise.ts` with `compareBytewise`.
   Replace all nine `Buffer.compare` calls named in the Decisions with it, across `dispatch.ts`,
   `query.ts`, `single.ts`, `invalid-request.ts`, `idempotency-response.ts` and `idempotency-key.ts`.
   Delete the `node:buffer` import from `dispatch.ts`, `query.ts`, `single.ts` and
   `invalid-request.ts`; `idempotency-response.ts` and `idempotency-key.ts` have no import to delete,
   and `idempotency-key.ts` keeps its `Buffer.byteLength` calls. Add
   `src/http/server/bytewise.test.ts` with an exact-order test over non-ASCII strings, and pin the
   same order in `query.test.ts` and `single.test.ts`.

2. **The result union, and every producer and consumer with it.** One story, because the type change
   is not separable: `Handler` contextually types each returned object literal, so an added `kind`
   field fails the excess-property check before the union exists, and the union rejects a result with
   no `kind` after it exists. Either half alone fails `npm run typecheck`. The story does all of it:

   - **`app.ts` declares the union.** Add `handlerStatuses`, `bodylessStatuses`, `HandlerStatus`,
     `BodylessStatus`, `BodyStatus`, `JsonResult`, `BytesResult` and `EmptyResult`, and redeclare
     `HandlerResult` as their union. The `Handler` type at `app.ts:43` keeps its text. Add a runtime
     test in `app.test.ts` that asserts `handlerStatuses` and `bodylessStatuses` by exact value.
   - **`dispatch.ts` builds the response from the variant.** Add `src/http/server/koa-body.ts`. In
     `dispatch.ts`, switch on `result.kind`: set the content type for the variant, apply the sorted
     result headers, set the status, and set the Koa body from the adapter. The `empty` variant sets
     no body at all. Add the internal-error throw for a `bytes` result with no `responseMedia`. Cover
     204, 304 and the missing-`responseMedia` defect in `dispatch.test.ts` with stub handlers.
   - **`show-blob.ts` returns the bytes variant.** Drop the `node:buffer` import, build
     `Uint8Array.from(record.content)`, return `kind: "bytes"` with the `bytes` field for 200 and for
     206, and remove `"Content-Type"` from the headers object, because the operation now names it.
     The `Accept-Ranges`, `Cache-Control`, `ETag` and `Content-Range` values are unchanged.
     `show-blob.test.ts` asserts both answers byte-exact.
   - **The remaining 43 handlers return the JSON variant.** Add `kind: "json"` to every returned
     result and to every handler test that asserts one. No status changes and no body changes. The
     groups, by directory and handler count: `actor` 5, `credential` 8, `edge` 1, `event` 1, `node`
     11, `plan` 4, `project` 6, `repository` 4, `system` 3. No handler needs the `empty` variant.
   - **The EPIC 030 parity tests move with the shape.** `app.handler-result.test.ts` pins P21 over
     `handlerStatuses`, P23 over the `json` variant and P24 over the `bytes` variant. Update P24 to
     assert a `Uint8Array` payload, and keep P21 asserting that no bound handler answers 204 or 304.
     P22 is unchanged: `showBlobHandler` stays the one handler that sets response headers.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/server/app.test.ts \
  src/http/server/app.handler-result.test.ts \
  src/http/server/app.parity-body.test.ts \
  src/http/server/app.parity-cors.test.ts \
  src/http/server/app.parity-path.test.ts \
  src/http/server/bytewise.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/envelope.test.ts \
  src/http/server/idempotency.test.ts \
  src/http/server/idempotency-response.test.ts \
  src/http/server/invalid-request.test.ts \
  src/http/server/preflight.test.ts \
  src/http/server/query.test.ts \
  src/http/server/route.test.ts \
  src/http/server/single.test.ts \
  src/http/server/start.test.ts \
  src/http/server/blob/range.test.ts \
  src/http/server/blob/show-blob.test.ts \
  src/http/server/actor/*.test.ts \
  src/http/server/credential/*.test.ts \
  src/http/server/edge/*.test.ts \
  src/http/server/event/*.test.ts \
  src/http/server/node/*.test.ts \
  src/http/server/plan/*.test.ts \
  src/http/server/project/*.test.ts \
  src/http/server/repository/*.test.ts \
  src/http/server/system/*.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/system.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-031"
```

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`. `typecheck` is the mechanism for the status-to-variant rule.
- **A blob 200 and a blob 206 stay byte-exact.** The full-payload answer equals the stored content
  byte for byte, and the range answer equals the same slice `parseRange` names. Both are asserted
  through the daemon, with a payload that holds a non-UTF-8 byte, so a JSON serialization of the
  bytes fails the test instead of passing it.
- **A 204 response and a 304 response carry no body**, asserted by absence rather than by an empty
  string. The test reads the raw response and asserts that no `content-type` header and no
  `content-length` header are present, and that the body has zero bytes.
- **`compareBytewise` and `Buffer.compare` agree.** `bytewise.test.ts` compares the two over a
  string set that holds non-ASCII code points, a shared prefix, and a pair whose bytewise order is
  the reverse of their code-unit order. It asserts the sign of every pair by exact value.
- **The bytewise response header order is unchanged.** An HTTP field name is an ASCII token only
  (RFC 9110), and Node throws `ERR_INVALID_HTTP_TOKEN` for anything else, so this row cannot use a
  non-ASCII name. A stub handler returns valid token names whose bytewise order differs from their
  case-insensitive order — for example `X-B`, `X-a` and `X_c` — and the test asserts the emitted
  order by exact list.
- **No production file under `src/http/server/**` imports `node:buffer`, except `koa-body.ts`.** The
  test reads every `.ts` file under the tree, excludes `*.test.ts` and `koa-body.ts`, and asserts an
  empty offender list by value.
- **No production file under `src/http/server/**` calls `Buffer.compare`.** The import rule does not
  reach the global `Buffer`, and two of the nine comparison sites read it that way. The same test
  asserts a second empty offender list, over the text `Buffer.compare`, with no exception.
- **The blob content type comes from the registry.** The emitted `Content-Type` for `blob.show`
  equals `responseMedia` of the registry entry, read from the registry inside the test rather than
  written as a literal.
- **A `bytes` result for an operation with no `responseMedia` fails.** The dispatch test asserts the
  500 envelope and asserts that the message names the operation id.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**

## Open items

- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
- **The caller-supplied file count was 46; the tree holds 44.** `src/http/server/**` exports 44
  handler factories. Story 2 takes all 44: one blob handler and 43 JSON handlers.
- **`eslint.config.js` is out of every agent lane, so Ulrich applies S1 by hand.** `scripts/lane-check.sh:47-49`
  denies any path whose basename matches `*.config.*` to every role. The `/work` cycle therefore
  cannot land S1, and the gate proves the rule with a test until Ulrich lands it.
- S1 - status:STAGED - action:YES - eslint bans `node:buffer` under `src/http/server` - The hermetic
  test of the gate reads the tree at run time, and `eslint.config.js` already carries a
  `no-restricted-imports` glob per layer. - fix:apply the verified block in
  `.agent/plan/pending/031-s1-eslint-node-buffer.md`, in the same change that lands Story 2. It goes
  after the `src/http/contract/**/*.ts` block and repeats the `gitLibraries` and `node:child_process`
  groups, because flat config applies the last `no-restricted-imports` entry per file. It cannot land
  earlier: measured against HEAD it fails `eslint .` with one error per file story 1 and story 2
  clear. - why:`eslint.config.js` matches `*.config.*`, so `scripts/lane-check.sh:47-49` denies the
  path to every agent lane, and the rule stays a test until a human applies it.
- S2 - status:OPEN - action:YES - the `koa-body.ts` exception is temporary - EPIC 032 story 16
  deletes `src/http/server/koa-body.ts`, two epics earlier than this epic first stated.
  `.agent/plan/epics/032-the-hono-middleware-chain.md:419-422` records the supersession, and EPIC 032
  S5 carries the obligation. - fix:remove `"src/http/server/koa-body.ts"` from the `ignores` array of
  the S1 block when EPIC 032 story 16 lands. The `node:buffer` group survives; only the exception
  goes. - why:the exception exists for Koa alone, and it must not outlive Koa.
- S3 - status:OPEN - action:NO - the global `Buffer` outlives this epic - `idempotency-key.ts` and
  `idempotency-store.ts` still measure a UTF-8 length through the global `Buffer`, which a Worker
  runtime does not have. - fix:replace `Buffer.byteLength(value, "utf8")` with a
  `TextEncoder().encode(value).byteLength` helper in EPIC 034. - why:a size budget is not an ordering
  rule, and EPIC 034 owns the runtime split; folding it here widens the epic for no gain.
