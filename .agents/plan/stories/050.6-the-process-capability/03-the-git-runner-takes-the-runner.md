# Story 4 — The git runner takes the runner

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Depends on: EPIC 050.6 Story 3 (`02-the-one-supervised-run-machine`) — this story is the first caller
of `createSupervisedRunner`.
Kind: story-foundation

`createGitRunner` stops supervising and starts mapping. Every timer, every signal and every chunk
leaves `src/services/git/run.ts`; the pid-file lifetime, the argument vector, the environment and
every `GitError` message stay.

**This story leaves `pnpm run typecheck` red, and the window is two stories wide.**
`src/main.ts:29` — `systemSchedule as gitSchedule` reads a symbol this story deletes, and
`src/main.ts:235` — `createGitRunner` passes a `Schedule` where a `SupervisedRunner` is now required.
Seven files under `scripts/e2e/` call `createGitRunner(paths)` with one argument. EPIC 050.6 Story 6
(`05-the-composition-root-and-the-harness`) repairs all eight, and the epic is the unit of greenness.
No numbered case of this story or of EPIC 050.6 Story 5
(`04-the-three-spawn-sites-and-the-facade`) runs `pnpm run typecheck` or `pnpm run verify`.

## Change

### 1 — `src/services/git/run.ts`, the required parameter and the mapping

**`createGitRunner(paths: GitPaths, runSupervised: SupervisedRunner): GitRunner`. The second
parameter is required and it has no default.** A default of `createSupervisedRunner(systemSchedule)`
would make this file import `src/services/process/supervisor.ts`, which is one capability's
implementation importing another capability's implementation. `eslint.config.js:211` — `service`
allows a service to reach another capability only at its `index.ts`, and
`src/domain/layout.test.ts:229` — `one capability's implementation importing another's implementation is a boundary violation`
proves the refusal.

**Delete from `src/services/git/run.ts`:** `systemSchedule` at `:43`, `Schedule` at `:38`,
`ScheduledTimer` at `:36`, the local `signalGroup` at `:84`, `cancel` at `:95`, both `data` handlers
at `:107` and `:120`, the timeout at `:133`, and the four chunk-and-flag declarations at `:74-82`.

**Keep in `src/services/git/run.ts`, unchanged:** `GitRunRequest` at `:18`, `GitRunResult` at `:27`
and `GitRunner` at `:34`. `src/services/git/authenticated.ts:2` and nine suites import those three
names, and none of them changes in this epic.

The new body of the returned runner, in order:

1. `timeoutMs`, `outputLimitBytes`, `pidFile` and `mintedPidFile` are computed exactly as today, at
   `src/services/git/run.ts:54` — `DEFAULT_TIMEOUT_MS`, `:56` — `DEFAULT_OUTPUT_LIMIT_BYTES`,
   `:58` — `randomUUID` and `:59` — `mintedPidFile`. The three names come from
   `../process/index.ts`, as EPIC 050.6 Story 2
   (`01-the-launcher-the-contract-and-the-pid-check`) left them.
2. One `await runSupervised({ command: paths.git, args: gitArgv(request.args), env: gitEnvironment({ paths, extra: request.extraEnv }), cwd: request.cwd ?? paths.home, pidFile, timeoutMs, outputLimitBytes, signal: null, onStdout: null, onStderr: null })`.
   The five spawn fields are byte-identical to `src/services/git/run.ts:61-67`. `signal`,
   `onStdout` and `onStderr` are null because no git caller streams and no git caller cancels.
3. The mapping, as one `switch` on `result.outcome`, inside a `try` whose `finally` holds only
   `if (mintedPidFile) { rmSync(pidFile, { force: true }); }`:

| outcome                   | result                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `output-exceeded`         | `throw new GitError("output-exceeded", \`git ${request.args[0]} exceeded ${outputLimitBytes} bytes of output\`, "")` |
| `timed-out`               | `throw new GitError("timed-out", \`git ${request.args[0]} exceeded ${timeoutMs}ms\`, stripUserinfo(result.stderr))`  |
| `not-started`             | `throw new GitError("unknown", \`git ${request.args[0]} did not start\`, "")`                                        |
| `pid-file-failed`         | `throw new GitError("unknown", "the launcher could not create the pid file", "")`                                    |
| `orphaned`                | `throw new GitError("unknown", "the launcher was orphaned before it started git", "")`                               |
| `cancelled`               | `throw new GitError("unknown", \`git ${request.args[0]} was cancelled\`, "")`                                        |
| `exited`, `code === null` | `throw new GitError("unknown", \`git ${request.args[0]} terminated by signal ${result.signal}\`, "")`                |
| `exited`, otherwise       | `return { code: result.code, stdout: result.stdout, stderr: result.stderr, args: request.args }`                     |

**Six of the seven messages are the shipped strings**, from `src/services/git/run.ts:144`,
`:151`, `:71`, `:158`, `:165` and `:172`. **The `cancelled` arm is a ruling this story takes.** No git
caller passes a signal, so the arm is unreachable today; it exists because a `switch` over
`ProcessOutcome` must be total, and reusing `did not start` there would ship a false message the
moment a caller does pass one. It introduces no new `GitFailure` code. Recorded in `index.md` and
reported to the human for `## Decisions`.

**`args` is the caller's argv, and the mapping must not forward the runner's.**
`result.args` holds `gitArgv(request.args)`, the vector the launcher received;
`src/services/git/run.ts:182` — `args` returns `request.args`, and it keeps doing so.
`src/services/git/run.test.ts:192` — `result.args is what the caller passed, never the vector` is the
shipped case that pins it.

**The `timed-out` detail keeps its redaction.** `src/services/git/run.ts:154` — `stripUserinfo` reads
the concatenated stderr chunks; it now reads `result.stderr`, which is the same bytes.

**The minted pid file keeps its owner.** `src/services/git/run.ts:189` — `mintedPidFile` stays in the
`finally`, because `src/commands/repository/register-repository.ts:219` — `pidFile` supplies a
journaled path whose removal `src/commands/startup/reap-orphans.ts:187` — `removePidFile` owns, and
the runner below removes nothing at all.

### 2 — The thirteen suites under `src/services/git/`

**Each suite constructs one runner at module scope and passes it to every call.**

```ts
import { createSupervisedRunner } from "../process/supervisor.ts";

const runSupervised = createSupervisedRunner();
```

Then `createGitRunner(paths)` becomes `createGitRunner(paths, runSupervised)` at every site. The
twelve suites this story repairs, with the call sites the closure resolved today:

| suite                                     | import line | call sites                                                                     |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `src/services/git/authenticated.test.ts`  | `:28`       | 125, 175, 221, 242, 301, 329, 366, 404, 437                                    |
| `src/services/git/clone.test.ts`          | `:26`       | 147, 191, 213, 237, 259, 282, 300, 324, 343, 364, 383, 428, 464, 497, 525, 550 |
| `src/services/git/fetch.test.ts`          | `:26`       | 157, 180, 196, 226, 248, 285, 313                                              |
| `src/services/git/host-key.test.ts`       | `:38`       | 763, 788                                                                       |
| `src/services/git/outside-writer.test.ts` | `:22`       | 236, 259, 284, 297, 333, 391, 425, 448, 475, 523                               |
| `src/services/git/preflight.test.ts`      | `:25`       | 345                                                                            |
| `src/services/git/push-probe.test.ts`     | `:14`       | 39                                                                             |
| `src/services/git/ref-read.test.ts`       | `:16`       | 65, 78, 91, 108, 121                                                           |
| `src/services/git/ref-update.test.ts`     | `:24`       | 155, 167, 178, 193, 204, 215, 233, 245                                         |
| `src/services/git/remote-info.test.ts`    | `:23`       | 141, 151, 168, 189, 203, 220, 241                                              |
| `src/services/git/seed.test.ts`           | `:35`       | 368, 398, 422, 431, 454, 486, 515, 547, 570, 591, 613, 643, 687                |
| `src/services/git/worktree.test.ts`       | `:17`       | 105, 116, 124, 130                                                             |

Citations: `src/services/git/authenticated.test.ts:28` — `createGitRunner`,
`src/services/git/clone.test.ts:26` — `createGitRunner`, `src/services/git/fetch.test.ts:26` —
`createGitRunner`, `src/services/git/host-key.test.ts:38` — `createGitRunner`,
`src/services/git/outside-writer.test.ts:22` — `createGitRunner`,
`src/services/git/preflight.test.ts:25` — `createGitRunner`,
`src/services/git/push-probe.test.ts:14` — `createGitRunner`,
`src/services/git/ref-read.test.ts:16` — `createGitRunner`,
`src/services/git/ref-update.test.ts:24` — `createGitRunner`,
`src/services/git/remote-info.test.ts:23` — `createGitRunner`,
`src/services/git/seed.test.ts:35` — `createGitRunner`,
`src/services/git/worktree.test.ts:17` — `createGitRunner`.

**None of the twelve asserts a timer, a signal or an output bound**, so none of them gains or loses a
case. Each is a two-line import addition and one argument per call. `src/services/git/seed.test.ts:687`
is the one inline form, `createGitRunner(paths)({ ...request, timeoutMs: 15_000 })`, and it becomes
`createGitRunner(paths, runSupervised)({ ...request, timeoutMs: 15_000 })`.

### 3 — `src/services/git/run.test.ts`, rewritten at the seam

**Delete the eight cases whose oracle is now the supervisor's**, each proven again by EPIC 050.6
Story 3 (`02-the-one-supervised-run-machine`): `src/services/git/run.test.ts:126` —
`systemSchedule is the default and both forms resolve git --version`, `:214` —
`the timeout signals the group and no descendant survives`, `:255` —
`the grace timer is registered with TERMINATION_GRACE_MS`, `:328` —
`the output bound kills rather than truncates`, `:356` — `the bound outranks the timeout`, `:386` —
`a cancelled operation ends even when a descendant holds the pipe`, `:430` —
`the timeout is registered with the caller's timeoutMs`, and `:441` —
`a settled run cancels both timers`.

**Delete the local `createFakeSchedule` at `:80` and the `FakeSchedule` type at `:74`**, together with
the `systemSchedule`, `Schedule`, `ScheduledTimer` and `TERMINATION_GRACE_MS` members of the import at
`:23-30`. EPIC 050.6 Story 3 (`02-the-one-supervised-run-machine`) holds the only copy.

**Keep, with the runner argument added:** `:118`, `:146`, `:164`, `:192`, `:200`, `:298`, `:413`,
`:466` and `:486`.

**Add a mock `SupervisedRunner`**, a hand-written object that returns the exact `ProcessRunResult`
the case names and records the request it received. Cases 1 and 4 below drive the mapping through it,
so every outcome is an exact value and no case waits on an operating system.

## Constraints

- `src/services/git/run.ts` holds no `setTimeout`, no `process.kill`, no `signalGroup`, no `Buffer`
  accumulation and no `spawnSupervised` after this story. Its only imports from the process
  capability are `../process/index.ts`.
- Every shipped `GitError` message and every `GitFailure` code is preserved exactly. No new
  `GitFailure` value enters `src/services/git/index.ts`.
- `GitRunResult.args` stays the caller's argv.
- Do not touch `src/main.ts` or any file under `scripts/`. EPIC 050.6 Story 6
  (`05-the-composition-root-and-the-harness`) owns both, and splitting the repair would leave two
  stories editing one file.
- Do not touch `src/services/git/probe.ts`, `host-key.ts`, `child.ts` or `binary.ts`. EPIC 050.6
  Story 5 (`04-the-three-spawn-sites-and-the-facade`) owns them; they still spawn through
  `spawnSupervised` after this story, and they still pass.
- Do not run `pnpm run typecheck` or `pnpm run verify` in a case of this story. Both are red on
  `src/main.ts` and `scripts/e2e/**` until EPIC 050.6 Story 6
  (`05-the-composition-root-and-the-harness`).

## Verify

```
node --test \
  src/services/git/run.test.ts \
  src/domain/layout.test.ts \
  src/services/git/clone.test.ts \
  src/services/git/seed.test.ts \
  src/services/git/authenticated.test.ts \
  src/services/git/outside-writer.test.ts \
  src/services/git/ref-update.test.ts \
  src/services/git/remote-info.test.ts \
  src/services/git/fetch.test.ts \
  src/services/git/ref-read.test.ts \
  src/services/git/worktree.test.ts \
  src/services/git/push-probe.test.ts \
  src/services/git/preflight.test.ts
```

**Case 1 comes first because it is what makes that command runnable.** Making the second parameter
required breaks every one-argument call in the same command, so the twelve suites are repaired in the
first turn and no later case runs against a suite that cannot resolve its own call.

Add, each as a separate `it`:

1. `"the twelve other git suites pass over the supervised runner"` — a build-only check, and the
   first turn of this story. Each of the twelve suites named in `## Change` step 2 constructs one
   `createSupervisedRunner()` at module scope and passes it at every site; the `node --test` line
   above exits `0`; and over `src/services/git/*.test.ts`, `grep -c 'createGitRunner(paths)'` prints
   `0` for each file, so no one-argument call survives. The control: the same grep for
   `createGitRunner(paths, runSupervised)` prints a non-zero count for each of the twelve.

2. `"every daemon fault maps to its shipped GitError"` — over a mock `SupervisedRunner`, in
   `src/services/git/run.test.ts`. A result with `outcome` `"output-exceeded"` makes
   `createGitRunner(paths, mock)({ args: ["fetch"], outputLimitBytes: 64 })` reject with a `GitError`
   whose `failure` is `"output-exceeded"` and whose `message` is
   `"git fetch exceeded 64 bytes of output"`. A result with `outcome` `"not-started"` rejects with
   `failure` `"unknown"` and `message` `"git fetch did not start"`. `"pid-file-failed"` rejects with
   `"unknown"` and `"the launcher could not create the pid file"`. `"orphaned"` rejects with
   `"unknown"` and `"the launcher was orphaned before it started git"`. An `"exited"` result with
   `code` `null` and `signal` `"SIGSEGV"` rejects with `"unknown"` and
   `"git fetch terminated by signal SIGSEGV"`.

3. `"a timeout error carries neither the environment nor the key directory"` — the amended shipped
   case at `src/services/git/run.test.ts:298`. A mock result with `outcome` `"timed-out"` and a
   `stderr` holding a url with userinfo makes the run reject with `failure` `"timed-out"`, `message`
   `"git fetch exceeded 120000ms"`, and a `stderr` that holds neither `paths.keyDirectory` nor any
   value of `gitEnvironment`, and whose userinfo is stripped.

4. `"the runner is required and it receives exactly one request"` — the mock records exactly one
   request per `createGitRunner` call, whose `command` equals `paths.git`, whose `args` equal
   `gitArgv(["--version"])`, whose `signal`, `onStdout` and `onStderr` are each `null`, whose
   `timeoutMs` is `120_000` and whose `outputLimitBytes` is `1_048_576` when the caller passes
   neither.

5. `"result.args is what the caller passed, never the vector"` — the shipped case at
   `src/services/git/run.test.ts:192`, now over the mock. The recorded request `args` deep-equal
   `gitArgv(["--version"])` — six elements, the pinned vector — and the resolved `GitRunResult.args`
   deep-equals `["--version"]`. `ProcessRunResult` carries no `args`, so the returned value can come
   from nowhere but `request.args`, and this case is what proves the mapping does not rebuild it.

6. `"a minted pid file is removed and a supplied one survives"` — the shipped case at
   `src/services/git/run.test.ts:413`, unchanged except for the runner argument.
   `createGitRunner(paths, runSupervised)({ args: ["--version"] })` resolves with `code` `0` and
   `readdirSync(paths.runDirectory)` deep-equals `[]`; a run with `pidFile` set to a path under
   `paths.home` resolves with `code` `0`, that file still exists, and the pid it holds is an integer
   greater than `1`.

7. `"git --version resolves with code 0 through the real supervised runner"` — the shipped case at
   `src/services/git/run.test.ts:118` over `createGitRunner(paths, createSupervisedRunner())`:
   `code` is `0` and `stdout` starts with `"git version "`.

8. `"the git service and the process capability import no phase-2 capability"` — in
   `src/domain/layout.test.ts`. Reading every `*.ts` file under `src/services/process/` and
   `src/services/git/`, no import specifier of any of them matches `services/model/`,
   `services/agent/`, `services/workspace/`, `services/ambient/` or `@earendil-works/`. The control:
   the same matcher over the same two directories finds `../../domain/pid.ts` in
   `src/services/git/child.ts`, so the assertion is proven to read real specifiers.

`pnpm run verify` is red on `pnpm run typecheck` until EPIC 050.6 Story 6
(`05-the-composition-root-and-the-harness`). No case of this story runs it.

Proof: gate rows 14, 15 and 16 delivered — `src/services/git/run.test.ts` and
`src/domain/layout.test.ts` in `PASS EPIC-050.6`.
