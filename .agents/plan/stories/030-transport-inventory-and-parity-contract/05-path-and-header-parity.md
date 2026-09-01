# Story 5 — Path and header parity

Epic: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`
Depends on: Story 1 (the proposal states the path and header rule).

Add one file: `src/http/server/app.parity-path.test.ts`. **No production file changes.**
`git diff --name-only` for this commit names exactly that one path.

Delivers P16, P17, P18 and P19.

## Change

### `src/http/server/app.parity-path.test.ts` — new file

Header:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import type { HandlerContext } from "./app.ts";
```

Suite name: `describe("src/http/server/app.parity-path.test", () => {`.

#### The recording handler

```ts
async function recordingApp() {
  const calls: HandlerContext[] = [];
  const app = await createTestApp({
    handlers: {
      "blob.show": (context) => {
        calls.push(context);
        return { status: 200, body: { ok: true } };
      },
    },
  });
  return { app, calls };
}
```

`blob.show` is `GET /v1/blob/:hash` and its path parameter is named `hash`
(`src/http/contract/system.ts:177-186`, `src/http/contract/path.ts:104-106`).

**Bind this bare recorder, not `showBlobHandler`.** The real handler validates the parameter against
`blobHash` — `/^sha256:[0-9a-f]{64}$/` at `src/domain/blob.ts:5` — and answers `400` for both path
values this story sends.

#### The five tests, in this order

**Every test builds its own app through `recordingApp()`**, so `calls.length` is `1` in each and no
request or `calls` array is shared across `it` blocks. A test never refers to a request another test
issued.

1. **`a percent-escaped path segment reaches the handler undecoded`** (P16) —
   `await app.get("/v1/blob/aa%2Fbb")`. Assert `response.status` equals `200`, `calls.length` equals
   `1`, and `assert.deepEqual(calls[0]?.parameters, { hash: "aa%2Fbb" })`. The whole parameter object
   by deep equality, matching `dispatch.test.ts:258`. The `%2F` stays the three characters `%`, `2`,
   `F`.

2. **`a malformed percent escape reaches route matching intact`** (P17) —
   `await app.get("/v1/blob/aa%zz")`. Assert `response.status` equals `200`, `calls.length` equals
   `1`, and `assert.deepEqual(calls[0]?.parameters, { hash: "aa%zz" })`. Assert the status is `200`
   and not `400`.

3. **`a duplicate request header reaches the handler joined with a comma and a space`** (P18) — send
   the value as an array in one `.set` call:

   ```ts
   const response = await app
     .get("/v1/blob/aa")
     .set("X-Kanthord-Client", ["one", "two"] as unknown as string);
   ```

   Two `.set` calls with the same name overwrite each other in superagent, so the array is the only
   way to put the name on the wire twice. Assert `response.status` equals `200`, `calls.length`
   equals `1`, and `calls[0]?.headers["x-kanthord-client"]` equals the exact string `"one, two"`.

   `preflightMiddleware` already declares `X-Kanthord-Client` a permitted request header
   (`src/http/server/preflight.ts:6-7`).

4. **`a request carrying a client header records five sorted lower-cased header names`** (P19) —
   issue **its own** request, identical to test 3:

   ```ts
   const { app, calls } = await recordingApp();
   const response = await app
     .get("/v1/blob/aa")
     .set("X-Kanthord-Client", ["one", "two"] as unknown as string);
   assert.equal(response.status, 200);
   assert.deepEqual(Object.keys(calls[0]?.headers ?? {}), [
     "accept-encoding",
     "authorization",
     "connection",
     "host",
     "x-kanthord-client",
   ]);
   ```

   Test 3 pins the joined **value**; test 4 pins the **name list**. Repeat the request rather than
   share one: a supertest response and a `calls` array cannot cross an `it` boundary.

5. **`a plain GET records four sorted lower-cased header names`** (P19) — one test covering both
   parity paths. Build a fresh app, issue `await app.get("/v1/blob/aa%2Fbb")`, and assert the
   recorded names. Then build a **second** fresh app, issue `await app.get("/v1/blob/aa%zz")`, and
   assert the same literal again:

   ```ts
   assert.deepEqual(Object.keys(calls[0]?.headers ?? {}), [
     "accept-encoding",
     "authorization",
     "connection",
     "host",
   ]);
   ```

   Two apps inside one `it`, so each `calls[0]` is the request that test issued.

`readHeaders` at `src/http/server/dispatch.ts:51-63` sorts names with `Buffer.compare` and drops an
`undefined` value, and Node lower-cases every request header name before that.

**Compare the list as a value.** `assert.deepEqual` against the literal array, never a sortedness
predicate, never `assert.equal(names.length, 4)`, and never a `filter` that drops a name the client
supplied. `accept-encoding`, `connection` and `host` come from supertest, not from the product, and
the list is deterministic for the pinned client. EPIC 033 replaces the harness and updates the
literal then.

Both literals are verified against the current harness. **If a run disagrees with either literal,
stop and report it — that is a planning defect.** Do not weaken the assertion to a predicate, do not
filter a name out, and do not sort the observed list before comparing.

Two notes that bound the literals:

- A `POST` carries a fifth name, `content-length`, even with no body sent. Every request in this file
  is a `GET`, so the four-name list holds.
- `createTestApp`'s `get` wrapper sets `Host` and `Authorization`
  (`test/helpers/app.ts:141-174`). Use `app.get`, never `app.raw.get`, or `authorization` leaves the
  list.

Verified: both path values answer `200` and record the literal; the duplicate header records
`"one, two"`; and both header-name lists are exactly as written above.

## Constraints

- **Change no production file.** `readHeaders` at `src/http/server/dispatch.ts:51-63` and
  `matchRoute` at `src/http/contract/registry.ts:50-116` are untouched.
- **Drive the chain through `createTestApp`.** Do not call `dispatchMiddleware` or `routeMiddleware`
  directly, and do not construct a `Koa` instance in this file.
- **Bind exactly one handler, the bare recorder for `blob.show`.** Do not import `showBlobHandler`.
- **Set no header beyond `X-Kanthord-Client`**, and set it only on tests 3 and 4. Any extra header
  changes both pinned literals.
- **Use `app.get`, not `app.raw.get`.** Both `Host` and `Authorization` are in the pinned literals.
- **Assert the parameter object by deep equality**, not `parameters["hash"]` alone.
- **Keep the injected defaults.** `createTestApp` supplies `now: () => 0` and
  `schedule: () => () => {}`. Override neither.
- Do not add a test that asserts a decoded path segment.
- Do not assert response header order in this file. P20 is pinned by `dispatch.test.ts:352`.

## Verify

```bash
node --test src/http/server/app.parity-path.test.ts
```

- All five tests pass on the current stack, first run, with no production change. The file
  declares exactly five `it` blocks.

```bash
node --test src/http/server/dispatch.test.ts src/http/server/route.test.ts \
  src/http/server/query.test.ts src/http/server/blob/show-blob.test.ts
```

- Every one passes unchanged. `show-blob.test.ts` still proves the real handler refuses a hash that
  is not `sha256:` plus 64 hex.
- `git diff --name-only` names exactly `src/http/server/app.parity-path.test.ts`.

`npm run verify` exits 0.

### The whole Proof block

Run the EPIC's complete copy-paste Proof verbatim from its `## Verification Gate` — all 22 test
files. It must print `PASS EPIC-030`. Edit none of the eighteen pre-existing files; each must pass
unchanged.

## Proof ownership

| Proof line                                       | Owner   |
| ------------------------------------------------ | ------- |
| `src/http/server/app.handler-result.test.ts`     | Story 2 |
| `src/http/server/app.parity-body.test.ts`        | Story 3 |
| `src/http/server/app.parity-cors.test.ts`        | Story 4 |
| `src/http/server/app.parity-path.test.ts`        | Story 5 |
| the other 18 files, and the `PASS EPIC-030` echo | Story 5 |

Proof: this story delivers the `app.parity-path.test.ts` line, the eighteen regression lines and the
`PASS EPIC-030` echo of the EPIC Proof block, and rows P16, P17, P18 and P19 of the parity surface.
It delivers the gate bullet **"P19 asserts the header-name list as a value"**.
