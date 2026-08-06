# Story 08 — The launcher handshake and the injected scheduler

Epic: `.agent/plan/epics/007.5-startup-recovery.md`
Dispatch **first**, before Story 01. It is numbered 08 only because the other seven were written first.

This story edits EPIC 006 code that is built and green. It is the one change in this epic that does, and B1 in `index.md` is why. It carries two tasks, both against `src/services/git/launcher.ts`, `run.ts` and their tests, so they land together rather than serializing on the same files twice.

- **Task 1 — the launcher handshake.** Makes "no pid file" a final observation.
- **Task 2 — the injected scheduler.** Removes the wall clock from `createGitRunner`'s timeout, which is what makes four `run.test.ts` cases deterministic instead of timing-based. This is S2 from `index.md`.

## Task 1 — the defect it closes

`docs/proposal/phase-3/recovery.md:44` reads a missing pid file as "`git` never started", and `:38` claims "There is no window in which a git process exists unrecorded." The launcher makes the first half true — `src/services/git/launcher.ts:6-7` writes `$$` and only then `exec`s, so a running `git` always has a pid file. It does not make the observation **final**:

1. `spawnSupervised` returns; `/bin/sh` exists and has not reached its `printf` yet.
2. The daemon is `SIGKILL`ed. `detached: true` (`launcher.ts:66`) leaves the shell alive in its own process group.
3. A replacement daemon takes the home lock, reaps, finds no pid file, and reads that as "git never started".
4. The shell then writes its pid file and `exec`s `git`, which begins writing into a staging directory the sweep is removing.

A pre-committed journal row does not close this either: the row's token would name a file that does not exist yet, and `recovery.md:44` resolves that to "stale". The window is an ordinary scheduling window, not a narrow one, and no wording change closes it.

## Task 1 — Change

- **Edit `src/services/git/launcher.ts:6-9`.** The script gains one gate between the pid write and the `exec`, and one new exit code:

  ```ts
  export const LAUNCHER_SCRIPT =
    'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; ' +
    "printf r >&3; exec 3>&-; " +
    'read -r _ || exit 112; exec 0</dev/null; exec "$@"';

  export const LAUNCHER_PID_FILE_FAILURE = 111;
  export const LAUNCHER_ORPHANED_FAILURE = 112;
  export const READY_FD = 3;
  ```

  The order is exact and load-bearing: **write, then report, then wait, then exec.** The write is first so a process that reaches `exec` always has a pid file. The report is second, on descriptor 3, and it is what lets the daemon hold the release byte until the pid file exists. The wait is third so a shell whose parent died before the release exits without ever touching the target. `exec 3>&-` closes the report descriptor so `git` never inherits it, and `exec 0</dev/null` is a redirection-only `exec` that runs before the command `exec`, so `git` inherits an empty stdin rather than the handshake pipe.

- **Edit `src/services/git/launcher.ts:66-67`.** `stdio` becomes `["pipe", "pipe", "pipe", "pipe"]`, so descriptor 3 is a pipe the parent reads. After `spawn` returns and only when `child.pid !== undefined`, subscribe to the report and write the go byte from inside that handler:

  ```ts
  ready.on("data", () => {
    child.stdin.write("go\n");
    child.stdin.end();
  });
  ```

  An `EPIPE` on that write is swallowed: the shell may already have exited on `111`. Attach `child.stdin.on("error", () => {})` and an error listener on the report stream before the write.

  **The go byte must never precede the report.** A byte written at spawn time survives the daemon in the pipe buffer, so a launcher delayed before its pid write reads it after the daemon is gone and execs `git` anyway — measured, not argued. The write therefore happens in the `data` handler and nowhere else. The parent's event loop must be free between the spawn and the report, so a caller that blocks the loop while it waits for the child deadlocks; every production caller awaits.

- **Edit `src/services/git/run.ts:121-151`.** In the failure-precedence chain, beside the existing `code === LAUNCHER_PID_FILE_FAILURE` branch, add `code === LAUNCHER_ORPHANED_FAILURE` throwing `new GitError("unknown", "the launcher was orphaned before it started git", "")`. Keep the existing precedence order otherwise.

- **Edit `src/services/git/probe.ts:127-208` and `src/services/git/host-key.ts:188-205`.** Both call `spawnSupervised` directly, so both now receive a child that waits for a go byte. No edit is needed in either: the write happens inside `spawnSupervised`. Assert that by test rather than by inspection.

## Task 1 — Constraints

- `git` must not inherit the handshake pipe on its stdin. `exec 0</dev/null` before the command `exec` is what guarantees it, and the test below proves it, because a `git` that read the pipe would hang.
- The pid write stays first. Reversing it to wait-then-write would let a shell pass the handshake and be killed before writing, which reintroduces a `git` with no pid file — the one state the whole reap depends on being impossible.
- Do not change `launcherArgv`, `assertSignallable`, `signalGroup`, `detached: true`, or the `exited` promise contract. Every existing assertion in `src/services/git/launcher.test.ts` that does not concern `stdio` or the script string must stay green untouched.
- `LAUNCHER_SCRIPT` is asserted as an exact string somewhere in the suite; find it and update it once. It is not duplicated in production code.

## Task 1 — Verify

- Edit `src/services/git/launcher.test.ts`:
  - The `LAUNCHER_SCRIPT` exact-string assertion becomes the new script. `launcherArgv`'s pinned array at `:93-104` changes only in the script element; its length stays `4` at `:106-111`.
  - Every existing case stays green with no other edit: the pid-file content and `ps -o comm=` case (`:113-121`), the `pgid` case (`:123-129`), the group-`SIGTERM` case (`:131-151`), the bare-pid control case (`:153-174`), the pre-existing-pid-file `111` case (`:176-194`), the missing-directory `111` case (`:196-211`), the file-left-in-place case (`:213-225`), `assertSignallable` (`:227-237`), and the missing-`cwd` case (`:239-262`).
  - **New: a clean `git --version` still completes.** The go byte reaches the shell, so `exited` resolves `{ code: 0, signal: null }` and stdout holds a version line. Without the write this case hangs, which is the assertion that the parent writes.
  - **New: `git` does not inherit the handshake pipe.** Run `git hash-object --stdin` through `spawnSupervised` and assert `exited` resolves rather than hanging, with an empty-input hash on stdout — `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, the exact sha1 of the empty blob. A `git` holding the pipe on stdin would block forever, and this is the only case that distinguishes the two.
  - **New: an orphaned launcher exits `112` and never runs the command.** The pipe alone builds the case, and no new production seam is added: `spawnSupervised` writes the go byte and ends the stream, so the test instead spawns a command whose target is a `sh` script that would `touch <marker>`, and drives the orphan state by calling `spawnSupervised` through a variant of the real call that the test constructs itself — one `spawn` of `LAUNCHER_SHELL` with `launcherArgv`, the same env and `stdio: ["pipe","pipe","pipe"]`, whose stdin is destroyed instead of written. Both exported constants and `launcherArgv` are reused, so the test exercises the real script. `exited` resolves `{ code: 112, signal: null }`, the marker does not exist, and the pid file **does** — the write precedes the gate.
  - **New: the pid write precedes the gate.** In the same case, `readFileSync(pidFile, "utf8")` equals `String(child.pid)` even though the command never ran.
  - **New: the report reaches the parent only after the pid file exists.** Read one byte from descriptor 3, assert it is `r`, assert the pid file already holds the child's pid, then destroy stdin and assert exit `112` with no marker.
  - **New: a launcher held before its pid write runs no command once its daemon dies.** This is the case the whole story exists for, and it is the only one that fails against a parent that writes the go byte at spawn time. Make the pid-file path a FIFO, so the launcher blocks in `open` before its write. Run the real `spawnSupervised` in a `node --input-type=module --eval` subprocess that exits 200 ms later. Read the FIFO to release the launcher, wait for that pid to exit, and assert the marker never appears. The target must be a shell builtin — `printf x > <marker>` — because the pinned `PATH` is git's exec path and holds no `touch`.
- Edit `src/services/git/run.test.ts`: add one case asserting an exit of `LAUNCHER_ORPHANED_FAILURE` surfaces as `GitError` with `failure === "unknown"` and the message `the launcher was orphaned before it started git`. Reach it the way the file already reaches the `111` mapping — find that case and copy its arrangement, substituting `112`.
- `node --test src/services/git/launcher.test.ts src/services/git/run.test.ts src/services/git/probe.test.ts src/services/git/host-key.test.ts src/services/git/seed.test.ts src/services/git/clone.test.ts src/services/git/fetch.test.ts src/services/git/ref-update.test.ts src/services/git/authenticated.test.ts src/services/git/binary.test.ts` exits 0 — every consumer of `spawnSupervised`.
- `node --test src/commands/repository/register-repository.test.ts` exits 0.

## Task 2 — the injected scheduler

`createGitRunner` schedules its own timers with a bare `setTimeout`: the operation timeout at `src/services/git/run.ts:113-118` and the `SIGTERM`-to-`SIGKILL` grace at `:81-84`, bounded by `TERMINATION_GRACE_MS = 2_000` at `:12`. Four `run.test.ts` cases therefore prove a timeout by waiting for real milliseconds, and one of them raced its own descendant until commit `f88972c`. AGENTS.md requires the hermetic suite to carry no wall-clock dependency, and the tests carry one because the seam does not exist.

## Task 2 — Change

- **Edit `src/services/git/run.ts`.** Add the seam above `createGitRunner`:

  ```ts
  export type ScheduledTimer = Readonly<{ cancel(): void }>;

  export type Schedule = (
    callback: () => void,
    delayMs: number,
  ) => ScheduledTimer;

  export const systemSchedule: Schedule = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  };

  export function createGitRunner(
    paths: GitPaths,
    schedule: Schedule = systemSchedule,
  ): GitRunner;
  ```

  Replace both `setTimeout` sites with `schedule(...)` and both `clearTimeout` sites at `:159` and `:161` with the returned `cancel()`. `unref` moves inside `systemSchedule` and appears nowhere else, so a fake scheduler cannot forget it and a fake timer cannot hold the loop open.

- **The second parameter is optional, and `src/main.ts:110` passes it anyway.** `createGitRunner(gitPaths, systemSchedule)`. Measured: `createGitRunner(` has **89 call sites across 14 test files** plus that one. A required parameter would rewrite all 89 for no behavioural gain, and this story already edits ten of those files. The default keeps them untouched; the composition root still names the implementation, which is the rule the default would otherwise bend. Add `systemSchedule` to the existing `./services/git/run.ts` import at `src/main.ts:20`.

- **`TERMINATION_GRACE_MS` stays an exported constant and stays `2_000`.** It is passed to `schedule` as the delay, so a fake reads it rather than waiting it out. Do not make it a parameter: no caller has a reason to vary it, and a configuration key would need a `convict.ts` schema entry.

## Task 2 — Constraints

- `Schedule` is a declared function type in `run.ts`, not a new service and not a member of `Clock`. `Clock` is `now(): number` (`src/services/clock/index.ts`) and is consumed by `SqliteStorage` and every command in this epic; adding a `schedule` member would force `createMockClock` (`test/helpers/clock.ts:5-14`) and every hand-written clock fake to implement scheduling they never use. Story 07's injected steps are the precedent for a declared function type bound by `main.ts`.
- The failure precedence of `:121-151` does not change. A fake that fires the timeout callback must reach exactly the same `timed-out` classification as a real timer, and the test below asserts that rather than assuming it.
- `src/services/git/probe.ts` and `host-key.ts` keep their own `setTimeout`. Both are read-only probes with a fixed 10 000 ms bound and neither is asserted by a timing test, so widening the seam to them is out of scope. Record it and leave it.

## Task 2 — Verify

- Edit `src/services/git/run.test.ts`. Add a `createFakeSchedule()` local helper returning `{ schedule, fire(delayMs), pending() }` that records every `(callback, delayMs)` pair, fires the callback registered for one exact delay, and reports the outstanding delays. Then:
  - **New: `systemSchedule` is the default.** `createGitRunner(paths)` and `createGitRunner(paths, systemSchedule)` both resolve `git --version` with code `0`. The default is exercised, so the 89 untouched call sites stay covered.
  - **New: the timeout is registered with the caller's `timeoutMs`.** With a fake scheduler and `timeoutMs: 4242`, `pending()` contains `4242` before the run settles and the callback is never fired, so the run resolves normally with code `0`. This pins that `timeoutMs` reaches the scheduler unmodified.
  - **Rewrite `the timeout signals the group and no descendant survives` (`:154`) to fire the timeout on demand.** Start the run with a fake scheduler, `await waitForFile(sshPidPath, 4000)`, assert `process.kill(sshPid, 0)` does not throw, `fire(timeoutMs)`, then await the rejection and assert `failure === "timed-out"`. The descendant is proven alive before the timeout exists, so the race commit `f88972c` narrowed is gone rather than widened, and `timeoutMs` becomes an arbitrary label. Keep the trailing `ESRCH` poll: the process death is a real signal and stays observed rather than faked.
  - **Rewrite `the timeout error carries neither environment nor key directory` (`:193`)** to fire the timeout instead of waiting `1000` ms. Every assertion about the message and the `Object.keys` shape is unchanged.
  - **Rewrite `a cancelled operation ends even when a descendant holds the pipe` (`:280`)** the same way.
  - **Rewrite `the bound outranks the timeout` (`:248`)** so the fake scheduler **never** fires. The output bound must win with no timer running at all, which proves the precedence by construction rather than by out-racing a `1500` ms timer.
  - **New: the grace timer is registered with `TERMINATION_GRACE_MS`.** After the timeout callback fires, `pending()` contains `2000`. Firing it is what escalates to `SIGKILL`; assert the descendant is gone after firing it, with no two-second wait anywhere.
  - **New: a settled run cancels both timers.** After a clean `git --version` with a fake scheduler, `pending()` is empty — the timeout's `cancel()` ran. After a fired timeout and a fired grace, `pending()` is empty too.
- `node --test src/services/git/run.test.ts` exits 0 and its reported `duration_ms` is **below 5000**. Before this task the file measured ≈8200 ms and the single `:154` case ≈5000 ms; the four rewritten cases stop waiting on real time. Assert the budget by reading the runner's own duration in review, not by an assertion inside the suite.
- `node --test src/services/git/outside-writer.test.ts src/services/git/clone.test.ts src/services/git/ref-read.test.ts src/services/git/seed.test.ts src/services/git/fetch.test.ts src/services/git/remote-info.test.ts src/services/git/preflight.test.ts src/services/git/ref-update.test.ts src/services/git/authenticated.test.ts src/services/git/host-key.test.ts` exits 0 — the ten files holding the 89 default-parameter call sites, none of which is edited.

## Story-level gate

- `npm run verify` exits 0 with both tasks applied.
- Proof: no `src/commands/startup/**` file. This story is a prerequisite of the EPIC Proof rather than a part of it, and the EPIC's `Proof:` block gains `src/services/git/launcher.test.ts`.
