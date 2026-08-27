# EPIC 034 — The node adapter

Status: **draft**. It is the fifth epic of the phase 1b band that replaces koa with hono. It sits
after EPIC 033 and before EPIC 035. It depends on EPIC 032, which makes `createApp` return a hono
application, and on EPIC 033, which builds the dual-level test harness.

`S1` under `## Open items` is applied. `@hono/node-server` 2.1.1 sits in `package.json` and in
`package-lock.json`, and `npm install` has run, so `node_modules/@hono/node-server` is present as of
2026-08-23.

**Human action required before execution.** Keep `@types/koa` and `@types/koa__cors` in
`package.json` until EPIC 035 completes. `src/http/server/koa-bridge.ts` and `test/helpers/agent.ts`
each name a koa type until story 3 lands, so an early removal breaks `npm run typecheck`. After
story 3 no file names koa, and the two type packages sit unused until EPIC 035 S1 removes them.
`scripts/lane-check.sh:41` locks the manifest, so no story in this epic edits it.

## Goal

`src/http/server/start.ts` serves the hono application through `@hono/node-server`. The exported
`listen` signature, the `ListeningServer` shape, the ephemeral-port resolution, the idempotent
`close()` and the bind-failure rejection stay identical. `src/http/server/shutdown.ts` needs no edit.
`src/main.ts` takes one edit, in story 1 and not later. `listen` takes a `Hono` from story 1, so the
call at `src/main.ts:644` passes the `hono` half of `App` in the same commit.

The shape the product ships:

| Concern            | Before                                      | After                                  |
| ------------------ | ------------------------------------------- | -------------------------------------- |
| the listener       | `app.listen(port, bind)` on koa             | `serve({ fetch, hostname, port })`     |
| the returned type  | `Promise<ListeningServer>`                  | `Promise<ListeningServer>` — unchanged |
| the shutdown steps | `waits`, `listener`, `storage`, `home-lock` | the same four, in the same order       |

## Non-goals

- **No middleware change.** EPIC 032 owns the hono middleware chain. This epic changes the listener
  and nothing above it.
- **No second entrypoint.** A lambda adapter and a worker adapter are outside the phase 1b band. No
  file in this epic names a runtime other than node.
- **No koa removal.** `koa`, `@koa/cors` and `@koa/bodyparser` stay in `package.json`. EPIC 035
  removes them, and `scripts/lane-check.sh:41` locks the file against this epic anyway.
- **No shutdown change.** The four step names, the step order, the failure report and the exit code
  1 on a failed step are unchanged. `src/http/server/shutdown.ts` takes no edit.
- **No composition-root split.** EPIC 035 owns it. Story 3 drops one field from the `App` type and
  changes two call sites. It moves no module and it names no new root.

## Decisions

- **The `ListeningServer` contract does not change.** `listen(app, input): Promise<ListeningServer>`
  keeps `{ port: number; close(): Promise<void> }`. `createShutdownSteps` at
  `src/http/server/shutdown.ts:44` takes `listening: { close(): Promise<void> }` structurally, so it
  needs no edit. This constraint shapes the whole epic: the adapter is one file, and every caller
  above it stays as it is. Only the first parameter type changes, from `Koa` to `Hono`.

- **`serve()` returns a `node:http` server, and the adapter keeps the current event contract.**
  `serve({ fetch: app.fetch, hostname: input.bind, port: input.port })` returns a `node:http.Server`.
  The adapter attaches `once("error", reject)` and `once("listening", ...)` to that server, exactly
  as today. The promise rejects on the first `error` event and resolves on `listening`.

- **Ephemeral-port resolution is preserved.** The adapter reads `server.address()` inside the
  `listening` handler. An object address reports `address.port`; any other value falls back to
  `input.port`. Port 0 therefore resolves to the real bound port through the same code path as
  today. The adapter does not read the port from the `serve()` callback, so one path reports it.

- **`close()` stays idempotent, and it drains.** The `closed` flag stays. The first call runs
  `server.close(() => resolveClose())` and resolves after the socket closes. `node:http` `close()`
  stops new connections and waits for an in-flight request to finish, so an in-flight request
  drains before the promise resolves.

- **The shutdown order stays `waits` before `listener`.** A long poll holds a request open for up to
  its wait budget, and `src/http/server/event/wait.ts` polls every `POLL_INTERVAL_MS = 250`. A
  listener close before `cancelWaits` therefore blocks for the whole budget. `cancelWaits` settles
  each pending wait first, the held request completes, and the listener close then drains an empty
  socket set.

- **`systemSchedule` stays in `src/http/server/app.ts`, and EPIC 035 moves it.** `app.ts:60` calls
  `.unref()`, which is node-only. `app.ts:103` uses `systemSchedule` as the default of the optional
  `schedule` dependency. A move into the adapter inverts the import direction, because `app.ts` then
  imports `start.ts`. The alternative makes `schedule` a required dependency of `createApp` and
  edits every caller. Both are composition-root work, and EPIC 035 owns the composition roots. This
  epic records the location and changes nothing.

- **The error path on a bound port is unchanged.** A port already in use rejects the returned
  promise with the node error whose `code` is `EADDRINUSE`. `src/main.ts:644` awaits `listen`, so the
  rejection propagates through the `catch` at `src/main.ts:667` and rethrows, exactly as today. No
  new error class, and no new message.

- **`src/http/server/start.test.ts` and the daemon tests are the oracle, not the level-2 harness.**
  Story 3 edits the harness, so the harness cannot be the oracle for a change to itself. The oracle
  is the set of tests this epic does not edit: the six cases of
  `src/http/server/start.test.ts` after story 2, and the nine `src/main.*.test.ts` tests, which boot
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
  hermetic, and the `WeakMap` cache holds the promise of it. `@hono/node-server` 2.1.1 exports two factories
  that return a `node:http.Server` and leave listening to the caller: `createAdaptorServer(options)`
  builds the whole server, and `getRequestListener(fetch)` builds the `(request, response)` listener
  that `createServer` takes. Story 3 uses `getRequestListener`, because that is the one-token
  replacement for `app.callback()` and it keeps every other line of `loopbackServer` unchanged.

  `serve()` is `createAdaptorServer` followed by `listen`. Level 2 therefore drives the same
  request-and-response bridge that `start.ts` ships, and only the promise wrapper of `listen` is
  outside level 2. Story 1 and story 2 cover that wrapper by value.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **`start.ts` serves through `@hono/node-server`.** Rewrite `src/http/server/start.ts`. Replace
   `import type Koa from "koa"` with `import type { Hono } from "hono"`, and add
   `import { serve } from "@hono/node-server"`. Change the first parameter to `app: Hono`. Replace
   `app.listen(input.port, input.bind)` with
   `serve({ fetch: app.fetch, hostname: input.bind, port: input.port })`. Keep the `Server` type
   annotation, the two `once` handlers, the `address()` read, the fallback to `input.port` and the
   `closed` flag byte for byte. Update the `buildApp` helper at `src/http/server/start.test.ts:25`
   to the hono application EPIC 032 returns. The four existing cases at
   `src/http/server/start.test.ts:43`, `:57`, `:74` and `:81` keep their names and their assertions.

   `src/main.ts` changes in this story. `:624` destructures `{ app, cancelWaits }` and `:644` calls
   `listen(app, ...)`, so the new `Hono` parameter does not typecheck until `:624` destructures
   `{ hono, cancelWaits }` and `:644` calls `listen(hono, ...)`. `App` still carries the `app` half at
   this point; story 3 drops it.

2. **The adapter drains an in-flight request.** Add one case to `src/http/server/start.test.ts`. Hold
   one request open on a handler that resolves on a signal from the test. Call `close()`. Assert that
   the request answers 200 and that the `close()` promise resolves after that answer. Add one case
   that asserts the port reported for `port: 0` is an integer above 0, and that a request to that
   exact port answers 200.
3. **The level-2 socket harness runs against the adapter.** In `test/helpers/agent.ts`, add
   `import { getRequestListener } from "@hono/node-server"`, replace `createServer(app.callback())`
   with `createServer(getRequestListener(app.fetch))`, and change the parameter of `loopbackServer`
   and `loopbackAgent` from `Koa` to `Hono<E>`, generic over `Env`, to match `fetchAgent`. Delete the
   `import type Koa from "koa"` line. Keep `server.unref()`, `server.listen(0, "127.0.0.1")`, the two
   `once` handlers and the `WeakMap` cache byte for byte. Do not call `listen` from
   `src/http/server/start.ts`, per the Decisions.

   The same story removes the koa bridge, because this story takes its last caller. Delete
   `src/http/server/koa-bridge.ts` and `src/http/server/koa-bridge.test.ts`. In
   `src/http/server/app.ts`, drop the `app: Koa` field from `App`, so `App` carries
   `hono: Hono<AppEnv>` and `cancelWaits` only, and delete the `Koa` type import and the
   `koaFromHono` import. `src/main.ts` already reads the `hono` half from story 1 and takes no
   further edit. After this story no file under `src/`, `test/` or `scripts/` names koa, which is the
   precondition of EPIC 035 story 4.

   Then drop the bridge from each caller. In `test/helpers/agent.test.ts` replace `new Koa()` with
   `new Hono()` and delete the koa import. In `test/helpers/app.ts`, change `createSocketTestApp` to
   pass the `hono` half of `createApp` to `loopbackAgent` in place of the `app` half; the level-1
   `createTestApp` beside it already passes `hono` and takes no edit. In
   `src/http/server/host.test.ts` and `src/http/server/idempotency.test.ts`, pass the hono
   application where the file wraps it with `koaFromHono(...)`.
   `src/http/server/blob/show-blob.test.ts` reaches the socket only through `createSocketTestApp`,
   so it takes no edit at all.

   Every level-2 case keeps its name and its assertions, including the two `set-cookie` values and
   the three `src/http/server/shutdown-socket.test.ts` cases. The three exported names of
   `test/helpers/agent.ts` and the two of `test/helpers/app.ts` do not change, so
   `test/helpers/socket-budget.test.ts` still reports the same 5 files. **Adds exactly 0 cases, and
   removes only the cases of `src/http/server/koa-bridge.test.ts`.**

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
- **Port 0 resolves to a real ephemeral port, asserted by value.** The reported port is an integer
  above 0, and a request to that exact port answers 200. A port read from a second source is not
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
- **The oracle passes unedited.** `git diff <base>..HEAD -- src/main.test.ts src/main.event-wait.test.ts
src/main.authorization.test.ts src/main.capability.test.ts src/main.claim.test.ts
src/main.node-write.test.ts src/main.project-graph.test.ts src/main.readiness.test.ts
src/main.report.test.ts src/main.repository-branch.test.ts` reports no changed file. A diff of any
  of the nine is a blocker, because story 3 edits the harness and these are what prove the swap.
- **The level-2 socket harness of EPIC 033 keeps every case name and every assertion.** Story 3
  changes how the server is built and what type the two functions take. It changes no assertion, and
  it adds no case. `test/helpers/socket-budget.test.ts` still reports the same 5 files, because the
  two exported helper names do not change.
- **The pass count falls by exactly 6 in story 3, and by nothing else.** Record
  `node --test 2>&1 | grep -m1 '^# pass'` before and after story 3. The second number is lower by 6,
  which is the 6 cases EPIC 032 story 15 enumerates for
  `src/http/server/koa-bridge.test.ts`. Story 1 and story 2 raise the count by 2, and story 3 is the
  only fall in this epic.
- **No file names koa after story 3.** `grep -rn koa src test scripts` returns nothing at all. Every
  match on the tree today is an import that EPIC 032, EPIC 033 or this epic replaces, and no file
  names koa in a string or a comment. EPIC 035 story 4 turns the same check into a test, and it must
  pass on the tree story 3 leaves.
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
- **The `.unref()` call is the one node-only call in the transport.** `src/http/server/app.ts:60` is
  the only site. EPIC 035 moves it, and EPIC 036 records it in the runtime capability matrix. This
  epic names it so that neither epic rediscovers it.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
