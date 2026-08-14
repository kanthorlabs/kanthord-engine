# Story 7 — The deadline has one owner

Epic: `.agent/plan/epics/102-provider-transport.md`
Depends on: Story 1.

This story runs in two parts. **Part A** touches the `clock` capability only and passes the full gate on its own. **Part B** edits `src/services/model/pi-ai.ts`, so it runs inside the coupled unit, after Story 2 creates that file. Do not start Part B before Story 2.

## Change — Part A (clock capability, dispatched on its own)

- Add one interface to `src/services/clock/index.ts`, below the existing `Clock` (`src/services/clock/index.ts:1-3`):

  ```ts
  export interface Deadline {
    arm(delayMs: number, onExpire: () => void): () => void;
  }
  ```

  The returned function disarms.

- Create `src/services/clock/system-deadline.ts`, exporting `class SystemDeadline implements Deadline`. `arm` calls `setTimeout(onExpire, delayMs)`, calls `.unref()` on the returned handle, and returns `() => clearTimeout(handle)`.

## Change — Part B (adapter, inside the coupled unit)

- In `src/services/model/pi-ai.ts`, own the deadline and the cancellation for one call (steps 8 and 11 of the Story 2 pipeline):
  - Hold one `let outcome: "timeout" | "cancelled" | null = null`. Assign it only when it is still `null`, so the first setter wins and a later one never replaces it.
  - Create one `const controller = new AbortController()` per call. `controller.signal` is the `signal` of `StreamOptions`.
  - `const disarm = this.dependencies.deadline.arm(request.timeoutMs, () => { if (outcome === null) outcome = "timeout"; controller.abort(); })`.
  - When `request.signal !== null`, add `const onAbort = () => { if (outcome === null) outcome = "cancelled"; controller.abort(); }` with `request.signal.addEventListener("abort", onAbort, { once: true })`.
  - In a `finally`, call `disarm()` and, when a listener was added, `request.signal.removeEventListener("abort", onAbort)`.
  - **The deadline preempts the iteration.** Do not wait on the stream alone. `pi-ai` can leave a stream that never ends, so an abort that only aborts the signal would leave `complete()` pending forever. Hold one `preempted` promise that both the deadline callback and the abort listener settle, take the iterator explicitly, and race each step:

    ```ts
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), preempted]);
      if (step === preemptedSentinel) break;
      if (step.done === true) break;
      // handle step.value per Story 5
    }
    ```

    `complete()` therefore always settles within `request.timeoutMs`, whatever the stream does. After the loop, the `outcome` flag decides the code per Story 5.

  - Map a refusal that follows an abort by `outcome`: `"timeout"` gives `model-timeout`, `"cancelled"` gives `model-cancelled`, `null` gives `model-failed`. Apply this to a terminal `error` event, to a synchronous throw from `models.stream`, and to a throw raised by the `for await` iteration.
  - An `onTextDelta` that throws calls `controller.abort()`, leaves `outcome` unchanged, and refuses `callback-failed`. The thrown value is not attached, and no later delta reaches the callback.
  - An abort that arrives after the terminal event changes no result.

## Constraints

- Pass no `timeoutMs` to `StreamOptions`. `pi-ai` forwards it to a provider SDK and enforces nothing itself; two timers would make the reported code depend on which fires first.
- Preemption is load-bearing, not defensive polish. On `pi-ai` 0.84.1 any provider stream that ends with no terminal event leaves the outer stream unended, so without preemption the call never settles. Verified against the real nested `lazyApi` topology; see `index.md`.
- Preemption must not change a settled outcome. A stream that produced a terminal event before the deadline keeps its result, so check the terminal event before the preemption branch.
- `unref()` is required so `node --test` exits with no hanging handle.
- `controller.abort()` is called with no argument, so the SDK sees a plain `AbortError` and kanthord never reads it.
- Add `Deadline` to `src/services/clock/index.ts` only. The file must stay free of the string `"implements "` (`src/domain/layout.test.ts:159-175`).
- Add no new service directory. `Deadline` and `SystemDeadline` belong to the existing `clock` capability.

## Verify

- Add `src/services/clock/system-deadline.test.ts`, suite name `src/services/clock/system-deadline.test`, asserting (Part A):
  - `new SystemDeadline().arm(3600000, () => {})` returns a value of `typeof === "function"`.
  - `arm(0, callback)` fires the callback; await it through one `new Promise` the callback resolves.
  - The returned function disarms, proved so that a no-op disarm fails: arm `0` with a callback that flips a boolean, call the returned function at once, then await `new Promise((resolve) => setTimeout(resolve, 20))`, and assert the boolean is still `false`. A one-hour delay must not be used here; its callback is never due, so a no-op disarm would pass.
  - Arming twice and disarming only the first leaves the second callback free to fire; assert the second boolean turns `true` after the same wait.
  - `node --test src/services/clock/system-deadline.test.ts` exits without a hanging handle.
- In `src/services/model/pi-ai.test.ts` (helpers from Story 9), add tests over the transport that never pushes a terminal event and resolves only on `options.signal` abort, asserting (Part B):
  - Called with `timeoutMs: 5000` under `createManualDeadline`, the deadline armed exactly one entry of `5000`. Expiring it by one synchronous call rejects the promise with `code === "model-timeout"`, and the transport observed `options.signal.aborted === true`. The test reads no wall clock.
  - Called with a `request.signal` from an `AbortController` aborted after the call starts, it rejects with `code === "model-cancelled"`, and the armed deadline is disarmed.
  - Cancelled through `request.signal` first and expired by the manual deadline second, it rejects with `code === "model-cancelled"`. The reverse order rejects with `code === "model-timeout"`.
  - A `request.signal` that is already aborted rejects with `code === "model-cancelled"`, and the transport recorded zero calls.
  - Preemption is proved to be load-bearing: the `endWithoutTerminal` transport, whose stream ends with no terminal event and therefore never ends the outer stream, still rejects with `code === "model-timeout"` once the manual deadline expires. A build without preemption fails this test on `--test-timeout` rather than passing.
  - A call whose terminal event arrived before the deadline keeps its result: script `text_delta` then `done`, await the result, then expire the manual deadline, and assert `result.text` is unchanged and nothing rejects.
  - An `onTextDelta` that throws on the first `text_delta` rejects with `code === "callback-failed"`, the transport observed `options.signal.aborted === true`, and the callback recorded exactly one call.
- Add to `src/domain/layout.test.ts` one test asserting `src/services/clock/system-deadline.ts` exists, with `fs.existsSync` through `fileURLToPath`, following `:144-157`.
- Part A runs `node --test --test-timeout=60000 src/services/clock/system-deadline.test.ts src/domain/layout.test.ts`; it exits 0, and `npm run verify` exits 0.
- Part B runs `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts` at the end of the coupled unit.
- Always pass `--test-timeout=60000` on a direct `node --test` command in this epic. The bare form has no timeout, so a deadline or stream defect hangs the run instead of failing it. `npm test` already sets it (`package.json` `"test"`).
- Proof: `PASS EPIC-102` for `src/services/clock/*.test.ts`, and Hermetic coverage lines 61, 62, 63, 64, 67, 77 and the `system-deadline.ts` clause of line 80.
