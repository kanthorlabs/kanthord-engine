# Story 01 — Server bootstrap

Epic: `.agent/plan/epics/004-transport-skeleton.md`
Depends on: Story 05 (`src/http/contract/errors.ts`, `src/http/server/envelope.ts`), Story 06a (`src/http/contract/registry.ts`), Story 04 (`src/http/server/origin.ts`, `src/http/server/host.ts`), Story 03 (`src/http/server/auth.ts`).

This story assembles the chain. Stories 05, 04 and 03 each deliver a middleware that refuses on its own input and calls `next()` otherwise; none of them knows its position. This story fixes the order, and it owns every assertion that depends on the order.

## Change

### 1. `src/http/server/app.ts` (new)

```ts
import Koa from "koa";

import type { Operation } from "../contract/operation.ts";

export type TransportSettings = Readonly<{
  token: string;
  allowedHosts: readonly string[];
}>;

export type HandlerContext = Readonly<{
  operation: Operation;
  parameters: Readonly<Record<string, string>>;
  body: unknown;
}>;

export type HandlerResult = Readonly<{ status: number; body: unknown }>;

export type Handler = (
  context: HandlerContext,
) => HandlerResult | Promise<HandlerResult>;

export type AppDependencies = Readonly<{
  settings: TransportSettings;
  handlers: Readonly<Record<string, Handler>>;
  unimplemented: readonly string[];
  onInternalError: (error: unknown) => void;
}>;

export class BindingError extends Error {}

export function createApp(dependencies: AppDependencies): Koa;
```

**`createApp` refuses an incomplete binding at construction.** Before it builds any middleware it checks the handler map against the registry, and throws `BindingError` naming every offender when any of these holds:

- a `routed` operation is in neither `handlers` nor `unimplemented`;
- an operation is in both `handlers` and `unimplemented`;
- an `operationId` in `handlers` or `unimplemented` is absent from the registry;
- an operation in `handlers` or `unimplemented` has `status === "stubbed"`.

`unimplemented` is the explicit list of `routed` operations whose command has not arrived yet. In this epic `src/main.ts` passes twenty-one ids; Story 08 binds two, so the list is the other twenty-one. It shrinks in EPIC 007, EPIC 008 and EPIC 010, and `.agent/plan/epics/009-cli-and-composition-root.md:23` asserts it is empty.

This is the correction the epic needs, and it is why `AGENTS.md` — "A `routed` entry binds to exactly one command or query" — is not violated by a half-built phase. An unbound `routed` operation is a composition defect, and a silent `501` would make it indistinguishable from a `stubbed` route for five epics. Naming the twenty-one in the composition root makes the debt a reviewable list rather than a runtime behaviour, and forgetting to bind a new command fails `createApp` immediately instead of answering a plausible `501`.

`TransportSettings` is declared here and not imported from `src/services/config/index.ts`. `eslint.config.js:138-155` gives `http-server` no route to a service, so `src/main.ts` maps `settings.http` into this shape at the wiring site.

`createApp` builds one `new Koa()` and uses the middleware in this exact order. Every module already exists when this story runs. The order is fixed, so a request with two faults always reports the same code.

1. `envelopeMiddleware({ onInternalError })` — Story 05.
2. `originMiddleware()` — Story 04.
3. `hostMiddleware({ allowedHosts })` — Story 04.
4. `authMiddleware({ token })` — Story 03.
5. `routeMiddleware()` — this story.
6. `bodyParser({ enableTypes: ["json"] })` from `@koa/bodyparser`.
7. `dispatchMiddleware({ handlers })` — this story.

Six middleware, not eight, and the reason is Ulrich's decision that **no route is exempt from the bearer token**. An earlier draft split route resolution across a `resolveMiddleware` and a `notFoundMiddleware` so that `authMiddleware` could sit between them and read the match to exempt `system.health`. With no exemption, `authMiddleware` needs no match, so it runs before resolution and the two halves collapse into one `routeMiddleware`. `401` before `404` is now structural: nothing can answer `404` before the token is checked, because resolution has not happened yet.

`app.proxy` stays `false`, its default, so `context.request.host` never reads `X-Forwarded-Host`. The `Host` check reads the raw header regardless; the setting is stated so a later edit does not open the trust.

The guarantee is exact, and it is worth stating precisely rather than broadly: **without a token, every path on the daemon answers the identical status and the identical envelope.** No path is distinguishable, because resolution runs after the token check and no route is exempt. The one thing this epic does not defend against is timing: a linear matcher has path-dependent cost, and it runs only for an authenticated caller. The claim under test is response equality, and the test asserts it that way.

### 2. `src/http/server/route.ts` (new)

```ts
import type { Context, Next } from "koa";

import type { RouteMatch } from "../contract/registry.ts";

export type RoutedState = Readonly<{ match: RouteMatch }>;

export function routeMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void>;
```

Call `matchRoute(context.method, context.path)`. When the result is `null`, throw `httpError("not-found", \`no operation for ${context.method} ${context.path}\`)`. Otherwise assign it to `context.state.match`and await`next()`.

One middleware, and `context.state.match` is therefore never `null` downstream — `dispatchMiddleware` reads it without a null check. `context.path` is koa's parsed pathname, so a query string never reaches `matchRoute`.

### 3. `src/http/server/dispatch.ts` (new)

```ts
import type { Context, Next } from "koa";

import type { Handler } from "./app.ts";

export type DispatchDependencies = Readonly<{
  handlers: Readonly<Record<string, Handler>>;
}>;

export function dispatchMiddleware(
  dependencies: DispatchDependencies,
): (context: Context, next: Next) => Promise<void>;
```

Read `context.state.match`, which `routeMiddleware` has already proved non-null.

1. When `match.operation.status` is `"stubbed"`, throw `httpError("not-implemented", \`${operationId} ships in ${introducedIn}\`)`. A stubbed route never reaches a handler and never reads a body.
2. Look up `dependencies.handlers[operationId]`. When it is absent, the operation is one `createApp` accepted into `unimplemented`, so throw `httpError("not-implemented", \`${operationId} is not implemented yet\`)`. The message differs from the stub message by design: a reader of a log line can tell a later-phase route from a phase-1 route still under construction, and `createApp` has already proved the absence is declared rather than accidental.
3. Otherwise call the handler with `{ operation, parameters, body: context.request.body }`, await the result, and assign `context.status` and `context.body` from it.

`next` is accepted and never called. This is the last middleware.

### 4. `src/http/server/start.ts` (new)

```ts
import type Koa from "koa";
import type { Server } from "node:http";

export type ListenInput = Readonly<{ bind: string; port: number }>;

export type ListeningServer = Readonly<{
  port: number;
  close(): Promise<void>;
}>;

export function listen(app: Koa, input: ListenInput): Promise<ListeningServer>;
```

`listen` calls `app.listen(input.port, input.bind)` and resolves on the `listening` event with the port read back from `server.address()`. It rejects on the `error` event, with the original error unwrapped. A rejection is not a startup refusal code: `EADDRINUSE` is not a member of the closed set of `.agent/plan/epics/001-runtime-foundation.md:67`, and `src/main.ts:57` already rethrows an error it does not recognise.

`close()` wraps `server.close` in a promise and resolves once.

### 5. `src/main.ts:20-59` — rewire `serve`

The `serve` action currently loads configuration, acquires the home lock, publishes the identity, sweeps the ref locks, prints `kanthord: ready` and parks on a `setInterval`. Insert the server between the sweep and the readiness line, and delete the `setInterval` — a listening server keeps the loop alive on its own.

The order after this story, and it is load-bearing:

1. `config.load(...)` — a refusal here exits before anything binds.
2. `homeLock.acquire(...)`, `publishIdentity`, `sweepRefLocks`.
3. The migration gate of Story 02.
4. `createApp({ settings: { token, allowedHosts }, handlers, onInternalError })`.
5. `await listen(app, { bind: settings.http.bind, port: settings.http.port })`.
6. `process.stdout.write("kanthord: ready\n")`.

Every EPIC 001 refusal therefore happens before step 5, so a refusing daemon never binds its port and never accepts a request. That is what "enforced at listen time" means here, and the test below proves it by connecting rather than by reading stderr alone.

`onInternalError` is `(error) => process.stderr.write(\`kanthord: internal-error: ${String(error)}\n\`)`.

`handlers` is `{}` in this story, and `unimplemented` is therefore every `routed` `operationId` — all twenty-three. Derive it in `src/main.ts` by filtering the registry, never by typing a list, so it cannot fall out of step with the registry:

```ts
const unimplemented = registry
  .filter((entry) => entry.status === "routed")
  .map((entry) => entry.operationId)
  .filter((operationId) => !(operationId in handlers));
```

Story 08 adds two entries to `handlers`, and the same expression yields twenty-one without a second edit.

Keep the existing `catch` at `src/main.ts:51-58` and add `StartupError` from Story 02 to its `instanceof` chain.

### 6. `test/helpers/app.ts` (new)

```ts
import type supertest from "supertest";

export type TestAppOverrides = Readonly<{
  token?: string;
  allowedHosts?: readonly string[];
  handlers?: Readonly<Record<string, Handler>>;
  onInternalError?: (error: unknown) => void;
}>;

export function unimplementedFor(
  handlers: Readonly<Record<string, Handler>>,
): readonly string[];

export type TestApp = Readonly<{
  raw: ReturnType<typeof supertest>;
  get(path: string): supertest.Test;
  post(path: string): supertest.Test;
  put(path: string): supertest.Test;
  del(path: string): supertest.Test;
  internalErrors(): readonly unknown[];
}>;

export function createTestApp(overrides?: TestAppOverrides): TestApp;
```

Defaults: `token` is `"test-token"`, `allowedHosts` is `["kanthord.test"]`, `handlers` is `{}`.

`unimplementedFor(handlers)` is the same registry filter `src/main.ts` uses — every `routed` `operationId` absent from `handlers`. `createTestApp` calls it and passes the result into `createApp`, so a test never trips `BindingError` by supplying a partial handler map, and a test that wants to trip it calls `createApp` directly. This helper is exported so the `BindingError` cases can build the valid list without duplicating the filter.

`raw` is `supertest(createApp(...).callback())` with nothing preset. Every negative case uses it.

`get`, `post`, `put` and `del` call `raw` and preset two headers: `Host: kanthord.test` and `Authorization: Bearer test-token`, using the resolved `token` and the first entry of the resolved `allowedHosts`. Measured: `supertest` honours an explicit `.set("Host", ...)`, and without one it sends `127.0.0.1:<ephemeral port>` — which is why the allow list is a fixed name rather than an address.

`internalErrors()` returns the errors captured by the default `onInternalError`, which pushes into a closure array. A supplied `onInternalError` replaces it, and `internalErrors()` then returns `[]`.

There is no `dispose()`. `createApp` opens no port and no file, so there is nothing to close; a test that needs a real port uses `listen` directly.

`test/helpers/app.test.ts` (new) covers the helper itself, in the convention of `test/helpers/database.test.ts`.

## Constraints

- `src/http/server/**` imports no service. `eslint.config.js:138-155` allows `domain`, `command`, `query`, `http-contract` and `http-server` only.
- Do not add `@koa/router`. The registry is the router, and `matchRoute` is its one dispatcher. A path-matching dependency would be a second place a path is spelled.
- Do not call `dependencies.handlers` for a `stubbed` operation, and do not parse a body for one. `.agent/plan/epics/010-contract-completion.md:33` asserts a stub writes nothing, and reaching a handler at all would make that assertion weaker.
- Delete `setInterval(() => {}, 1 << 30)` from `src/main.ts`. It is the orphan this change creates.
- Do not touch `test/helpers/daemon.ts`. Its readiness contract is the exact substring `"kanthord: ready\n"`, and step 6 keeps it.

## Verify

`node --test src/http/server/route.test.ts` — new file, suite `"src/http/server/route.test"`. Cases build a bare `new Koa()` with `envelopeMiddleware`, `routeMiddleware`, then an inspector middleware that writes `context.state.match` into the body:

- `GET /v1/health` leaves `context.state.match.operation.operationId` equal to `"system.health"`.
- `GET /v1/node/task_01JQ8ZAN9P` leaves `context.state.match.parameters` deep-equal to `{ id: "task_01JQ8ZAN9P" }`.
- `GET /v1/nope` answers `404` with body deep-equal to `{ error: { code: "not-found", message: "no operation for GET /v1/nope" } }`, and the inspector is not reached.
- `GET /v1/health?x=1` resolves to `system.health`. A query string does not reach `matchRoute`.
- On every reached request `context.state.match` is not `null`, which is the invariant `dispatchMiddleware` relies on.

`node --test src/http/server/dispatch.test.ts` — new file, suite `"src/http/server/dispatch.test"`, driven through `createTestApp`:

- A `stubbed` route with an empty handler map: `post("/v1/node/task_01JQ8ZAN9P/unblock")` answers `501` with body deep-equal to `{ error: { code: "not-implemented", message: "node.unblock ships in phase-2" } }`.
- A `stubbed` route with a handler **registered anyway** for `node.unblock`: the response is still `501`, and the handler's call counter is `0`. A stub cannot be bound by accident.
- A `routed` route declared `unimplemented`: with `unimplemented: ["system.status"]`, `get("/v1/status")` answers `501` with message `"system.status is not implemented yet"`, and the message differs from the stub message above.
- `createApp` refuses an incomplete binding. One case per rule, each asserting a `BindingError` whose message names the offending id:
  - `handlers: {}` and `unimplemented: []` throws, and the message names `system.health` — every one of the 23 routed operations is unaccounted for.
  - `system.status` in both `handlers` and `unimplemented` throws.
  - `handlers: { "zzz.invented": h }` throws — the id is absent from the registry.
  - `handlers: { "node.unblock": h }` throws — `node.unblock` is `stubbed`.
  - `unimplemented: ["node.unblock"]` throws for the same reason.
  - The complete form does **not** throw: `handlers` holding `system.health` and `system.db`, and `unimplemented` holding the other 21 routed ids. Build that list by filtering the registry rather than typing it, and assert its length is `21`.
- A `routed` route with a handler: register `system.status` as `() => ({ status: 200, body: { ok: true } })`; `get("/v1/status")` answers `200` with body deep-equal to `{ ok: true }`.
- A handler receives the parameters: register `node.show` and assert the recorded `HandlerContext.parameters` deep-equals `{ id: "task_01JQ8ZAN9P" }` and `operation.operationId` is `"node.show"`.
- A handler receives a parsed JSON body: register `repository.register`, `post("/v1/repository").send({ url: "https://example.test/r.git" })`, and assert the recorded `body` deep-equals that object.
- An async handler is awaited: a handler returning `Promise.resolve({ status: 201, body: { created: true } })` answers `201`.
- A handler that throws `httpError("needs-reconcile", "diverged", { local: "a", remote: "b" })` answers `409` with the `details` intact — the envelope middleware is reached from inside a handler.
- A handler that throws a plain `Error` answers `500`, and `internalErrors()` has length `1`.
- Every one of the 30 `stubbed` operations answers `501` from an empty handler map. Loop the registry, build the concrete path by substituting `"x_01"` for each parameter, and drive it with the method from the entry. Assert the status is `501` and the body `error.code` is `"not-implemented"`. This is a status assertion only — `.agent/plan/epics/010-contract-completion.md:18` owns the sweep that also proves no table gained a row.

`node --test src/http/server/start.test.ts` — new file, suite `"src/http/server/start.test"`:

- `listen(app, { bind: "127.0.0.1", port: 0 })` resolves with a `port` greater than `0`, and a real `fetch` to `http://127.0.0.1:<port>/v1/health` with `Host` left to the client returns `403` — the allow list is `["kanthord.test"]` in the default test app, which proves the middleware runs over a real socket and not only through `app.callback()`. `after()` calls `close()`.
- Two `listen` calls on the same explicit port: the first resolves, the second rejects. Assert the rejection value is not a `HttpError` and that its `code` is `"EADDRINUSE"`. `after()` closes the first.
- `close()` resolves, and a second `close()` also resolves without throwing.

`node --test src/http/server/app.test.ts` — new file, suite `"src/http/server/app.test"`. This file owns the chain, and every case here is an ordering assertion that no single middleware can make on its own. Drive them through `createTestApp` with a `system.status` handler bound so a clean request reaches `200`, and with a `system.health` handler bound for the exemption cases.

- **The browser defences apply to every route, including `system.health`.** `get("/v1/health")` with a bound handler answers `200`. The same request with `Origin: http://evil.example` answers `403` with code `origin-forbidden`, and with `Host: evil.example` answers `403` with code `host-forbidden`. `docs/proposal/api/system.md:28` — a route exempt from these would reopen the DNS rebind path.
- **`system.health` requires the token.** `raw.get("/v1/health").set("Host", "kanthord.test")` with no `Authorization` answers `401`. This is Ulrich's decision at the chain level, and it is the assertion that replaces the epic's original coverage line "`system.health` answers with no token".
- **`origin-forbidden` wins over `host-forbidden`.** `raw.get("/v1/status").set("Host", "evil.example").set("Origin", "http://evil.example")` answers `403` with code `origin-forbidden`, never `host-forbidden`.
- **A browser check wins over the token.** `raw.get("/v1/status").set("Host", "evil.example")` with no `Authorization` answers `403` with code `host-forbidden`, not `401`. And `raw.get("/v1/status").set("Origin", "http://x")` with no `Host` and no token answers `403` with code `origin-forbidden`.
- **`401` wins over `404`.** `raw.get("/v1/nope").set("Host", "kanthord.test")` with no token answers `401`. `get("/v1/nope")`, which presets the correct token, answers `404`. With `authMiddleware` ahead of `routeMiddleware` this is structural rather than a split-resolution trick, and the assertion stays as the regression guard.
- **Every path is indistinguishable without a token.** Build the request set from the whole registry: for each of the 53 entries substitute `"x_01"` for each parameter, and add `/v1/nope` and `/v1/` as unregistered paths. Drive each through `raw` with only `Host: kanthord.test`. Assert every response has status `401` and a body deep-equal to the first response's body. One loop, 55 assertions, and it is the guarantee stated as an equality rather than as an absence of knowledge.
- **The token wins over `501`.** `raw.post("/v1/node/task_01/unblock").set("Host", "kanthord.test")` with no token answers `401`, and with the correct token answers `501`. A stub does not leak its existence either.
- A clean request reaches the handler: `get("/v1/status")` answers `200`.
- A body is parsed only after every check: register `repository.register`, and assert `raw.post("/v1/repository").set("Host", "kanthord.test").send({ url: "x" })` with no token answers `401` and the handler's call counter is `0`.
- `app.proxy` is `false` on the app `createApp` returns.

`node --test test/helpers/app.test.ts` — new file, suite `"test/helpers/app.test"`:

- `createTestApp({ handlers: { "system.health": healthLike } }).get("/v1/health")` answers `200`, and the same request through `raw` with no headers answers `403`. That pair proves both presets land without adding a seam to read them.
- `createTestApp({ allowedHosts: ["other.test"] }).get("/v1/health")` presets `Host: other.test`, so the request still passes the host check.
- `createTestApp({ token: "custom" }).get("/v1/status")` with a bound handler answers `200`, so the preset bearer follows the override rather than the default.
- `internalErrors()` collects a thrown non-`HttpError` and is empty when `onInternalError` is supplied.

`node --test src/services/home-lock/startup.test.ts` — the existing file, extended. It already launches the real daemon through `test/helpers/daemon.ts`:

- A daemon started on a configured loopback port answers `GET /v1/health` over a real `fetch` after `ready()` resolves, and the response is `403` when no `Host` header matches the configured allow list and `200` once `Host` is set to the configured entry. `test/helpers/home.ts:24-25` writes `allowedHosts: ["127.0.0.1:7421"]`, so the case that must pass sets the config's `http.port` and `http.allowedHosts` through `writeConfig` overrides to a port it chose and the matching `127.0.0.1:<port>` entry.
- A daemon whose configuration fails a refusal rule never binds. Write a config with `bind: "0.0.0.0"` and `token: ""` — the `config-refused` rule of `src/services/config/refusals.ts:63`. Assert `exited()` gives code `1`, stderr matches `/^kanthord: config-refused: [^\n]+\n$/`, and a `fetch` to `http://127.0.0.1:<port>/v1/health` rejects with `ECONNREFUSED`. This is the "start refusals enforced at listen time" assertion, and it proves the negative by connecting.
- A second daemon on the same home still exits `home-locked` and never binds, asserted the same way. This extends the existing ordering proof at `src/services/home-lock/startup.test.ts:96` rather than replacing it.

`npm run verify` exits 0.

Proof: contributes `src/http/server/resolve.test.ts`, `dispatch.test.ts`, `app.test.ts` and `start.test.ts` to `node --test src/http/**/*.test.ts`.
