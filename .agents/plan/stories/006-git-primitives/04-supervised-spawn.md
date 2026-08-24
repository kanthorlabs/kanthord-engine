# Story 04 — The supervised spawn

Epic: `.agents/plan/epics/006-git-primitives.md`
Depends on: nothing in this epic. Dispatch it before Story 01, which spawns only through it.

This file is the only one under `src/` that imports `node:child_process`. That is the enforceable claim, and it is narrower than "the only place a process is created": `git` itself starts `ssh`, a credential helper and a transport child, and the launcher is what makes that whole subtree one signallable group.

`/bin/sh` is a stated platform prerequisite, not an injected path. It is the single hard-coded executable in the service, and `docs/proposal/phase-1/git-foundation.md:260` already limits the daemon to POSIX. Every construct in the script — `set -C`, `$$`, `|| exit`, `exec "$@"` — is POSIX shell and not a `bash` extension.

## Change

### 1. `src/services/git/launcher.ts` (new)

```ts
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export const LAUNCHER_SHELL = "/bin/sh";

export const LAUNCHER_SCRIPT =
  'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; exec "$@"';

export const LAUNCHER_PID_FILE_FAILURE = 111;

export type SupervisedSpawnInput = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  pidFile: string;
}>;

export type SupervisedExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type SupervisedChild = Readonly<{
  pid: number;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<SupervisedExit>;
  signalGroup(signal: NodeJS.Signals): void;
}>;

export function launcherArgv(
  input: Pick<SupervisedSpawnInput, "command" | "args">,
): readonly string[];

export function assertSignallable(pid: number | undefined): void;

export type SupervisedSpawnFailure = Readonly<{
  pid: undefined;
  exited: Promise<SupervisedExit>;
}>;

export type SupervisedSpawn = SupervisedChild | SupervisedSpawnFailure;

export function spawnSupervised(input: SupervisedSpawnInput): SupervisedSpawn;
```

`launcherArgv` returns exactly:

```ts
["-c", LAUNCHER_SCRIPT, "sh", input.command, ...input.args];
```

The fourth element onward is what `exec "$@"` runs. `"sh"` occupies `$0`, so `$1` is the executable and the shell never reads a command from the argument vector it is passed.

`spawnSupervised` calls `spawn` once:

```ts
const child = spawn(LAUNCHER_SHELL, launcherArgv(input), {
  env: { ...input.env, KANTHORD_PID_FILE: input.pidFile },
  cwd: input.cwd,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
```

It returns `child.pid` as `pid`, the two streams, an `exited` promise that resolves on the `close` event with `{ code, signal }`, and `signalGroup`.

`assertSignallable(pid)` throws an `Error` with message `"a supervised pid must be greater than 1"` when `pid` is `undefined`, not an integer, or not greater than `1`. `spawnSupervised` calls it once on `child.pid` before it returns a `SupervisedChild`, and `signalGroup` calls it again before every signal.

**A failed spawn returns the failure member, and never a `SupervisedChild` carrying a fake pid.** `spawn` returns a `ChildProcess` with `pid === undefined` when the spawn failed asynchronously — a missing `cwd`, for example — and reports the cause through the `error` event afterwards. Every value of `SupervisedChild.pid` is signallable, so that state cannot be expressed as a `SupervisedChild`; returning one with `pid: 0` would make the type claim a signallable process id for a process that does not exist. The failure member carries `exited` and nothing else, because `exited` is the only channel that can report a cause which has not arrived yet when `spawnSupervised` returns.

A caller narrows on `pid === undefined` before it reads a stream or sends a signal. `run.ts` awaits `exited` in that branch, so the spawn error — `ENOENT` for a missing `cwd` — rejects the runner promise unchanged. It raises `GitError("unknown", `git ${args[0]} did not start`, "")` only if `exited` resolves instead.

`signalGroup(signal)` calls `assertSignallable(pid)` and then `process.kill(-pid, signal)`. It never falls back to `process.kill(pid, signal)`. Signalling group `0` is the daemon's own group and signalling group `1` is every process on the machine, which is why the guard is a throw rather than a return.

Four properties are load-bearing, and each is measured rather than assumed.

- **`spawn` is required; `execFile` cannot serve.** `child_process.execFile` does not forward `detached` to `spawn`. A child started with `execFile({ detached: true })` keeps the parent's process group, so `process.kill(-pid, …)` either raises `ESRCH` or signals **the daemon's own group**. Measured on this repository's platform: `execFile` yields `pgid = <the node process group>`, `spawn` yields `pgid = pid`.
- **`detached: true` is what makes the group signallable.** With it, `pgid === pid`, so `-pid` names exactly this child and its descendants.
- **`set -C` alone is not enough.** A redirection failure in a non-interactive `/bin/sh` does not stop the script: the shell prints `cannot overwrite existing file` and still reaches `exec`. `|| exit 111` is what stops it. Without that operator, `git` runs with no pid file, which is the one state recovery reads as "git never started".
- **`exec` keeps the process id.** The launcher writes `$$` and then replaces itself, so the recorded id names the `git` process, and the write completes before `git` begins.

State the pid-file guarantee precisely, because the reap depends on the exact wording. An absent pid file means **the launcher did not record a process id**, and therefore `git` never ran under this row. A present pid file means a process id was recorded before `exec` was reached; it does not by itself prove `exec` succeeded, because the launcher can be killed in the window between the write and the `exec`. That case is not a hole: the recorded process is then dead, and `docs/proposal/phase-3/recovery.md:40` decides liveness from the process being alive **and** its start time preceding the file's creation time, which the dead launcher fails on the first half.

`spawnSupervised` never creates, truncates or removes the pid file. The launcher creates it; the caller removes it. `docs/proposal/database/git_operation.md:37-43` gives the reason — for a journaled operation the path is committed to the row before the spawn, and the file's creation time is the liveness discriminator of the reap.

## Constraints

- `node:child_process` is imported by this file and by no other file under `src/`. Story 01 adds the lint rule that enforces it.
- Never pass `shell: true`. The only shell is `LAUNCHER_SHELL` with `-c` and a fixed script.
- The pid-file path reaches the launcher through the `KANTHORD_PID_FILE` environment entry, never through `launcherArgv` and never interpolated into `LAUNCHER_SCRIPT`. A path is caller data, and a path inside the script text would be shell-parsed.
- `LAUNCHER_SCRIPT` is one string literal and is never built by concatenation.
- Do not add a `timeout` option, a `killSignal` option or an `AbortSignal` to the `spawn` call. Cancellation is Story 01's timer and `signalGroup`, because a `spawn` timeout signals the process rather than the group.
- `signalGroup` does not swallow an error. `ESRCH` means the group is already gone, and the caller decides what that means; Story 01's runner swallows exactly that code and rethrows every other.
- `stdio[0]` is `"ignore"`. `git` under `GIT_TERMINAL_PROMPT=0` never reads standard input, and an inherited descriptor would let a child block on the daemon's console.

## Verify

`node --test src/services/git/launcher.test.ts` — new file, suite `"src/services/git/launcher.test"`.

Every case below builds its own `mkdtemp` directory and removes it in `after`. `resolveTools()` from `test/helpers/remote/tools.ts` (EPIC 005 Story 01) supplies every binary path: `tools.paths.git`, `tools.paths.ssh` and `tools.paths.sshKeyscan` are the three `GitPaths` needs, already resolved and version-probed.

`launcherArgv` unit case, asserted as an exact array:

```ts
assert.deepEqual(
  launcherArgv({ command: tools.paths.git, args: ["--version"] }),
  [
    "-c",
    'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; exec "$@"',
    "sh",
    tools.paths.git,
    "--version",
  ],
);
```

A second case asserts `launcherArgv({ command: tools.paths.git, args: [] })` has length 4.

**A long-running child, with no network.** Three cases share one helper that spawns `git ls-remote ssh://kanthord.invalid/r.git` with a `GIT_SSH_COMMAND` naming a generated script that writes its own process id into `<dir>/ssh.pid` and then sleeps for 30 seconds. `git` therefore stays alive, contacts nothing, and owns one descendant. The helper waits until `<dir>/ssh.pid` exists, polling every 25 ms up to 5000 ms, and fails the test on the timeout rather than sleeping a fixed interval.

- **The pid file names `git`, not the launcher.** Read `<dir>/git.pid` while the operation runs and assert its content, parsed as a number, equals `child.pid`. Then run `execFileSync("/bin/ps", ["-o", "comm=", "-p", String(recorded)])`, take `path.basename` of the trimmed output, and assert it equals `"git"`. It is not `"sh"`, and that is the whole point of the launcher. `ps` reports a full path on Darwin and a 15-character name on Linux, so the assertion is on the basename.
- **The child leads its own group.** `execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(child.pid)])` trimmed and parsed equals `child.pid`. This is the assertion that fails if anyone replaces `spawn` with `execFile`.
- **The group signal reaches the descendant.** Record the ssh process id from `<dir>/ssh.pid`. Assert `process.kill(sshPid, 0)` does not throw. Call `signalGroup("SIGTERM")`, await `exited`, and assert the resolved value is `{ code: null, signal: "SIGTERM" }`. Then assert `process.kill(sshPid, 0)` throws with `code === "ESRCH"`.
- **The control that proves the group is load-bearing.** Repeat the spawn, call `process.kill(child.pid, "SIGTERM")` — the process, not the group — await `exited`, and assert `process.kill(sshPid, 0)` still does **not** throw. Kill it with `signalGroup`-equivalent cleanup afterwards so the test leaves nothing running. A reviewer who narrows cancellation from the group to the process turns the previous case red and this case's contrast is why.

**The pid-file guard.**

- Pre-create `<dir>/git.pid` with `fs.writeFileSync`, spawn, await `exited`, and assert `{ code: 111, signal: null }`. Assert `<dir>/ssh.pid` does not exist — `git` never ran — and assert the pre-created content is unchanged.
- Spawn with `pidFile` under a directory that does not exist. Assert `{ code: 111, signal: null }` and that `<dir>/ssh.pid` does not exist.
- A clean spawn of `git --version` leaves the pid file **in place** after `exited` resolves. `spawnSupervised` removes nothing.

**The signal guard, as a unit.** `assertSignallable` throws with message `"a supervised pid must be greater than 1"` for each of `undefined`, `0`, `1`, `-1` and `1.5`, and returns for `2` and for `99999`. No signal is sent in this case.

`npm run verify` exits 0.

Proof: contributes `src/services/git/launcher.test.ts` to `node --test src/services/git/**/*.test.ts`. Delivers the epic coverage line "The pid file names the `git` process and not the launcher, proved by reading the process name of the recorded id while the operation runs."
