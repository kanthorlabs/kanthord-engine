# EPIC 034 — The node adapter — stories

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Prereq: EPIC 033 (sequence order).

`src/http/server/start.ts` serves the hono application through `@hono/node-server`, and no file names
koa afterwards.

## Dispatch order

1. `01-serve-through-the-node-adapter.md` swaps the listener and retargets `src/main.ts`.
2. `02-the-adapter-drains-and-leaves-globals-alone.md` restates the six bridge cases against the
   adapter and adds the drain.
3. `03-the-level-2-harness-runs-against-the-adapter.md` moves the socket harness off the bridge and
   deletes `koa-bridge.test.ts`.
4. `04-delete-the-koa-bridge.md` deletes `koa-bridge.ts` and drops the `app` half.

Stories 1 and 2 are a coupled pair over `src/http/server/start.ts` and `src/http/server/start.test.ts`;
story 2 must land before story 3, because story 3 deletes the file story 2 copies from. Story 4 fails
`npm run typecheck` if story 3 leaves any `koaFromHono` caller behind. Story 4 runs last and owns the
full Proof.

## Stories

- 1 — `start.ts` serves through `@hono/node-server` -> `01-serve-through-the-node-adapter.md`
- 2 — Restate the six bridge cases and add the drain -> `02-the-adapter-drains-and-leaves-globals-alone.md`
- 3 — Move the level-2 harness to `getRequestListener` -> `03-the-level-2-harness-runs-against-the-adapter.md`
- 4 — Delete `koa-bridge.ts` and drop the `app` half -> `04-delete-the-koa-bridge.md`

## Facts (needed for implementation)

- `@hono/node-server` 2.1.1 is installed. `node_modules/@hono/node-server/dist/index.mjs:996` reads
  `if (options.overrideGlobalObjects !== false && global.Request !== Request$1)`, so the default is
  **true** and it replaces `global.Request` and `global.Response`. Pass `false` at both call sites.
- **`serve()` is not used.** It feeds its one `hostname` option to both `server.listen`
  (`dist/index.mjs:1305`) and the request listener's URL-authority fallback (`:1010` ->
  `newRequest:589`, `const host = incoming.headers.host || defaultHostname`). Those need different
  values for an IPv6 bind. Measured on this tree, for a raw `GET /v1/health HTTP/1.0` with no Host
  header: `hostname: "::"` answers **400** and never reaches the application; `hostname: "[::]"`
  answers 200 with `req.url === "http://[::]/v1/health"` and a null host header, which reaches
  `hostMiddleware` and yields the 403. `0.0.0.0` and `127.0.0.1` behave the same either way.
  `src/domain/host-authority.ts:3` declares `wildcardBinds = ["0.0.0.0", "::"]`, so `::` is a
  supported bind, and `host-authority.ts:25` already carries the bracket rule.
- `dist/index.d.mts:78` — `serve: (options: Options, listeningListener?) => ServerType`.
  `dist/index.d.mts:87` — `getRequestListener: (fetchCallback, options?: { hostname?, errorHandler?,
overrideGlobalObjects?, autoCleanupIncoming? }) => (incoming, outgoing) => Promise<void>`.
  `dist/index.d.mts:46` — `type ServerType = Server | Http2Server | Http2SecureServer`.
- `src/http/server/start.ts:11` is `listen(app: Koa, input: ListenInput)`; the body spans lines 12-38
  and every line except 13 survives unchanged.
- `src/main.ts:647` destructures `{ app, cancelWaits }`; `src/main.ts:667` calls `listen(app, ...)`.
  Those are the only two `src/main.ts` lines this epic touches.
- `src/http/server/shutdown.ts:45` — `createShutdownSteps` takes
  `listening: { close(): Promise<void> }` structurally, so it needs no edit.
- `src/http/server/host.ts:18` throws `httpError("host-forbidden", "the request carried no Host header")`
  when the header is absent. `src/http/contract/errors.ts:11` maps `host-forbidden` to 403, and
  `errors.ts:113-120` renders the body as `{"error":{"code":...,"message":...}}` with `details`
  omitted when undefined.
- Node's llhttp answers 400 for an HTTP/1.1 request with no `Host` header, before application code
  runs. Only an HTTP/1.0 request line reaches `hostMiddleware` with `headers.host === undefined`.
  `scripts/e2e/lib/driver/local.ts:100-130` is the raw-socket shape to mirror.
- `test/helpers/agent.ts:14` is `createServer(app.callback())`, and `:6` is
  `new WeakMap<Koa, Promise<Server>>()`. The server is `unref()`'d and bound to `127.0.0.1:0`.
- `test/helpers/app.ts:139` is `const raw = await loopbackAgent(app);`. EPIC 033 story 3 splits this
  into `createTestApp` on `fetchAgent(created.hono)` and `createSocketTestApp` on
  `loopbackAgent(created.app)`. Only the second changes here.
- `src/http/server/host.test.ts:10-18` and `src/http/server/idempotency.test.ts:64-116` build their
  application directly and never call `createApp`. From EPIC 032 story 6 and story 13 each builds a
  `Hono` application and wraps it with `koaFromHono` to reach `loopbackAgent`, which is why EPIC 032
  story 15 dispatches before story 6.
- `src/http/server/idempotency.test.ts:118-145` is `rawRequest`, and `:712` is its only call site,
  through `loopbackServer(app)`.
- `src/http/server/shutdown-socket.test.ts` and the `preserves two set-cookie values over the socket`
  case of `test/helpers/agent.test.ts` are created by EPIC 033 story 6, and both wrap with
  `koaFromHono`. Story 3 takes both.
- `test/helpers/port.ts:3` — `reservePort(): Promise<number>` binds an ephemeral port, reads it, then
  closes the probe before resolving.
- `src/http/server/koa-bridge.test.ts` holds exactly 6 cases, enumerated at EPIC 032 story 15. **All
  six** move to Story 2 of this epic, restated against the node adapter; Story 3 then deletes the
  file. Case 5 is the `global.Request` / `global.Response` identity, and case 6 is the no-Host
  authority case.
- Case counts: story 1 adds 1 (in `src/domain/host-authority.test.ts`), story 2 adds 7, story 3
  removes 6, story 4 moves nothing. Net +2. `src/http/server/start.test.ts` goes from 4 cases to 11.
- The 1 MiB request body limit is **not** in this epic. EPIC 032 Decision 13 places it in
  `src/http/server/body.ts`.
