# Story 01 — The pinned invocation

Epic: `.agent/plan/epics/006-git-primitives.md`
Depends on: Story 04 (`spawnSupervised`), Story 02 (`src/services/git/index.ts` already carries the widened `UrlRefusal`).

One file builds every `git` argument vector and its environment. One file runs it. Every later story in this epic calls `runGit` and builds no vector of its own.

## Change

### 1. `src/services/git/index.ts` — add the paths type and the run failure

Append to `src/services/git/index.ts`, after `HostKey` at `:12`:

```ts
export type GitPaths = Readonly<{
  git: string;
  ssh: string;
  sshKeyscan: string;
  home: string;
  keyDirectory: string;
  knownHosts: string;
  runDirectory: string;
}>;
```

Every member is an absolute path. `git`, `ssh` and `sshKeyscan` are executables that the caller already resolved. `home` is the `HOME` the child sees. `keyDirectory` is mode `0700` and holds ssh key material and the credential helper. `knownHosts` is the daemon's `known_hosts` file. `runDirectory` holds the pid files that `runGit` mints for an operation the caller does not journal.

Add `"timed-out"` and `"output-exceeded"` to `GitFailure` at `:44-51`, after `"lock-held"`. A timeout and a bound breach are outcomes a caller reports differently from `unknown`, and `docs/proposal/phase-1/git-foundation.md:261` makes both a failure rather than a truncation.

### 2. `src/services/git/environment.ts` (new)

```ts
import { dirname } from "node:path";

import type { GitPaths } from "./index.ts";

export const GIT_CONFIG_ARGS: readonly string[];

export type GitEnvironmentInput = Readonly<{
  paths: GitPaths;
  extra?: Readonly<Record<string, string>>;
}>;

export function gitPath(paths: GitPaths): string;

export function gitEnvironment(
  input: GitEnvironmentInput,
): Readonly<Record<string, string>>;

export function gitArgv(args: readonly string[]): readonly string[];
```

`GIT_CONFIG_ARGS` is exactly, in this order:

```ts
[
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
];
```

`gitArgv(args)` returns `[...GIT_CONFIG_ARGS, ...args]`. Every command in this epic passes its own arguments through it, so no command can omit the three pins.

`gitPath(paths)` returns the `PATH` value: the `dirname` of `paths.git`, `paths.ssh` and `paths.sshKeyscan`, in that order, with a later duplicate dropped, joined by `":"`. Nothing else is on it. `docs/proposal/phase-1/git-foundation.md:61` fixes the content, and the order is fixed here so the value is deterministic.

`gitEnvironment` returns a fresh object built **from nothing** — it never spreads `process.env`. The keys are exactly these, and the test asserts the key set:

| Key                   | Value                       |
| --------------------- | --------------------------- |
| `PATH`                | `gitPath(paths)`            |
| `HOME`                | `paths.home`                |
| `LC_ALL`              | `C`                         |
| `GIT_CONFIG_GLOBAL`   | `/dev/null`                 |
| `GIT_CONFIG_SYSTEM`   | `/dev/null`                 |
| `GIT_CONFIG_NOSYSTEM` | `1`                         |
| `GIT_TERMINAL_PROMPT` | `0`                         |
| `GIT_AUTHOR_NAME`     | `kanthord`                  |
| `GIT_AUTHOR_EMAIL`    | `kanthord@kanthord.invalid` |
| `GIT_COMMITTER_NAME`  | `kanthord`                  |
| `GIT_COMMITTER_EMAIL` | `kanthord@kanthord.invalid` |

The identity domain is `kanthord.invalid`, not `localhost`. RFC 2606 reserves `.invalid`, so the name can never resolve. A `localhost` literal is also unavailable here: `src/domain/loopback.test.ts:85` admits exactly two files that may hold one, and `src/services/git/environment.ts` is not one of them.

`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT` and every `GIT_TRACE*` name are absent rather than empty. A fresh object has no inherited key to unset, and an empty `GIT_DIR` is not the same as an absent one.

`input.extra` merges last, and it is the only channel for a per-operation entry — `GIT_SSH_COMMAND` and the credential-helper variables of Story 03. `gitEnvironment` throws an `Error` with message `` `${key} is a pinned entry` `` when `extra` carries any of the eleven keys above, and with message `` `${key} is a suppressed entry` `` when `extra` carries `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT`, or any key starting with `GIT_TRACE`. A caller cannot re-introduce ambient state through the one door that stays open.

No commit date is pinned. `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` belong to the command that writes an object, and no command in this epic writes one.

### 3. `src/services/git/redact.ts` (new)

```ts
export function stripUserinfo(text: string): string;
```

It replaces every match of `/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g` with `"$1"`, so `https://user:token@forge.test/r.git` becomes `https://forge.test/r.git`. It removes the username as well: a username is not a secret, and a rule that keeps it needs a second rule to decide which half of `user:pass@` to drop.

This is **defence in depth, not the mechanism.** No url the daemon hands to `git` carries a credential — Story 02 refuses a password in a userinfo, and Story 03 delivers the secret through a helper — so the strip exists for what a diagnostic echoes back from a url a human typed. It lives in its own file because `run.ts`, `fetch.ts` and `clone.ts` all use it, and `clone.ts` must not import `credential.ts` to get it.

### 4. `src/services/git/run.ts` (new)

```ts
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GitError, type GitPaths } from "./index.ts";
import { gitArgv, gitEnvironment } from "./environment.ts";
import { spawnSupervised, LAUNCHER_PID_FILE_FAILURE } from "./launcher.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
export const TERMINATION_GRACE_MS = 2_000;

export type GitRunRequest = Readonly<{
  args: readonly string[];
  cwd?: string;
  extraEnv?: Readonly<Record<string, string>>;
  pidFile?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
}>;

export type GitRunResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  args: readonly string[];
}>;

export type GitRunner = (request: GitRunRequest) => Promise<GitRunResult>;

export function createGitRunner(paths: GitPaths): GitRunner;
```

`createGitRunner(paths)` returns a `GitRunner` that, per call:

1. Resolves `pidFile` to `request.pidFile ?? join(paths.runDirectory, `git-${randomUUID()}.pid`)`. It records whether it minted the path.
2. Calls `spawnSupervised({ command: paths.git, args: gitArgv(request.args), env: gitEnvironment({ paths, extra: request.extraEnv }), cwd: request.cwd ?? paths.home, pidFile })`.
3. Collects `stdout` and `stderr` into two arrays of `Buffer`, tracking each total. When either total exceeds `request.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES`, it cancels (step 4) and settles as `output-exceeded`.
4. Starts one timer of `request.timeoutMs ?? DEFAULT_TIMEOUT_MS`. Cancellation is `signalGroup("SIGTERM")`, then a second timer of `TERMINATION_GRACE_MS`, then `signalGroup("SIGKILL")`. A `signalGroup` that throws with `code === "ESRCH"` or `code === "EPERM"` is swallowed. Both mean the group is already gone: `ESRCH` when it is fully reaped, and `EPERM` when the leader is still a zombie, which is what `process.kill(-pid, …)` raises on darwin and Node 24.17.0. A fast-exiting child that breaches the output bound always hits that zombie window, so tolerating only `ESRCH` makes `run.test.ts` fail deterministically. Any other error is recorded and then rejects the runner promise after `exited` resolves. It is never thrown from inside a stream listener or a timer callback, because that raises an `uncaughtException` instead of failing the call. Both timers are cleared in a `finally`, so a resolved call leaves no pending handle and a `SIGTERM` cannot arrive after the child was reaped.
   After a cancellation, both streams stay attached and their data is discarded rather than accumulated. A descendant that inherited the pipe and writes into a full one would otherwise block, and the operation would not end when its `git` did.
5. Awaits `exited`. When it minted the pid file, it removes it with `rmSync(pidFile, { force: true })` in a `finally`. When the caller supplied the path, it removes nothing: that file belongs to a `git_operation` row, and `.agent/plan/epics/007.5-startup-recovery.md:23` owns its lifecycle.
6. **One precedence, and the first decision wins.** The runner records at most one verdict and never overwrites it, in this order: `output-exceeded`, then `timed-out`, then the launcher's `111`, then the exit code as data. The bound precedes the timeout because a breach is usually what causes the timeout that follows, and reporting the timeout would name the symptom rather than the cause.
7. On a timeout, throws `GitError("timed-out", `git ${request.args[0]} exceeded ${timeoutMs}ms`, stripUserinfo(stderr))`. On a bound breach, throws `GitError("output-exceeded", `git ${request.args[0]} exceeded ${limit} bytes of output`, "")`. On `code === LAUNCHER_PID_FILE_FAILURE`, throws `GitError("unknown", "the launcher could not create the pid file", "")`.
8. Otherwise resolves `{ code, stdout, stderr, args: request.args }`, whatever the exit code is. A non-zero `git` is data for the caller, not a throw: Story 05 reads a non-zero `update-ref` and Story 03 classifies a non-zero transport failure.

Two redaction rules hold at this boundary, and both are asserted by construction.

- `GitRunResult.args` is `request.args`, never `gitArgv(request.args)` and never the launcher vector. A caller that logs the args logs what it asked for.
- No `GitError` raised in this file carries the environment. The `detail` field carries `stripUserinfo(stderr)` and nothing else.

### 4. `eslint.config.js` — confine the spawn

Add a sixth `no-restricted-imports` block after the `src/cli/**` block at `eslint.config.js:254-278`:

- `files: ["src/**/*.ts"]`, `ignores: ["src/services/git/launcher.ts"]`
- `paths: [{ name: "node:child_process", message: "only src/services/git/launcher.ts creates a process; see .agent/plan/stories/006-git-primitives/04-supervised-spawn.md" }]`

`test/helpers/daemon.ts:1` and `test/helpers/cli.ts:1` are under `test/`, so they are unaffected. This is the mechanism behind the epic's "no other file spawns a process"; a test alone would let a reviewer add a second spawn and then fix the test.

The `ignores` list also needs `src/**/*.test.ts`, because `src/services/git/launcher.test.ts` and `src/services/home-lock/startup.test.ts` both create a process. That exemption is `node:child_process` only. Flat config applies the **last** matching `no-restricted-imports` entry per file and merges nothing, so a further block after the `src/**/*.test.ts` boundaries block must restate the `gitLibraries` group for `files: ["src/**/*.test.ts", "src/services/git/launcher.ts"]`. Without it the wrapper-library ban silently stops firing for every test file and for the launcher — the one file where a wrapper would be introduced. `src/domain/layout.test.ts` asserts both halves: `isomorphic-git` fires in a git-service file, in `launcher.ts` and in a test file, while `node:child_process` stays clean in `launcher.ts` and `launcher.test.ts`.

## Constraints

- `gitEnvironment` never reads `process.env`. Assert it by construction, not only by behaviour.
- **`GitPaths` is not `ToolPaths`.** EPIC 005's `Tools.paths` is a five-name record — `git`, `ssh`, `sshd`, `sshKeyscan`, `sshKeygen` — of which `sshd` and `sshKeygen` are fixture-only tools that the daemon never runs. Build `GitPaths` by naming three members: `git: tools.paths.git`, `ssh: tools.paths.ssh`, `sshKeyscan: tools.paths.sshKeyscan`. Never spread `tools.paths` into it. A spread would put `/usr/sbin` on the child `PATH` through `sshd`, and `docs/proposal/phase-1/git-foundation.md:61` allows only the directories of the probed binaries the daemon itself invokes.
- `run.ts` builds no argument vector of its own beyond `gitArgv`. Every `--git-dir`, `-C` and subcommand comes from `request.args`.
- Never set `GIT_DIR` or `GIT_WORK_TREE`. Every command names `--git-dir` or `-C` in its own arguments — `docs/proposal/phase-1/git-foundation.md:40`.
- Never add a `timeout` or `killSignal` option to `spawnSupervised`. The timer in `run.ts` is the only timeout, because it signals the group.
- Do not decode output as `utf8` incrementally. Concatenate the buffers, then decode once. A multi-byte sequence split across two chunks corrupts an object id otherwise.
- The output bound counts bytes on each stream separately, and the breach kills the child. It never truncates and returns.

## Verify

`node --test src/services/git/environment.test.ts src/services/git/run.test.ts` — two new files, suites `"src/services/git/environment.test"` and `"src/services/git/run.test"`.

### `environment.test.ts` — no process runs here

- `gitArgv(["--git-dir=/x", "rev-parse", "HEAD"])` deep-equals `["-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "--git-dir=/x", "rev-parse", "HEAD"]`.
- `gitPath` with `git: "/usr/bin/git"`, `ssh: "/usr/bin/ssh"`, `sshKeyscan: "/usr/bin/ssh-keyscan"` is `"/usr/bin"` — the duplicates collapse to one entry. Those three are `toolDefaults` at `.agent/plan/stories/005-test-infrastructure/01-tool-prerequisites.md:52-58`, so the case is the real shape rather than an invented one.
- `gitPath` with `git: "/opt/git/bin/git"`, `ssh: "/usr/bin/ssh"`, `sshKeyscan: "/usr/bin/ssh-keyscan"` is `"/opt/git/bin:/usr/bin"`, in that order.
- `Object.keys(gitEnvironment({ paths })).sort()` deep-equals the eleven pinned keys, sorted. This is the assertion that fails when a twelfth entry is added silently.
- Each of the eleven values is asserted individually against the table.
- `gitEnvironment({ paths })` has no own property `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT`, `GIT_TRACE`, `GIT_TRACE_PACKET` or `GIT_TRACE2`, asserted with `Object.hasOwn` rather than by value, because `undefined` and absent differ.
- `process.env.KANTHORD_LEAK_PROBE = "leak"` before the call, and the returned object has no `KANTHORD_LEAK_PROBE` key. Delete the variable in `after`.
- `gitEnvironment({ paths, extra: { GIT_SSH_COMMAND: "x" } }).GIT_SSH_COMMAND` is `"x"`, and the key count is twelve.
- `gitEnvironment({ paths, extra: { LC_ALL: "en_US.UTF-8" } })` throws with message `"LC_ALL is a pinned entry"`. The same for `PATH` and `HOME`.
- `gitEnvironment({ paths, extra: { GIT_TRACE: "1" } })` throws with message `"GIT_TRACE is a suppressed entry"`. The same for `GIT_DIR` and `GIT_CONFIG_COUNT`.
- Read `src/services/git/environment.ts` as text and assert it does not include `"process.env"`.
- **The child `PATH` never carries a fixture tool.** Build a `GitPaths` from `resolveTools()` and assert `gitPath(paths).split(":")` has at most three entries, and that it contains neither `dirname(tools.paths.sshd)` nor `dirname(tools.paths.sshKeygen)` unless that directory is already the directory of `git`, `ssh` or `ssh-keyscan`. On this machine `sshd` is `/usr/sbin/sshd`, so the assertion has a real negative to catch.

### `run.test.ts` — a real `git`, no network

`resolveTools()` from `test/helpers/remote/tools.ts` (EPIC 005 Story 01) supplies every binary path: `tools.paths.git`, `tools.paths.ssh` and `tools.paths.sshKeyscan` are the three `GitPaths` needs, already resolved and version-probed. Each case builds a `GitPaths` over its own `mkdtemp` directory, with `home`, `keyDirectory`, `knownHosts` and `runDirectory` created inside it, and removes the tree in `after`.

- `runGit({ args: ["--version"] })` resolves with `code === 0` and `stdout` starting with `"git version "`.
- **The environment is what the child sees.** `runGit({ args: ["var", "-l"] })` and parse the output: assert the line `` `GIT_CONFIG_GLOBAL=/dev/null` `` is present. Then assert `runGit({ args: ["config", "--get", "core.hooksPath"] })` resolves with `stdout.trim() === "/dev/null"`, `maintenance.auto` is `"false"` and `gc.auto` is `"0"` — the three `-c` pins arrive on a command that never named them.
- **An operator config does not reach the child.** Write a `.gitconfig` into a second temporary directory setting `user.name = hostile` and `core.hooksPath = /tmp/evil`, point the process's own `HOME` at it for the duration of the case, then assert `runGit({ args: ["config", "--get", "user.name"] })` returns `code !== 0` with empty `stdout`, and `core.hooksPath` is still `/dev/null`. Restore `HOME` in `after`.
- **`args` is what the caller passed.** The resolved `result.args` deep-equals `["--version"]` and does not include `"-c"`. This is the redaction rule as a test.
- **A non-zero exit resolves.** `runGit({ args: ["--git-dir=" + join(dir, "absent.git"), "rev-parse", "HEAD"] })` resolves with `code !== 0` and non-empty `stderr`, and does not throw.
- **The timeout signals the group, and no descendant survives.** Run `git ls-remote ssh://kanthord.invalid/r.git` with `extraEnv.GIT_SSH_COMMAND` naming a generated script that records its own process id and sleeps 30 seconds, and `timeoutMs: 1500`. Assert the call rejects with a `GitError` whose `failure` is `"timed-out"`. Then assert `process.kill(<recorded ssh pid>, 0)` throws `ESRCH`. This is the epic coverage line "A killed `git` child is signalled by process group, and no descendant survives the cancellation."
- **The timeout error carries no environment.** On that same rejection, assert `JSON.stringify({ message: error.message, detail: error.detail })` includes neither `"GIT_CONFIG_GLOBAL"` nor the value of `paths.keyDirectory`, and assert `Object.keys(error).sort()` deep-equals `["detail", "failure", "name"]` — the three own enumerable properties `src/services/git/index.ts:53-62` assigns, and no environment object. `message` is own and non-enumerable on an `Error`, so it does not appear. Assert the same for a `GitError` raised from the output bound.
- **The output bound kills rather than truncates.** Run `git --git-dir=<seeded home> log --format=%H%n%s` against a fixture repository with `outputLimitBytes: 64`, and assert the call rejects with `failure === "output-exceeded"`. The seeded repository is `seedRepositories(tools).repositories["fixture.git"]` from `test/helpers/remote/seed.ts`.
- **The bound outranks the timeout.** Run the same command with `outputLimitBytes: 64` **and** `timeoutMs: 1`, and assert the failure is `"output-exceeded"`. One invocation satisfying two conditions has one verdict, and this case is the precedence rule as a test.
- **A cancelled operation ends even when a descendant holds the pipe.** Repeat the timeout case with a `GIT_SSH_COMMAND` script that writes 512 KiB to standard error and then sleeps. Assert the call rejects with `"timed-out"` and that it resolves within twice the timeout. Without the discard drain the descendant blocks on a full pipe and the case hangs.
- **The redaction, as a unit.** In `src/services/git/redact.test.ts`: `stripUserinfo("fatal: unable to access 'https://user:tok@forge.test/r.git/'")` equals `"fatal: unable to access 'https://forge.test/r.git/'"`; `stripUserinfo("ssh://git@forge.test/r.git")` equals `"ssh://forge.test/r.git"`; a percent-encoded userinfo `"https://u%40x:t@forge.test/r"` becomes `"https://forge.test/r"`; a string with two urls has both stripped; `"no url here"` is unchanged; `"git@forge.test:o/r.git"` is unchanged, because the scp spelling has no password position and its username is not a secret.
- **A minted pid file is removed; a supplied one is not.** After a successful `runGit({ args: ["--version"] })`, assert `fs.readdirSync(paths.runDirectory)` is empty. After `runGit({ args: ["--version"], pidFile: join(dir, "kept.pid") })`, assert `fs.existsSync(join(dir, "kept.pid"))` is `true` and its content parses as a positive integer.
- **The launcher failure is classified.** Pre-create `<dir>/taken.pid`, then `runGit({ args: ["--version"], pidFile: join(dir, "taken.pid") })` rejects with a `GitError` whose `failure` is `"unknown"` and whose message is `"the launcher could not create the pid file"`.

### The lint rule

Extend `src/domain/layout.test.ts` with one case: `lintCase({ filePath: "src/services/git/probe.ts", code: 'import { spawn } from "node:child_process";' })` includes `"no-restricted-imports"`, and `lintCase({ filePath: "src/services/git/launcher.ts", code: 'import { spawn } from "node:child_process";' })` does **not**. `test/helpers/lint.ts:7` returns the sorted rule ids, and `src/domain/layout.test.ts:55` is the existing pattern.

`npm run verify` exits 0.

Proof: contributes `src/services/git/environment.test.ts` and `src/services/git/run.test.ts` to `node --test src/services/git/**/*.test.ts`.
