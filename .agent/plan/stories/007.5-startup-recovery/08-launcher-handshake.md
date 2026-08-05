# Story 08 — The launcher handshake

Epic: `.agent/plan/epics/007.5-startup-recovery.md`
Dispatch **first**, before Story 01. It is numbered 08 only because the other seven were written first.

This story edits EPIC 006 code that is built and green. It is the one change in this epic that does, and B1 in `index.md` is why.

## The defect it closes

`docs/proposal/phase-3/recovery.md:44` reads a missing pid file as "`git` never started", and `:38` claims "There is no window in which a git process exists unrecorded." The launcher makes the first half true — `src/services/git/launcher.ts:6-7` writes `$$` and only then `exec`s, so a running `git` always has a pid file. It does not make the observation **final**:

1. `spawnSupervised` returns; `/bin/sh` exists and has not reached its `printf` yet.
2. The daemon is `SIGKILL`ed. `detached: true` (`launcher.ts:66`) leaves the shell alive in its own process group.
3. A replacement daemon takes the home lock, reaps, finds no pid file, and reads that as "git never started".
4. The shell then writes its pid file and `exec`s `git`, which begins writing into a staging directory the sweep is removing.

A pre-committed journal row does not close this either: the row's token would name a file that does not exist yet, and `recovery.md:44` resolves that to "stale". The window is an ordinary scheduling window, not a narrow one, and no wording change closes it.

## Change

- **Edit `src/services/git/launcher.ts:6-9`.** The script gains one gate between the pid write and the `exec`, and one new exit code:

  ```ts
  export const LAUNCHER_SCRIPT =
    'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; ' +
    'read -r _ || exit 112; exec 0</dev/null; exec "$@"';

  export const LAUNCHER_PID_FILE_FAILURE = 111;
  export const LAUNCHER_ORPHANED_FAILURE = 112;
  ```

  The order is exact and load-bearing: **write, then wait, then exec.** The write is first so a process that reaches `exec` always has a pid file. The wait is second so a shell whose parent died before the handshake exits without ever touching the target. `exec 0</dev/null` is a redirection-only `exec` that runs before the command `exec`, so `git` inherits an empty stdin rather than the handshake pipe.

- **Edit `src/services/git/launcher.ts:66-67`.** `stdio` becomes `["pipe", "pipe", "pipe"]`. Immediately after `spawn` returns and only when `child.pid !== undefined`, write the go byte and close the stream:

  ```ts
  child.stdin.write("go\n");
  child.stdin.end();
  ```

  An `EPIPE` on that write is swallowed: the shell may already have exited on `111`. Attach `child.stdin.on("error", () => {})` before the write.

  The mechanism is the pipe's lifetime, not the byte. A daemon that dies before writing closes the write end, `read` sees end-of-file, and the shell exits `112`. No timer, no polling, no ambient state.

- **Edit `src/services/git/run.ts:121-151`.** In the failure-precedence chain, beside the existing `code === LAUNCHER_PID_FILE_FAILURE` branch, add `code === LAUNCHER_ORPHANED_FAILURE` throwing `new GitError("unknown", "the launcher was orphaned before it started git", "")`. Keep the existing precedence order otherwise.

- **Edit `src/services/git/probe.ts:127-208` and `src/services/git/host-key.ts:188-205`.** Both call `spawnSupervised` directly, so both now receive a child that waits for a go byte. No edit is needed in either: the write happens inside `spawnSupervised`. Assert that by test rather than by inspection.

## Constraints

- `git` must not inherit the handshake pipe on its stdin. `exec 0</dev/null` before the command `exec` is what guarantees it, and the test below proves it, because a `git` that read the pipe would hang.
- The pid write stays first. Reversing it to wait-then-write would let a shell pass the handshake and be killed before writing, which reintroduces a `git` with no pid file — the one state the whole reap depends on being impossible.
- Do not change `launcherArgv`, `assertSignallable`, `signalGroup`, `detached: true`, or the `exited` promise contract. Every existing assertion in `src/services/git/launcher.test.ts` that does not concern `stdio` or the script string must stay green untouched.
- `LAUNCHER_SCRIPT` is asserted as an exact string somewhere in the suite; find it and update it once. It is not duplicated in production code.

## Verify

- Edit `src/services/git/launcher.test.ts`:
  - The `LAUNCHER_SCRIPT` exact-string assertion becomes the new script. `launcherArgv`'s pinned array at `:93-104` changes only in the script element; its length stays `4` at `:106-111`.
  - Every existing case stays green with no other edit: the pid-file content and `ps -o comm=` case (`:113-121`), the `pgid` case (`:123-129`), the group-`SIGTERM` case (`:131-151`), the bare-pid control case (`:153-174`), the pre-existing-pid-file `111` case (`:176-194`), the missing-directory `111` case (`:196-211`), the file-left-in-place case (`:213-225`), `assertSignallable` (`:227-237`), and the missing-`cwd` case (`:239-262`).
  - **New: a clean `git --version` still completes.** The go byte reaches the shell, so `exited` resolves `{ code: 0, signal: null }` and stdout holds a version line. Without the write this case hangs, which is the assertion that the parent writes.
  - **New: `git` does not inherit the handshake pipe.** Run `git hash-object --stdin` through `spawnSupervised` and assert `exited` resolves rather than hanging, with an empty-input hash on stdout — `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, the exact sha1 of the empty blob. A `git` holding the pipe on stdin would block forever, and this is the only case that distinguishes the two.
  - **New: an orphaned launcher exits `112` and never runs the command.** The pipe alone builds the case, and no new production seam is added: `spawnSupervised` writes the go byte and ends the stream, so the test instead spawns a command whose target is a `sh` script that would `touch <marker>`, and drives the orphan state by calling `spawnSupervised` through a variant of the real call that the test constructs itself — one `spawn` of `LAUNCHER_SHELL` with `launcherArgv`, the same env and `stdio: ["pipe","pipe","pipe"]`, whose stdin is destroyed instead of written. Both exported constants and `launcherArgv` are reused, so the test exercises the real script. `exited` resolves `{ code: 112, signal: null }`, the marker does not exist, and the pid file **does** — the write precedes the gate.
  - **New: the pid write precedes the gate.** In the same case, `readFileSync(pidFile, "utf8")` equals `String(child.pid)` even though the command never ran.
- Edit `src/services/git/run.test.ts`: add one case asserting an exit of `LAUNCHER_ORPHANED_FAILURE` surfaces as `GitError` with `failure === "unknown"` and the message `the launcher was orphaned before it started git`. Reach it the way the file already reaches the `111` mapping — find that case and copy its arrangement, substituting `112`.
- `node --test src/services/git/launcher.test.ts src/services/git/run.test.ts src/services/git/probe.test.ts src/services/git/host-key.test.ts src/services/git/seed.test.ts src/services/git/clone.test.ts src/services/git/fetch.test.ts src/services/git/ref-update.test.ts src/services/git/authenticated.test.ts src/services/git/binary.test.ts` exits 0 — every consumer of `spawnSupervised`.
- `node --test src/commands/repository/register-repository.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: no `src/commands/startup/**` file. This story is a prerequisite of the EPIC Proof rather than a part of it, and the EPIC's `Proof:` block gains `src/services/git/launcher.test.ts`.
