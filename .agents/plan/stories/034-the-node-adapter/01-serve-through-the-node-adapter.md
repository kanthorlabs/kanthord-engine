# Story 1 — `start.ts` serves through `@hono/node-server`

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: EPIC 032 (`createApp` returns `hono: Hono<AppEnv>`), EPIC 033 (dual-level harness).

## Change

### `src/domain/host-authority.ts` — export the bracket rule

- Add `export function bindAuthority(bind: string): string`. It returns `` `[${bind}]` `` when `bind`
  contains `:`, and `bind` otherwise.
- Change line 25 to use it: `const authority = bindAuthority(input.bind);`. `deriveAllowedHosts`
  keeps its behaviour byte for byte.
- The file stays pure. It imports nothing new.

### `src/http/server/start.ts` — rewrite

- Delete `import type Koa from "koa"` at line 1.
- Keep `import type { Server } from "node:http"` and add `createServer` as a value import from
  `node:http`.
- Add `import type { Env, Hono } from "hono"`.
- Add `import { getRequestListener } from "@hono/node-server"`.
- Add `import { bindAuthority } from "../../domain/host-authority.ts"`.
- Keep `ListenInput` and `ListeningServer` byte for byte.
- Change the signature at line 11 to end in `{`, not `;`:

```ts
export function listen<E extends Env>(
  app: Hono<E>,
  input: ListenInput,
): Promise<ListeningServer> {
```

- Replace `const server: Server = app.listen(input.port, input.bind);` at line 13 with:

```ts
const server: Server = createServer(
  getRequestListener(app.fetch, {
    hostname: bindAuthority(input.bind),
    overrideGlobalObjects: false,
  }),
);
server.listen(input.port, input.bind);
```

- Do **not** use `serve()` from `@hono/node-server`. `serve()` passes its one `hostname` option to
  both `server.listen` (`dist/index.mjs:1305`) and the request listener's URL-authority fallback
  (`:1010`). Those need different values: `server.listen` needs the raw bind, and the authority needs
  the bracketed form. With `bind: "::"` a request that carries no `Host` header answers **400** and
  never reaches `hostMiddleware`. With `bindAuthority("::")` it answers the `host-forbidden` 403 the
  product answers today.
- `overrideGlobalObjects: false` is mandatory. Its default is `true`, at
  `node_modules/@hono/node-server/dist/index.mjs:996`, and `true` replaces `global.Request` and
  `global.Response`.
- The annotation stays `Server`, not `ServerType`. `createServer` from `node:http` returns `Server`,
  so no union is introduced.
- Keep lines 14-37 unchanged: the `closed` flag, `server.once("error", reject)`,
  `server.once("listening", ...)`, the `server.address()` read, the
  `address !== null && typeof address === "object" ? address.port : input.port` fallback, and the
  `close()` that resolves immediately when `closed` is true and otherwise sets `closed = true` and
  calls `server.close(() => resolveClose())`.

### `src/domain/host-authority.test.ts` — one case

- Add exactly one case named `brackets an IPv6 bind and leaves every other bind alone`.
- Table over four pairs, asserted with `assert.equal`:
  `["0.0.0.0", "0.0.0.0"]`, `["127.0.0.1", "127.0.0.1"]`, `["::", "[::]"]`, `["::1", "[::1]"]`.
- Keep every existing case name and assertion.

### `src/http/server/start.test.ts` — retarget the helper only

- `buildApp` at lines 25-40 ends `const { app } = created; return app;`. Change it to read the
  `hono` half: `const { hono } = created; return hono;`.
- The second `createApp` call at lines 107-119 ends `const { app } = created;` at line 119. Change it
  to `const { hono } = created;` and pass `hono` to `listen` at line 120.
- Change no case name and no assertion. The four cases at lines 43, 57, 74 and 81 stay as they are.

### `src/main.ts` — two lines

- Line 647: change `const { app, cancelWaits } = createApp({` to
  `const { hono, cancelWaits } = createApp({`.
- Line 667: change `const listening = await listen(app, {` to `const listening = await listen(hono, {`.
- Change nothing else. `App` still carries the `app` half at this point; story 4 drops it.

## Constraints

- Add exactly 1 case, in `src/domain/host-authority.test.ts`. Remove 0.
- Do not edit `src/http/server/shutdown.ts`. `createShutdownSteps` at `src/http/server/shutdown.ts:45`
  takes `listening: { close(): Promise<void> }` structurally and needs no change.
- Do not read the port from a `serve()` callback. One path reports the port, and it is the
  `server.address()` read inside the `listening` handler.
- Do not add an error class, and do not change any message. A bound port still rejects with the node
  error whose `code` is `EADDRINUSE`, through the same `once("error", reject)`.
- `bindAuthority` returns a host with no port. The port is not part of the authority fallback, and
  `hostMiddleware` reads the request header rather than the URL.
- Do not edit `package.json` or `package-lock.json`. `@hono/node-server` 2.1.1 is already installed.
- `src/main.ts` takes its only edit here, not in a later story.

## Verify

- `node --test src/domain/host-authority.test.ts` passes, including the new case.
- `node --test src/http/server/start.test.ts` passes all four cases, with their existing names.
- `node --test src/http/server/shutdown.test.ts` passes, including
  `the production steps run cancelWaits before listener close through the shared factory` at line 274.
- `node --test src/main.test.ts` passes, including
  `every routed operation answers and none resolves to the shared 501 handler` at line 264.
- `grep -n "overrideGlobalObjects" src/http/server/start.ts` reports exactly one line, reading `false`.
- `grep -n "serve(" src/http/server/start.ts` returns nothing.
- `grep -rni "koa" src/http/server/start.ts` returns nothing.
- `npm run verify` exits 0.
- Proof: contributes `src/http/server/start.test.ts`, `src/http/server/shutdown.test.ts` and
  `src/main.test.ts` of the EPIC Proof block. The `PASS EPIC-034` marker is delivered by Story 4.
