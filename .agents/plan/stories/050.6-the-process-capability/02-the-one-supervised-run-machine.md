# Story 3 — The one supervised-run machine

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Depends on: EPIC 050.6 Story 2 (`01-the-launcher-the-contract-and-the-pid-check`) — this story
implements the interface that story declares, over the launcher that story moved.
Kind: story-foundation

This story adds two files and changes none. Nothing calls the machine yet: EPIC 050.6 Story 4
(`03-the-git-runner-takes-the-runner`) is the first caller.

## Change

### 1 — `src/services/process/supervisor.ts`, the schedule, the spawn seam and the runner

**Create `src/services/process/supervisor.ts`.** It imports from `./index.ts` and `./launcher.ts`
and from nothing else.

**`systemSchedule` moves here whole**, verbatim from `src/services/git/run.ts:43` — `systemSchedule`:

```ts
export const systemSchedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};
```

It calls `setTimeout`, so it belongs to the implementation file and not to
`src/services/process/index.ts`.

**`createSupervisedRunner` takes two defaulted parameters, and the second is the spawn seam:**

```ts
export type SpawnChild = (input: SupervisedSpawnInput) => SupervisedSpawn;

export function createSupervisedRunner(
  schedule: Schedule = systemSchedule,
  spawn: SpawnChild = spawnSupervised,
): SupervisedRunner;
```

**The seam exists because gate row 11 is otherwise unprovable, and it makes four more assertions
exact.** `process.kill` cannot be made to raise `EPERM` or a third `errno` on demand for a child this
process owns, so the swallow rule and the rethrow have no runner-level oracle without it. The same
seam turns three platform-dependent cases into exact ones: a pipe chooses its own chunk boundaries, so
the truncation proof cannot pin a byte count over a real child, and a `spawn` that reports an unusable
`cwd` may throw synchronously on some platform, so `not-started` has no portable real fixture. A fake
child emits the chunks the case names and rejects the exit the case names, and every value is pinned.

**Both defaults keep the production call trivial.** `createSupervisedRunner()` is what
`scripts/e2e/**` and every git suite construct, `createSupervisedRunner(gitSchedule)` is what
`src/main.ts` constructs, and no production caller ever passes the second argument. The seam is
intra-capability — `SupervisedSpawnInput` and `SupervisedSpawn` are already exported from
`./launcher.ts` — so no import matrix rule is crossed and no service interface gains a member.

**`signalErrorIsIgnorable` is a private function of this file**, and it is the whole swallow rule:

```ts
function signalErrorIsIgnorable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ESRCH" || code === "EPERM";
}
```

It is **not exported**: the seam proves the rule through the runner, so the predicate needs no
test-only export surface. It is the same test the four shipped sites make inline —
`src/services/git/run.ts:89` — `ESRCH`, `src/services/git/probe.ts:168` — `ESRCH`,
`src/services/git/host-key.ts:219` — `ESRCH` and `src/services/git/child.ts:202` — `ESRCH` — and
after EPIC 050.6 Story 5 (`04-the-three-spawn-sites-and-the-facade`) this is the only copy left.

The runner body, in order:

1. **An already-aborted signal spawns nothing.** When `request.signal !== null` and
   `request.signal.aborted`, return
   `{ outcome: "cancelled", code: null, signal: null, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 }`
   before any other statement.
2. **Spawn.** `spawn({ command, args, env, cwd, pidFile })` with the five fields of the request that
   the launcher takes. The launcher builds the vector, so this file never names `LAUNCHER_SCRIPT`.
3. **A child with no pid never started.**
   ```ts
   if (child.pid === undefined) {
     try {
       await child.exited;
     } catch {
       // the child never started; report not-started
     }
     return {
       outcome: "not-started",
       code: null,
       signal: null,
       stdout: "",
       stderr: "",
       stdoutBytes: 0,
       stderrBytes: 0,
     };
   }
   ```
   **The rejection is swallowed, and that is a deliberate unification.**
   `src/services/git/probe.ts:150`, `src/services/git/host-key.ts:206` and
   `src/services/git/child.ts:188` each wrap this await in `try`/`catch`;
   `src/services/git/run.ts:70` — `await child.exited` does not, so a spawn failure reaching
   `createGitRunner` today surfaces the raw `ENOENT` instead of the `GitError` two lines below it.
   One machine cannot hold both, and three of the four shipped sites swallow.
4. **Four mutable facts and one signal helper.** `stdoutChunks`, `stderrChunks`, `stdoutSize`,
   `stderrSize`, and the booleans `cancelled`, `exceeded`, `timedOut`, `aborted`, plus `graceClear`
   and `signalError`. `signalGroup(signal)` calls `child.signalGroup(signal)` inside a `try`, and its
   `catch` records `signalError ??= error` only when `signalErrorIsIgnorable(error)` is `false`.
5. **`cancel()` is the one signal sequence**, relocated from `src/services/git/run.ts:95` — `cancel`:
   it returns when `cancelled` is already `true`, sets `cancelled`, sends `SIGTERM`, then registers
   `schedule(() => signalGroup("SIGKILL"), TERMINATION_GRACE_MS)` and keeps its `cancel` in
   `graceClear`. **The bound is on the signal, not on the exit.** The runner then awaits the child,
   for which no completion deadline exists.
6. **Each stream handler bounds, streams, then keeps.** For `stdout`:
   ```ts
   child.stdout.on("data", (chunk: Buffer) => {
     if (cancelled) {
       return;
     }
     stdoutSize += chunk.length;
     if (stdoutSize > request.outputLimitBytes) {
       exceeded = true;
       cancel();
       return;
     }
     stdoutChunks.push(chunk);
     request.onStdout?.(chunk);
   });
   ```
   `stderr` is the same over `stderrSize`, `stderrChunks` and `request.onStderr`.
   **The crossing chunk is dropped before the callback**, so a streaming caller and a buffering
   caller observe the same bytes. `.agents/plan/epics/107-verify-service.md:29` pins that rule.
7. **The timeout** is `schedule(() => { timedOut = true; cancel(); }, request.timeoutMs)`.
8. **The cancellation** is one `abort` listener on `request.signal`, registered only when the signal
   is not null: `() => { aborted = true; cancel(); }`.
9. **The settle**, inside `try`, after `const { code, signal } = await child.exited`:
   rethrow `signalError` when it is defined; then decide the outcome in this exact order —
   `exceeded` gives `"output-exceeded"`, `timedOut` gives `"timed-out"`, `aborted` gives
   `"cancelled"`, `code === LAUNCHER_PID_FILE_FAILURE` gives `"pid-file-failed"`,
   `code === LAUNCHER_ORPHANED_FAILURE` gives `"orphaned"`, and anything else gives `"exited"`.
   **The order is the shipped order with one entry appended.** `src/services/git/run.ts:143` —
   `exceeded` is already checked before `src/services/git/run.ts:150` — `timedOut`, so the output cap
   outranks the timeout today and keeps outranking it. `cancelled` is new, and it ranks last.
10. **Every outcome returns one shape.** `code` and `signal` are the values `child.exited` reported
    for `"exited"`, `"pid-file-failed"` and `"orphaned"`, and `code` is `null` with `signal` the
    reported signal for the three cancel-driven outcomes. `stdout` is
    `Buffer.concat(stdoutChunks).toString("utf8")` and `stdoutBytes` is the summed length of the
    retained chunks, never `stdoutSize`, which counts the crossing chunk. `stderr` and `stderrBytes`
    are the same. **The result echoes no argument vector**: a caller holds its own request, and
    `src/services/git/run.ts:182` — `args` builds `GitRunResult.args` from `request.args` itself.
11. **The `finally` cancels the timeout, cancels `graceClear` when it is set, and removes the abort
    listener. It removes no file.** `ProcessRunRequest.pidFile` is a required `string` and carries no
    supplied-versus-minted bit, so this machine cannot decide the file's lifetime. A scratch owner
    removes its file in its own `finally`; a journal owner keeps it until reconciliation. Removing
    every pid file here would destroy the token
    `src/commands/startup/reap-orphans.ts:187` — `removePidFile` reconciles.

### 2 — `src/services/process/supervisor.test.ts`

**Create the suite `src/services/process/supervisor.test`.** It carries a **local**
`createFakeSchedule`, moved from `src/services/git/run.test.ts:80` — `createFakeSchedule` with its
`FakeSchedule` type at `:74`, unchanged: `schedule`, `fire(delayMs)` which asserts exactly one timer
at that delay, and `pending()` which returns the armed delays sorted.

**It stays local, and it is not promoted.** `test/helpers/virtual-clock.ts:17` — `createFakeSchedule`
already exports that name over the `Schedule` of
`src/http/server/idempotency-store.ts:19` — `Schedule`, whose argument order is `(milliseconds,
callback)` and whose cancel is a bare function. The two types are incompatible, so promoting this one
would collide by name.

**It also carries a local `createFakeSpawn`**, a hand-written `SpawnChild` that records every
`SupervisedSpawnInput` it receives and returns a `SupervisedChild` the case scripts:

```ts
type FakeChild = Readonly<{
  spawn: SpawnChild;
  inputs: SupervisedSpawnInput[];
  signals: NodeJS.Signals[];
  emitStdout(bytes: Buffer): void;
  emitStderr(bytes: Buffer): void;
  settle(exit: SupervisedExit): void;
}>;
```

`stdout` and `stderr` are `PassThrough` streams the case writes into, so a chunk boundary is the
case's decision and never the operating system's. `signalGroup` pushes the signal into `signals` and
then throws whatever the case armed, or nothing. `exited` settles when the case calls `settle`.
A `createFakeSpawn` built with `pid: undefined` returns a `SupervisedSpawnFailure` whose `exited`
rejects, which is the `not-started` fixture.

**Three cases still run a real process**, because no fake proves that an operating system reaped a
process group: cases 5, 11 and 13. They write `/bin/sh` scripts into their own `mkdtemp` directory and
remove them in an `after` hook, exactly as `src/services/process/launcher.test.ts` does.

## Constraints

- The runner removes no pid file, on any outcome. Cases 7 and 11 are what prove it.
- `stdoutBytes` counts retained bytes, not observed bytes. A crossing chunk raises neither the count
  nor the buffer.
- `onStdout` and `onStderr` are called only for a chunk the runner keeps, and never after `cancel()`.
- The outcome order is fixed: `output-exceeded`, `timed-out`, `cancelled`, `pid-file-failed`,
  `orphaned`, `exited`. **`cancelled` ranking last is a ruling this story takes**, because the epic's
  gate pins only that the cap outranks the timeout.
- **Swallowing the `child.exited` rejection on the no-pid path is a caller-visible change**, and
  `.agents/plan/epics/050.6-the-process-capability.md` records it in `## Decisions`.
  `createGitRunner` today lets an `ENOENT` escape; after EPIC 050.6 Story 4
  (`03-the-git-runner-takes-the-runner`) it raises `GitError("unknown", "git <verb> did not start")`.
  The path needs an unusable `cwd`, and `src/services/git/run.ts:65` — `request.cwd` falls back to
  `paths.home`, which `buildGitPaths` creates, so no product path reaches it.
- `signalErrorIsIgnorable` is not exported, and `src/services/process/supervisor.ts` holds exactly one
  `"ESRCH"` literal and one `"EPERM"` literal. Case 6 asserts both by reading the source.
- `src/services/process/supervisor.ts` imports only `./index.ts` and `./launcher.ts`. It names no
  vendor package, no other capability and no `node:` module.
- No production caller ever passes the second parameter of `createSupervisedRunner`. Case 13 is what
  pins the two production forms.
- Do not touch `src/services/git/run.ts` in this story. Its `systemSchedule` is still what
  `src/main.ts:29` — `systemSchedule as gitSchedule` reads, and EPIC 050.6 Story 4
  (`03-the-git-runner-takes-the-runner`) deletes it.

## Verify

```
node --test src/services/process/supervisor.test.ts
```

Add, each as a separate `it`:

1. `"a normal exit reports exited with the child's code"` — over `createFakeSpawn` and
   `createFakeSchedule`, a request with `timeoutMs` `60_000`, `outputLimitBytes` `1_048_576`, `signal`
   null and both callbacks null. The case settles the child with `{ code: 7, signal: null }`, and the
   run resolves with `outcome` `"exited"`, `code` `7`, `signal` `null`, `stdout` `""`, `stderr` `""`,
   `stdoutBytes` `0` and `stderrBytes` `0`. The recorded `inputs` hold exactly one entry whose five
   fields deep-equal the request's `command`, `args`, `env`, `cwd` and `pidFile`.

2. `"a fired timeout reports timed-out"` — `timeoutMs` `4242`. After
   `assert.deepEqual(fake.pending(), [4242])`, `fake.fire(4242)` records `"SIGTERM"` in `signals`;
   the case then settles the child with `{ code: null, signal: "SIGTERM" }` and the run resolves with
   `outcome` `"timed-out"` and `code` `null`. `fake.pending()` is then `[]`.

3. `"an abort mid-run reports cancelled"` — with a live `AbortController` as `signal`. Aborting after
   the child is running records `"SIGTERM"`, and settling the child resolves the run with `outcome`
   `"cancelled"` and `code` `null`. The child's own `{ code: 0 }` never becomes the outcome.

4. `"an already-aborted signal spawns nothing"` — with a `signal` aborted before the call, the run
   resolves with `outcome` `"cancelled"`, `code` `null`, `stdout` `""`, `stderr` `""`, `stdoutBytes`
   `0` and `stderrBytes` `0`, and the fake spawn's `inputs` deep-equals `[]`. The control: case 1's
   identical construction records exactly one input, so the empty-list assertion detects a spawn.

5. `"the group is signalled SIGTERM first and SIGKILL after exactly 2_000, and no descendant survives"`
   — two halves in one case. Over the fake spawn at `timeoutMs` `4242`: `fake.fire(4242)` makes
   `signals` deep-equal `["SIGTERM"]` and `fake.pending()` deep-equal `[2_000]`, and
   `fake.fire(2_000)` makes `signals` deep-equal `["SIGTERM", "SIGKILL"]` — the order and the exact
   grace delay, pinned by value. Over the real launcher: a script that runs `/bin/sleep 30 &`, records
   the descendant pid, traps `TERM` and then `exec /bin/sleep 30`, driven through
   `createSupervisedRunner(fake.schedule)`, survives `fake.fire(4242)` — `process.kill(leaderPid, 0)`
   still succeeds, because the leader traps `TERM` — and after `fake.fire(2_000)` the run resolves
   `"timed-out"` and polling `process.kill(descendantPid, 0)` and `process.kill(leaderPid, 0)` each
   reaches `ESRCH`. **The trapped leader is what makes the two signals distinguishable**: a leader
   that died on `SIGTERM` would leave the case unable to tell the sequence from a single `SIGKILL`.

6. `"ESRCH and EPERM are swallowed at the runner and a third errno is rethrown"` — three runs over the
   fake spawn, each arming `signalGroup` to throw. With `code` `"ESRCH"` the run **resolves**
   `outcome` `"timed-out"`; with `code` `"EPERM"` it also **resolves** `"timed-out"`; with `code`
   `"EINVAL"` it **rejects** with the identical error object, asserted by reference. In the same case,
   `readFileSync` of `src/services/process/supervisor.ts` holds the string `"ESRCH"` exactly once and
   the string `"EPERM"` exactly once, read the way `src/domain/layout.test.ts:432` — `readFileSync`
   reads a config source, so the runner holds one copy of the rule and no second one.

7. `"the runner removes no pid file, on any outcome"` — four sub-assertions, each with a
   caller-supplied `pidFile` the test writes beforehand, over the fake spawn: an `exited` settle, a
   `pid-file-failed` settle at `code` `111`, an `orphaned` settle at `code` `112`, and a
   `not-started` spawn. `existsSync(pidFile)` is `true` after every one of the four. The control: the
   test's own `rmSync(pidFile, { force: true })` after the last one makes `existsSync` report `false`,
   so the assertion detects a removed file.

8. `"the crossing chunk is dropped whole"` — over the fake spawn at `outputLimitBytes` `150` with an
   `onStdout` that records each chunk. The case emits exactly `Buffer.alloc(100, 0x61)`, then exactly
   `Buffer.alloc(100, 0x62)`, then settles `{ code: 0 }`. The run resolves `outcome`
   `"output-exceeded"`, `stdout` equals `"a".repeat(100)`, `stdoutBytes` equals `100`, the recorded
   callback chunks concatenate to exactly those 100 bytes asserted with `Buffer.compare`, and no
   recorded chunk holds a `0x62` byte. **The chunk boundary is the case's, not the pipe's**, so every
   value here is exact.

9. `"a run one byte under the cap keeps every chunk"` — the control for case 8. The same two 100-byte
   emissions at `outputLimitBytes` `201` resolve `"exited"` with `code` `0`, `stdout` equal to
   `"a".repeat(100) + "b".repeat(100)`, `stdoutBytes` `200`, and exactly two recorded callback chunks
   whose concatenation equals `stdout`, asserted with `Buffer.compare`.

10. `"a run with both callbacks null reports the same bytes as a run with both supplied"` — the same
    two emissions on `stdout` and two more on `stderr` at `outputLimitBytes` `1_048_576`, run twice:
    once with `onStdout` and `onStderr` null and once with both recording. The two results have equal
    `stdout`, `stderr`, `stdoutBytes` and `stderrBytes`, compared with `Buffer.compare` on the two
    string pairs.

11. `"the two launcher exit codes and a spawn that never starts each map, over the real launcher"` —
    a pre-existing pid file the test writes makes the launcher exit `111` and the run resolve
    `"pid-file-failed"`; a command that is a node script exiting `112` resolves `"orphaned"`; and a
    `cwd` the test never created resolves `"not-started"`. Each is driven through
    `createSupervisedRunner(fake.schedule)` with the real `spawnSupervised`, and
    `existsSync(pidFile)` is `true` after each. **The `not-started` half tolerates either platform
    shape**: `spawn` may report an unusable `cwd` through an `error` event with `child.pid`
    `undefined`, which is the branch `src/services/git/launcher.test.ts:423` —
    `if (child === undefined)` already tolerates. Case 7's fake-spawn half is what pins the outcome by
    value if a platform makes this half unreachable.

12. `"the output cap outranks the timeout when both fire"` — over the fake spawn at
    `outputLimitBytes` `50` and `timeoutMs` `4242`. Emitting `Buffer.alloc(100, 0x61)` crosses the cap
    and cancels; `fake.fire(2_000)` then settles the run as `outcome` `"output-exceeded"` and never
    `"timed-out"`, and `fake.pending()` no longer holds `4242`.

13. `"both production constructor forms resolve a real command"` — `createSupervisedRunner()` and
    `createSupervisedRunner(systemSchedule)` each run `/bin/sh` with args `["-c", "exit 0"]`,
    `timeoutMs` `60_000`, `outputLimitBytes` `1_048_576`, `signal` null and both callbacks null, and
    each resolves with `outcome` `"exited"` and `code` `0`. Neither passes a spawn argument, so the
    default `spawnSupervised` is what ran.

`pnpm run verify` exits 0.

Proof: gate rows 8, 9, 10, 11, 12 and 13 delivered — `src/services/process/supervisor.test.ts` in
`PASS EPIC-050.6`.
