# EPIC 031 — The fetch-native response model

Status: **draft**. It sits after EPIC 030 in the sequence, inside phase 1b. It is the second epic of
the 030-039 band that replaces Koa with Hono. It changes no response body, so it lands before the
Hono swap of EPIC 032 and it stays on Koa.

## Goal

A handler declares what it returns. `HandlerResult.body: unknown` at `src/http/server/app.ts:38`
becomes a discriminated union of three variants: JSON, bytes and empty. After this epic a `Response`
is constructed from a `HandlerResult` with no framework guessing, and the transport contract names no
Node type.

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
result.bytes.byteOffset, result.bytes.byteLength)` for the `bytes` variant. EPIC 034 replaces the
  file with the node adapter, and EPIC 035 deletes it. Every other file under `src/http/server/`
  imports `node:buffer` no more.

- **The bytewise comparison moves to `src/http/server/bytewise.ts`.** `AGENTS.md` requires bytewise
  ordering, and five files under `src/http/server/` reach `node:buffer` for that one comparison:
  `dispatch.ts:43`, `dispatch.ts:56`, `query.ts:13`, `single.ts:9`, `invalid-request.ts:38`,
  `invalid-request.ts:45`, `invalid-request.ts:52` and `idempotency-response.ts:49`. The helper
  exports `compareBytewise(left: string, right: string): number`. It encodes each side with one
  module-level `TextEncoder` and compares the two byte arrays: the first differing byte decides, and
  a prefix sorts first. `TextEncoder` emits the same UTF-8 bytes `Buffer.from(value)` emits, so the
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

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **A bytewise helper with no `Buffer`.** Add `src/http/server/bytewise.ts` with
   `compareBytewise`. Replace every `Buffer.compare(Buffer.from(...), Buffer.from(...))` call in
   `dispatch.ts`, `query.ts`, `single.ts`, `invalid-request.ts` and `idempotency-response.ts` with it,
   and delete the now-unused `node:buffer` import from each of those files. Add
   `src/http/server/bytewise.test.ts` with an exact-order test over non-ASCII names, and pin the same
   order in `query.test.ts` and `single.test.ts`.
2. **`app.ts` declares the discriminated result.** Add `handlerStatuses`, `bodylessStatuses`,
   `HandlerStatus`, `BodylessStatus`, `BodyStatus`, `JsonResult`, `BytesResult`, `EmptyResult`, and
   redeclare `HandlerResult` as their union. The `Handler` type at `app.ts:43` keeps its text. Add a
   runtime test in `app.test.ts` that asserts `handlerStatuses` and `bodylessStatuses` by exact value.
3. **`dispatch.ts` builds the response from the variant.** Add `src/http/server/koa-body.ts`. In
   `dispatch.ts`, switch on `result.kind`: set the content type for the variant, apply the sorted
   result headers, set the status, and set the Koa body from the adapter. The `empty` variant sets no
   body at all. Add the internal-error throw for a `bytes` result with no `responseMedia`. Cover 204,
   304 and the missing-`responseMedia` defect in `dispatch.test.ts` with stub handlers.
4. **`show-blob.ts` returns the bytes variant.** Drop the `node:buffer` import, build
   `Uint8Array.from(record.content)`, return `kind: "bytes"` with the `bytes` field for 200 and for
   206, and remove `"Content-Type"` from the headers object, because the operation now names it. The
   `Accept-Ranges`, `Cache-Control`, `ETag` and `Content-Range` values are unchanged.
   `show-blob.test.ts` asserts both answers byte-exact.
5. **The remaining 43 handlers return the JSON variant.** Add `kind: "json"` to every returned result
   and to every handler test that asserts one. No status changes and no body changes. The groups, by
   directory and handler count: `actor` 5, `credential` 8, `edge` 1, `event` 1, `node` 11, `plan` 4,
   `project` 6, `repository` 4, `system` 3. No handler needs the `empty` variant.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/server/app.test.ts \
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
- **The bytewise header order is unchanged.** A handler returns header names that differ only beyond
  the ASCII range, and the test asserts the emitted order by exact list. The same test asserts that
  `compareBytewise` and `Buffer.compare` agree over that name set.
- **No production file under `src/http/server/**` imports `node:buffer`, except `koa-body.ts`.** The
  test reads every `.ts` file under the tree, excludes `*.test.ts` and `koa-body.ts`, and asserts an
  empty offender list by value.
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
  handler factories. Story 4 takes one, and story 5 takes the other 43.
- S1 - status:OPEN - action:YES - eslint bans `node:buffer` under `src/http/server` - The
  hermetic test of the gate reads the tree at run time, and `eslint.config.js` already carries a
  `no-restricted-imports` glob per layer. - fix:add a `no-restricted-imports` entry for
  `src/http/server/**/*.ts` that denies `node:buffer`, with `src/http/server/koa-body.ts` as the one
  exception. - why:`eslint.config.js` matches `*.config.*`, so `scripts/lane-check.sh:47-49` denies
  the path to every agent lane, and the rule stays a test until a human applies it.
- S2 - status:OPEN - action:YES - the `koa-body.ts` exception is temporary - EPIC 034 replaces the
  adapter and EPIC 035 deletes it. - fix:delete the S1 exception when EPIC 035 removes
  `src/http/server/koa-body.ts`. - why:the exception exists for Koa alone, and it must not outlive
  Koa.
