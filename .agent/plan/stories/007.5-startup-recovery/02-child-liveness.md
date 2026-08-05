# Story 02 — Child liveness and stop

Epic: `.agent/plan/epics/007.5-startup-recovery.md`

This story delivers the two `Git` members the reap decides with. It holds the platform work the EPIC's second bullet names; Story 03 holds the decision matrix.

## Change

- **New file `src/services/git/child.ts`.** Exports:

  ```ts
  export const PS_CANDIDATES = ["/bin/ps", "/usr/bin/ps"] as const;
  export const SUPPORTED_PLATFORMS = ["darwin", "linux"] as const;

  export function resolvePs(platform: string): string;
  export function parseLstart(text: string): number | null;
  export function inspectChild(
    input: InspectChildInput,
  ): Promise<ChildInspection>;
  export function stopChild(input: StopChildInput): Promise<boolean>;
  ```

- **`resolvePs(platform)`.** Throws `RecoveryError("platform-unsupported", \`${platform} is not a supported platform for startup recovery\`)`when`platform`is not in`SUPPORTED_PLATFORMS`, and `RecoveryError("platform-unsupported", "no ps executable was found at /bin/ps or /usr/bin/ps")`when neither entry of`PS_CANDIDATES`passes`accessSync(candidate, X_OK)`. Otherwise it returns the first one that does, and it resolves no name through `PATH`.

  `RecoveryError` comes from `../../domain/recovery.ts`, which **this story creates** (below). A service implementation may import `domain/` (AGENTS.md's import matrix), and this error must be a `RecoveryError` rather than a `GitError` because `src/main.ts:217-229` catches `RecoveryError` and would let a `GitError` escape as an uncaught exception on an unsupported platform.

- **New file `src/domain/recovery.ts`.** Pure, `zod` only, no `node:` import. It holds the shared recovery vocabulary, because `src/commands/**` files may not relative-import one another and every later story needs these types.

  ```ts
  export const ZERO_OID = "0000000000000000000000000000000000000000";

  export type RecoveryFinding = Readonly<{
    step: "reap" | "sweep" | "reconcile" | "leases";
    code: string;
    repositoryId: string | null;
    detail: string;
  }>;

  export type RecoveryErrorCode =
    | "orphan-alive"
    | "liveness-unknown"
    | "ref-unreadable"
    | "platform-unsupported";

  export class RecoveryError extends Error {
    readonly code: RecoveryErrorCode;
    constructor(code: RecoveryErrorCode, message: string);
  }

  export function renderFinding(finding: RecoveryFinding): string;
  ```

  `renderFinding` returns `\`${finding.step}: ${finding.code}: ${finding.detail}\`` when `repositoryId` is `null`, and `\`${finding.step}: ${finding.code}: ${finding.repositoryId}: ${finding.detail}\``otherwise. It is the one renderer, so`main.ts` formats nothing itself. Story 03 adds the reap types to this file and Story 07 adds the step types.

- **`parseLstart(text)`.** Parses one `ps -o lstart=` line into epoch **seconds**. The regex is exact:

  ```
  /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
  ```

  applied to `text.trim()`. The month name maps through a module-level `MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]` index. The value is `Date.UTC(year, monthIndex, day, hour, minute, second) / 1000`. Any non-match returns `null`. Never call `new Date(string)` — that parse is implementation-defined.

- **`inspectChild`.** Signature and result, declared in `src/services/git/index.ts` (below):

  ```ts
  export type InspectChildInput = Readonly<{ pidFile: string }>;

  export type ChildInspection =
    | Readonly<{ finding: "no-pid-file" }>
    | Readonly<{ finding: "pid-file-unreadable"; detail: string }>
    | Readonly<{ finding: "process-absent"; pid: number }>
    | Readonly<{
        finding: "started-later";
        pid: number;
        startedAt: number;
        recordedAt: number;
      }>
    | Readonly<{ finding: "liveness-unknown"; pid: number; detail: string }>
    | Readonly<{ finding: "alive"; pid: number; pidFile: string }>;
  ```

  Order of steps, exactly:

  1. `lstatSync(input.pidFile)`. `ENOENT` returns `{ finding: "no-pid-file" }`. A path that is not a regular file, or is a symbolic link, returns `{ finding: "pid-file-unreadable", detail: "<path> is not a regular file" }`.
  2. `recordedAt = Math.floor(stat.mtimeMs / 1000)`. **`mtimeMs`, not `birthtimeMs`**: the launcher creates the file with `set -C` and one `printf` and never writes it again (`src/services/git/launcher.ts:6-7`), so its modification time is its creation time, and `mtimeMs` is portable where `birthtimeMs` is not.
  3. `readFileSync(input.pidFile, "utf8").trim()`. A value that is not an integer greater than 1 returns `{ finding: "pid-file-unreadable", detail: "<content> is not a signallable pid" }`. Reuse `assertSignallable` from `./launcher.ts` inside a `try` rather than restating the rule.
  4. `process.kill(pid, 0)`. `ESRCH` returns `{ finding: "process-absent", pid }`. `EPERM` returns `{ finding: "liveness-unknown", pid, detail: "the process is not signallable by this user" }` — the process exists and this daemon cannot inspect or signal it, which is neither absence nor a proven reuse.
  5. Read the start time: `spawnSupervised` from `./launcher.ts` with `command: resolvePs(process.platform)`, `args: ["-o", "lstart=", "-p", String(pid)]`, `env: { PATH: "", LC_ALL: "C", TZ: "UTC" }`, `cwd: dirname(input.pidFile)`, and `pidFile: join(dirname(input.pidFile), \`ps-${randomUUID()}.pid\`)`. Collect stdout, await `exited`, then `rmSync`that scratch pid file in a`finally`. `probe.ts:127-208`is the pattern to copy, including the`signalGroup("SIGKILL")` on a 10 000 ms timeout.
  6. A non-zero exit, empty stdout, or `parseLstart` returning `null` returns `{ finding: "liveness-unknown", pid, detail: <the reason> }`. Step 4 already proved the process exists, so its start time being unreadable is a failure to establish the fact, **not** absence. `docs/proposal/phase-3/recovery.md:49` requires a daemon that cannot establish the fact to refuse rather than guess, and Story 03 turns this finding into that refusal. A `ps` exit of `1` with empty stdout is the one case that means genuine absence — the process exited between step 4 and step 5 — and it is still reported as `liveness-unknown`, because a startup refusal an operator clears is cheaper than a sweep over a repository a live `git` still holds.
  7. `startedAt <= recordedAt` returns `{ finding: "alive", pid, pidFile: input.pidFile }`. `startedAt > recordedAt` returns `{ finding: "started-later", pid, startedAt, recordedAt }`.

  The comparison is at whole-second granularity because `ps -o lstart=` prints seconds. `recordedAt` is floored to the same unit so both sides are compared in one unit.

- **`stopChild`.**

  ```ts
  export type StopChildInput = Readonly<{
    pid: number;
    graceMs: number;
    pollMs?: number;
  }>;
  ```

  1. `assertSignallable(input.pid)`.
  2. `process.kill(-input.pid, "SIGTERM")`. `ESRCH` returns `true` at once. Any other error rethrows.
  3. Poll **the process group**, `process.kill(-input.pid, 0)`, every `input.pollMs ?? 50` ms, using `await new Promise((resolve) => setTimeout(resolve, delay))`. `ESRCH` returns `true`.
  4. After `input.graceMs` it sends `process.kill(-input.pid, "SIGKILL")`, polls the group once more for at most `input.graceMs`, and returns `true` on `ESRCH` or `false` when any group member is still there.

  It never returns `false` before both signals were sent.

  **The poll targets the group, not the leader.** `process.kill(-pid, 0)` answers `ESRCH` only when the group holds no member, so a leader that exits while an `ssh` descendant survives keeps the answer negative — which is the state the reap must not mistake for "gone". A leader-only poll would return `true` over a live `ssh` still holding a lock.

  **The poll timer is not `unref`'d.** Recovery runs before `listen` (`src/main.ts:206-209`), so an `unref`'d timer may be the only referenced handle and Node would exit mid-poll.

- **Edit `src/services/git/index.ts`.** Add `InspectChildInput`, `ChildInspection`, `StopChildInput` from above, and two members to `interface Git`, placed after `clone` (`:161` region):

  ```ts
  inspectChild(input: InspectChildInput): Promise<ChildInspection>;
  stopChild(input: StopChildInput): Promise<boolean>;
  ```

- **Edit `src/services/git/binary.ts`.** Add two delegations to the returned literal, matching the existing one-line style of `:27`:

  ```ts
  inspectChild: (input) => inspectChild(input),
  stopChild: (input) => stopChild(input),
  ```

  Neither takes `runner` or `paths` — they reach `spawnSupervised` directly, exactly as `probe.ts` does.

## Constraints

- `child.ts` must not import `node:child_process`. `eslint.config.js:174-198` allows it only in `src/services/git/launcher.ts`; `spawnSupervised` is the permitted route.
- `process.kill` is ambient and unrestricted; `src/services/git/launcher.ts:86` is the precedent.
- `stopChild` signals the **process group** (`-pid`) and never the bare pid. `launcher.test.ts:153-174` is the control case proving a bare-pid signal leaves an ssh descendant alive.
- `parseLstart` returns `null` rather than throwing. A throw here would turn an unreadable process table into a startup crash instead of a "leave it alone" finding.
- Add no configuration key. `src/services/config/convict.ts:160` validates with `allowed: "strict"`, and `ps` is resolved from two absolute paths rather than configured, because it is read-only, is not a git tool, and takes no part in the pinned git environment.

## Verify

- New file `src/services/git/child.test.ts`, suite `src/services/git/child.test`. It resolves tools with `resolveTools()` from `test/helpers/remote/tools.ts`, makes temp directories with `mkdtempSync(join(tmpdir(), "kanthord-child-"))` pushed onto a module-level array removed in one `after`, and copies the `spawnSleepingSsh` shape of `launcher.test.ts:52-76` for a long-lived child. Assertions:
  - `parseLstart("Tue Aug  5 10:23:41 2026")` equals `Date.UTC(2026, 7, 5, 10, 23, 41) / 1000` — an exact number. Also `"Wed Jan 15 00:00:00 2025"` with a two-digit day and one space.
  - `parseLstart` returns `null` for `""`, `"not a date"`, and `"Tue Aug 5 10:23:41"`.
  - `resolvePs("win32")` throws `RecoveryError` with `code === "platform-unsupported"` and a message containing `win32`; `resolvePs(process.platform)` returns a path that `accessSync(path, X_OK)` accepts.
  - `inspectChild` on a path that does not exist returns `{ finding: "no-pid-file" }` by `deepEqual`.
  - `inspectChild` on a directory returns `finding === "pid-file-unreadable"`.
  - `inspectChild` on a file containing `"1"` returns `finding === "pid-file-unreadable"`; on a file containing `"abc"` the same.
  - `inspectChild` on a file containing the pid of a process that has already exited returns `finding === "process-absent"` and that `pid`. Get the pid by spawning `/bin/sh -c "exit 0"` through `spawnSupervised`, awaiting `exited`, then writing the recorded pid into a fresh file.
  - **Alive child.** Spawn the sleeping ssh helper first, then `writeFileSync(pidFile, String(child.pid))`. `inspectChild` returns `finding === "alive"` and that `pid`. The start time necessarily precedes the write.
  - **Reused pid.** The state to reproduce is "a pid file that existed before the process holding that number started", and reaching it needs the file's recorded time restored after the pid is written, because writing the pid necessarily updates it. Steps, in order: `writeFileSync(pidFile, "2")`; `const recorded = statSync(pidFile)`; busy-wait past the next whole-second boundary with the `Atomics.wait` idiom of `launcher.test.ts:41-50`; spawn the sleeping ssh helper; `writeFileSync(pidFile, String(child.pid))`; `utimesSync(pidFile, recorded.atime, recorded.mtime)`. Assert the precondition before the act: the process's own start second, read in the test with `execFileSync(resolvePs(process.platform), ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" })` through `parseLstart`, is strictly greater than `Math.floor(recorded.mtimeMs / 1000)`. Then `inspectChild({ pidFile })` returns `finding === "started-later"` with `startedAt > recordedAt`, and `process.kill(child.pid, 0)` still succeeds — the child was never signalled. `utimesSync` reconstructs a real state rather than faking a comparison: a reused number is exactly a pid file older than its process.
  - **`liveness-unknown` on an unreadable start time.** Write a pid file holding the pid of the live sleeping helper into a directory then made read-only with `chmodSync(dir, 0o500)`. `inspectChild` reads the file (mode `0500` still grants `r-x`), `process.kill(pid, 0)` succeeds, and the scratch `ps-<uuid>.pid` cannot be created, so the launcher exits `111` (`launcher.ts:9`) with empty stdout. Assert `finding === "liveness-unknown"` and that `pid` equals the helper's. Restore `0o700` in the `after` so the teardown can remove the directory.
  - `stopChild` on the sleeping ssh helper returns `true`, and afterwards both `process.kill(child.pid, 0)` and `process.kill(-child.pid, 0)` throw `ESRCH`. Assert the ssh descendant recorded in the helper's own pid file is also gone, which is what proves the group was signalled.
  - `stopChild` on a pid that does not exist returns `true` without throwing.
  - `stopChild({ pid, graceMs: 50 })` against a child that ignores `SIGTERM` returns `true` after the `SIGKILL`. Build that child with a `sh` script installing `trap "" TERM` before a `sleep 30`. Assert the elapsed wall time exceeded `50` ms, so the test proves the `SIGKILL` path ran rather than the `SIGTERM` path.
  - **A leader that exits while a descendant survives does not return `true` early.** Build a `sh` script that starts `/bin/sleep 30` in its own background, installs `trap "" TERM`, and then `exec`s a short `sleep 0.1` so the leader exits while the group keeps a member. `stopChild({ pid, graceMs: 200 })` must not resolve before the `SIGKILL`; assert the descendant is gone afterwards. This is the case a leader-only poll passes wrongly.
  - `stopChild({ pid: 1 })` throws, by `assertSignallable`.
- New file `src/domain/recovery.test.ts`, suite `src/domain/recovery.test`:
  - `ZERO_OID.length === 40` and `objectId.parse(ZERO_OID)` succeeds — import `objectId` from `./column.ts`.
  - `renderFinding({ step: "reap", code: "pid-reused", repositoryId: null, detail: "x" })` equals `"reap: pid-reused: x"`, exact string.
  - The same with `repositoryId: "repo_01"` equals `"reap: pid-reused: repo_01: x"`.
  - `new RecoveryError("orphan-alive", "m").name === "RecoveryError"` and `.code === "orphan-alive"`.
  - `readFileSync(new URL("./recovery.ts", import.meta.url), "utf8")` contains no `"node:"`, no `Date.now(`, no `new Date(` and no `Math.random(`.
- Edit `src/services/git/binary.test.ts:79-100`: the suite name becomes `Object.keys of createBinaryGit bytewise sorted deep-equals the fourteen member names`, `assert.equal(keys.length, 12)` becomes `14`, and the array gains `"inspectChild"` after `"fetch"` and `"stopChild"` after `"seedHome"`.
- `node --test src/domain/recovery.test.ts src/services/git/child.test.ts src/services/git/binary.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: no `src/commands/startup/**` file, so no Proof line. See B2 in `index.md`.
