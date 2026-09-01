# Story 1 — `start.ts` serves through `@hono/node-server`

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: EPIC 032 (`createApp` returns an `App` that carries `hono: Hono<AppEnv>`).

`listen` becomes generic over `Env`, takes a `Hono<E>` and serves it through `serve()`. `src/main.ts` passes the `hono` half in the
same commit. The exported names, the `ListeningServer` shape, the ephemeral-port resolution, the
idempotent `close()` and the bind-failure rejection do not change.

**Adds exactly 0 cases.** The four case names of `src/http/server/start.test.ts` stay.

Lane split: `src/http/server/start.ts` and `src/main.ts` are the software-engineer lane
(`scripts/lane-check.sh:75-83`). `src/http/server/start.test.ts` is the test-engineer lane
(`scripts/lane-check.sh:78-80`).

## Change

### 1. `src/http/server/start.ts` — the whole file

The file holds 39 lines at the base commit and neither EPIC 032 nor EPIC 033 edits it. Replace it in
full with:

```ts
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono, Env } from "hono";

export type ListenInput = Readonly<{ bind: string; port: number }>;

export type ListeningServer = Readonly<{
  port: number;
  close(): Promise<void>;
}>;

export function listen<E extends Env>(
  app: Hono<E>,
  input: ListenInput,
): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const server: ServerType = serve({
      fetch: app.fetch,
      hostname: input.bind,
      port: input.port,
      overrideGlobalObjects: false,
    });
    let closed = false;
    server.once("error", (error) => {
      reject(error);
    });
    server.once("listening", () => {
      const address = server.address();
      const port =
        address !== null && typeof address === "object"
          ? address.port
          : input.port;
      resolve({
        port,
        close() {
          return new Promise<void>((resolveClose) => {
            if (closed) {
              resolveClose();
              return;
            }
            closed = true;
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}
```

Five points of that file are load-bearing, and each is verified against `@hono/node-server` 2.1.1
and this repository's `tsconfig.json` rather than inferred.

- **`listen` is generic over `Env`, and a bare `Hono` parameter does not compile.** The EPIC's story
  text says to change the first parameter to `app: Hono`. `Hono` defaults to `Hono<BlankEnv>`, and
  `createApp` returns `hono: Hono<AppEnv>`. Passing it fails
  `TS2345: Argument of type 'Hono<AppEnv, BlankSchema, "/">' is not assignable to parameter of type
'Hono<BlankEnv, BlankSchema, "/">'`, because `Hono`'s env parameter is invariant through its handler
  signatures — the same invariance that forces the `WeakMap` key type in story 3.
  `listen<E extends Env>(app: Hono<E>, …)` accepts both `Hono<AppEnv>` and the bare `new Hono()` that
  story 2 builds. Verified by compiling both call sites.

- **The annotation is `ServerType`, not `Server`.** `serve` returns
  `Server | Http2Server | Http2SecureServer`. `const server: Server = serve(...)` fails with
  `TS2322: Type 'ServerType' is not assignable to type 'Server<typeof IncomingMessage, typeof
ServerResponse>'`. The EPIC's Decisions say `serve()` returns a `node:http` server and story 1 says
  to keep the `Server` annotation; the declared return type is the union, so the annotation moves to
  `ServerType` and the `node:http` import leaves the file. `once`, `address()` and `close(callback)`
  are all declared on every member of the union, so no other line changes and no cast is added.

- **`overrideGlobalObjects: false` is mandatory.** The option defaults to true
  (`node_modules/@hono/node-server/dist/index.mjs:996` reads
  `options.overrideGlobalObjects !== false`), and the true path runs
  `Object.defineProperty(global, "Request", ...)` and the same for `Response`. EPIC 032 Decision 12
  already ruled that this process-wide effect is one "no hermetic suite may carry", and
  `src/http/server/start.test.ts` calls `listen` inside the suite. The same rule therefore binds this
  call. EPIC 031 makes the response model fetch-native, so the daemon wants the platform
  `Request` and `Response` in any case.

- **The two `once` handlers stay, and they are attached after `serve()` returns.** `serve` calls
  `server.listen()` synchronously and the `listening` event is emitted on a later tick, so a handler
  attached on the next line still observes it. This is the same ordering the koa `app.listen(...)`
  call relies on today.

- **The port is read from `server.address()` and from nowhere else.** The `serve()` second argument
  is a `listeningListener` that receives an `AddressInfo`. Do not use it. One path reports the port,
  which is what the Verification Gate requires.

### 2. `src/main.ts` — two lines

`src/main.ts` is untouched by EPIC 032 and EPIC 033, so both sites keep the line numbers they hold
today.

**Edit 1 — line 647.** It reads today:

```ts
      const { app, cancelWaits } = createApp({
```

Replace it with:

```ts
      const { hono, cancelWaits } = createApp({
```

**Edit 2 — line 667.** It reads today:

```ts
      const listening = await listen(app, {
```

Replace it with:

```ts
      const listening = await listen(hono, {
```

Change no other line of `src/main.ts`. `cancelWaits` still reaches `createShutdownSteps` at `:673`,
and the `catch` at `:690-708` is untouched: an `EADDRINUSE` rejection matches none of the six named
error classes, so it rethrows exactly as today.

`App` still carries the `app: Koa` half after this story. Story 3 drops it.

### 3. `src/http/server/start.test.ts` — the `buildApp` helper only

Replace line 38, inside `buildApp`. It reads today:

```ts
const { app } = created;
```

Replace it with:

```ts
const { hono } = created;
```

and replace line 39, which reads `  return app;`, with `  return hono;`.

Change nothing else in the file. Lines 26-37 construct `createApp` with the same six dependencies,
and EPIC 032 keeps that signature. The four case names at `:43`, `:57`, `:74` and `:81` and every
assertion in them stay byte for byte.

## Constraints

- **Do not edit `package.json` or `package-lock.json`.** `scripts/lane-check.sh:41` denies both to
  every agent lane. `@hono/node-server` 2.1.1 is already declared and installed.
- **Do not delete `koa`, `@koa/cors`, `@koa/bodyparser`, `@types/koa` or `@types/koa__cors`.** EPIC
  035 removes them, and the manifest is locked in any case.
- **Do not edit `src/http/server/shutdown.ts`.** `createShutdownSteps` takes
  `listening: { close(): Promise<void> }` structurally, and `ListeningServer` still satisfies it.
- **Do not edit `src/http/server/app.ts`.** The `app: Koa` half of `App` stays until story 3.
- **Do not move `systemSchedule`.** It stays in `src/http/server/app.ts`. EPIC 035 owns the move.
- **Do not add a request-body size limit, an error handler option, or a `listeningListener`.** The
  `serve()` call carries four members and no more.
- **Add no case and remove no case.**

## Verify

```bash
node --test \
  src/http/server/start.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/server/event/wait.test.ts \
  src/main.test.ts \
  src/main.event-wait.test.ts \
  src/main.authorization.test.ts \
  src/main.capability.test.ts
```

- `src/http/server/start.test.ts` passes with its four case names unchanged:
  - `"listen on port 0 resolves a real port and the middleware runs over a real socket"` still
    asserts `server.port > 0`, then a fetch of `/v1/health` answering `403` with
    `body.error.code === "host-forbidden"`.
  - `"two listen calls on one explicit port: the first resolves, the second rejects with EADDRINUSE"`
    still asserts `code === "EADDRINUSE"` on the second rejection, that the rejection is not an
    `HttpError`, and that the first listener stays resolved.
  - `"close resolves, and a second close also resolves without throwing"` still calls `close()` twice
    and asserts neither throws.
  - `"the registry, renderer, middleware, queries, handlers and client run against one socket"` still
    drives `system.health`, `system.db`, `system.status` as `not-implemented`, and `degraded` health
    after the storage closes.
- `src/http/server/event/wait.test.ts` passes **with no edit**. It owns `POLL_INTERVAL_MS = 250` and
  the wait registry that `cancelWaits` settles, and the shutdown order `waits` before `listener` is
  unchanged, so nothing in it observes the adapter swap.
- The four `src/main.*.test.ts` files pass **with no edit**. `git diff` over them reports no changed
  file.
- `grep -c "from \"koa\"" src/http/server/start.ts` reports `0`.
- `grep -c "node:http" src/http/server/start.ts` reports `0`.
- `grep -c "overrideGlobalObjects: false" src/http/server/start.ts` reports `1`.
- `grep -cE "\{ app, cancelWaits \}|listen\(app," src/main.ts` reports `0`.
- `npm run verify` exits 0.

Proof: this story delivers the `src/http/server/start.test.ts`, `src/http/server/shutdown.test.ts`,
`src/http/server/event/wait.test.ts`, `src/main.test.ts`, `src/main.event-wait.test.ts`,
`src/main.authorization.test.ts` and `src/main.capability.test.ts` rows of the EPIC Proof block, and the gate bullets **"The daemon boots
and answers a request end to end"**, **"A second `close()` resolves and does not throw"**, **"A bound
port rejects with the same reported message"**, **"Graceful shutdown runs the four steps in order"**
and **"A pending long poll settles before the listener closes"**.
