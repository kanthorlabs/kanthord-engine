# Story 4 — CORS parity

Epic: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`
Depends on: Story 1 (the proposal states the browser-defence rule).

Add one file: `src/http/server/app.parity-cors.test.ts`. **No production file changes.**
`git diff --name-only` for this commit names exactly that one path.

Delivers P8, P9, P10, and the non-`OPTIONS` half of P11. **Story 2 owns the preflight half:** it
asserts `vary: Origin` on the `204`. This story drives no `OPTIONS` request.

## Change

### `src/http/server/app.parity-cors.test.ts` — new file

Header:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import { httpError } from "../contract/errors.ts";
```

Suite name: `describe("src/http/server/app.parity-cors.test", () => {`.

Module-level constants:

```ts
const ORIGIN = "http://localhost:8080";
const EXPOSED = "etag, accept-ranges, content-range";
```

`EXPOSED` restates the value `src/http/server/origin.ts:5` writes. Declare it as a literal; it is
not exported, so do not import it.

#### The one app under test

```ts
async function corsApp() {
  return createTestApp({
    allowedOrigins: [ORIGIN],
    handlers: {
      "system.health": () => {
        throw new Error("boom");
      },
      "system.status": () => {
        throw httpError("lease-held", "held", { holder: "actor_01" });
      },
      "system.db": () => ({ status: 200, body: { ok: true } }),
    },
  });
}
```

`system.health` is `GET /v1/health`, `system.status` is `GET /v1/status`, `system.db` is
`GET /v1/db/status`. `lease-held` is a `409` (`src/http/contract/errors.ts:18`), and `httpError` requires a details
argument for every `409` code (`errors.ts:95-111`).

#### The four survival tests

Each asserts three headers by exact value. Build a fresh app per test.

- **`CORS headers survive an authentication failure`** (P7 regression, P11) — issue the request
  through `app.raw` so no `Authorization` header is set:
  `await app.raw.get("/v1/status").set("Host", "kanthord.test").set("Origin", ORIGIN)`.
  Assert `response.status` equals `401`, `response.body.error.code` equals `"unauthenticated"`,
  `response.headers["access-control-allow-origin"]` equals `ORIGIN`,
  `response.headers["access-control-expose-headers"]` equals `EXPOSED`, and
  `response.headers["vary"]` equals `"Origin"`.
- **`CORS headers survive a routing failure`** (P8) —
  `await app.get("/v1/nope/nope").set("Origin", ORIGIN)`. Assert `response.status` equals `404`,
  `response.body.error.code` equals `"not-found"`, and the same three header values.
- **`CORS headers survive an internal error`** (P9) —
  `await app.get("/v1/health").set("Origin", ORIGIN)`. Assert `response.status` equals `500`,
  `response.body.error.code` equals `"internal-error"`, the same three header values, and
  `app.internalErrors().length` equals `1`. Assert `response.text.includes("boom")` is `false`,
  matching `envelope.test.ts:61`.
- **`CORS headers survive a handler refusal`** (P10) —
  `await app.get("/v1/status").set("Origin", ORIGIN)`. Assert `response.status` equals `409`,
  `response.body.error.code` equals `"lease-held"`, `response.body.error.details.holder` equals
  `"actor_01"`, the same three header values, and `app.internalErrors().length` equals `0`.

Verified: all four carry `ORIGIN`, `EXPOSED` and `Vary: Origin`.

#### The three `Vary` tests

- **`Vary is Origin on a completed answer`** (P11) —
  `await app.get("/v1/db/status").set("Origin", ORIGIN)`. Assert `response.status` equals `200`,
  `response.headers["vary"]` equals `"Origin"`,
  `response.headers["access-control-allow-origin"]` equals `ORIGIN`, and
  `response.headers["access-control-expose-headers"]` equals `EXPOSED`.
- **`Vary is Origin on a request that carries no Origin`** (P11) —
  `await app.get("/v1/db/status")` with no `Origin` header. Assert `response.status` equals `200`,
  `response.headers["vary"]` equals `"Origin"`,
  `response.headers["access-control-allow-origin"]` equals `undefined`, and
  `response.headers["access-control-expose-headers"]` equals `undefined`. `originMiddleware` writes
  `Vary` in a `finally` block at `src/http/server/origin.ts:32-36`, outside the
  `if (origin !== undefined)` guard at `:19`.
- **`the origin-forbidden refusal carries neither allow-origin nor Vary`** (P11) —
  `await app.get("/v1/db/status").set("Origin", "http://evil.test")`. Assert `response.status` equals
  `403`, `response.body.error.code` equals `"origin-forbidden"`,
  `response.headers["access-control-allow-origin"]` equals `undefined`,
  `response.headers["access-control-expose-headers"]` equals `undefined`, and
  `response.headers["vary"]` equals `undefined`. The throw at `origin.ts:20-25` precedes the `try`,
  so the `finally` never runs.

Verified: the `403` carries none of the three headers, and `Vary` is `undefined`, not an empty
string.

## Constraints

- **Change no production file.** `src/http/server/origin.ts` keeps its `finally` block and its throw
  site, and the middleware order at `app.ts:82-106` is untouched.
- **Drive the chain through `createTestApp`.** Do not call `originMiddleware` or `envelopeMiddleware`
  directly, and do not construct a `Koa` instance in this file.
- **Assert `Vary` as an exact value, never with `includes`.** Every assertion here is
  `assert.equal(response.headers["vary"], "Origin")`, and an absence is
  `assert.equal(..., undefined)`. `origin.test.ts:204` uses `includes` for a merged value; no test in
  this file merges one.
- **Assert the expose-headers value as the full string.** `"etag, accept-ranges, content-range"`,
  never a substring and never a regular expression.
- **Do not set an `Origin` header on an `OPTIONS` request in this file.** P12 to P15 are pinned by
  `app.test.ts:184`, `:209`, `:220` and `:264`, and Story 2 asserts the preflight answer.
- **Keep the injected defaults.** `createTestApp` supplies `now: () => 0` and
  `schedule: () => () => {}`. Override neither.
- Do not override `onInternalError`. `app.internalErrors()` reads the default collector at
  `test/helpers/app.ts:118-124`.
- Do not add an origin to the allow list beyond `ORIGIN`.

## Verify

```bash
node --test src/http/server/app.parity-cors.test.ts
```

- All seven tests pass on the current stack, first run, with no production change.

```bash
node --test src/http/server/origin.test.ts src/http/server/app.test.ts \
  src/http/server/envelope.test.ts src/http/server/preflight.test.ts
```

- Every one passes unchanged. `app.test.ts:151` and `:248` still pin P7; `:184`, `:209`, `:220` and
  `:264` still pin P12 to P15.
- `git diff --name-only` names exactly `src/http/server/app.parity-cors.test.ts`.

`npm run verify` exits 0.

Proof: this story delivers the `app.parity-cors.test.ts` line of the EPIC Proof block, rows P8, P9
and P10, and the non-`OPTIONS` half of P11. It delivers the gate bullet **"Each parity test drives
the full chain through `createTestApp`"** for this file.
