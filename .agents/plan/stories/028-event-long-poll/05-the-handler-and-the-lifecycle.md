# Story 5 — The handler and the lifecycle

Epic: `.agents/plan/epics/028-event-long-poll.md`
Depends on: Story 2, Story 3, Story 4.

This story merges the EPIC's two story bullets "The handler" and "The lifecycle". They are one story because Story 4's handler alone would make every shutdown take up to `http.event.maxWait` seconds, and a plan must not create that intermediate state.

**D5 is honoured, with one correction the EPIC could not see.** D5 says the app exposes `cancelWaits()` "held beside the idempotency store in `createApp`". Taken literally that is impossible: `createApp` receives an already-built `handlers` map, so a registry constructed inside `createApp` can never reach `listEventHandler`. The faithful reading is therefore:

- the registry is **constructed** by the caller, because the handler needs it first;
- the app **owns and exposes** the cancel handle, so every `createApp` consumer gets one and no consumer has to rebuild the lifecycle wiring;
- `createApp` returns `Readonly<{ app: Koa; cancelWaits: () => void }>` instead of a bare `Koa`.

That keeps D5's operative sentence — the app exposes one `cancelWaits()` — and fixes only its construction site. There are exactly 11 `createApp` call sites and the 50 files using `createTestApp` are shielded by `test/helpers/app.ts`, so the change is small and `npm run typecheck` names every site.

## Change

### `src/http/server/event/list-event.ts`

The whole file is 34 lines. Change three things and nothing else.

Add one import:

```ts
import type { WaitRegistry } from "./wait.ts";
```

Extend `ListEventHandlerDependencies` (lines 10-12) to exactly:

```ts
export type ListEventHandlerDependencies = Readonly<{
  listEvents: (input: ListEventInput) => readonly EventView[];
  waits: WaitRegistry;
  maxWaitSeconds: number;
}>;
```

Both new members are required, not optional.

Replace the returned handler at lines 17-33. It becomes `async`, and the order of its steps is binding:

1. `const parsed = eventListRequest.safeParse(singleValued(context.query));` — unchanged, line 18.
2. `if (!parsed.success) { throw httpError("invalid-request", "the event filters are not valid"); }` — unchanged, lines 19-21.
3. Split the wait out of the filters: `const { wait, ...filters } = parsed.data;`. `ListEventInput` at `src/queries/event/list-event.ts:7-17` has no `wait` member, so `filters` is what reaches the query.
4. Refuse a wait above the configured maximum, **after** the schema parse and **before** the first read:

```ts
if (wait !== undefined && wait > dependencies.maxWaitSeconds) {
  throw httpError("invalid-request", "the event filters are not valid");
}
```

5. First read: `const first = dependencies.listEvents(filters);`.
6. If `wait` is `undefined`, or `wait` is `0`, or `first.length > 0`, format `first` and return. **A first read that returns events never waits**, and it never touches `dependencies.waits`.
7. Otherwise `const waited = await dependencies.waits.wait({ read: () => dependencies.listEvents(filters), waitSeconds: wait });` and format `waited`.

Keep the formatting map exactly as it is at lines 22-31 — the same eight fields, with `createdAt: event.occurredAt` the only rename. Extract it into one local function so both returns share it; do not write the object literal twice.

Both paths return `{ status: 200, body: { events } }`.

### `src/http/server/app.ts`

Add the `export` keyword to `systemSchedule` at line 58, so `main.ts` reuses the one production timer binding per D4:

```ts
export const systemSchedule: Schedule = (milliseconds, callback) => {
```

Add one import:

```ts
import type { WaitRegistry } from "./event/wait.ts";
```

Add one member to `AppDependencies` (lines 47-56), as the **last** member after `schedule` at line 55:

```ts
waits: WaitRegistry;
```

It is required. `npm run typecheck` then names every call site that must supply it.

Add one exported type immediately before `createApp`:

```ts
export type App = Readonly<{
  app: Koa;
  cancelWaits: () => void;
}>;
```

Change the signature at line 66 to `export function createApp(dependencies: AppDependencies): App {` and the final `return app;` at line 100 to:

```ts
return {
  app,
  cancelWaits: () => {
    dependencies.waits.cancelAll();
  },
};
```

Change nothing else. The middleware chain, its order, `bindingOffenders` and `BindingError` are untouched.

### `src/main.ts`

Extend the `createApp` import at line 170 to carry `systemSchedule`, and add:

```ts
import { createWaitRegistry } from "./http/server/event/wait.ts";
```

Build the registry **before** the `handlers` map, immediately after the services block that ends at line 247:

```ts
const waits = createWaitRegistry({ schedule: systemSchedule });
```

Extend the `event.list` binding at lines 564-566. It reads today:

```ts
        "event.list": listEventHandler({
          listEvents: (input) => listEvents({ events }, input),
        }),
```

It becomes:

```ts
        "event.list": listEventHandler({
          listEvents: (input) => listEvents({ events }, input),
          waits,
          maxWaitSeconds: settings.http.event.maxWait,
        }),
```

`settings.http.event.maxWait` comes from Story 3.

Change the `createApp` call at line 613. Add `waits,` to the dependency object, and destructure the result:

```ts
      const { app, cancelWaits } = createApp({
```

`listen(app, ...)` at line 632 then takes the destructured `app` and needs no other change.

Add one shutdown step as the **first** element of the `steps` array at lines 638-652, before the `listener` step at line 639:

```ts
          {
            name: "waits",
            run: () => {
              cancelWaits();
            },
          },
```

The final production order is `waits`, `listener`, `storage`, `home-lock`.

### `test/helpers/app.ts`

Add two imports beside the existing `createApp` import:

```ts
import { createWaitRegistry } from "../../src/http/server/event/wait.ts";
import type { WaitRegistry } from "../../src/http/server/event/wait.ts";
```

At line 122 the helper calls `createApp`. Destructure both members — the helper needs `cancelWaits` for the `TestApp` it returns — and keep the helper's own contract otherwise unchanged, so none of the 50 files using `createTestApp` need an edit:

```ts
  const { app, cancelWaits } = createApp({
```

Add `waits` to that dependency object, defaulting so a handler test needs no ceremony:

```ts
    waits: overrides?.waits ?? createWaitRegistry({ schedule }),
```

Add `waits?: WaitRegistry;` to `TestAppOverrides` (lines 45-55) as its last member, and add `cancelWaits` to the returned `TestApp` so a test can drive a shutdown in process. Extend `TestApp` (lines 57-64) with one member:

```ts
  cancelWaits(): void;
```

Add `cancelWaits` to the returned object literal, forwarding the one `createApp` gave back.

Note the existing `schedule` default at line 121 is the no-op `() => () => {}`. A test that drives a wait passes its own `waits` built on a virtual-clock fake, exactly as Story 4's test does.

### The remaining `createApp` call sites

`npm run typecheck` names them. Add `waits: createWaitRegistry({ schedule: () => () => {} })` to the dependency literal, and destructure `const { app } = createApp({...})` where the return value is used:

- `src/http/server/app.test.ts:358`
- `src/http/server/start.test.ts:25` and `:103`
- `src/http/server/dispatch.test.ts:137`, `:154`, `:171`, `:187`, `:202`, `:219` — these assert `BindingError` and discard the return value, so they need only the new `waits` member.

Change no assertion in those files. This is a mechanical type fix, not a behaviour change.

### `src/http/server/shutdown.ts`

No edit. The order is data in `main.ts`, not code here.

## Constraints

- Build exactly one registry per process. `main.ts` constructs it, and `createApp` only exposes its cancel handle.
- `cancelWaits()` is synchronous and must not throw. It runs before `listening.close()`, so `server.close()` never waits on a held request.
- Change no other shutdown step, and do not reorder `listener`, `storage` and `home-lock` relative to each other.
- Add no signal handler. `main.ts:658-662` already wires `SIGTERM` and `SIGINT`.
- Do not change the middleware chain or its order.
- The refusal in step 4 compares against `dependencies.maxWaitSeconds` and never clamps. Do not call `Math.min`.
- Pass `filters` to `listEvents`, never `parsed.data`.
- Do not mutate `filters` between polls, and do not advance `after` inside the handler.
- Change no other handler. Every other handler stays synchronous.
- The handler reads neither `context.body` nor `context.parameters`. The test at `src/http/server/event/list-event.test.ts:236` asserts this and stays passing.

## Verify

### `src/http/server/event/list-event.test.ts`

Extend the `handlerApp` helper at lines 34-40 so a test supplies a registry and a maximum, keeping the existing zero-argument call sites working:

```ts
async function handlerApp(
  listEvents: (input: ListEventInput) => readonly EventView[],
  options?: Readonly<{ waits?: WaitRegistry; maxWaitSeconds?: number }>,
) {
  const waits =
    options?.waits ?? createWaitRegistry({ schedule: () => () => {} });
  return createTestApp({
    waits,
    handlers: {
      "event.list": listEventHandler({
        listEvents,
        waits,
        maxWaitSeconds: options?.maxWaitSeconds ?? 30,
      }),
    },
  });
}
```

The registry passed to `createTestApp` and the one passed to `listEventHandler` must be the **same object**, so an in-process `app.cancelWaits()` cancels the wait the handler entered.

Use the **virtual-clock** `createFakeSchedule` of Story 4's test — `advanceBy(milliseconds)`, with `fired` and `cancelCalls` recorded separately.

**Story 2 already replaced the old `wait answers 400` test at line 183** with `wait parses and the handler still answers at once` plus `wait 61 answers 400 at the schema`. Replace the **first** of those two with the waiting behaviour below, and leave the `wait 61` test byte-identical. Leave every other existing test in the file byte-identical.

The behaviour matrix:

- **`wait` absent answers immediately.** `GET /v1/event` with `listEvents` returning `[first]` answers `200`, the body deep-equals the one-event shape, and `armed.length` is `0`.
- **`wait=0` answers immediately.** `GET /v1/event?wait=0` with `listEvents` returning `[]` answers `200` with `{ events: [] }`, and `armed.length` is `0`.
- **`wait=5` with events already present answers immediately and never schedules a timer.** `?wait=5` with `listEvents` returning `[first, second]` answers `200` with both events, `armed.length` is `0`, and `listEvents` was called exactly `1` time.
- **`wait=5` with no events elapses to an empty `200`.** `listEvents` always returns `[]`. Issue the request without awaiting it, call `advanceBy(250)` 20 times, then await: status `200`, body deep-equals `{ events: [] }`, and `listEvents` was called exactly `21` times — one first read plus 20 polls.
- **`wait=5` with an event appended after two poll ticks answers with that event and cancels its timer.** `listEvents` returns `[]` for calls 1 to 3 and `[first]` from call 4 on. Call `advanceBy(250)` 3 times, then await: status `200`, body deep-equals the `[first]` shape, every fired `armed` entry has `cancelCalls` equal to `1`, and `armed.length` is `3`.

The elapsed wait is not an error:

- The elapsed response status is exactly `200`. Not `204`, not `408`.
- `eventListResponse.safeParse(response.body).success` is `true`.
- `Object.hasOwn(response.body, "error")` is `false`, and `JSON.stringify(response.body)` equals the string `{"events":[]}`.

The cursor is honoured under a wait:

- **`after` reaches the query on every poll.** `?wait=5&after=<second.id>` with a `listEvents` that records each input. Elapse it with 20 `advanceBy(250)` calls, then assert every recorded input deep-equals `{ after: "<second.id>", limit: 100, order: "asc" }` — 21 identical recordings — and that `"wait" in recorded` is `false` for each.
- **A wait that returns carries only events after the cursor, and a second call with the returned last id returns empty.** Model the log in the fake: `listEvents` filters its fixture array by the `after` it receives. First request `?wait=5&after=<first.id>` returns `[second]` on its first tick after one `advanceBy(250)`; second request `?wait=5&after=<second.id>` elapses to `{ events: [] }`. No event is delivered twice and none is skipped.
- **`order=desc` under a wait.** `?wait=5&order=desc` with `listEvents` returning `[second, first]` answers at once with that order and `armed.length` is `0`. With `listEvents` empty it elapses to `{ events: [] }`, and every recorded input carries `order: "desc"`.

The maximum is a refusal, not a clamp:

- `?wait=61` answers `400` with `body.error.code` equal to `invalid-request`, refused at the schema.
- `?wait=45` against `maxWaitSeconds: 30` answers `400` with `body.error.code` equal to `invalid-request`, `armed.length` is `0`, and `listEvents` was called `0` times — the refusal precedes the first read.
- `?wait=30` against `maxWaitSeconds: 30` is accepted: the boundary is inclusive. With `listEvents` empty it arms a timer, so `armed.length` is `1` before any advance.
- `?wait=1` against `maxWaitSeconds: 0` answers `400`.
- `?wait=0` against `maxWaitSeconds: 0` answers `200` immediately, because `0` is not greater than `0`.
- `?wait=-1` answers `400` at the schema.
- `?wait=abc` answers `400` at the schema.

A repeated key is refused:

- `?wait=1&wait=2` answers `400`, `body.error.code` is `invalid-request`, and `String(body.error.message).includes("wait")` is `true`. The message comes from `singleValued` at `src/http/server/single.ts:14-19`, matching the repeated-`type` test at line 191.

Concurrency:

- **Two waiting requests with different filters both return correctly.** One registry, one virtual-clock fake. Issue `?wait=5&type=node.created` and `?wait=5&type=node.blocked` without awaiting either, and await one macrotask so both have armed their timers — assert `armed.length` is `2` before advancing. The fake `listEvents` returns `[first]` when the recorded input has `type === "node.created"` and `[]` otherwise. One `advanceBy(250)` fires one tick of each. Await both: the `node.created` request answers `200` with the `[first]` shape, and the `node.blocked` request is still pending. Elapse it with 19 further `advanceBy(250)` calls and it answers `200` with `{ events: [] }`.

**The in-process cancellation case — this is the deterministic proof of D5, and it replaces the racy daemon handshake.**

- **A wait cancelled in flight answers an empty `200`.** Build the app through `handlerApp` with a virtual-clock fake and `listEvents` always empty. Register a **registration signal** on the fake so the test never guesses when the wait was entered:

```ts
let registered!: () => void;
const armedOnce = new Promise<void>((resolve) => {
  registered = resolve;
});
```

Call `registered()` inside the fake `schedule` the first time it is invoked. Issue `?wait=30` without awaiting it, `await armedOnce` — which proves the handler completed its first read and entered the registry — then call `app.cancelWaits()`. Await the response: status `200`, body deep-equals `{ events: [] }`, `advanceBy` was never called, and the armed entry has `cancelCalls` equal to `1`. No timer fired, so the wait ended by cancellation and not by elapse.

Regression guards that must keep passing unchanged: lines 43, 75, 82, 94, 116, 134, 143, 151, 161, 175, 191, 200, 214, 222 and 236.

### `src/http/server/shutdown.test.ts`

Add two tests in the existing style — synthetic steps pushing letters into a local `order` array, mirroring lines 7-34:

- **A cancel step declared first runs before the listener step.** Steps named `waits`, `listener`, `storage`, `home-lock` whose `run` closures push their own names; `order` deep-equals `["waits", "listener", "storage", "home-lock"]`.
- **A throwing cancel step does not stop the listener step.** `waits` throws; `order` still deep-equals the same four names, `settled` deep-equals `[1]`, and one line matching `/^kanthord: shutdown: waits failed: /` was written. Mirrors lines 50-85.

Leave every existing test byte-identical.

### `src/main.test.ts`

Nothing pins the **production** step array — `shutdown.test.ts` uses synthetic steps only. Add one source-text-order test, mirroring the convention at `src/main.test.ts:530-545` which reads `./main.ts` with `readFileSync` and compares `indexOf` positions:

- **The shutdown steps are declared in the order `waits`, `listener`, `storage`, `home-lock`.** Take `indexOf` of each of `name: "waits"`, `name: "listener"`, `name: "storage"`, `name: "home-lock"`, assert each is greater than `-1`, and assert the four positions are strictly increasing.

Leave every other test in the file byte-identical.

### `src/http/server/app.test.ts`

Add one test for the new return shape:

- **`createApp` returns an app and a cancel handle, and the handle reaches the registry.** Build a registry whose `cancelAll` sets a local flag, pass it as `waits`, call `createApp`, assert the result has exactly the keys `["app", "cancelWaits"]`, call `cancelWaits()`, and assert the flag is `true`. This is the assertion that D5's exposure actually exists.

### `src/main.event-wait.test.ts` — new file

The route-level acceptance test, driving the real composition root through `launchDaemon` with no injected handler map. Mirror `src/main.capability.test.ts`: `createTemporaryHome()`, `reservePort()`, `home.writeConfig({ http: { port, allowedHosts: [`127.0.0.1:${port}`] } })`, `runCli({ args: ["db", "migrate", "--home", home.path] })` asserted to exit `0`, `launchDaemon({ configPath })`, `await daemon.ready()`. Copy the local `rawRequest()` helper of `src/main.capability.test.ts:31-59`.

`home.writeConfig` shallow-merges the `http` key, so a lower maximum is passed as `http: { port, allowedHosts, event: { maxWait: 2 } }`.

**No test in this file waits on a wall clock to observe an elapse.** The elapse is proven against the fake schedule above. This file proves only what the fake cannot: that the real root wired the schema, the configuration value and the shutdown step.

Tests:

- **`wait=61` is refused by the shipped schema.** `?wait=61` answers `400` with `body.error.code` equal to `invalid-request`.
- **A wait above the configured maximum is refused.** With `maxWait: 2`, `?wait=30` answers `400` with `body.error.code` equal to `invalid-request`. This proves the configuration value reached the handler through the real composition root.
- **An immediate answer still comes from the real root.** `?wait=0` answers `200` and the body parses against `eventListResponse`. This proves the new handler dependencies are bound in `main.ts`.
- **`GET /v1/event` writes nothing.** Use the inline `DatabaseSync` idiom of `src/main.capability.test.ts:197-224` against `join(home.path, "kanthord.db")`. Compare `SELECT * FROM event ORDER BY id ASC` and `PRAGMA data_version` around a `?wait=0` call, and again around a call that returns an event — seed that event with `actor.register`, which appends one, then read it back with `?after=<the id before it>`.

- **Shutdown does not wait for a waiter.** Its own `describe` with its own daemon and `http: { event: { maxWait: 30 } }`. The handshake is deterministic and must be built in this exact order, because a `sleep` is not an acceptable synchronisation primitive:

  1. Send the waiting request with `node:http` rather than `fetch`, and `await` a promise that resolves on the request's `"finish"` event. That proves the request bytes were fully written to the socket.
  2. Then `await` a complete `?wait=0` round trip on a second connection — a **barrier request**. The daemon is single-threaded, and the waiting request's bytes reached the socket first, so the daemon dispatched that handler, completed its first read and entered the registry before it could answer the barrier. A completed barrier therefore proves the wait is registered.
  3. Only then `daemon.kill("SIGTERM")`, capturing `Date.now()` immediately before.

  Assert:
  - the pending request resolves with status `200` and a parsed body deep-equal to `{ events: [] }`;
  - `(await daemon.exited()).code` equals `0`;
  - the elapsed time from the signal to the exit is under one second, `assert.ok(elapsed < 1000)`. The EPIC requires this bound, and it is a bound on a process exit rather than a wait on a clock. Without the `waits` step it fails by taking the full thirty seconds;
  - `daemon.stderr()` ends with `kanthord: stopped\n` and contains no `kanthord: shutdown: ` line, matching `src/main.test.ts:516-528`.

### Commands

```bash
node --test \
  src/http/server/event/list-event.test.ts \
  src/http/server/event/wait.test.ts \
  src/http/server/app.test.ts \
  src/http/server/start.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/shutdown.test.ts \
  src/main.test.ts \
  src/main.event-wait.test.ts
```

`npm run verify` exits 0. `npm run typecheck` must be clean — the required `waits` member and the new `createApp` return type are what name every remaining call site.

Proof: `PASS EPIC-028` for `src/http/server/event/list-event.test.ts`, `src/http/server/event/wait.test.ts`, `src/http/server/shutdown.test.ts` and `src/main.event-wait.test.ts`.

Delivers the Hermetic coverage bullets "The behaviour matrix, against a fake schedule", "The elapsed wait is not an error", "The cursor is honoured under a wait", "The maximum is a refusal, not a clamp", "A repeated key is refused", "Concurrency", "Shutdown does not wait for a waiter", "Shutdown order", "`GET /v1/event` still writes nothing" and "The route-level acceptance test". It also delivers the `wait` with `order=desc` assertion the Open items of `026-event-tail-read.md` assign to this epic.

**The shutdown-order evidence sits outside the Proof block.** The source-order test lands in `src/main.test.ts`, which the EPIC Proof command does not run. Cite `npm run verify` for that bullet, not the printed `PASS EPIC-028` line.
