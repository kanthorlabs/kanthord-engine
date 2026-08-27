# Story 2 — The adapter drains an in-flight request

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: Story 1 (`listen<E extends Env>` takes a `Hono<E>` and serves through `serve()`).

Two cases prove the two adapter properties the four existing cases do not reach: `close()` resolves
after an in-flight request answers, and the port reported for `port: 0` is the port that answers.

**Adds exactly 2 cases.** No production file changes. `src/http/server/start.test.ts` is the only
edited file, and it is the test-engineer lane (`scripts/lane-check.sh:78-80`).

## Change

### `src/http/server/start.test.ts`

**Edit 1 — one import.** Add, beside the existing imports at lines 1-23:

```ts
import { Hono } from "hono";
```

**Edit 2 — two cases.** Append both inside the `describe("src/http/server/start.test", ...)` block,
after the case that begins at `:81` and before the closing `});`. Write them in this order, with
these exact names:

```ts
it("close resolves after an in-flight request answers", async () => {
  const order: string[] = [];
  let entered: () => void = () => {};
  const hasEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = new Hono();
  app.get("/held", async (context) => {
    entered();
    await held;
    const response = context.text("ok");
    order.push("answered");
    return response;
  });

  const server = await listen(app, { bind: "127.0.0.1", port: 0 });
  const inflight = fetch(`http://127.0.0.1:${server.port}/held`, {
    headers: { connection: "close" },
  });
  await hasEntered;

  const closing = server.close().then(() => {
    order.push("closed");
  });
  release();
  const response = await inflight;
  await closing;

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.deepEqual(order, ["answered", "closed"]);
});

it("port 0 resolves the real bound port, and that port answers", async () => {
  const beforeRequest = globalThis.Request;
  const beforeResponse = globalThis.Response;
  const app = new Hono();
  app.get("/ping", (context) => context.text("pong"));

  const server = await listen(app, { bind: "127.0.0.1", port: 0 });
  try {
    assert.equal(Number.isInteger(server.port), true);
    assert.equal(server.port > 0, true);

    const response = await fetch(`http://127.0.0.1:${server.port}/ping`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pong");
    assert.equal(globalThis.Request, beforeRequest);
    assert.equal(globalThis.Response, beforeResponse);
  } finally {
    await server.close();
  }
});
```

Seven points of those cases are load-bearing, and each is verified by running the case rather than
inferred.

- **Both cases build a bare `new Hono()`, not `buildApp()`.** `buildApp` at `:25-40` sets
  `allowedHosts: ["kanthord.test"]`, so a request to `127.0.0.1` answers `403 host-forbidden` — which
  is exactly what the case at `:43` asserts. A case that must observe `200` therefore needs an
  application with no host check. A one-route `Hono` is also what the held handler needs.

- **`connection: "close"` on the in-flight request is required, and it is a speed fix, not a
  correctness fix.** Without it the case passes but takes about **3000 ms**, because `undici` holds
  the response socket open under keep-alive and `server.close()` waits for that socket. With the
  header the case takes about **20 ms**. Measured on both paths, and the assertion is identical.

- **The order is asserted with an array, never with a delay.** `order` records `"answered"` when the
  handler returns and `"closed"` when the `close()` promise resolves. `assert.deepEqual(order,
["answered", "closed"])` is the whole proof that the adapter drains. Do not add a `setTimeout`
  budget, and do not compare two `Date.now()` readings.

- **The array holds two members, not three.** Do not record when the client receives the response.
  The handler's own `order.push("answered")` already establishes the answer, and the client-side
  resolution races the socket close with no rule that fixes the winner.

- **`hasEntered` is a handshake, and a loop yield is not enough.** The handler resolves `hasEntered`
  on its first statement, and the test awaits it before calling `close()`. That proves the request
  reached the handler and is genuinely in flight. A single `setImmediate` yield does **not** prove
  it: one turn of the event loop is not a completed TCP connect plus request parse, so `close()` can
  win the race and the case then proves nothing. Do not substitute `setImmediate`, `setTimeout(0)` or
  a fixed delay.

- **`order.push("answered")` runs after the response object exists.** The handler builds
  `context.text("ok")` into a local, pushes, then returns it. Pushing before the response is
  constructed would record the handler's resumption rather than its answer.

- **Case 2 carries the global-object assertion, and it adds no case.** `globalThis.Request` and
  `globalThis.Response` are captured before `listen` and compared by identity after a request
  answers. This is the assertion that `overrideGlobalObjects: false` is in force; it replaces the
  cover that case 5 of `src/http/server/koa-bridge.test.ts` gives until story 3 deletes that file.
  It lives inside an existing case, so the pinned `+2` is unaffected.

- **Case 2 closes in a `finally`.** A failed assertion must not leak the listener. Case 1 cannot do
  the same, because its `close()` is the thing under test.

Change nothing else in the file. The four existing case names and every assertion in them stay byte
for byte, and the `buildApp` helper keeps the form story 1 left it in.

## Constraints

- **Edit no file under `src/http/server/` other than `start.test.ts`.** `start.ts` is finished in
  story 1 and takes no further change.
- **Add no case to any other file, and remove none.** This story moves the pass count by exactly
  `+2`.
- **Open no fixed port.** Both cases use `port: 0`. Do not call `reservePort` — the case at `:57`
  is the one case that needs a reserved port, and it already has it.
- **Close every server the case opens.** Case 1 closes through the assertion under test. Case 2
  closes in a `finally`. A leaked listener makes the suite non-hermetic.
- **Assert no wall-clock value, no timestamp and no elapsed duration.** A test that gates on a
  millisecond budget is a defect, not a speed check.

## Verify

```bash
node --test src/http/server/start.test.ts
```

- The file reports **6 passing cases**, in this order: the four names story 1 preserved, then
  `"close resolves after an in-flight request answers"`, then `"port 0 resolves the real bound port,
and that port answers"`.
- `node --test src/http/server/start.test.ts 2>&1 | grep -c '^# fail 0'` reports `1`.
- Run the file 10 times in a row; it passes 10 times. The ordering assertion is a handshake, not a
  race, and must not be flaky. Verified 10 of 10 on the shape above.
- No assertion reads a clock. The `connection: "close"` header is a speed measure only: without it
  the drain case still passes but waits about 3000 ms on the keep-alive socket. Do not turn that into
  a timing assertion.
- `npm run verify` exits 0.

Proof: this story delivers the `src/http/server/start.test.ts` row of the EPIC Proof block, and the
gate bullets **"Port 0 resolves to a real ephemeral port, asserted by value"**, **"An in-flight
request drains"**, the global-object identity guarantee of EPIC 032 Decision 12, and the `+2` half of **"The pass count falls by exactly 6 in story 3 ... Story 1
and story 2 raise the count by 2"**.
