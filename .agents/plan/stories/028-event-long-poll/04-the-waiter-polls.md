# Story 4 — The waiter polls

Epic: `.agents/plan/epics/028-event-long-poll.md`

## Change

### `src/http/server/event/wait.ts` — new file

One module holding the poll loop and the cancel token. It owns no SQL, imports no koa type, and never calls the query itself — the caller passes a `read` closure.

Exact public contract:

```ts
import type { Schedule } from "../idempotency-store.ts";

export const POLL_INTERVAL_MS = 250;

export type WaitInput<T> = Readonly<{
  read: () => readonly T[];
  waitSeconds: number;
}>;

export type WaitRegistry = Readonly<{
  wait<T>(input: WaitInput<T>): Promise<readonly T[]>;
  cancelAll(): void;
}>;

export type WaitRegistryDependencies = Readonly<{
  schedule: Schedule;
}>;

export function createWaitRegistry(
  dependencies: WaitRegistryDependencies,
): WaitRegistry;
```

`Schedule` is the HTTP one at `src/http/server/idempotency-store.ts:18-21` — `(milliseconds, callback) => () => void`. Do not import the git `Schedule` of `src/services/git/run.ts:36-48`; its arguments are reversed.

Pin the loop exactly:

- `wait` returns a promise and schedules the **first** tick at `POLL_INTERVAL_MS`. It never calls `read()` before the first tick, because the caller already did the first read.
- The tick count is `Math.floor((waitSeconds * 1000) / POLL_INTERVAL_MS)`. For `waitSeconds` of 5 that is exactly 20 ticks.
- On each tick, call `read()` exactly once. If the result length is greater than zero, resolve with that result and schedule no further tick.
- If the result is empty and ticks remain, schedule the next tick at `POLL_INTERVAL_MS`.
- If the result is empty and the tick just run was the last, resolve with an empty array.
- A `waitSeconds` of `0` resolves with an empty array and schedules **zero** timers.
- Every resolution — a match, an elapse, or a cancel — calls the cancel function the current `schedule` call returned, then removes the wait from the registry. Call each cancel function exactly once.
- `cancelAll()` resolves every pending wait with an empty array, cancels its outstanding timer, and empties the registry. It never rejects, and it is safe to call with nothing pending.
- **The registry exposes no observability method.** There is no `pending()` and no `size()`. A test-only public method is a poor trade on a production type, and the fake schedule already answers every question a test has: a leaked wait leaves an entry that is neither fired nor cancelled, and an unresolved promise is observable by racing it against a resolved sentinel.
- **A scheduled callback never runs synchronously inside `schedule()`.** `wait` must return its promise before any tick can run. The `Schedule` type does not express this, and the production binding at `src/http/server/app.ts:58-62` satisfies it through `setTimeout`, so state it here and let the fake satisfy it too.
- A wait already resolved is never resolved a second time. `cancelAll()` after an elapse is a no-op for that wait.
- `wait` never rejects on its own. A throw from `read()` becomes a rejection of that one wait's promise, and still removes it from the registry and cancels its timer.

The registry holds its waits in insertion order, and `cancelAll()` resolves them in that order.

## Constraints

- The interval is the exported constant `POLL_INTERVAL_MS`, fixed at `250`. It is not configuration and takes no dependency.
- Call no timer function directly. No `setTimeout`, no `setInterval`. Every delay goes through `dependencies.schedule`.
- Read no clock. The elapse is counted in ticks, never in milliseconds measured against `Date.now()`. This is what makes the test hermetic.
- The module is generic over the row type and imports nothing from `queries/`, `domain/` or `http/contract/`. It stays ignorant of what an event is.
- Import no koa type and no `Handler`.

## Verify

### `src/http/server/event/wait.test.ts` — new file

Build a **virtual clock**, not a first-in-first-out callback queue. A queue that fires "the oldest armed timer" cannot express "advance 250 ms" once two waits are pending, and Story 4's concurrency case depends on that distinction. Model `now` and `dueAt`, and run every callback due at the same virtual time in insertion order:

```ts
type Armed = {
  dueAt: number;
  run: () => void;
  fired: boolean;
  cancelCalls: number;
};

function createFakeSchedule() {
  let now = 0;
  const armed: Armed[] = [];
  const schedule: WaitRegistryDependencies["schedule"] = (at, run) => {
    const entry: Armed = { dueAt: now + at, run, fired: false, cancelCalls: 0 };
    armed.push(entry);
    return () => {
      entry.cancelCalls += 1;
    };
  };
  const advanceBy = (milliseconds: number): void => {
    now += milliseconds;
    for (const entry of [...armed]) {
      if (!entry.fired && entry.cancelCalls === 0 && entry.dueAt <= now) {
        entry.fired = true;
        entry.run();
      }
    }
  };
  return { schedule, armed, advanceBy, now: () => now };
}
```

Two properties of this fake are load-bearing:

- `fired` and `cancelCalls` are **separate**. A fake that marks an entry cancelled in order to fire it makes "every timer was cancelled" vacuously true, and it cannot tell one cancel call from two. Assert `cancelCalls` by value where the contract names it.
- `advanceBy` iterates a copy of `armed`, so a callback that arms the next tick during the sweep does not run inside the same advance. One `advanceBy(250)` therefore fires exactly one tick of each pending wait.

Derive the `Schedule` type from `WaitRegistryDependencies["schedule"]` as shown, and do **not** import `Schedule` from `../idempotency-store.ts`. A test imports its module under test, `domain/`, service interfaces, `test/helpers/` and `node:` builtins; a sibling production module is outside that list, and the type is reachable through the module under test at no cost.

Assert a pending promise with `Promise.race` against a resolved sentinel value. Never assert pending with a timer.

Tests, each asserting a value:

- **`POLL_INTERVAL_MS` is 250.** Asserted by value.
- **Zero seconds schedules nothing.** `wait({ read, waitSeconds: 0 })` resolves deep-equal to `[]`, `armed.length` is `0`, and `read` was called `0` times.
- **The promise is returned before any tick runs.** With `waitSeconds: 5`, `read` was called `0` times immediately after `wait(...)` returns and before the first `advanceBy`. This pins the no-synchronous-callback rule.
- **The first tick is due at the interval.** With `waitSeconds: 5`, `armed[0].dueAt` equals `250`. `advanceBy(249)` leaves `read` called `0` times; `advanceBy(1)` makes it `1`.
- **A match on the first tick resolves with the rows.** `read` returns `["a"]`. After `advanceBy(250)` the promise resolves deep-equal to `["a"]`, `armed.length` is `1` — no second timer was armed — and every armed entry is settled — each one has `fired === true` or `cancelCalls === 1`.
- **A match cancels its outstanding timer exactly once.** After the match above, `armed[0].cancelCalls` equals `1`. Not `0`, and not `2`.
- **A match on the third tick.** `read` returns `[]` twice then `["a", "b"]`. After three `advanceBy(250)` calls the promise resolves deep-equal to `["a", "b"]`, `read` was called exactly `3` times, and `armed.length` is `3`.
- **The full elapse resolves empty after exactly twenty ticks.** `waitSeconds: 5`, `read` always empty. After 19 `advanceBy(250)` calls the promise is still pending. After the 20th it resolves deep-equal to `[]`. `read` was called exactly `20` times and `armed.length` is exactly `20`.
- **No tick runs after the terminal one.** Continue with two further `advanceBy(250)` calls after the elapse; `read` is still `20` and `armed.length` is still `20`.
- **One second is four ticks.** `waitSeconds: 1` elapses empty on the 4th `advanceBy(250)`, and `armed.length` is `4`.
- **`cancelAll` resolves a pending wait empty.** Start `waitSeconds: 30`, two `advanceBy(250)` calls with `read` empty, call `cancelAll()`, and the promise resolves deep-equal to `[]`. the one un-fired entry has `cancelCalls` equal to `1`, and no entry is left both un-fired and un-cancelled.
- **`cancelAll` resolves several waits in insertion order.** Start three waits, each with a `.then` pushing its own name into a shared array. After `cancelAll()` and awaiting all three, the array deep-equals the insertion order.
- **`cancelAll` with nothing pending does not throw**, and `armed` stays empty.
- **`cancelAll` after an elapse does not resolve twice.** Elapse a wait fully, count resolutions in a `.then` counter, call `cancelAll()`, and the counter is `1`. The already-fired terminal entry keeps `cancelCalls` at `1` — `cancelAll` does not cancel a wait that already resolved.
- **A second `cancelAll` is a no-op.** Two consecutive calls, nothing throws, and no `cancelCalls` moves past `1`.
- **No wait leaks.** Start two waits, elapse one fully, then `cancelAll()`. Both promises settle — assert with `Promise.all` — and every entry of `armed` satisfies `fired === true || cancelCalls === 1`. This is the leak oracle, and it needs no method on the production type.
- **A throwing `read` rejects that one wait and cleans up.** `read` throws on the first tick. `assert.rejects` on the promise, and that entry's `cancelCalls` is `1`. A second wait started afterwards still resolves normally.
- **Two waits advance together and stay independent.** Wait A's `read` returns `["a"]` on its first tick; wait B's `read` stays empty with `waitSeconds: 30`. One `advanceBy(250)` fires one tick of each: A resolves deep-equal to `["a"]`, B is still pending, and `read` for B was called exactly `1` time. Then `cancelAll()` and B resolves `[]`. This is the per-request property — the registry holds no shared cursor — and it is the case a first-in-first-out fake cannot express.
- **No wall clock, asserted by construction.** Read `./wait.ts` with `readFileSync` and assert the source contains none of `setTimeout`, `setInterval`, `Date.now`, `performance.now`. Mirror the source-text convention of `src/main.test.ts:530-545`.

### Commands

```bash
node --test src/http/server/event/wait.test.ts
```

`npm run verify` exits 0. `npm run lint` passes — this module imports only from `http/server/`, which the import matrix permits.

Proof: `PASS EPIC-028` for `src/http/server/event/wait.test.ts`. Delivers the Hermetic coverage bullet "No test waits on a wall clock" for this module, and the tick-level half of "The behaviour matrix, against a fake schedule".
