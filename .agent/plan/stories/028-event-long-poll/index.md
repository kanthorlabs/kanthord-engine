# EPIC 028 — Event long poll — stories

Epic: `.agent/plan/epics/028-event-long-poll.md`
Prereq: EPIC 027 (sequence order).

`GET /v1/event` gains `wait`, so one request holds open until an event matches the filters or the wait elapses, and an elapsed wait is a normal empty `200`.

## Dispatch order

1. `02-the-contract-declares-the-wait.md`
2. `03-the-configuration-bounds-the-wait.md`
3. `04-the-waiter-polls.md`
4. `05-the-handler-and-the-lifecycle.md` — depends on Stories 2, 3 and 4.
5. `06-the-capability-names-the-wait.md`
6. `01-the-proposal-records-the-wait.md` — documentation only, no source change.

**Six stories cover the EPIC's seven story bullets.** "The handler" and "The lifecycle" are merged into Story 5, because a handler that enters a wait without the shutdown step makes every stop take up to `http.event.maxWait` seconds. A plan must not create that intermediate state, so the pair is one story with one gate.

Every story passes `npm run verify` on its own, and there is no coupled pair left.

## Stories

- 1 — `docs/proposal/api/event.md` and `phase-1/transport.md` record the wait and the held request → `01-the-proposal-records-the-wait.md`
- 2 — `eventListRequest` gains `wait`, and the query example carries it → `02-the-contract-declares-the-wait.md`
- 3 — `http.event.maxWait` reaches `HttpSettings` → `03-the-configuration-bounds-the-wait.md`
- 4 — `src/http/server/event/wait.ts` holds the poll loop over an injected `Schedule` → `04-the-waiter-polls.md`
- 5 — the handler goes async and enters the waiter; `createApp` exposes `cancelWaits()` and `main.ts` cancels before it closes the listener → `05-the-handler-and-the-lifecycle.md`
- 6 — `event-wait` joins `capabilityOperations` → `06-the-capability-names-the-wait.md`

## Facts (needed for implementation)

- **D5 is honoured with one corrected construction site, and the EPIC needs no amendment.** D5 says the app exposes `cancelWaits()` held in `createApp`. A registry built inside `createApp` can never reach `listEventHandler`, because `createApp` receives an already-built `handlers` map. So `main.ts` **constructs** the registry and `createApp` **owns and exposes** the cancel handle, returning `Readonly<{ app: Koa; cancelWaits: () => void }>` in place of a bare `Koa`. Every `createApp` consumer therefore gets a cancellation handle. Story 5 states it in full.
- **The `createApp` return-type change touches 11 call sites and no more.** `src/main.ts:613`, `test/helpers/app.ts:122`, `src/http/server/app.test.ts:358`, `src/http/server/start.test.ts:25` and `:103`, and `src/http/server/dispatch.test.ts:137`, `:154`, `:171`, `:187`, `:202`, `:219`. The 50 files that use `createTestApp` are shielded by the helper and need no edit. `npm run typecheck` names every site.
- **`before` and `order` already landed.** `src/http/contract/cursor.ts:5-10` is `z.strictObject` with `after`, `before`, `order` (default `asc`) and `limit`. `wait` joins `eventListRequest` in `src/http/contract/event.ts:11-17`, never `cursorRequest`.
- **The strictness is why `wait` is a `400` today.** `src/http/contract/event.test.ts:22-24` and `src/http/server/event/list-event.test.ts:183` assert that refusal. **Story 2 inverts both**, because making `wait` a declared member turns the handler test at `:183` from a `400` into a `200` the moment the schema changes — a story that deferred it could not pass its own gate. Story 5 then replaces the accepting test with the waiting behaviour.
- **`createApp` discards the idempotency store it builds**, keeping only `.middleware` (`src/http/server/app.ts:92-99`). That is why the wait registry cannot follow the same pattern.
- **`systemSchedule` at `src/http/server/app.ts:58-62` is module-private.** Story 5 exports it so `main.ts` reuses the one production timer binding, per D4. Argument order is `(milliseconds, callback)` and it returns a bare cancel function.
- **Two unrelated `Schedule` types exist.** The HTTP one is `src/http/server/idempotency-store.ts:18-21`, `(milliseconds, callback) => () => void`. The git one is `src/services/git/run.ts:36-48`, `(callback, delayMs) => ScheduledTimer`, with the arguments reversed. This epic uses the HTTP one only, and Story 4's test derives the type from `WaitRegistryDependencies["schedule"]` rather than importing it from a sibling production module.
- **The repository's recording fake is not good enough for this epic.** `src/http/server/idempotency-store.test.ts:15-28` marks an entry `cancelled` in order to fire it, which makes "every timer was cancelled" vacuously true and cannot tell one cancel call from two. Stories 4 and 5 use a **virtual clock** — `now`, `dueAt`, `advanceBy(milliseconds)`, with `fired` and `cancelCalls` recorded separately. One `advanceBy(250)` fires one tick of _every_ pending wait, which is what makes Story 5's concurrency case expressible.
- **The wait registry exposes no observability method.** No `pending()`, no `size()`. A test-only public method on a production type is a poor trade, and the fake already answers every question: a leaked wait leaves an entry neither fired nor cancelled, and an unresolved promise is observable by racing it against a resolved sentinel.
- **A wait is never observed by guessing.** Both cancellation tests use an explicit registration signal: the in-process one resolves a promise inside the fake `schedule`, and the daemon one awaits the request's `"finish"` event and then a full barrier round trip. A `sleep` is not an acceptable synchronisation primitive anywhere in this epic.
- **A handler test builds the whole Koa app with a fake query.** `src/http/server/event/list-event.test.ts:34-40` uses `createTestApp` from `test/helpers/app.ts`. No sqlite. `test/helpers/app.ts:121` defaults `schedule` to a no-op, and that timer belongs to the idempotency store — a test that drives a wait passes its own `waits` built on a virtual-clock fake.
- **`singleValued` names the offending key.** `src/http/server/single.ts:14-19` throws `the query parameter <key> appeared more than once`, sorted bytewise, so `?wait=1&wait=2` names `wait`. The handler's own message is the generic `the event filters are not valid`.
- **`ListEventInput` has no `wait` member** — `src/queries/event/list-event.ts:7-17`. The handler strips `wait` before it calls the query.
- **The field-decisions fixture is regenerated, never hand-edited.** Run this, then read the diff:

```bash
node scripts/field-decisions-probe.mjs --write
```

`src/http/contract/coverage.test.ts:314` asserts `fieldDecisions` equals the freshly walked registry.

- **Two kinds of key assertion exist, and they are handled differently.** A _declared-key enumeration_ walks the schema and must gain `wait`: `src/http/contract/openapi.test.ts:400-412` (the parameter name list) and `src/http/contract/field-decisions.fixture.ts:46-54` (regenerated). A _parsed-key assertion_ lists the keys of one parse result and stays byte-identical, because its request does not send `wait`: `src/http/contract/event.test.ts:45-50` and `:52-73`, and `src/http/server/event/list-event.test.ts:82` and `:94`. Story 2 adds new tests for the `wait` key rather than amending any of those four.
- **`event-wait` sorts first, bytewise.** `eve` < `ext`, so it is the **first** key of `capabilityOperations` in `src/http/contract/capability.ts:5-14`. `src/http/contract/capability.test.ts:34-40` asserts the map keys equal the zod enum options and that the options are already bytewise sorted, so insertion position is load-bearing.
- **Two expected capability lists exist** and both change: `src/http/contract/capability.test.ts:43-48` and `src/main.capability.test.ts:124-128`.
- **`http.idempotency.joinTimeout` is the template for a duration in seconds** — `src/services/config/convict.ts:190-194`, `format: "nonNegativeInteger"`, `default: 30`, `env: "KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT"`. No entry in that file carries a `doc:` key. Three further sites carry it: the env-integer list at `convict.ts:339-349`, the settings projection at `convict.ts:493-498`, and the type at `src/services/config/index.ts:1-14`.
- **No generated configuration-file sample is asserted anywhere.** `src/cli/config/generate.ts:81-95` emits no `idempotency` block either, and the repository has no snapshot mechanism. Story 3 writes no sample.
- **The daemon-test template is `src/main.capability.test.ts`.** `createTemporaryHome()` + `home.writeConfig({ http: { port, allowedHosts: [...] } })` + `runCli(["db","migrate","--home",...])` + `launchDaemon({ configPath })` + `daemon.ready()`, torn down with `daemon.kill("SIGTERM")` and `await daemon.exited()`. `test/helpers/daemon.ts:10-17` gives `DaemonProcess`, and `exited()` resolves `{ code, signal }`. There is no shared http client for daemon tests — each file defines its own `rawRequest`.
- **`home.writeConfig` shallow-merges the `http` key** (`test/helpers/home.ts:31-47`), so a lower maximum is passed as `http: { port, allowedHosts, event: { maxWait: 2 } }`.
- **The write-nothing assertion pattern** is `src/main.capability.test.ts:197-224` (`PRAGMA data_version` through `DatabaseSync`) and `src/http/server/project/show-project-graph.test.ts:171-185` (full table contents plus `data_version`).
- **The production shutdown order is data in `main.ts:637-651`**, not code in `shutdown.ts`. `createShutdown` iterates `dependencies.steps` in array order. `src/http/server/shutdown.test.ts` asserts order with synthetic steps only, so Story 5 adds a source-text-order test to `src/main.test.ts` — the only mechanism that pins the production array. That file is **not** in the EPIC Proof command, so cite `npm run verify` for that bullet.
