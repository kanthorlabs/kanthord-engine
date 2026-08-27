# Story 3 — Body-parsing parity

Epic: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`
Depends on: Story 1 (the proposal states the body rule).

Add one file: `src/http/server/app.parity-body.test.ts`. **No production file changes.**
`git diff --name-only` for this commit names exactly that one path.

Delivers P3, P4, P5 and P6.

## Change

### `src/http/server/app.parity-body.test.ts` — new file

Header:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import type { HandlerContext } from "./app.ts";
```

Suite name: `describe("src/http/server/app.parity-body.test", () => {`.

#### The recording handler

Use the in-place closure of `src/http/server/dispatch.test.ts:247-261`. Add no shared helper.

```ts
async function recordingApp() {
  const calls: HandlerContext[] = [];
  const app = await createTestApp({
    handlers: {
      "repository.register": (context) => {
        calls.push(context);
        return { status: 200, body: { ok: true } };
      },
    },
  });
  return { app, calls };
}
```

`repository.register` is `POST /v1/repository`, `routed`, with no path parameter
(`src/http/contract/repository.ts:191-208`). Binding it leaves every other routed operation in
`unimplemented`, because `createTestApp` derives that list with `unimplementedFor(handlers)`
(`test/helpers/app.ts:130`).

#### The three empty-body tests

Each drives the full chain and asserts the recorded body by exact deep equality with `{}`.

- **`a POST with no body reaches the handler with an empty object body`** (P3) —
  `await app.post("/v1/repository")`. Assert `response.status` equals `200`, `calls.length` equals
  `1`, and `assert.deepEqual(calls[0]?.body, {})`.
- **`a POST with text/plain reaches the handler with an empty object body`** (P4) —
  `await app.post("/v1/repository").set("Content-Type", "text/plain").send("hello")`. Assert
  `response.status` equals `200`, `calls.length` equals `1`, and
  `assert.deepEqual(calls[0]?.body, {})`. Also assert `JSON.stringify(calls[0]?.body)` equals `"{}"`,
  so the payload `hello` survives under no name.
- **`a POST with a zero-length JSON body reaches the handler with an empty object body`** (P5) —
  `await app.post("/v1/repository").set("Content-Type", "application/json").send("")`. Assert
  `response.status` equals `200`, `calls.length` equals `1`, and
  `assert.deepEqual(calls[0]?.body, {})`.

Assert **no message text** in any of the three. Each test builds its own app through
`recordingApp()`, so `calls.length` is `1` in each.

Verified: all three answer `200` with a recorded body of `{}`.

#### The two unbound-operation tests

`project.create` is `POST /v1/project`, `routed`, and it is **not** bound above, so it is in
`unimplemented` and `dispatchMiddleware` throws at `src/http/server/dispatch.ts:26-32`.

- **`a routed operation with no bound handler answers 501 with a malformed body and records no
call`** (P6) — on the same app,
  `await app.post("/v1/project").set("Content-Type", "application/json").send('{"oops')`. Assert
  `response.status` equals `501`, `calls.length` equals `0`, and

  ```ts
  assert.deepEqual(response.body, {
    error: {
      code: "not-implemented",
      message: "project.create is not implemented yet",
    },
  });
  ```

  The whole envelope by deep equality, matching `dispatch.test.ts:88-102`. A malformed payload must
  not turn this into a `400`.

- **`a routed operation with no bound handler answers 501 with a valid body and records no call`**
  (P6) — `await app.post("/v1/project").set("Content-Type", "application/json").send('{"name":"a"}')`.
  Assert the identical status, the identical envelope by deep equality, and `calls.length` equals
  `0`. The two answers must be identical.

Verified: `POST /v1/project` on an app that binds only `repository.register` answers `501` with
exactly that envelope.

## Constraints

- **Change no production file.** `bodyParserForHandled` at `src/http/server/app.ts:115-140` keeps its
  condition, and the middleware order at `app.ts:82-106` is untouched.
- **Drive the chain through `createTestApp`.** Do not call `bodyParserForHandled` or any other
  middleware factory directly, and do not construct a `Koa` instance in this file.
- **Bind exactly one handler.** A second binding removes the `501` this story asserts.
- **Never bind a stubbed operation.** `createApp` throws `BindingError` for one
  (`src/http/server/app.ts:151-177`). Use `project.create`, which is `routed`. `node.abandon` is
  `stubbed` and belongs to P2, already pinned at `dispatch.test.ts:88`.
- **Compare the recorded body with `{}` by deep equality.** Do not assert `typeof`, a key count, or
  `undefined`.
- **Keep the injected defaults.** `createTestApp` supplies `now: () => 0` and
  `schedule: () => () => {}`. Override neither.
- Do not import the real `registerRepositoryHandler`. Its zod `400` would hide the recorded body.
- Do not assert `app.internalErrors()`.

## Verify

```bash
node --test src/http/server/app.parity-body.test.ts
```

- All five tests pass on the current stack, first run, with no production change.

```bash
node --test src/http/server/dispatch.test.ts \
  src/http/server/credential/register-provider.test.ts \
  src/http/server/app.test.ts
```

- Every one passes unchanged. `register-provider.test.ts:104-129` still pins P1: a bound handler
  with a malformed body answers `400 invalid-request`.
- `git diff --name-only` names exactly `src/http/server/app.parity-body.test.ts`.

`npm run verify` exits 0.

Proof: this story delivers the `app.parity-body.test.ts` line of the EPIC Proof block, and rows P3,
P4, P5 and P6 of the parity surface. It delivers the gate bullet **"Each parity test drives the full
chain through `createTestApp`"** for this file.
