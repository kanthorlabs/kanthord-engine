# Story 3 — The level-2 socket harness runs against the adapter, and koa leaves the tree

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: Story 1 (`src/main.ts` reads the `hono` half), EPIC 033 (the level-2 file set).

`loopbackServer` builds its server from `getRequestListener` instead of `app.callback()`. That takes
the last caller of the koa bridge, so the bridge, its test and the `app: Koa` half of `App` go with
it. After this story no file under `src/`, `test/` or `scripts/` names koa.

**Adds exactly 0 cases, and removes exactly 6** — the 6 cases of
`src/http/server/koa-bridge.test.ts` that EPIC 032 story 15 enumerates. This is the only fall in the
pass count in this epic.

Lane split. The software-engineer owns `src/http/server/app.ts` and the deletion of
`src/http/server/koa-bridge.ts` (`scripts/lane-check.sh:75-83`). The test-engineer owns
`test/helpers/agent.ts`, `test/helpers/app.ts`, and every `*.test.ts` file named below, including the
deletion of `src/http/server/koa-bridge.test.ts` (`scripts/lane-check.sh:78-80` and `:95-98`).

## Change

### 1. `test/helpers/agent.ts` — the server is built from `getRequestListener`

EPIC 033 story 2 adds `fetchAgent`, `Agent`, `AgentRequest` and `AgentResponse` to this file and
keeps `loopbackServer` and `loopbackAgent` byte for byte, so anchor every edit on the symbol, not on
a line number.

**Edit 1 — the imports.** Delete the line `import type Koa from "koa";`. Add:

```ts
import { getRequestListener } from "@hono/node-server";
```

`Hono` and `Env` are already imported as types by `fetchAgent`, which EPIC 033 story 2 declares as
`fetchAgent<E extends Env>(app: Hono<E>): Agent`. Reuse that import; do not add a second one.

**Edit 2 — the cache key type.** The declaration reads today:

```ts
const servers = new WeakMap<Koa, Promise<Server>>();
```

Replace it with:

```ts
const servers = new WeakMap<object, Promise<Server>>();
```

**The key type is `object`, and it is not `Hono<Env>`.** `WeakMap<Hono<Env>, Promise<Server>>` does
not accept a `Hono<E>` argument: `servers.get(app)` and `servers.set(app, listening)` each fail with
`TS2345: Argument of type 'Hono<E, BlankSchema, "/">' is not assignable to parameter of type
'Hono<Env, BlankSchema, "/">'`, because `Hono`'s env parameter is invariant through its handler
signatures. `object` compiles, keeps the identity semantics the cache depends on, and adds no `any`.

**Edit 3 — the two signatures and the one construction.** `loopbackServer` reads today:

```ts
export function loopbackServer(app: Koa): Promise<Server> {
  const existing = servers.get(app);
  if (existing !== undefined) {
    return existing;
  }
  const listening = new Promise<Server>((resolve, reject) => {
    const server = createServer(app.callback());
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
  servers.set(app, listening);
  return listening;
}
```

Replace it with:

```ts
export function loopbackServer<E extends Env>(app: Hono<E>): Promise<Server> {
  const existing = servers.get(app);
  if (existing !== undefined) {
    return existing;
  }
  const listening = new Promise<Server>((resolve, reject) => {
    const server = createServer(
      getRequestListener(app.fetch, { overrideGlobalObjects: false }),
    );
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
  servers.set(app, listening);
  return listening;
}
```

`loopbackAgent` reads today:

```ts
export async function loopbackAgent(
  app: Koa,
): Promise<ReturnType<typeof request>> {
  return request(await loopbackServer(app));
}
```

Replace its parameter only:

```ts
export async function loopbackAgent<E extends Env>(
  app: Hono<E>,
): Promise<ReturnType<typeof request>> {
  return request(await loopbackServer(app));
}
```

Four points are load-bearing.

- **`overrideGlobalObjects: false` is mandatory.** The option defaults to true
  (`node_modules/@hono/node-server/dist/index.mjs:996` reads
  `options.overrideGlobalObjects !== false`), and the true path runs
  `Object.defineProperty(global, "Request", ...)` and the same for `Response`. EPIC 032 Decision 12
  made that option mandatory on this exact call for this exact reason, and this story replaces the
  call it governed. Omitting it reintroduces a process-wide effect into every level-2 test file.
- **`createServer` stays, and `createAdaptorServer` is not used.** `getRequestListener` is the
  one-token replacement for `app.callback()`, so `unref()`, `listen(0, "127.0.0.1", …)` and the cache
  keep the exact lines they hold today.
- **`server.unref()`, `server.listen(0, "127.0.0.1", …)`, `server.once("error", reject)` and the
  `WeakMap` write stay byte for byte.** The EPIC's story text says "the two `once` handlers"; the file
  holds **one** `once` handler — `server.once("error", reject)` — and resolves from the third
  argument of `listen`. Keep both as they are.
- **No `hostname` option.** The koa bridge passed `hostname: BRIDGE_HOSTNAME` so a request carrying
  no `Host` header still reached `hostMiddleware`. The one case that sent such a request is case 6 of
  `src/http/server/koa-bridge.test.ts`, which this story deletes. `supertest` and `node:http` both
  send a `Host` header on every request, so no surviving level-2 case needs the fallback.

**Do not call `listen` from `src/http/server/start.ts`.** It returns `ListeningServer`, which carries
`port` and `close` only. `loopbackServer` needs the `node:http.Server` object itself for
`supertest(server)`, for the `server.address()` assertions in `test/helpers/agent.test.ts`, for
`server.unref()` and for the `WeakMap` value.

### 2. `src/http/server/koa-bridge.ts` and `src/http/server/koa-bridge.test.ts` — deleted

Delete both files. EPIC 032 story 15 created them and this story takes their last caller.
`BRIDGE_HOSTNAME` is declared in `koa-bridge.ts` and goes with it.

### 3. `src/http/server/app.ts` — `App` loses its koa half

EPIC 032 story 16 rewrites this file, so anchor on the symbol.

**Edit 1 — the `App` type.** It reads, after EPIC 032:

```ts
export type App = Readonly<{
  app: Koa;
  hono: Hono<AppEnv>;
  cancelWaits: () => void;
}>;
```

Replace it with:

```ts
export type App = Readonly<{
  hono: Hono<AppEnv>;
  cancelWaits: () => void;
}>;
```

**Edit 2 — the imports.** Delete the `Koa` type import and the `koaFromHono` import from
`./koa-bridge.ts`.

**Edit 3 — `createApp`.** Delete the statement that builds the koa application with `koaFromHono`,
and drop `app` from the returned object literal, so the return reads:

```ts
return {
  hono,
  cancelWaits: () => {
    dependencies.waits.cancelAll();
  },
};
```

Keep `cancelWaits`, `HandlerContext`, `Handler`, `AppDependencies`, `TransportSettings`,
`BindingError`, `unimplementedFor`, `bindingOffenders` and `systemSchedule` exactly as EPIC 032 left
them. `systemSchedule` and its `.unref()` call stay in this file — EPIC 035 moves them.

### 4. `test/helpers/agent.test.ts` — the fixture application is a `Hono`

Replace the `import Koa from "koa";` line with `import { Hono } from "hono";`, and replace **every**
`new Koa()` with `new Hono()`.

**The projected inventory is 7 sites, and the derivation is fixed.** The file holds 5 `new Koa()`
sites today, at `:9`, `:17`, `:24`, `:25` and `:30`. EPIC 033 story 1 adds one level-2 case that
calls `loopbackServer(new Koa())`: `+1`. EPIC 033 story 2 adds 14 level-1 cases, all of them driven
through `fetchAgent` over a `Hono`: `+0`. EPIC 033 story 6 adds one level-2 `set-cookie` case through
`loopbackAgent`: `+1`. Total **7**. Confirm the count before editing, and **report a mismatch rather
than improvising** — a different count means EPIC 033 landed a shape this story did not project:

```bash
grep -c "new Koa()" test/helpers/agent.test.ts
```

Every site is the same edit: `new Koa()` becomes `new Hono()`. Two of the seven also carry a koa
middleware body, and each becomes its hono equivalent — the handler case below, and the `set-cookie`
case EPIC 033 story 6 adds, whose two `context.append("set-cookie", …)` writes become two
`context.header("set-cookie", …, { append: true })` writes on the hono context. Its two asserted
values do not change.

The one case that mounts a handler reads today:

```ts
const app = new Koa();
app.use((context) => {
  context.status = 200;
  context.body = { reached: true };
});
```

Replace that body with the hono form:

```ts
const app = new Hono();
app.all("*", (context) => context.json({ reached: true }));
```

Keep every case name and every assertion, including the `address.address === "127.0.0.1"`
assertions, the port assertion EPIC 033 story 1 adds, the two `set-cookie` values EPIC 033 story 6
adds, and both cache cases. A cache case that calls `loopbackServer(new Hono())` twice must still
get two different servers, and one that passes one application twice must still get one.

**Add two assertions to the existing bind-address case, and no new case.** That case is
`"binds the loopback address and never the wildcard"` at `:8`. Capture `globalThis.Request` and
`globalThis.Response` as the first two statements of the case, and after the `loopbackServer` call
assert each is identical to what was captured:

```ts
assert.equal(globalThis.Request, beforeRequest);
assert.equal(globalThis.Response, beforeResponse);
```

This is the guarantee that case 5 of `src/http/server/koa-bridge.test.ts` carried, moved onto the
call that replaces the one it covered. It lives inside an existing case, so the pinned `−6` is
unaffected. Story 2 asserts the same property on the `serve()` path.

### 5. `test/helpers/app.ts` — `createSocketTestApp` reads the `hono` half

EPIC 033 story 3 adds `createSocketTestApp`, backed by `loopbackAgent(app)` over the `app` half of
the `App` that `createApp` returns. Change that one call to pass the `hono` half instead:

```ts
loopbackAgent(created.hono);
```

The level-1 `createTestApp` beside it already passes `hono` to `fetchAgent` and takes no edit. The
two exported factory names do not change, so `test/helpers/socket-budget.test.ts` still reports the
same 5 files.

### 6. `src/http/server/host.test.ts` and `src/http/server/idempotency.test.ts` — drop the wrapper

EPIC 032 rewrites both files onto the hono chain, and both reach the socket, so both wrap their
application with `koaFromHono(...)` before handing it to `loopbackAgent`.

**The projected inventory is one wrapping site per file, plus one import line per file.** Each file
builds its application in exactly one place today — `host.test.ts` in the `buildApp` helper at
`:10-16`, and `idempotency.test.ts` in the factory at `:92` — and EPIC 032 rewrites the body of each
without splitting it. Confirm before editing, and **report a mismatch rather than improvising**:

```bash
grep -c "koaFromHono" src/http/server/host.test.ts src/http/server/idempotency.test.ts
```

Each file reports `2`: one import and one call. `koaFromHono(x)` becomes `x` at the call, the
`koaFromHono` import leaves the file, and the helper's return type changes from `Koa` to
`Hono<AppEnv>`. Change no case name and no assertion. `host.test.ts` still asserts the `127.0.0.1:<port>` Host header that
ephemeral-port resolution produces, and `idempotency.test.ts` still sends `Idempotency-Key` twice
over its raw `node:http` request.

`src/http/server/blob/show-blob.test.ts` reaches the socket only through `createSocketTestApp`, so it
takes no edit at all.

### 7. Every remaining koa name leaves

Sections 1 to 6 are the closed edit inventory. This grep is the **oracle** on that inventory, not a
substitute for it — it must already return nothing once sections 1 to 6 are applied:

```bash
grep -rn -i koa src test scripts
```

It must return nothing at all. Every hit on the tree today is an import that EPIC 032, EPIC 033 or
this story replaces, and no file names koa in a string or a comment. If a hit survives in a file no
section above names, that file is one EPIC 032 left on the koa chain — report it rather than
inventing an edit for it.

## Constraints

- **Add no case, and remove no case other than the 6 of `src/http/server/koa-bridge.test.ts`.** The
  pass count falls by exactly 6.
- **Change no case name and no assertion in any surviving level-2 file.** This story changes how the
  server is built and what type two functions take. It changes nothing a test observes. The three
  cases of `src/http/server/shutdown-socket.test.ts` and the two `set-cookie` values are included.
- **Do not edit `package.json` or `package-lock.json`.** `scripts/lane-check.sh:41` denies both.
  `koa`, `@koa/cors`, `@koa/bodyparser`, `@types/koa` and `@types/koa__cors` stay declared and unused
  until EPIC 035 removes them. An unused type package is not a defect of this story.
- **Do not edit any of the nine `src/main.*.test.ts` files.** They are the oracle for this swap. A
  diff of any one is a blocker.
- **Do not edit `src/http/server/start.ts`, `src/http/server/start.test.ts` or
  `src/http/server/shutdown.ts`.** Stories 1 and 2 finished the adapter.
- **Do not change the three exported names of `test/helpers/agent.ts` or the two of
  `test/helpers/app.ts`.** `test/helpers/socket-budget.test.ts` scans for them by name.
- **Do not move `systemSchedule`, and do not add a runtime directory.** EPIC 035 owns both.
- **Do not add a second entrypoint.** No file in this story names a runtime other than node.

## Verify

```bash
node --test \
  test/helpers/agent.test.ts \
  test/helpers/app.test.ts \
  test/helpers/socket-budget.test.ts \
  src/http/server/host.test.ts \
  src/http/server/idempotency.test.ts \
  src/http/server/shutdown-socket.test.ts \
  src/http/server/blob/show-blob.test.ts \
  src/http/server/app.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/route.test.ts \
  src/http/server/start.test.ts \
  src/main.test.ts \
  src/main.event-wait.test.ts \
  src/main.authorization.test.ts \
  src/main.capability.test.ts
```

- Every named file passes. `test/helpers/socket-budget.test.ts` still reports **5** files and the
  same sorted list of 5 paths.
- `grep -rn -i koa src test scripts` returns nothing. Assert the count is zero:

```bash
test "$(grep -rn -i koa src test scripts | wc -l | tr -d ' ')" = 0 && echo "PASS no-koa"
```

- `grep -rn "BRIDGE_HOSTNAME" src test scripts` returns nothing.
- `ls src/http/server/koa-bridge.ts src/http/server/koa-bridge.test.ts` reports both files absent.
- `grep -c "overrideGlobalObjects: false" test/helpers/agent.ts` reports `1`.
- `grep -c "new Hono()" test/helpers/agent.test.ts` reports `7`, matching the projected inventory.
- `test/helpers/agent.test.ts` still reports the case count EPIC 033 leaves it with, and the
  bind-address case asserts `globalThis.Request` and `globalThis.Response` unchanged by identity.
- **The pass count falls by exactly 6.** Record it on the commit before this story and on this one:

```bash
node --test 2>&1 | grep -m1 '^# pass'
```

The second number is lower by 6, and by nothing else.

- **The oracle is undiffed.** This reports no changed file:

```bash
git diff <base>..HEAD -- \
  src/main.test.ts src/main.event-wait.test.ts src/main.authorization.test.ts \
  src/main.capability.test.ts src/main.claim.test.ts src/main.node-write.test.ts \
  src/main.project-graph.test.ts src/main.readiness.test.ts src/main.report.test.ts \
  src/main.repository-branch.test.ts
```

- `npm run verify` exits 0, including `eslint .`.

Proof: this story delivers the `src/http/server/app.test.ts`, `src/http/server/dispatch.test.ts` and
`src/http/server/route.test.ts` rows of the EPIC Proof block, and the the global-object identity guarantee of EPIC 032 Decision 12 that case 5 of
`src/http/server/koa-bridge.test.ts` carried, and the gate bullets **"The level-2
socket harness of EPIC 033 keeps every case name and every assertion"**, **"The pass count falls by
exactly 6 in story 3, and by nothing else"**, **"No file names koa after story 3"** and **"The oracle
passes unedited"**.
