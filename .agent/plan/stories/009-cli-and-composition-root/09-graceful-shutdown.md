# Story 09 — graceful shutdown

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: Story 01 (`serve` is a named function in `src/main.ts`).

Dispatch it before Story 07 and Story 08. Both stop a daemon, and both gain an assertion from this story.

Today the daemon cannot be stopped cleanly. `src/main.ts:252` discards the `ListeningServer` that `src/http/server/start.ts:11` returns, `held` from `:105` is never referenced again, `storage.close()` at `:260` runs only when `reachedListen` is false, and no `process.on` handler exists in any non-test file under `src/`. Every consumer — `test/helpers/daemon.ts:122`, five e2e scripts, Stories 07 and 08 — sends a signal that terminates the process outright.

## Change

### 1. `src/http/server/shutdown.ts` (new) — the sequencer

```ts
export type ShutdownStep = Readonly<{
  name: string;
  run: () => void | Promise<void>;
}>;

export type ShutdownDependencies = Readonly<{
  steps: readonly ShutdownStep[];
  write: (text: string) => void;
  onSettled: (code: number) => void;
}>;

export function createShutdown(
  dependencies: ShutdownDependencies,
): (signal: string) => Promise<void>;
```

The returned function:

1. **Is idempotent.** A module-scoped `started` flag inside the closure. A second signal while the first is in flight returns the same promise and runs no step twice. A daemon receives `SIGINT` twice from an impatient human, and a second pass over a closed database throws.
2. Runs every step **in the declared order**, awaiting each. Order is the caller's, not this file's.
3. **Never stops on a failing step.** A step that throws writes `kanthord: shutdown: <name> failed: <error>\n` through `write` and the next step still runs. A listener that refuses to close must not leak the home lock.
4. Writes `kanthord: stopped\n` when every step succeeded.
5. Calls `onSettled(0)` when every step succeeded and `onSettled(1)` when any step failed.

`src/http/server/` may import `domain/`, `commands/`, `queries/`, `http/contract/` and `http/server/` — not a service. That is why a step is a `{ name, run }` pair and not a typed `Storage` or `HomeLock`: this file names no capability, and `src/main.ts` supplies the three closures.

### 2. `src/main.ts` — keep what `serve` currently throws away

Inside the `serve` body:

- `const listening = await listen(app, { … });` at `:252` — bind the result instead of discarding it.
- After `reachedListen = true;` and before the `kanthord: ready` write, install the handler:

```ts
const shutdown = createShutdown({
  steps: [
    { name: "listener", run: () => listening.close() },
    {
      name: "storage",
      run: () => {
        storage.close();
      },
    },
    {
      name: "home-lock",
      run: () => {
        held.release();
      },
    },
  ],
  write: (text) => process.stderr.write(text),
  onSettled: (code) => {
    process.exitCode = code;
  },
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
```

**The step order is fixed and load-bearing.** The listener closes first, so no request arrives at a closed database. Storage closes second. The home lock releases last, because `src/services/home-lock/sqlite.ts:151-156` closes the connection holding `BEGIN IMMEDIATE`, and a successor daemon that acquired the home while this one still held an open database would race it.

- `held` at `src/main.ts:105` gains no other use. It is referenced here for the first time.

### 3. `test/helpers/daemon.ts` — observe the exit

`kill(signal)` at `:122-124` stays as it is. Add:

```ts
exit(): Promise<DaemonExit>;
```

resolving with the child's `code` and `signal` once the process has exited, memoized so two callers await one event. Story 07 and Story 08 both need to distinguish "the port is free" from "the child is gone", and today no helper exposes that.

## Constraints

- `src/http/server/shutdown.ts` imports nothing but its own types. No `process`, no service, no koa.
- No shutdown timeout and no forced exit. `src/http/server/start.ts:26-35` already makes `close()` idempotent and resolving; a hung connection is a later-phase concern and inventing a deadline here would be a decision this epic has no source for.
- The handler is installed **after** `listen` resolves. A signal arriving during the boot sequence keeps today's behaviour, which is an immediate termination of a daemon that never announced readiness.
- `process.once`, not `process.on`. The idempotence of step 1 covers the case anyway; both together mean a repeated signal cannot re-enter.
- Do not touch the `catch` block at `src/main.ts:263-277`. A boot failure is not a shutdown.

## Verify

```bash
node --test src/http/server/shutdown.test.ts test/helpers/daemon.test.ts
```

### `src/http/server/shutdown.test.ts` (new)

- Three steps run in declared order, asserted on a recorded name array deep-equal to `["a", "b", "c"]`.
- `write` received exactly `"kanthord: stopped\n"`, and `onSettled` was called once with `0`.
- **A failing middle step does not stop the sequence.** With `b` throwing `new Error("boom")`, the recorded order is still `["a", "b", "c"]`, `write` received a line matching `/^kanthord: shutdown: b failed: /`, `onSettled` was called once with `1`, and no `kanthord: stopped` line was written.
- Two failing steps produce two failure lines and one `onSettled(1)`.
- **Idempotent.** Calling the returned function twice runs each step exactly once and calls `onSettled` exactly once. Asserted with a step whose `run` increments a counter.
- **Idempotent under concurrency.** Two calls awaited together, with a step that resolves on a deferred promise, still run each step once.
- An `async` step is awaited: a step resolving after a timer completes before the next step starts, asserted on the order array.

### `test/helpers/daemon.test.ts`

- `exit()` resolves with the code and signal after `kill()`.
- Two `exit()` calls on one daemon resolve with the same object.
- `exit()` called after the process already exited resolves rather than hanging.

### The two stories that gain an assertion

- **Story 07** adds: `daemon.kill("SIGTERM")`, then `await daemon.exit()` yields code `0` and the captured stderr ends with `kanthord: stopped`; then `runCli({ args: ["db", "migrate", "--home", home.path] })` exits `0`, which proves the home lock was released. Without this story that command prints `kanthord: home-locked:`.
- **Story 08** adds nothing new: its `finally` already kills and awaits, and its three cleanup assertions now pass because the daemon released the lock rather than because the process died holding it.

`npm run verify` exits 0.

Proof: contributes `src/http/server/shutdown.test.ts` to the EPIC Proof glob `src/http/server/shutdown.test.ts`.
