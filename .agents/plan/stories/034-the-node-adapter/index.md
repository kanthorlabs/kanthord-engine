# EPIC 034 — The node adapter — stories

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Prereq: EPIC 033 (sequence order), and EPIC 032 for the `hono` half of `App`.

`src/http/server/start.ts` serves the hono application through `@hono/node-server`, and the level-2
socket harness runs against the same request bridge. Only `listen`'s first parameter type changes.
The `ListeningServer` shape, the ephemeral-port resolution, the idempotent `close()`, the
bind-failure rejection and the four shutdown steps are unchanged. After story 3 no file under `src/`, `test/` or `scripts/` names
koa.

## Dispatch order

1. `01-start-serves-through-hono-node-server.md` — `start.ts`, `src/main.ts` and the `buildApp`
   helper, one commit. **+0 cases.**
2. `02-the-adapter-drains-an-in-flight-request.md` — two cases in `start.test.ts`. **+2 cases.**
3. `03-the-level-2-harness-runs-against-the-adapter.md` — the harness, the bridge deletion and the
   `App` field. **−6 cases.**

Strictly sequential. Story 1 must land before story 2, because story 2's cases call the new `listen`.
Story 1 must land before story 3, because story 3 removes the `app` half that `src/main.ts` reads
until story 1 stops reading it. There is no coupled pair: each story passes `npm run verify` on its
own.

Net for the epic: **−4** on the pass count.

## Stories

- 1 — `listen<E extends Env>` takes a `Hono<E>` and serves through `serve()`; `src/main.ts` passes
  the `hono` half →
  `01-start-serves-through-hono-node-server.md`
- 2 — the adapter drains an in-flight request, and `port: 0` reports the port that answers →
  `02-the-adapter-drains-an-in-flight-request.md`
- 3 — `loopbackServer` builds from `getRequestListener`; the koa bridge, its test and the `app: Koa`
  field of `App` are deleted → `03-the-level-2-harness-runs-against-the-adapter.md`

## Facts (needed for implementation)

- **The tree is still on koa today, and EPICs 030 to 033 have not landed.** Every anchor below is
  stated for the tree **EPIC 033 leaves**, which is this epic's base commit. Three files are
  untouched by EPIC 032 and EPIC 033, so their line numbers hold from today's tree:
  `src/http/server/start.ts` (39 lines), `src/http/server/start.test.ts`, and `src/main.ts`. Two are
  rewritten before this epic and must be anchored on a symbol: `src/http/server/app.ts` (EPIC 032
  story 16) and `test/helpers/agent.ts` (EPIC 033 story 2).

- **The EPIC's `src/main.ts` line numbers are stale by 23.** It names `:624` for the destructure and
  `:644` for the `listen` call. The tree reads `const { app, cancelWaits } = createApp({` at
  **`src/main.ts:647`** and `const listening = await listen(app, {` at **`src/main.ts:667`**. Story 1
  uses the true numbers.

- **`listen` must be generic over `Env`.** The EPIC says the first parameter becomes `app: Hono`.
  `Hono` defaults to `Hono<BlankEnv>` and `createApp` returns `hono: Hono<AppEnv>`, so
  `listen(app: Hono, …)` rejects the only production argument with **TS2345**. Verified against this
  repository's `tsconfig.json`. `listen<E extends Env>(app: Hono<E>, …)` accepts `Hono<AppEnv>` and
  the bare `new Hono()` of story 2, and it is the same invariance that forces the `WeakMap` key type
  in story 3.

- **`serve()` returns `ServerType`, not `node:http.Server`.** `ServerType` is
  `Server | Http2Server | Http2SecureServer`. `const server: Server = serve(...)` fails
  **TS2322** — verified by compiling it against this repository's `tsconfig.json` with TypeScript
  5.7.2. `const server: ServerType = serve(...)` compiles, and `once("error")`, `once("listening")`,
  `address()` and `close(callback)` are all declared on every member of the union, so the body of
  `listen` needs no other change and no cast. The `node:http` import leaves `start.ts`.

- **`overrideGlobalObjects` defaults to true, and both call sites must pass `false`.**
  `node_modules/@hono/node-server/dist/index.mjs:996` reads
  `options.overrideGlobalObjects !== false`, and the true path runs
  `Object.defineProperty(global, "Request", …)` and the same for `Response`. `serve` reaches the same
  code through `createAdaptorServer` (`:1289`). EPIC 032 Decision 12 already ruled this process-wide
  effect out for a hermetic suite. Verified: with `false`, a served request answers 200 and
  `global.Request` and `global.Response` are identical before and after.

- **`WeakMap<Hono<Env>, Promise<Server>>` does not compile.** `servers.get(app)` and
  `servers.set(app, listening)` each fail **TS2345** for a `Hono<E>` argument, because `Hono`'s env
  parameter is invariant through its handler signatures. `WeakMap<object, Promise<Server>>` compiles,
  keeps identity semantics and needs no `any`. Verified against this repository's `tsconfig.json`.

- **`test/helpers/agent.ts` holds one `once` handler, not two.** It is
  `server.once("error", reject)` at `:16`; the resolve path is the third argument of
  `server.listen(0, "127.0.0.1", …)` at `:17-19`. The EPIC's story-3 text says "the two `once`
  handlers". Keep the file's actual shape.

- **The four adapter behaviours are verified by running them against `@hono/node-server` 2.1.1**, not
  inferred:
  - `port: 0` resolves through `server.address()` to an integer above 0, and a request to that exact
    port answers 200.
  - an in-flight request drains: the order recorded is `answered` then `closed`, so the `close()`
    promise resolves after the held request answers 200.
  - a second `close()` short-circuits on the `closed` flag and resolves without throwing.
  - a second `listen` on a bound port rejects with `code === "EADDRINUSE"`, and the first listener
    keeps answering 200.

- **A drain case without `connection: "close"` takes about 3000 ms.** `undici` holds the response
  socket under keep-alive and `server.close()` waits for it. With the header the case takes about
  20 ms and asserts exactly the same order. Measured on both paths.

- **`buildApp` at `src/http/server/start.test.ts:25-40` sets `allowedHosts: ["kanthord.test"]`**, so
  a request to `127.0.0.1` through it answers `403 host-forbidden` — which the case at `:43` asserts
  on purpose. Story 2's two cases need a `200`, so each builds a bare one-route `new Hono()`.

- **The oracle is the set this epic does not edit**: the four surviving cases of
  `src/http/server/start.test.ts` and the nine `src/main.*.test.ts` files, which boot the real daemon
  over a real socket. `src/main.test.ts:264` answers every routed operation and is the strongest
  single row. A harness cannot be the oracle for a change to itself, and story 3 edits the harness.

- **The global-object guarantee keeps an owner, at no cost to the pinned counts.** Case 5 of
  `src/http/server/koa-bridge.test.ts` asserted `global.Request` and `global.Response` unchanged by
  identity, and story 3 deletes that file. The guarantee moves into **assertions inside existing
  cases**, not into new cases: story 2 asserts it on the `serve()` path inside its `port: 0` case,
  and story 3 asserts it on the `getRequestListener` path inside the existing
  `"binds the loopback address and never the wildcard"` case of `test/helpers/agent.test.ts`. A case
  count is not an assertion count, so `+2` and `−6` are unaffected.

- **The pass-count arithmetic is pinned**: story 1 `+0`, story 2 `+2`, story 3 `−6`. The 6 are the
  cases of `src/http/server/koa-bridge.test.ts` that EPIC 032 story 15 enumerates. Story 3 is the
  only fall in this epic.

- **`createShutdownSteps` at `src/http/server/shutdown.ts:45-52` takes
  `listening: { close(): Promise<void> }` structurally**, and its four steps are `waits`, `listener`,
  `storage`, `home-lock` at `:53-73`. `ListeningServer` still satisfies the parameter, so
  `src/http/server/shutdown.ts` takes no edit in this epic.

- **`systemSchedule` and its `.unref()` stay at `src/http/server/app.ts:60-64`**, and the optional
  `schedule` dependency still defaults to it. EPIC 035 moves both. EPIC 036 records the call in the
  runtime capability matrix. No story here touches either.

- **The lane split for this epic.** Software-engineer: `src/http/server/start.ts`, `src/main.ts`,
  `src/http/server/app.ts`, and the deletion of `src/http/server/koa-bridge.ts`. Test-engineer:
  `src/http/server/start.test.ts`, `test/helpers/agent.ts`, `test/helpers/app.ts`,
  `test/helpers/agent.test.ts`, `src/http/server/host.test.ts`,
  `src/http/server/idempotency.test.ts`, and the deletion of
  `src/http/server/koa-bridge.test.ts`. `scripts/lane-check.sh:95-98` puts `test/helpers/*.ts` in the
  test-engineer lane even though neither is a `*.test.ts` file.

- **`package.json` and `package-lock.json` are locked** by `scripts/lane-check.sh:41`.
  `@hono/node-server` 2.1.1 is already declared in `dependencies` and installed. `@types/koa` and
  `@types/koa__cors` stay declared and go unused after story 3; EPIC 035 S1 removes them. An unused
  type package is not a defect of this epic.

- **`src/http/server/start.test.ts` holds six cases after story 2.** The four at
  `:43`, `:57`, `:74` and `:81` plus the two story 2 adds. The EPIC read "five" at
  `.agents/plan/epics/034-the-node-adapter.md:89`; Ulrich corrected it to "six" while authoring these
  stories, so the Decisions line, the story bullets and the gate arithmetic now agree.

- **This worktree has no `node_modules`.** `npm run verify` cannot run here as it stands, and every
  compile and run check above was made against
  `/Users/tuanatelsa/Projects/kanthorlabs/kanthord/engine/node_modules`. Resolve that before
  dispatching `/work`.
