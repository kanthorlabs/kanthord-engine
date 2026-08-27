# Story 3 — The level-2 socket harness runs against the adapter

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: Story 2, EPIC 033 story 6 (`src/http/server/shutdown-socket.test.ts` and the
`set-cookie` case exist).

## Change

### `test/helpers/agent.ts` — the primitive

- Add `import { getRequestListener } from "@hono/node-server"`.
- Delete `import type Koa from "koa"` at line 4.
- Import `Env` and `Hono` types from `hono`, matching the `fetchAgent` signature EPIC 033 story 2
  adds to this same file.
- Change line 6 to `const servers = new WeakMap<object, Promise<Server>>();`.
- Change the `loopbackServer` signature at line 8 to
  `export function loopbackServer<E extends Env>(app: Hono<E>): Promise<Server>`.
- Change the `loopbackAgent` signature at line 25 to
  `export async function loopbackAgent<E extends Env>(app: Hono<E>): Promise<ReturnType<typeof request>>`.
- Replace `createServer(app.callback())` at line 14 with:

```ts
createServer(
  getRequestListener(app.fetch, {
    hostname: "127.0.0.1",
    overrideGlobalObjects: false,
  }),
);
```

- `127.0.0.1` is the address `server.listen(0, "127.0.0.1")` binds on the next line. Both options are
  mandatory; `overrideGlobalObjects` defaults to `true`.
- Keep lines 9-12, `server.unref()`, `server.once("error", reject)`,
  `server.listen(0, "127.0.0.1", ...)`, `servers.set(app, listening)` and the early return byte for
  byte.
- Do not import or call `listen` from `src/http/server/start.ts`. `listen` returns `ListeningServer`,
  which carries `port` and `close` only, and this helper needs the `Server` object.

### The socket callers — six files, roughly nine call sites

Story 4 deletes `koaFromHono` and `src/http/server/koa-bridge.test.ts`, so every caller changes here.
An unedited caller breaks `npm run typecheck` in story 4. Count call sites, not files: the grep gate
below is the authority, not this list.

1. `test/helpers/agent.test.ts` — replace each `new Koa()` with `new Hono()` and delete the koa
   import. Three cases construct a bare application and need no body. The fourth,
   `drives the app over that server` at line 29, sets `context.status = 200` and
   `context.body = { reached: true }`, which no constructor swap converts. Replace that body with
   exactly:

   ```ts
   const app = new Hono();
   app.all("*", (c) => c.json({ reached: true }));
   ```

   Its two assertions — status 200 and `response.body` deep-equal `{ reached: true }` — do not
   change. In the `preserves two set-cookie values over the socket` case that EPIC 033 story 6
   appends, delete the `koaFromHono` wrap and pass the hono application to `loopbackAgent`. Its
   assertion that `response.headers["set-cookie"]` deep-equals `["a=1", "b=2"]` does not change.
   Delete the `koaFromHono` import if no case still names it.

2. `test/helpers/app.ts` — `createSocketTestApp`, which EPIC 033 story 3 exports as a call using
   `loopbackAgent(created.app)`, changes to `loopbackAgent(created.hono)`. The level-1
   `createTestApp` beside it already passes `created.hono` and takes no edit.
3. `src/http/server/host.test.ts` — `buildApp` at lines 10-18 returns the application that reaches
   `loopbackAgent`. Pass the hono application where the file wraps it with `koaFromHono(...)`, and
   delete the wrap and its import.
4. `src/http/server/idempotency.test.ts` — the same edit at its `buildApp` site (lines 64-116, which
   ends `const agent = await loopbackAgent(app)` at line 114) and at the `loopbackServer(app)` call
   at line 712.
5. `src/http/server/shutdown-socket.test.ts` — each of its three cases wraps a fresh hono
   application with `koaFromHono` before it reaches `loopbackServer` and `loopbackAgent`. Delete the
   `koaFromHono` import and all three wraps, and pass each hono application straight through. The
   `WeakMap` cache key becomes the hono application itself, so `loopbackServer` and `loopbackAgent`
   must receive the _same_ hono reference in case 1, exactly as they receive the same bridge
   reference today.

6. `src/http/server/app.test.ts` — the HTTP/1.0 no-Host case reaches the socket through the
   application returned by `createApp`. Change `loopbackServer(created.app)` to
   `loopbackServer(created.hono)`. Change no case name or assertion.

### `src/http/server/koa-bridge.test.ts` — delete

Delete the file, and its 6 cases with it. Story 2 restated all six against the node adapter, so no
behaviour loses its proof. The deletion belongs here rather than in story 4, because story 4 deletes
production files only and a test file deleted there contradicts its own scope line.

`src/http/server/blob/show-blob.test.ts` reaches the socket only through `createSocketTestApp`, so it
takes no edit at all.

## Constraints

- Add exactly 0 cases. Remove exactly the 6 cases of `src/http/server/koa-bridge.test.ts`, which
  EPIC 032 story 15 enumerates and story 2 restated.
- Change no case name and no assertion in any of the six files, including the two `set-cookie`
  values and the three `src/http/server/shutdown-socket.test.ts` case names.
- Keep the three exported names of `test/helpers/agent.ts` — `loopbackServer`, `loopbackAgent`,
  `fetchAgent` — and the two factory names of `test/helpers/app.ts` — `createTestApp`,
  `createSocketTestApp`. `test/helpers/socket-budget.test.ts` counts files that reach
  `test/helpers/agent.ts`, and a renamed export changes that count.
- Edit no production module. Under `src/http/server/**` this story touches test files only:
  `app.test.ts`, `host.test.ts`, `idempotency.test.ts`, `shutdown-socket.test.ts`, and the deleted
  `koa-bridge.test.ts`.
- Do not delete `src/http/server/koa-bridge.ts`. Story 4 owns the production half.

## Verify

- `node --test test/helpers/agent.test.ts` passes every case, including
  `preserves two set-cookie values over the socket`.
- `node --test src/http/server/shutdown-socket.test.ts` passes its three cases:
  `graceful shutdown drains an in-flight request to its full body`,
  `a connection opened after shutdown starts is refused`, and `the listener closes`.
- `node --test src/http/server/host.test.ts src/http/server/idempotency.test.ts src/http/server/blob/show-blob.test.ts`
  passes with no changed case name.
- `node --test test/helpers/socket-budget.test.ts` passes both cases and reports the same 5 paths:
  `agent.test.ts`, `host.test.ts`, `idempotency.test.ts`, `show-blob.test.ts`,
  `shutdown-socket.test.ts`.
- `grep -rn koaFromHono src test` reports only `src/http/server/koa-bridge.ts`, its definition.
- `node --test --test-reporter=tap 2>&1 | grep -m1 '^# pass'` reports exactly 6 fewer than after
  Story 2.
- `git diff <base>..HEAD -- src/main.test.ts src/main.event-wait.test.ts src/main.authorization.test.ts src/main.capability.test.ts src/main.claim.test.ts src/main.node-write.test.ts src/main.project-graph.test.ts src/main.readiness.test.ts src/main.report.test.ts src/main.repository-branch.test.ts`
  reports no changed file. A diff of any of the ten is a blocker.
- `npm run verify` exits 0.
- `node --test src/http/server/app.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts`
  passes.
- Proof: contributes `src/http/server/app.test.ts`, `src/http/server/dispatch.test.ts` and
  `src/http/server/route.test.ts` of the EPIC Proof block, run by the command above.
