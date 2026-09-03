# Story 5 — The three remaining spawn sites and the git facade

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Depends on: EPIC 050.6 Story 3 (`02-the-one-supervised-run-machine`) for the machine, and
EPIC 050.6 Story 4 (`03-the-git-runner-takes-the-runner`) for the two `createGitRunner` call sites
inside `src/services/git/host-key.test.ts`.
Kind: story-foundation

After this story no file under `src/services/git/` imports `spawnSupervised`, arms a timer or sends a
signal for a child it holds. `stopChild` keeps its own signal sequence and its own poll loop, because
it signals a pid it read from a journal and holds no child handle.

**`pnpm run typecheck` is still red on `src/main.ts` and `scripts/e2e/**` across this story.**
EPIC 050.6 Story 6 (`05-the-composition-root-and-the-harness`) closes it. No case here runs it.

## Change

### 1 — `src/services/git/probe.ts`

**`probeTools(runSupervised: SupervisedRunner, input: ProbeInput)`, and
`runVersionProbe(runSupervised, input, tool, args, stream)`.** The runner comes first, as
`## The shape of a command` of `AGENTS.md` puts dependencies first and as
`src/services/git/binary.ts:28` — `fetchTracking` already does. `ProbeInput` gains no field, so the
three `scripts/e2e/` callers change one argument and no object literal.

**Delete from `src/services/git/probe.ts`:** the import at `:12` — `spawnSupervised`, the spawn at
`:137` — `spawnSupervised`, the `child.pid === undefined` block at `:149-160`, the timer at `:162` —
`setTimeout`, the `SIGKILL` and its `catch` at `:164-171`, `timeoutTimer.unref()` at `:173`, the
chunk array and its `data` handler at `:176-179`, the `await child.exited` at `:180`, the `killError`
rethrow at `:181-183`, and the inner `finally` at `:202-204`.

**Keep:** the pid-file mint at `:135` — `randomUUID`, the whole outer `try`/`finally` whose
`rmSync(pidFile, { force: true })` at `:206` — `rmSync` removes this scratch file, and every
`ToolProbeError` construction and message.

The call:

```ts
const result = await runSupervised({
  command: toolPath,
  args,
  env: { PATH: "", LC_ALL: "C" },
  cwd: input.runDirectory,
  pidFile,
  timeoutMs,
  outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
  signal: null,
  onStdout: null,
  onStderr: null,
});
```

The mapping, and it is a table:

| outcome                                                   | result                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exited`                                                  | parse `result.stdout` when `stream` is `"stdout"`, else `result.stderr`; a `null` parse raises `ToolProbeError("tool-unreadable", tool, \`${toolPath} reported no recognisable version\`)` |
| `timed-out`                                               | `ToolProbeError("tool-unreadable", tool, \`${toolPath} did not answer a version within ${timeoutMs}ms\`)`                                                                                  |
| `output-exceeded`                                         | `ToolProbeError("tool-unreadable", tool, \`${toolPath} produced more than ${DEFAULT_OUTPUT_LIMIT_BYTES} bytes of output\`)`                                                                |
| `not-started`, `pid-file-failed`, `orphaned`, `cancelled` | `ToolProbeError("tool-unreadable", tool, \`${toolPath} did not start\`)`                                                                                                                   |

**Four of the five messages are shipped strings**, from `src/services/git/probe.ts:198`, `:188` and
`:158`. `pid-file-failed` and `orphaned` both mean the launcher never reached the tool, so
`did not start` is exactly true for them. **The `output-exceeded` message is new**, and it is the one
new string in the git service; it carries no environment value and no path but the tool path the
error already names. Recorded in `index.md` and reported to the human for `## Decisions`.

**The `timed-out` message names the effective timeout, and that is a change.**
`src/services/git/probe.ts:188` interpolates the constant `PROBE_TIMEOUT_MS` while the timer used
`input.timeoutMs ?? PROBE_TIMEOUT_MS` from `:134`, so an overridden probe reports `10000ms` whatever
the caller asked for. The message now interpolates `timeoutMs`, the value the run actually used. The
epic's `## Decisions` records it as the fourth caller-visible change; it is visible only under an
override, so no product path changes, and the alternative is a case that asserts a number the run did
not use.

**`sshKeyscan` still never reaches `runVersionProbe`.** The loop at `src/services/git/probe.ts:82` —
`sshKeyscan` access-checks all three tools and version-probes two, and that does not change.

**Both streams are now captured, and the selector picks one.** Today `src/services/git/probe.ts:177`
attaches to `child[stream]` alone and never drains the other. The runner drains both, so the bound
applies per stream and the selector reads `result.stdout` for `git` and `result.stderr` for `ssh`,
exactly as `src/services/git/probe.ts:102` and `:108` choose today.

### 2 — `src/services/git/host-key.ts`

**`scanHostKeys(runSupervised, paths, remoteUrl, options?)` and
`confirmHostKey(runSupervised, paths, remoteUrl, hostFingerprint)`.** `confirmHostKey` is in the
repair set because `src/services/git/host-key.ts:129` — `scanHostKeys` calls the scan; it forwards
the runner and changes nothing else. `ScanOptions` at `:113` keeps its `timeoutMs`.

**Delete:** the import at `:12` — `spawnSupervised`, the import at `:14` — `TERMINATION_GRACE_MS`,
the spawn at `:190` — `spawnSupervised`, the `child.pid === undefined` block at `:205-212`, the local
`signalGroup` at `:214`, the timeout and the nested grace at `:225-233`, the two chunk arrays and
their handlers at `:198-199` and `:236-241`, the `await child.exited` at `:243`, the `signalError`
rethrow at `:244-246`, and the inner `finally` at `:270-275`.

**Keep:** the pid-file mint at `:188` — `randomUUID`, the outer `finally` whose
`rmSync(pidFile, { force: true })` at `:277` — `rmSync` removes it, `parseKeyscanOutput`,
`stripUserinfo`, and the inner `-T 10` budget in the argument vector at `:192`.

The call passes `command: paths.sshKeyscan`, the same argument vector, the same
`env: { PATH: "", LC_ALL: "C", HOME: paths.home }`, `cwd: paths.runDirectory`, that `pidFile`,
`timeoutMs`, `outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES`, `signal: null`, and both callbacks null.

The mapping:

| outcome                                                   | result                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `exited`, keys parsed                                     | `{ scanned: true, hostKeys }`                                                                                               |
| `exited`, no keys parsed                                  | `{ scanned: false, failure: "host-key-unavailable", detail: <first line of stripUserinfo(result.stderr), trimmed, or ""> }` |
| `timed-out`                                               | `{ scanned: false, failure: "timed-out", detail: \`ssh-keyscan did not answer within ${timeoutMs}ms\` }`                    |
| `output-exceeded`                                         | exactly `{ scanned: false, failure: "host-key-unavailable", detail: "" }`                                                   |
| `not-started`, `pid-file-failed`, `orphaned`, `cancelled` | exactly `{ scanned: false, failure: "host-key-unavailable", detail: "" }`                                                   |

**The `timed-out` detail names the effective timeout, for the same reason and by the same edit.**
`src/services/git/host-key.ts:251` — `KEYSCAN_TIMEOUT_MS` interpolates the constant while the timer
used `options?.timeoutMs ?? KEYSCAN_TIMEOUT_MS` from `:187`. It now interpolates `timeoutMs`.
`KEYSCAN_TIMEOUT_MS` stays exported and stays the default, and
`src/services/git/host-key.test.ts:200` — `pins the default port and the scan timeout` still asserts
its value.

**No new `ScanOutcome` failure name enters the type.** `src/services/git/host-key.ts:32` —
`host-key-unavailable` admits exactly two failures, and the `output-exceeded` outcome maps onto the
one this path already returns when the scanner produces nothing readable. That is the whole of the
epic's ruling, and gate row 18 deep-equals the object so no field is left unpinned.

### 3 — `src/services/git/child.ts`

**`inspectChild(runSupervised, input)` and
`readProcessStartSeconds(runSupervised, pidFile, pid)`. `stopChild(input)` is unchanged.**
`src/services/git/child.ts:233` — `stopChild` spawns nothing: `:237` — `process.kill` signals a pid
read from a journal, so it takes no runner and keeps `groupGone` at `:258` and `groupExists` at
`:273`. `src/services/git/child.ts:167` — `readProcessStartSeconds` is the only spawn in the file.

**Delete:** the `spawnSupervised` member of the import at `:17` — `spawnSupervised`, the spawn at
`:175` — `spawnSupervised`, the `child.pid === undefined` block at `:187-194`, the timer and its
`SIGKILL` at `:196-207`, the chunk array and its handler at `:210-213`, the `await child.exited` at
`:214`, the `killError` rethrow at `:215-217`, and the inner `finally` at `:225-227`.

**Keep:** the `assertSignallable` import from `../../domain/pid.ts` that EPIC 050.6 Story 2
(`01-the-launcher-the-contract-and-the-pid-check`) landed, `resolvePs(process.platform)` at `:172`
and its `RecoveryError` before any run, the scratch mint at `:173` — `randomUUID`, and the outer
`finally` whose `rmSync(scratch, { force: true })` at `:229` — `rmSync` removes it.

The call passes `command: ps`, `args: ["-o", "lstart=", "-p", String(pid)]`,
`env: { PATH: "", LC_ALL: "C", TZ: "UTC" }`, `cwd: directory`, `pidFile: scratch`,
`timeoutMs: PROCESS_START_READ_TIMEOUT_MS`, `outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES`,
`signal: null`, and both callbacks null.

The mapping is two lines: an `exited` outcome with `code === 0` returns
`parseLstart(result.stdout)`; **every other outcome and every non-zero code returns `null`**, which is
the value `src/services/git/child.ts:219` and `:222` already return. The `null` surfaces at
`src/services/git/child.ts:151` — `liveness-unknown` with the detail
`"the process start time could not be read"`, unchanged.

**`readProcessStartSeconds` stops rejecting.** `src/services/git/child.ts:216` — `throw killError`
lets a non-`ESRCH` signal error escape `inspectChild` today. The runner now owns that rethrow, and it
cannot reach this function because a `SupervisedRunner` never signals on this path unless the timeout
fires. The six findings are unchanged either way.

### 4 — `src/services/git/binary.ts`

**`BinaryGitDependencies` gains `runSupervised: SupervisedRunner`**, beside `runner` at
`src/services/git/binary.ts:20` — `runner` and `paths` at `:21` — `paths`.

Three members forward it, and no other line of the file changes:

- `src/services/git/binary.ts:33` — `scanHostKeys` becomes
  `scanHostKeys: (remoteUrl) => scanHostKeys(runSupervised, paths, remoteUrl),`
- `src/services/git/binary.ts:34` — `confirmHostKey` becomes
  `confirmHostKey: (input) => confirmHostKey(runSupervised, paths, input.remoteUrl, input.hostFingerprint),`
- `src/services/git/binary.ts:41` — `inspectChild` becomes
  `inspectChild: (input) => inspectChild(runSupervised, input),`

**`src/services/git/index.ts` does not change.** `:159` — `scanHostKeys`, `:160` — `confirmHostKey`,
`:185` — `inspectChild` and `:186` — `stopChild` keep their exact signatures, because the runner is
bound at construction. **No file under `src/commands/` or `src/queries/` changes, and no `Git` fake in
their tests changes**, which is why this epic holds no `story-implement` entry.

The returned object keeps nineteen members in the same source order.

### 5 — The four suites

- **`src/services/git/probe.test.ts`** passes `createSupervisedRunner()` as the first argument of
  every `probeTools` call at `:137`, `:151`, `:168`, `:185`, `:194`, `:213`, `:233`, `:252`, `:283`
  and `:295`. Its shell-script fixtures, its `waitForProbePid` at `:69` and its `after` hook are
  unchanged.
- **`src/services/git/host-key.test.ts`** passes it as the first argument of every `scanHostKeys` and
  `confirmHostKey` call, and keeps the `{ timeoutMs: 1500 }` override at `:485`.
- **`src/services/git/child.test.ts`** passes it as the first argument of every `inspectChild` call,
  and passes nothing new to `stopChild`.
- **`src/services/git/binary.test.ts`** gains a **recording `SupervisedRunner`** beside its recording
  `GitRunner` at `:57` — `recordingRunner`, and constructs
  `createBinaryGit({ runner, paths, runSupervised })`. The nineteen-name case at `:76` is unchanged.

## Constraints

- No file under `src/services/git/` imports `spawnSupervised`, `LAUNCHER_PID_FILE_FAILURE` or
  `LAUNCHER_ORPHANED_FAILURE` after this story.
- `src/services/git/child.ts` keeps `process.kill` — three times, all inside `stopChild`,
  `groupGone` and `groupExists`, and once inside `inspectChild` at `:128` for the liveness probe.
  Those four are not a supervised child's signals.
- Every scratch pid file keeps its `finally` removal. The runner removes none.
- `src/services/git/index.ts` gains and loses nothing.
- Do not touch `src/main.ts` or `scripts/e2e/**`.
- The two timeout messages interpolate `timeoutMs`, never `PROBE_TIMEOUT_MS` and never
  `KEYSCAN_TIMEOUT_MS`. Both constants keep their values and their exports.
- `src/services/git/probe.test.ts` gains a local `createFakeSchedule` for the hanging-tool case, so
  the amended `src/services/git/probe.test.ts:243` — `a hanging tool is killed and the group is signalled`
  arms no real 1500 ms timer.
- `src/services/git/host-key.test.ts` gains a local `createFakeSchedule`, or imports none and drives
  the timed-out branch through a mock `SupervisedRunner`. It must not arm a real 1500 ms timer for the
  timeout branch: `AGENTS.md` forbids a wall-clock dependency, and gate row 18 names a fake schedule.
- Do not add a case to `src/services/git/binary.test.ts` for a member the shipped suite does not
  exercise. The nineteen-name assertion is what covers the rest.

## Verify

```
node --test \
  src/services/git/probe.test.ts \
  src/services/git/host-key.test.ts \
  src/services/git/child.test.ts \
  src/services/git/binary.test.ts
```

`src/services/git/host-key.test.ts` runs against the loopback ssh fixture of
`test/helpers/remote/ssh.ts`, created in the `before` at `src/services/git/host-key.test.ts:401` and
disposed in the `after` at `:405`. The dead loopback `"ssh://git@127.0.0.1:1/r.git"` is what forces
the unavailable branch today, at `:467`.

Add, each as a separate `it`:

1. `"probeTools reports the same ProbedTools for a healthy toolchain"` — the amended shipped case at
   `src/services/git/probe.test.ts:134`. `probeTools(createSupervisedRunner(), probeInput(dir))`
   resolves deep-equal to `{ git, ssh, sshKeyscan, gitVersion: "2.50.1", sshVersion: "10.2p1" }` with
   the three paths the fixture wrote, and `readdirSync(runDirectory)` deep-equals `[]`.

2. `"a tool that never starts and a tool that floods both refuse as tool-unreadable"` — one case, two
   assertions. A `git` whose `cwd` cannot be entered raises `ToolProbeError` with `code`
   `"tool-unreadable"` and `tool` `"git"`. A hanging `git` at `{ timeoutMs: 1500 }`, driven through
   `createSupervisedRunner(fake.schedule)`, raises `ToolProbeError` with `code` `"tool-unreadable"`
   and `message` equal to `` `${gitPath} did not answer a version within 1500ms` `` — the caller's
   value, not `PROBE_TIMEOUT_MS`. A `git` fixture that prints `1_048_577` bytes before its
   banner raises `ToolProbeError` with `code` `"tool-unreadable"`, `tool` `"git"` and `message`
   equal to `` `${gitPath} produced more than 1048576 bytes of output` ``.

3. `"the version stream is stdout for git and stderr for ssh"` — a `git` fixture that prints its
   banner on `stdout` and noise on `stderr`, and an `ssh` fixture that prints its banner on `stderr`
   and noise on `stdout`, resolve to `gitVersion` `"2.50.1"` and `sshVersion` `"10.2p1"`.

4. `"scanHostKeys returns the fixture host keys, a timed-out failure, and an exact unavailable object"`
   — the amended shipped cases at `src/services/git/host-key.test.ts:409` and `:477`.
   `scanHostKeys(createSupervisedRunner(), paths, remote.url("fixture.git"))` resolves `scanned`
   `true` with the two fixture algorithms in accepted order. A sleeping `sshKeyscan` driven through
   `createSupervisedRunner(fake.schedule)` at `{ timeoutMs: 1500 }`, whose fake fires `1500` and then
   `2_000`, resolves deep-equal to
   `{ scanned: false, failure: "timed-out", detail: "ssh-keyscan did not answer within 1500ms" }` —
   the caller's `timeoutMs`, not `KEYSCAN_TIMEOUT_MS`. The control: the same sleeping `sshKeyscan` at
   the default timeout, whose fake fires `15000` and then `2_000`, reports
   `"ssh-keyscan did not answer within 15000ms"`, so the case tells the two values apart.
   **The fake schedule replaces the shipped real timer of `src/services/git/host-key.test.ts:477`**,
   because gate row 18 requires the failure after a fake schedule fires and because
   `AGENTS.md` forbids a wall-clock dependency. A mock `SupervisedRunner` returning `outcome`
   `"output-exceeded"` makes the scan resolve deep-equal to exactly
   `{ scanned: false, failure: "host-key-unavailable", detail: "" }`, asserted as a whole object so no
   field is left unpinned.

5. `"confirmHostKey forwards the same runner"` — the amended shipped case at
   `src/services/git/host-key.test.ts:527`. `confirmHostKey(recording, paths, remote.url("fixture.git"), remote.hostKeys[0]!.fingerprint)`
   resolves `confirmed` `true`, and the recording `SupervisedRunner` reports exactly one run whose
   `command` equals `paths.sshKeyscan`.

6. `"inspectChild reports the six findings exactly as today"` — the six amended shipped cases at
   `src/services/git/child.test.ts:156`, `:163`, `:169`, `:184`, `:203`, `:216` and `:248`, each
   passing `createSupervisedRunner()` as the first argument, resolving to `no-pid-file`,
   `pid-file-unreadable`, `process-absent`, `alive`, `started-later` and `liveness-unknown` with the
   same payload fields and the same `detail` strings.

7. `"stopChild takes no runner"` — the five shipped cases at `src/services/git/child.test.ts:265`,
   `:281`, `:285`, `:326` and `:360` pass unchanged, and a recording `SupervisedRunner` handed to the
   same suite reports zero runs across all five, so `stopChild` reaches no supervised run.

8. `"createBinaryGit returns the same nineteen members and scanHostKeys reaches no GitRunner"` — the
   amended shipped cases at `src/services/git/binary.test.ts:76` and `:236`.
   `Object.keys(createBinaryGit({ runner, paths, runSupervised }))` sorted bytewise deep-equals the
   shipped nineteen names, and `git.scanHostKeys("ssh://git@127.0.0.1:1/r.git")` leaves the recording
   `GitRunner` with zero requests and the recording `SupervisedRunner` with exactly one run. The
   control: `git.fetch(...)` on the same facade leaves the `GitRunner` with exactly one request, so
   the zero-count assertion detects a call it must not miss.

`pnpm run verify` is red on `pnpm run typecheck` until EPIC 050.6 Story 6
(`05-the-composition-root-and-the-harness`). No case of this story runs it.

Proof: gate rows 17, 18, 19 and 20 delivered — `src/services/git/probe.test.ts`,
`src/services/git/host-key.test.ts`, `src/services/git/child.test.ts` and
`src/services/git/binary.test.ts` in `PASS EPIC-050.6`.
