# EPIC 034 — The node adapter

Status: **draft**. It is the fifth epic of the phase 1b band that replaces koa with hono. It sits
after EPIC 033 and before EPIC 035. It depends on EPIC 032, which makes `createApp` return a hono
application, and on EPIC 033, which builds the dual-level test harness.

`S1` under `## Open items` is applied. `@hono/node-server` 2.1.1 sits in `package.json` and in
`package-lock.json`, and `npm install` has run, so `node_modules/@hono/node-server` is present as of
2026-08-23.

**Human action required before execution.** Keep `@types/koa` and `@types/koa__cors` in
`package.json` until EPIC 035 completes. `src/http/server/koa-bridge.ts` and `test/helpers/agent.ts`
each name a koa type until story 4 lands, so an early removal breaks `npm run typecheck`. After
story 4 no file names koa, and the two type packages sit unused until EPIC 035 S1 removes them.
`scripts/lane-check.sh:41` locks the manifest, so no story in this epic edits it.

**Every line number in this file is read against the tree at commit `de8df72`, before EPIC 032.** A
number that names a file EPIC 032 or EPIC 033 creates carries the story that creates it instead of a
line, because that file does not exist on the baseline tree.

## Goal

`src/http/server/start.ts` serves the hono application through `@hono/node-server`. The exported
`listen` signature, the `ListeningServer` shape, the ephemeral-port resolution, the idempotent
`close()` and the bind-failure rejection stay identical. `src/http/server/shutdown.ts` needs no edit.
`src/main.ts` takes one edit, in story 1 and not later. `listen` takes a generic `Hono<E>` from story
1, so the call at `src/main.ts:667` passes the `hono` half of `App` in the same commit.

The shape the product ships:

| Concern            | Before                                      | After                                   |
| ------------------ | ------------------------------------------- | --------------------------------------- |
| the listener       | `app.listen(port, bind)` on koa             | `createServer(getRequestListener(...))` |
| the returned type  | `Promise<ListeningServer>`                  | `Promise<ListeningServer>` — unchanged  |
| the shutdown steps | `waits`, `listener`, `storage`, `home-lock` | the same four, in the same order        |

## Non-goals

- **No middleware change.** EPIC 032 owns the hono middleware chain. This epic changes the listener
  and nothing above it.
- **No second entrypoint.** A lambda adapter and a worker adapter are outside the phase 1b band. No
  file in this epic names a runtime other than node.
- **No koa removal.** `koa`, `@koa/cors` and `@koa/bodyparser` stay in `package.json`. EPIC 035
  removes them, and `scripts/lane-check.sh:41` locks the file against this epic anyway.
- **No shutdown change.** The four step names, the step order, the failure report and the exit code
  1 on a failed step are unchanged. `src/http/server/shutdown.ts` takes no edit.
- **No composition-root split.** EPIC 035 owns it. Story 4 drops one field from the `App` type and
  changes two call sites. It moves no module and it names no new root.

- **No request body limit.** `@hono/node-server` caps no body, and `node:http` exposes no body-size
  option, so the listener cannot hold the limit. `src/http/server/body.ts` is the one place the
  product reads a request body, and EPIC 032 story 11 creates it. EPIC 032 Decision 13 now
  reinstates the 1 MiB cap there. This epic reads no body and applies no cap.

## Decisions

- **The `ListeningServer` contract does not change.**
  `listen<E extends Env>(app: Hono<E>, input): Promise<ListeningServer>`
  keeps `{ port: number; close(): Promise<void> }`. `createShutdownSteps` at
  `src/http/server/shutdown.ts:45` takes `listening: { close(): Promise<void> }` structurally, so it
  needs no edit. This constraint shapes the whole epic: the adapter is one file, and every caller
  above it stays as it is. Only the first parameter type changes, from `Koa` to generic `Hono<E>`.

- **`overrideGlobalObjects` is `false` at every call site.**
  `node_modules/@hono/node-server/dist/index.mjs:996` reads
  `if (options.overrideGlobalObjects !== false && global.Request !== Request$1)` and then replaces
  `global.Request` and `global.Response`. The default is therefore **true**, for `serve()` and for
  `getRequestListener()` alike. EPIC 032 Decision 12 pins the flag to `false` on the bridge, and case
  5 of `src/http/server/koa-bridge.test.ts` asserts the identity of the two globals. Story 4 deletes
  that file, so story 1 passes `overrideGlobalObjects: false`, story 3 passes it too, and story 2
  carries the identity assertion into `src/http/server/start.test.ts` before story 4 removes the
  original.

- **The URL authority fallback is the bind address, at both levels.** `getRequestListener` builds the
  request URL from the `Host` header, and it falls back to the `hostname` option when the header is
  absent. Production passes `hostname: input.bind`. Level 2 passes `hostname: "127.0.0.1"`, which is
  the address `loopbackServer` binds. One rule therefore covers both, and EPIC 032's
  `BRIDGE_HOSTNAME` dies with the bridge in story 4. The observable behaviour is unchanged: an
  HTTP/1.0 request that carries no `Host` header leaves `c.req.header("host")` undefined, and
  `hostMiddleware` answers the `host-forbidden` envelope with `the request carried no Host header`.
  Story 2 asserts it against the adapter.

- **The two direct level-2 callers reach the socket through `koaFromHono`, and that is a
  precondition.** `src/http/server/host.test.ts:10` and `src/http/server/idempotency.test.ts` build
  their application with `new Koa()` and mount one middleware directly. Neither calls `createApp`.
  EPIC 032 stories 6 and 13 rewrite those middlewares against `Context<AppEnv>`, so each test file
  builds a `Hono` application from that story onward and wraps it with `koaFromHono(...)` to reach
  `loopbackAgent`. EPIC 032 story 15 therefore dispatches before story 6. Story 3 of this epic
  deletes that wrap and passes the hono application straight to `loopbackAgent`. If EPIC 032 leaves
  either file in another shape, story 3 is wrong and this Decision is the thing to fix.

- **`serve()` is not used, because one option cannot carry two values.** `serve()` passes its single
  `hostname` option to `server.listen` (`dist/index.mjs:1305`) **and** to the request listener's
  URL-authority fallback (`:1010`, reaching `newRequest:589`,
  `const host = incoming.headers.host || defaultHostname`). `server.listen` needs the raw bind, and
  the authority needs the bracketed form of an IPv6 literal. `src/domain/host-authority.ts:3`
  declares `wildcardBinds = ["0.0.0.0", "::"]`, so `::` is a supported bind, and
  `host-authority.ts:25` already carries the bracket rule. Measured on this tree, for
  `GET /v1/health HTTP/1.0` with no Host header: `hostname: "::"` answers **400** and never reaches
  the application, while `hostname: "[::]"` answers 200 with `req.url === "http://[::]/v1/health"`
  and a null host header, which reaches `hostMiddleware` and yields the 403 the product answers
  today. `0.0.0.0` and `127.0.0.1` are identical either way.

  The adapter therefore composes the two halves itself:

  ```ts
  const server: Server = createServer(
    getRequestListener(app.fetch, {
      hostname: bindAuthority(input.bind),
      overrideGlobalObjects: false,
    }),
  );
  server.listen(input.port, input.bind);
  ```

  Story 1 exports `bindAuthority` from `src/domain/host-authority.ts` and reuses it at line 25. The
  annotation stays `node:http`'s `Server`, so no `ServerType` union enters the file. The adapter
  attaches `once("error", reject)` and `once("listening", ...)` to that server, exactly as today. The
  promise rejects on the first `error` event and resolves on `listening`. Level 2 uses the same
  `createServer(getRequestListener(...))` shape, so production and level 2 now build the listener
  identically.

- **Ephemeral-port resolution is preserved.** The adapter reads `server.address()` inside the
  `listening` handler. An object address reports `address.port`; any other value falls back to
  `input.port`. Port 0 therefore resolves to the real bound port through the same code path as
  today. The adapter reads the port from `server.address()` only, so one path reports it.

- **`close()` stays idempotent, and it drains.** The `closed` flag stays. The first call runs
  `server.close(() => resolveClose())` and resolves after the socket closes. `node:http` `close()`
  stops new connections and waits for an in-flight request to finish, so an in-flight request
  drains before the promise resolves.

- **The shutdown order stays `waits` before `listener`.** A long poll holds a request open for up to
  its wait budget, and `src/http/server/event/wait.ts` polls every `POLL_INTERVAL_MS = 250`. A
  listener close before `cancelWaits` therefore blocks for the whole budget. `cancelWaits` settles
  each pending wait first, the held request completes, and the listener close then drains an empty
  socket set.

- **`systemSchedule` stays in `src/http/server/app.ts`, and EPIC 035 moves it.** `app.ts:62` calls
  `.unref()`, which is node-only. `app.ts:103` uses `systemSchedule` as the default of the optional
  `schedule` dependency. A move into the adapter inverts the import direction, because `app.ts` then
  imports `start.ts`. The alternative makes `schedule` a required dependency of `createApp` and
  edits every caller. Both are composition-root work, and EPIC 035 owns the composition roots. This
  epic records the location and changes nothing.

- **The error path on a bound port is unchanged.** A port already in use rejects the returned
  promise with the node error whose `code` is `EADDRINUSE`. `src/main.ts:667` awaits `listen`, so the
  rejection propagates through the `catch` at `src/main.ts:690` and rethrows, exactly as today. No
  new error class, and no new message.

- **`src/http/server/start.test.ts` and the daemon tests are the oracle, not the level-2 harness.**
  Story 3 edits the harness, so the harness cannot be the oracle for a change to itself. The oracle
  is the set of tests this epic does not edit: the seven cases of
  `src/http/server/start.test.ts` after story 2, and the ten `src/main.*.test.ts` tests, which boot
  the real daemon over a real socket through `src/main.ts`. Each one passes unedited.
  `src/main.test.ts:264` answers every routed operation, and it is the strongest single row.

- **EPIC 033 lands before EPIC 034, for the level-2 file set and not for the oracle.** EPIC 033
  decides which 5 files run at level 2 and what each one proves. Story 3 moves those 5 files from
  the koa bridge to the node adapter without changing that decision. The reverse order makes story 3
  edit a harness that does not exist yet.

- **The level-2 server needs a raw `node:http.Server`, so story 3 does not call `listen`.**
  `listen` returns `ListeningServer`, which carries `port` and `close` only. `loopbackServer` needs
  the server object itself for four reasons: `supertest(server)` takes it, `test/helpers/agent.test.ts`
  asserts `server.address().address` and `server.address().port`, `server.unref()` keeps the suite
  hermetic, and the `WeakMap` cache holds the promise of it. The cache is
  `new WeakMap<object, Promise<Server>>()`, keyed by Hono application identity.
  `@hono/node-server` 2.1.1 exports the two factories behind its serve path.
  `createAdaptorServer(options)` returns `ServerType` and leaves listening to the caller.
  `getRequestListener(fetch)` builds the `(request, response)` listener that `createServer` takes.
  Story 3 uses `getRequestListener`, because that is the one-token replacement for `app.callback()`
  and it keeps every other line of `loopbackServer` unchanged. It passes the options object
  `{ hostname: "127.0.0.1", overrideGlobalObjects: false }`, per the two Decisions above.

  `serve()` is `createAdaptorServer` followed by `listen`. Level 2 therefore drives the same
  request-and-response bridge that `start.ts` ships, and only the promise wrapper of `listen` is
  outside level 2. Story 1 and story 2 cover that wrapper by value, and story 2 additionally
  restates all six `koa-bridge.test.ts` cases against the adapter, so no wire behaviour loses its
  only proof when story 3 deletes that file.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit. The
detailed files sit under `.agents/plan/stories/034-the-node-adapter/`.

1. **`start.ts` serves through `@hono/node-server`.** Export `bindAuthority(bind)` from
   `src/domain/host-authority.ts`, returning `` `[${bind}]` `` when `bind` contains `:` and `bind`
   otherwise, and reuse it at `host-authority.ts:25`. Add one case to
   `src/domain/host-authority.test.ts` over `0.0.0.0`, `127.0.0.1`, `::` and `::1`.

   Rewrite `src/http/server/start.ts`. Replace `import type Koa from "koa"` with
   `import type { Env, Hono } from "hono"`. Keep `import type { Server } from "node:http"` and add
   `createServer` as a value import. Add `import { getRequestListener } from "@hono/node-server"` and
   `import { bindAuthority } from "../../domain/host-authority.ts"`. Change the signature to
   `listen<E extends Env>(app: Hono<E>, input: ListenInput): Promise<ListeningServer>`, ending in `{`
   and not `;`. Replace `app.listen(input.port, input.bind)` with:

   ```ts
   const server: Server = createServer(
     getRequestListener(app.fetch, {
       hostname: bindAuthority(input.bind),
       overrideGlobalObjects: false,
     }),
   );
   server.listen(input.port, input.bind);
   ```

   Do not use `serve()`, and do not change the annotation to `ServerType`, per the Decisions.
   `overrideGlobalObjects: false` is not optional. Keep the two `once` handlers, the `address()`
   read, the fallback to `input.port` and the `closed` flag byte for byte. Update the `buildApp`
   helper at `src/http/server/start.test.ts:25` to the hono application EPIC 032 returns. The four
   existing cases at `src/http/server/start.test.ts:43`, `:57`, `:74` and `:81` keep their names and
   their assertions. **Adds exactly 1 case, in `src/domain/host-authority.test.ts`.**

   `src/main.ts` changes in this story. `:647` destructures `{ app, cancelWaits }` and `:667` calls
   `listen(app, ...)`, so the new `Hono` parameter does not typecheck until `:647` destructures
   `{ hono, cancelWaits }` and `:667` calls `listen(hono, ...)`. `App` still carries the `app` half at
   this point; story 4 drops it.

2. **The adapter owns the wire behaviour the bridge proved.** Add exactly seven cases to
   `src/http/server/start.test.ts`. Six are the six cases of `src/http/server/koa-bridge.test.ts`
   that EPIC 032 story 15 enumerates, restated against the node adapter, because story 3 deletes that
   file and it holds the only wire proof of each. The seventh is the drain.

   Capture `globalThis.Request` and `globalThis.Response` at **module scope**, above `describe`.
   `node:test` runs cases in declaration order, so a capture taken inside the identity case would
   read references an earlier `listen` already replaced, and the case would pass with the flag
   removed. Add one module-scope `rawSocketRequest(port, requestLine)` helper over `node:net`, which
   accumulates into a `Buffer` and returns status, lower-cased headers and body.

   1. a `%2F` path and a `%zz` path each reach the route intact
   2. a `Uint8Array` answer carries the exact `content-length` and the exact bytes
   3. a 204 answer carries neither `content-length` nor `content-type`
   4. a POST body reaches the route with its whitespace intact
   5. `listen` leaves `global.Request` and `global.Response` untouched, asserted against the
      module-scope captures
   6. an HTTP/1.0 request with no `Host` header answers 403, `error.code` `host-forbidden` and
      `error.message` exactly `the request carried no Host header`
   7. an in-flight request drains before `close()` resolves

   Case 7 builds a standalone `new Hono()` and calls `listen` on it, so it needs no allow list and no
   `reservePort`. It records `close-resolved` in a `.then` on the close promise and asserts
   `order.indexOf("close-resolved") > order.indexOf("handler-released")`. It does **not** order the
   client resolution against the close callback, and it does not assert the bare four-entry sequence,
   which holds even when `close()` resolves immediately. **Adds exactly 7 cases**, so
   `src/http/server/start.test.ts` holds 11.

3. **The level-2 socket harness runs against the adapter.** In `test/helpers/agent.ts`, add
   `import { getRequestListener } from "@hono/node-server"`, replace `createServer(app.callback())`
   with

   ```ts
   createServer(
     getRequestListener(app.fetch, {
       hostname: "127.0.0.1",
       overrideGlobalObjects: false,
     }),
   );
   ```

   and change the parameter of `loopbackServer` and `loopbackAgent` from `Koa` to `Hono<E>`, generic
   over `Env`, to match `fetchAgent`. Delete the `import type Koa from "koa"` line. Change the cache
   declaration to `const servers = new WeakMap<object, Promise<Server>>()`. Keep `server.unref()`,
   `server.listen(0, "127.0.0.1")`, the two `once` handlers and the cache behavior byte for byte. Do
   not call `listen` from `src/http/server/start.ts`, per the Decisions.

   Then drop the bridge from **every** remaining `koaFromHono` caller, because story 4 deletes the
   function and an unedited caller breaks `npm run typecheck`. Five files, roughly eight call sites:

   1. `test/helpers/agent.test.ts` — `new Koa()` becomes `new Hono()`. The
      `drives the app over that server` case sets `context.status` and `context.body`, which no
      constructor swap converts; replace its body with `app.all("*", (c) => c.json({ reached: true }))`.
      The `preserves two set-cookie values over the socket` case that EPIC 033 story 6 appends loses
      its `koaFromHono` wrap. Both keep their assertions.
   2. `test/helpers/app.ts` — `createSocketTestApp` passes `created.hono` in place of `created.app`.
      The level-1 `createTestApp` beside it already passes `hono` and takes no edit.
   3. `src/http/server/host.test.ts` — pass the hono application where the file wraps it.
   4. `src/http/server/idempotency.test.ts` — the same, at its `buildApp` site and its
      `loopbackServer` call.
   5. `src/http/server/shutdown-socket.test.ts` — EPIC 033 story 6 creates this file, and each of its
      three cases wraps a fresh hono application before it reaches `loopbackServer` and
      `loopbackAgent`. Delete the import and all three wraps. The cache key becomes the hono
      application itself, so both helpers must receive the same reference in case 1.

   `src/http/server/blob/show-blob.test.ts` reaches the socket only through `createSocketTestApp`, so
   it takes no edit at all.

   The same story deletes `src/http/server/koa-bridge.test.ts`, because story 2 restated all six of
   its cases and this story takes its last caller. The deletion sits here rather than in story 4, so
   that story 4 stays a production-only commit. **Adds 0 cases, and removes exactly 6.** After this
   story `grep -rn koaFromHono src test` reports only `src/http/server/koa-bridge.ts` itself.

   Every level-2 case keeps its name and its assertions, including the two `set-cookie` values and
   the three `src/http/server/shutdown-socket.test.ts` cases. The three exported names of
   `test/helpers/agent.ts` and the two factory names of `test/helpers/app.ts` — `createTestApp` and
   `createSocketTestApp` — do not change, so `test/helpers/socket-budget.test.ts` still reports the
   same 5 files.

4. **Delete the koa bridge and drop the `app` half.** Delete `src/http/server/koa-bridge.ts`. In
   `src/http/server/app.ts`, drop the `app: Koa` field from `App`, so `App` carries
   `hono: Hono<AppEnv>` and `cancelWaits` only, and delete the `Koa` type import and the
   `koaFromHono` import. `src/main.ts` already reads the `hono` half from story 1 and takes no
   further edit. This story edits production modules only, and it writes and deletes no test.

   **Adds 0 cases and removes 0.** After this story no file under `src/`, `test/` or `scripts/` names
   koa, which is the precondition of EPIC 035 story 4.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/server/start.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/server/app.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/route.test.ts \
  src/http/server/event/wait.test.ts \
  src/main.test.ts \
  src/main.event-wait.test.ts \
  src/main.authorization.test.ts \
  src/main.capability.test.ts \
  && echo "PASS EPIC-034"
```

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **The daemon boots and answers a request end to end, through `src/main.ts`.** The existing case at
  `src/main.test.ts:264` answers every routed operation over a real socket, and it takes no edit.
- **Port 0 resolves to a real ephemeral port, asserted by value.** The case at
  `src/http/server/start.test.ts:43` is the port oracle. It resolves `port: 0`, asserts
  `server.port > 0`, and fetches `http://127.0.0.1:${server.port}/v1/health`. It keeps its name and
  its assertions, and no story adds a second port case. A port read from a second source is not
  accepted as the proof.
- **A second `close()` resolves and does not throw.** The case at `src/http/server/start.test.ts:74`
  keeps its assertion, and the `closed` flag guards the second call.
- **A bound port rejects with the same reported message.** The case at
  `src/http/server/start.test.ts:57` asserts `code === "EADDRINUSE"` on the rejection of the second
  `listen`, and the first `listen` stays resolved.
- **Graceful shutdown runs the four steps in order.** `src/http/server/shutdown.test.ts:274` asserts
  `cancelWaits` before the listener close through the shared factory, and the four names stay
  `waits`, `listener`, `storage`, `home-lock`.
- **A pending long poll settles before the listener closes.** `src/main.event-wait.test.ts:292`
  answers a pending wait empty and exits without the wait elapsing. It runs against the adapter
  unedited.
- **An in-flight request drains.** The `close()` promise resolves after the held request answers
  200, asserted by order and not by a delay.
- **`listen` leaves `global.Request` and `global.Response` untouched.** Story 2 asserts both by
  identity across the call. `grep -rn "overrideGlobalObjects" src test` reports exactly two sites,
  `src/http/server/start.ts` and `test/helpers/agent.ts`, and each reads `false`. A missing flag is a
  blocker, because the default is true and the assertion is the only thing that catches it.
- **A request that carries no `Host` header answers `host-forbidden` through the adapter.** Story 2
  sends an HTTP/1.0 request over a raw socket, asserts status 403 and the exact message
  `the request carried no Host header`. The URL authority falls back to `hostname`, and the request
  header stays absent.
- **Every behaviour `src/http/server/koa-bridge.test.ts` proved still has a wire proof.** Story 2
  restates all six of its cases against the node adapter before story 3 deletes the file. A level-1
  fetch agent never touches the node adapter, so a level-1 case is not an acceptable substitute for
  any of the six.
- **The globals guard cannot be satisfied by a capture taken too late.**
  `src/http/server/start.test.ts` captures `globalThis.Request` and `globalThis.Response` at module
  scope. A capture inside the case reads references an earlier `listen` already replaced. Verify by
  removing `overrideGlobalObjects: false` and running the whole file: the case must fail.
- **The drain is asserted against the close promise, not against the client.**
  `order.indexOf("close-resolved") > order.indexOf("handler-released")`. The four-entry sequence
  `handler-entered, shutdown-started, handler-released, response-complete` holds even when `close()`
  resolves immediately, so it proves nothing on its own.
- **`serve()` appears nowhere.** `grep -rn "serve(" src/http/server/` returns nothing, and
  `grep -rn "overrideGlobalObjects" src test` reports exactly two lines, both reading `false`.
- **An IPv6 bind keeps the no-Host behaviour.** `src/domain/host-authority.test.ts` asserts
  `bindAuthority("::") === "[::]"` and `bindAuthority("::1") === "[::1]"` by value. Passing the raw
  bind as the URL authority answers 400 and never reaches `hostMiddleware`.
- **The oracle passes unedited.** `git diff <base>..HEAD -- src/main.test.ts src/main.event-wait.test.ts
src/main.authorization.test.ts src/main.capability.test.ts src/main.claim.test.ts
src/main.node-write.test.ts src/main.project-graph.test.ts src/main.readiness.test.ts
src/main.report.test.ts src/main.repository-branch.test.ts` reports no changed file. A diff of any
  of the ten is a blocker, because story 3 edits the harness and these are what prove the swap.
- **The level-2 socket harness of EPIC 033 keeps every case name and every assertion.** Story 3
  changes how the server is built and what type the two functions take. It changes no assertion, and
  it adds no case. `test/helpers/socket-budget.test.ts` still reports the same 5 files, because the
  two exported helper names do not change.
- **The pass count falls by exactly 6 in story 3, and by nothing else.** Record
  `node --test --test-reporter=tap 2>&1 | grep -m1 '^# pass'` before and after each story. Story 1
  raises it by 1. Story 2 raises it by 7. Story 3 lowers it by 6, which is the 6 cases EPIC 032 story
  15 enumerates for `src/http/server/koa-bridge.test.ts`, and story 2 restated all six first. Story 4
  moves it by 0. Story 3 is the only fall in this epic, and the net across the epic is +2.
  `src/http/server/start.test.ts` goes from 4 cases to 11.
- **No file names koa after story 4.** `grep -rni koa src test scripts` returns nothing at all. The
  search is case-insensitive, so a leftover `Koa` type import is caught. Every
  match on the tree today is an import that EPIC 032, EPIC 033 or this epic replaces, and no file
  names koa in a string or a comment. EPIC 035 story 4 turns the same check into a test, and it must
  pass on the tree story 4 leaves.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
  A test that needs a port uses `reservePort` from `test/helpers/port.ts`. A test that needs a home
  uses `createTemporaryHome` from `test/helpers/home.ts`.

## Open items

- S1 - status:FIXED - action:YES - add `@hono/node-server` - the adapter imports `serve` from
  `@hono/node-server`, and story 3 imports `getRequestListener` from it - fix:`"@hono/node-server":
"2.1.1"` sits in the `dependencies` block of `package.json`, `package-lock.json` records it, and
  `npm install` has run, so `node_modules/@hono/node-server` is present - why:`scripts/lane-check.sh:41`
  locks `package.json` and `package-lock.json` against every agent lane, so no story in this epic
  adds it, and story 1 does not typecheck until a human applies it.
- **The 1 MiB request body limit is reinstated in EPIC 032, not here.** EPIC 032 Decision 13 first
  read "the limit does not survive the port … and EPIC 034 owns the request limit". The listener
  cannot hold a body limit, so that handoff had no landing site. EPIC 032 Decision 13 and story 11
  now place the cap in `src/http/server/body.ts`, which is the one place the product reads a body.
  This epic records the change so that neither epic rediscovers it.
- **The `.unref()` call is the one node-only call in the transport.** `src/http/server/app.ts:62` is
  the only site. EPIC 035 moves it, and EPIC 036 records it in the runtime capability matrix. This
  epic names it so that neither epic rediscovers it.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
