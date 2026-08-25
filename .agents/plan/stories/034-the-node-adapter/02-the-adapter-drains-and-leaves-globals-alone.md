# Story 2 — The adapter owns the wire behaviour the bridge proved

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: Story 1.

## Change

Add exactly seven cases to `src/http/server/start.test.ts`, after the existing case at line 81, in
this order. Six are the six cases of `src/http/server/koa-bridge.test.ts`, restated against the node
adapter, because Story 4 deletes that file and it is the only wire proof of each behaviour. The
seventh is the drain.

### Module-scope capture, before any case

At module scope, above `describe`, add:

```ts
const nativeRequest = globalThis.Request;
const nativeResponse = globalThis.Response;
```

Capture here and nowhere else. `node:test` runs cases in declaration order, so a capture inside case
6 would read references that an earlier `listen` already replaced, and the assertion would pass with
the flag removed.

### A single raw-socket helper

Add one module-scope helper, used by cases 5 and 6:

```ts
function rawSocketRequest(
  port: number,
  requestLine: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }>;
```

- Open the socket with `connect` from `node:net` against `127.0.0.1` and the given port.
- Write `requestLine` verbatim. The caller supplies the full head, terminator included.
- Accumulate every chunk into a `Buffer` with `Buffer.concat`, never a string, so case 2 can assert
  exact bytes.
- Resolve on `close`. Split the head on the first `\r\n\r\n`. Read the status from the second token
  of the status line. Lower-case every header name into the record. Return the remainder as the body.
- Reject on `error`.

### Case 1 — `a %2F path and a %zz path each reach the route intact`

- Build a hono application with one route that answers 200 with `c.req.path`.
- Request `/v1/a%2Fb` and assert the route receives the path with `%2F` intact and undecoded.
- Request `/v1/a%zzb` and assert the route receives it intact. `%zz` is not a valid escape, and it
  must not throw.
- This is case 1 of `src/http/server/koa-bridge.test.ts`.

### Case 2 — `a Uint8Array answer carries the exact content-length and the exact bytes`

- Answer a `Uint8Array` of ten known bytes from the route.
- Assert `content-length` equals `10` exactly, as a string.
- Assert the received body bytes deep-equal the sent bytes, compared as a `Buffer`.
- This is case 2 of `src/http/server/koa-bridge.test.ts`.

### Case 3 — `a 204 answer carries neither content-length nor content-type`

- Answer 204 from the route.
- Assert the status is 204, and that `content-length` and `content-type` are both absent from the
  header record.
- This is case 3 of `src/http/server/koa-bridge.test.ts`.

### Case 4 — `a POST body reaches the route with its whitespace intact`

- Answer 200 with the exact string `await c.req.text()` returns.
- POST a body carrying interior and trailing whitespace, for example `{ "a" :  1 }\n`.
- Assert the echoed body equals the sent body byte for byte.
- This is case 4 of `src/http/server/koa-bridge.test.ts`.

### Case 5 — `listen leaves the global Request and Response untouched`

- Assert `globalThis.Request === nativeRequest` and `globalThis.Response === nativeResponse`, by
  identity with `assert.equal`, against the module-scope captures.
- This is case 5 of `src/http/server/koa-bridge.test.ts`.

### Case 6 — `a request with no Host header answers 403 host-forbidden`

- `listen(buildApp(), { bind: "127.0.0.1", port: 0 })`, and register the close in `after`.
- Call `rawSocketRequest(server.port, "GET /v1/health HTTP/1.0\r\n\r\n")`. The request line must be
  HTTP/1.0: llhttp answers 400 for an HTTP/1.1 request with no `Host` header, before the application
  runs, and Node's HTTP client always writes the header.
- Assert the status is `403`.
- Assert `JSON.parse(body).error.code` equals `host-forbidden`.
- Assert `JSON.parse(body).error.message` equals exactly `the request carried no Host header`.
- This is case 6 of `src/http/server/koa-bridge.test.ts`, restated against
  `bindAuthority(input.bind)`.

### Case 7 — `an in-flight request drains before close resolves`

- The shared `buildApp` at line 25 sets `allowedHosts: ["kanthord.test"]`, so a request to the
  loopback port answers 403. This case needs a 200, so it builds a standalone `new Hono()` with one
  route and calls `listen` on it directly. It does not call `createApp`, so it needs no allow list,
  no reserved port and no `reservePort`; `port: 0` is enough.
- The route resolves an `entered` signal, awaits a `release` gate, then answers 200 with the exact
  text `complete-body`.
- Add a local generic `deferred<T>()` with one promise and one resolver. Use it for both signals.
- Start the request with `fetch` and retain its response promise. Do not await it yet.
- Await `entered`. Call `server.close()` and retain its promise. Release the gate.
- Push `handler-entered`, `shutdown-started` and `handler-released` into an `order` array at those
  three points. Push `close-resolved` in a `.then` on the retained close promise.
- Await the response, then await the close promise.
- Assert the response status is 200 and its text is `complete-body`.
- Assert `order.indexOf("close-resolved") > order.indexOf("handler-released")`. That is the drain:
  the close promise cannot settle until the held request finishes.
- Do **not** assert a position for the client resolution. The close callback and the client
  resolution race, so ordering them is a defect. Asserting only the four-entry sequence
  `handler-entered, shutdown-started, handler-released, response-complete` proves nothing, because
  that order holds even when `close()` resolves immediately.

## Constraints

- Add exactly 7 cases. Remove 0.
- Add no helper beyond `rawSocketRequest` and the local `deferred<T>()`.
- Add no port case. `src/http/server/start.test.ts:43` already resolves `port: 0`, asserts
  `server.port > 0` and fetches `http://127.0.0.1:${server.port}/v1/health`. It is the port oracle,
  and a second case proves nothing further.
- Assert case 7 by recorded order only. Use no delay, no timeout and no wall clock.
- Close every server through `after`, so a failed assertion leaves no listening socket.
- Cases 1 to 4 assert wire bytes and wire headers. Read them through `rawSocketRequest` or through
  `fetch`, never through a level-1 fetch agent, which never touches the node adapter.
- The exact refusal message lives at `src/http/server/host.ts:18`. Assert the literal string, never a
  pattern.

## Verify

- `node --test src/http/server/start.test.ts` passes 11 cases: the 4 that existed and these 7.
- `node --test --test-reporter=tap src/http/server/start.test.ts 2>&1 | grep -m1 '^# pass'` reports
  `# pass 11`.
- Case 5 fails if `overrideGlobalObjects: false` is removed from `src/http/server/start.ts`. Confirm
  by deleting the option, running the whole file, and seeing case 5 fail; then restore it. A capture
  taken inside the case instead of at module scope does **not** fail this check, and that is the
  point of the module-scope rule.
- Case 6 fails if `bindAuthority` is replaced by the raw bind and the bind is `::`. The case runs on
  `127.0.0.1`, where both forms agree, so its guard is `src/domain/host-authority.test.ts` from
  Story 1 plus the `grep -n "serve(" src/http/server/start.ts` gate.
- Case 7 fails if `close()` resolves before the held request answers.
- `npm run verify` exits 0.
- Proof: contributes `src/http/server/start.test.ts` of the EPIC Proof block.
