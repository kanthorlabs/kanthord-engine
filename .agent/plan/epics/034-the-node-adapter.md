# EPIC 034 — The node adapter

Status: **blocked**. It is the fifth epic of the phase 1b band that replaces koa with hono. It sits
after EPIC 033 and before EPIC 035. It depends on EPIC 032, which makes `createApp` return a hono
application. `S1` under `## Open items` is applied: `@hono/node-server` 2.1.1 sits in `package.json`
as of 2026-08-23, so the epic is no longer blocked.

**Human action required before execution.** Keep `@types/koa` and `@types/koa__cors` in
`package.json` until EPIC 035 completes. The koa middleware still typechecks while the port runs, so
an early removal breaks `npm run typecheck`. `scripts/lane-check.sh:41` locks the manifest, so no
story in this epic edits it.

## Goal

`src/http/server/start.ts` serves the hono application through `@hono/node-server`. The exported
`listen` signature, the `ListeningServer` shape, the ephemeral-port resolution, the idempotent
`close()` and the bind-failure rejection stay identical. `src/http/server/shutdown.ts` needs no
edit, and `src/main.ts` needs no edit.

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
- **No composition-root split.** EPIC 035 owns it.

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

- **EPIC 033 lands before EPIC 034.** The level-2 socket harness is the regression oracle for this
  swap. EPIC 033 builds it against the current koa listener through the same `listen` signature,
  which this epic preserves. The harness then proves the adapter by passing unchanged. The reverse
  order gives the adapter no oracle at the moment it lands.

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
2. **The adapter drains an in-flight request.** Add one case to `src/http/server/start.test.ts`. Hold
   one request open on a handler that resolves on a signal from the test. Call `close()`. Assert that
   the request answers 200 and that the `close()` promise resolves after that answer. Add one case
   that asserts the port reported for `port: 0` is an integer above 0, and that a request to that
   exact port answers 200.
3. **The level-2 socket harness runs against the adapter.** EPIC 033 declares the harness under
   `test/helpers/`. Change its server construction to `listen` from `src/http/server/start.ts`, and
   delete any koa type it names. The harness keeps its exported shape, and every level-2 case keeps
   its name and its assertions.

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
- **The level-2 socket harness of EPIC 033 passes unchanged in its case names and assertions.**
- **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
  A test that needs a port uses `reservePort` from `test/helpers/port.ts`. A test that needs a home
  uses `createTemporaryHome` from `test/helpers/home.ts`.

## Open items

- S1 - status:OPEN - action:YES - add `@hono/node-server` - the adapter imports `serve` from
  `@hono/node-server`, and `package.json` declares no such dependency - fix:add
  `"@hono/node-server": "1.15.0"` to the `dependencies` block of `package.json`, next to the `hono`
  entry EPIC 032 adds, then run `npm install` and commit `package-lock.json` - why:`scripts/lane-check.sh:41`
  locks `package.json` and `package-lock.json` against every agent lane, so no story in this epic
  adds it, and story 1 does not typecheck until a human applies it.
- **The `.unref()` call is the one node-only call in the transport.** `src/http/server/app.ts:60` is
  the only site. EPIC 035 moves it, and EPIC 036 records it in the runtime capability matrix. This
  epic names it so that neither epic rediscovers it.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
