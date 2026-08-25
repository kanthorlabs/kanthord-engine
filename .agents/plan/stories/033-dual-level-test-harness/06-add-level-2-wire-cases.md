# Story 6 — Add level-2 wire cases

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: Story 5.

## Change

### `src/http/server/shutdown-socket.test.ts` — new file

- Use `node:test`, `node:assert/strict`, Hono, and `node:http` `Server` types.
- Import `loopbackAgent` and `loopbackServer` from `test/helpers/agent.ts`.
- Import `koaFromHono` from `src/http/server/koa-bridge.ts`.
- Name the suite `src/http/server/shutdown-socket.test`.
- Add a local generic `deferred<T>()` with one promise and one resolver.
- Add `closeServer(server)` that wraps `server.close(callback)` in `Promise<void>`.
- Reject `closeServer` when the callback receives an error; otherwise resolve it.
- Add `portOf(server)` that narrows `server.address()` and returns its positive numeric port.
- Add exactly three cases in the following order.

1. `graceful shutdown drains an in-flight request to its full body`.
2. `a connection opened after shutdown starts is refused`.
3. `the listener closes`.

- In case 1, construct a fresh Hono application with one asynchronous route.
- The route resolves an `entered` signal, awaits a `release` gate, then returns `complete-body`.
- Wrap the Hono application once with `koaFromHono`.
- Obtain both the cached server and agent for that same bridge application.
- Start the Supertest request by calling `.then` and retain its response promise.
- Await `entered`, call `closeServer(server)`, then release the handler.
- Await the response before awaiting the close promise.
- Assert status 200 and text `complete-body`.
- Record `handler-entered`, `shutdown-started`, and `handler-released` at those three points.
- Record `response-complete` inside a `.then` on the retained response promise.
- Deep-equal that four-entry order after both promises settle.
- Record no entry inside the close callback. The close callback and the client resolution race.
- Prove the listener close by asserting `server.listening === false` after the close promise resolves.
- In case 2, construct a second Hono application and its own bridge, then read its port through `portOf`.
- Call `closeServer(server)` before attempting a new `fetch` to that exact loopback port.
- Assert rejection where `(error as { cause?: { code?: string } }).cause?.code` equals
  `ECONNREFUSED`, then await close.
- In case 3, construct a third Hono application and its own bridge.
- Assert `server.listening` is initially true.
- Await `closeServer(server)`, then assert `server.listening` is false and `server.address()` is null.

### `test/helpers/agent.test.ts`

- Append one case named `preserves two set-cookie values over the socket`.
- Construct a fresh Hono application and append `a=1` and `b=2` to `Set-Cookie` response headers.
- Wrap it with `koaFromHono`, then drive the bridge through `await loopbackAgent(app)`.
- Assert `response.headers["set-cookie"]` deep-equals `["a=1", "b=2"]`.
- Keep all nineteen prior cases unchanged.

## Constraints

- Add exactly four cases: three shutdown cases and one `set-cookie` case.
- Give each shutdown case a fresh application. Never reuse a closed cached server.
- Assert shutdown through signals and event order. Use no delay, timeout, fixed port, or wall clock.
- Order only events the test itself sequences. Never order a server callback against a client resolution.
- Bind only through `loopbackServer`; keep its implementation unchanged.
- Drive every new wire case through EPIC 032's `koaFromHono` bridge.
- Do not add a level-1 `set-cookie` assertion.
- Close every server created by `shutdown-socket.test.ts`.

## Verify

- Run the wire suite:

```bash
node --test \
  src/http/server/shutdown-socket.test.ts \
  test/helpers/agent.test.ts \
  src/http/server/shutdown.test.ts
```

- `shutdown-socket.test.ts` passes exactly three cases.
- `agent.test.ts` passes exactly twenty cases.
- The duplicate cookie assertion matches the exact two-element array.
- Run `npm run verify`; it exits 0.
- Proof: delivers the `shutdown.test.ts`, `shutdown-socket.test.ts`, and `agent.test.ts` lines.
- Proof: delivers the graceful-drain, connection-refusal, listener-close, and two-cookie gate bullets.
- Proof: the repository pass count rises by exactly four from Story 5.
