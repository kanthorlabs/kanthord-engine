# Story 2 — The launcher, the process contract and the pure pid check

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Depends on: EPIC 050.6 Story 1 (`00-groundwork`) — its `eslint.config.js` edit is what makes the
moved launcher legal and the git launcher illegal. This story is the one that closes that window.
Kind: story-foundation

This story creates the capability directory, moves the launcher into it whole, extracts the three pid
predicates into `src/domain/`, and repairs every importer's specifier. It changes no behaviour: every
symbol keeps its name, its signature and its body. The supervision machine is EPIC 050.6 Story 3
(`02-the-one-supervised-run-machine`), and no caller moves onto it before EPIC 050.6 Story 4
(`03-the-git-runner-takes-the-runner`).

## Change

### 1 — `src/domain/pid.ts`, the three pure predicates

**Create `src/domain/pid.ts` holding all three predicates, and export exactly two of them.**
The bodies move verbatim from `src/services/git/launcher.ts:50` — `assertSignallable`,
`src/services/git/launcher.ts:56` — `isSignallable` and `src/services/git/launcher.ts:60` —
`requireSignallable`:

```ts
export function assertSignallable(pid: number | undefined): void {
  if (!isSignallable(pid)) {
    throw new Error("a supervised pid must be greater than 1");
  }
}

export function requireSignallable(pid: number | undefined): number {
  if (!isSignallable(pid)) {
    throw new Error("a supervised pid must be greater than 1");
  }
  return pid;
}

function isSignallable(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}
```

**`assertSignallable` and `requireSignallable` are exported; `isSignallable` is not.**
`src/services/git/child.ts:119` — `assertSignallable` and `src/services/git/child.ts:234` —
`assertSignallable` call the first; `src/services/git/launcher.ts:117` — `requireSignallable` and
`src/services/git/launcher.ts:125` — `requireSignallable` call the second. Nothing outside
`launcher.ts` names `isSignallable` today, so it stays private and gate row 2 proves it only through
the two exported callers.

**The throw message is duplicated in the source, and it stays duplicated.** Both bodies carry the
exact string `"a supervised pid must be greater than 1"`, and `src/services/git/child.test.ts:362`
asserts that text. Folding the two throws into one helper is a refactor this epic does not take.

**The file imports nothing.** `eslint.config.js:320` — `node:*` bans every node builtin under
`src/domain/**`, and the purity loop at `src/domain/layout.test.ts:57` — `Date.now` reads every
non-test file of the directory. Three integer checks need neither, so both hold with no exemption.

### 2 — `src/domain/pid.test.ts`, the unit proof

**Create `src/domain/pid.test.ts` with the suite name `src/domain/pid.test`.** It takes over the case
at `src/services/git/launcher.test.ts:396` — `assertSignallable refuses a pid that cannot name a
group`, and it names `isSignallable` nowhere.

### 3 — `src/services/process/index.ts`, the contract

**Create `src/services/process/index.ts`. It is the interface file of the new capability: no
implementation, no re-export of one, no `implements`, and no `import` at all.** `Buffer`,
`AbortSignal` and `NodeJS.Signals` are ambient, so the file needs no `node:` specifier and gate row 3
holds.

It holds exactly these declarations:

```ts
export type ScheduledTimer = Readonly<{ cancel(): void }>;

export type Schedule = (
  callback: () => void,
  delayMs: number,
) => ScheduledTimer;

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
export const TERMINATION_GRACE_MS = 2_000;

export type ProcessOutcome =
  | "exited"
  | "timed-out"
  | "cancelled"
  | "output-exceeded"
  | "not-started"
  | "pid-file-failed"
  | "orphaned";

export type ProcessRunRequest = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  pidFile: string;
  timeoutMs: number;
  outputLimitBytes: number;
  signal: AbortSignal | null;
  onStdout: ((chunk: Buffer) => void) | null;
  onStderr: ((chunk: Buffer) => void) | null;
}>;

export type ProcessRunResult = Readonly<{
  outcome: ProcessOutcome;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}>;

export type SupervisedRunner = (
  request: ProcessRunRequest,
) => Promise<ProcessRunResult>;
```

**Every field is required, and `null` is the way a caller declines one.** A caller that streams
nothing passes `onStdout: null`; a caller that cannot be cancelled passes `signal: null`. An optional
field would let two callers disagree about a default, and `.agents/plan/epics/107-verify-service.md:58`
and `.agents/plan/epics/106-agents-on-pi-coding-agent.md:33` both pass every field explicitly.

**The result carries no `args`.** `.agents/plan/epics/106-agents-on-pi-coding-agent.md:33` and
`.agents/plan/epics/107-verify-service.md:29` read `outcome`, `code`, `stdout` and `stderr` and name
no argument vector, and gate row 15 is about `GitRunResult.args`, which
`src/services/git/run.ts:182` — `args` already builds from `request.args`. A caller that wants its own
argv back already holds it, so echoing it here would be flexibility nobody asked for.

**`ProcessRunResult.signal` exists because the shipped runner reads it.**
`src/services/git/run.ts:174` — `terminated by signal` builds its message from the close signal, and
that message survives into EPIC 050.6 Story 4 (`03-the-git-runner-takes-the-runner`). A result that
dropped the field would make an `exited` outcome with `code` null unreportable.

**The three constants move here whole**, from `src/services/git/run.ts:14` — `DEFAULT_TIMEOUT_MS`,
`src/services/git/run.ts:15` — `DEFAULT_OUTPUT_LIMIT_BYTES` and `src/services/git/run.ts:16` —
`TERMINATION_GRACE_MS`. Their values do not change.
`.agents/plan/epics/107-verify-service.md:29` reads `DEFAULT_TIMEOUT_MS` from this file.

**`systemSchedule` does not come here.** It calls `setTimeout`, so it belongs to the implementation
file that EPIC 050.6 Story 3 (`02-the-one-supervised-run-machine`) writes. This file keeps the
`Schedule` and `ScheduledTimer` types only.

### 4 — `src/services/process/launcher.ts`, moved whole

**Move `src/services/git/launcher.ts` to `src/services/process/launcher.ts` and delete the original.**
Every export keeps its name and its body: `LAUNCHER_SHELL`, `READY_FD`, `LAUNCHER_SCRIPT`,
`LAUNCHER_PID_FILE_FAILURE`, `LAUNCHER_ORPHANED_FAILURE`, `SupervisedSpawnInput`, `SupervisedExit`,
`SupervisedChild`, `SupervisedSpawnFailure`, `SupervisedSpawn`, `launcherArgv`, `spawnSupervised`.

Two edits, and no third:

- **Delete the three predicate definitions** at `src/services/git/launcher.ts:50` —
  `assertSignallable`, `:56` — `isSignallable` and `:60` — `requireSignallable`.
- **Add `import { requireSignallable } from "../../domain/pid.ts";`** as the first repository import,
  below the three `node:` imports at `src/services/git/launcher.ts:1` — `node:child_process`. A
  service implementation may import `domain/`, per `eslint.config.js:208` — `domain`.

`assertSignallable` is no longer imported here, because this file never called it.

### 5 — `src/services/process/launcher.test.ts`, moved whole

**Move `src/services/git/launcher.test.ts` to `src/services/process/launcher.test.ts` and delete the
original.** Three edits:

- The suite name at `src/services/git/launcher.test.ts:160` — `describe` becomes
  `"src/services/process/launcher.test"`.
- The import list at `src/services/git/launcher.test.ts:21` — `assertSignallable` drops
  `assertSignallable`; the other four members stay.
- The case at `src/services/git/launcher.test.ts:396` — `assertSignallable refuses a pid that cannot
name a group` is deleted here, because case 1 below re-lands it in `src/domain/pid.test.ts`.

**Every relative import keeps its depth.** `src/services/git/launcher.test.ts:16` — `resolveTools`
and `:18` — `pinnedGitEnvironment` reach `../../../test/helpers/remote/`, and
`src/services/process/` sits at the same depth. **The generated child module at
`src/services/git/launcher.test.ts:365` — `launcherModule` resolves `new URL("./launcher.ts",
import.meta.url)`, so it follows the file with no edit.**

### 6 — The five specifier repairs under `src/services/git/`

**Nothing in this story changes how a git module spawns. Each one repairs its import path and nothing
else.**

| file                                   | today                                                                                                    | after                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/services/git/run.ts:7-11`         | `import { spawnSupervised, LAUNCHER_ORPHANED_FAILURE, LAUNCHER_PID_FILE_FAILURE } from "./launcher.ts";` | the same three names from `"../process/launcher.ts"`                                                    |
| `src/services/git/probe.ts:12`         | `import { spawnSupervised } from "./launcher.ts";`                                                       | the same name from `"../process/launcher.ts"`                                                           |
| `src/services/git/host-key.ts:12`      | `import { spawnSupervised } from "./launcher.ts";`                                                       | the same name from `"../process/launcher.ts"`                                                           |
| `src/services/git/child.ts:17`         | `import { assertSignallable, spawnSupervised } from "./launcher.ts";`                                    | `spawnSupervised` from `"../process/launcher.ts"`, and `assertSignallable` from `"../../domain/pid.ts"` |
| `src/services/git/child.test.ts:23-24` | `spawnSupervised` and `type SupervisedChild` from `"./launcher.ts"`                                      | both from `"../process/launcher.ts"`                                                                    |

`src/services/git/child.ts` is the one file that gains a second import, because it is the only
consumer of `assertSignallable` outside the launcher. Gate row 16 uses exactly that import as its
control.

### 7 — The three constants stop living in `src/services/git/run.ts`

**Delete `src/services/git/run.ts:14`, `:15` and `:16`, and import the three names from
`../process/index.ts` instead.** The two `??` defaults at `src/services/git/run.ts:54` —
`DEFAULT_TIMEOUT_MS` and `:56` — `DEFAULT_OUTPUT_LIMIT_BYTES` and the grace at `:103` —
`TERMINATION_GRACE_MS` keep reading the same values.

Two importers move with them:

- `src/services/git/host-key.ts:14` — `TERMINATION_GRACE_MS` reads it from `"../process/index.ts"`.
- `src/services/git/run.test.ts:26` — `TERMINATION_GRACE_MS` reads it from `"../process/index.ts"`.

**`ScheduledTimer`, `Schedule` and `systemSchedule` stay in `src/services/git/run.ts` for now.**
`systemSchedule` calls `setTimeout` and has no home until EPIC 050.6 Story 3
(`02-the-one-supervised-run-machine`) writes `src/services/process/supervisor.ts`, and
`src/main.ts:29` — `systemSchedule as gitSchedule` still reads it from `run.ts`. EPIC 050.6 Story 4
(`03-the-git-runner-takes-the-runner`) deletes all three from `run.ts`.

### 8 — `docs/proposal/phase-1/runtime-capability-matrix.md`, one path

**Replace `src/services/git/launcher.ts` with `src/services/process/launcher.ts` in the sentence at
`docs/proposal/phase-1/runtime-capability-matrix.md:59` — `A subprocess boundary makes git impossible on a Worker`.**
The sentence states that the named file imports `node:child_process` and that every git operation runs
the binary through it. Both halves stay true of the moved file, and the path is the only stale token.

**`docs/proposal/` is the source of truth for behaviour**, per `AGENTS.md`, so a shipped tree whose
launcher lives elsewhere than the document says is a contradiction this epic creates and must repair.
The path is in the software-engineer lane, so no `Paths:` grant is needed. Change no other sentence of
the document: the capability inventory, the portability verdict and the counts are EPIC 036's, and the
capability that owns the subprocess is still one capability.

### 9 — `src/domain/layout.test.ts`, three edits

**Add `"process"` to the service inventory, between `"plan"` and `"storage"`, and take the case name
back to twenty-one.** The literal is at `src/domain/layout.test.ts:108` — `deepEqual` and the case
name is at `src/domain/layout.test.ts:101` — `twenty-one`. EPIC 050.5 Story 7
(`06-the-lease-service-is-deleted`) removes `"lease"` from the same literal and takes the name to
twenty, so this story's edit lands on a twenty-one-entry literal and restores the case name to its
current text, `"src/services/ holds exactly the twenty-one capabilities plus home-lock"`, over a
twenty-two-entry array. The name counts capabilities and `home-lock` separately.

**Repoint the three launcher-path lint cases.** All three are string arguments to `lintCase` and none
is an import:

- `src/domain/layout.test.ts:253` — `filePath` becomes `"src/services/process/launcher.ts"`, and the
  case name at `:251` — `spawn in src/services/git/launcher.ts does not trigger no-restricted-imports`
  is renamed to name the new path.
- `src/domain/layout.test.ts:264` — `"src/services/git/launcher.ts"`, the second element of the
  `isomorphic-git` loop array at `:262-266`, becomes `"src/services/process/launcher.ts"`. The array
  keeps three entries.
- `src/domain/layout.test.ts:281` — `filePath` becomes `"src/services/process/launcher.test.ts"`, and
  the case name at `:279` — `spawn in src/services/git/launcher.test.ts does not trigger
no-restricted-imports` is renamed to name the new path.

**The contrast case at `src/domain/layout.test.ts:240` — `spawn in src/services/git/probe.ts triggers
no-restricted-imports` does not change.** `src/services/git/probe.ts` is still restricted, and it is
one half of gate row 5.

**Do not touch the case at `src/domain/layout.test.ts:151` — `worker-health`.** The new capability
holds no `not-implemented.ts`, because EPIC 050.6 Story 6
(`05-the-composition-root-and-the-harness`) constructs the real runner in `src/main.ts` and there is
no slot to stub.

## Constraints

- No behaviour changes in this story. Every moved body is byte-identical apart from the two deletions
  named in step 4, and every repaired importer changes only its specifier.
- `src/domain/pid.ts` imports nothing, holds no `Date.now(`, no `new Date(` and no `Math.random(`.
- `src/services/process/index.ts` holds no `import` line at all, no `implements`, no `class` and no
  function body.
- Do not add `src/services/process/not-implemented.ts`. There is no stub slot in this epic.
- Do not delete `src/services/git/run.ts`'s `systemSchedule`, `Schedule` or `ScheduledTimer`.
  EPIC 050.6 Story 4 (`03-the-git-runner-takes-the-runner`) owns that deletion, and `src/main.ts:29`
  still reads the first of the three.
- Do not touch `eslint.config.js`. EPIC 050.6 Story 1 (`00-groundwork`) already made this edit legal,
  and the path is outside both engineer lanes.

## Verify

```
node --test \
  src/domain/pid.test.ts \
  src/domain/layout.test.ts \
  src/services/process/launcher.test.ts \
  src/services/git/child.test.ts \
  src/services/git/run.test.ts
```

**The command above is the whole-story list, and it is runnable from the first turn.** `## Change` is
the implementation contract and is applied whole, so `src/services/process/launcher.test.ts` exists
and `src/services/git/launcher.ts` is gone before any case runs. A case whose oracle is a grep or a
build command names that command in its own text and needs no test file.

`src/domain/layout.test.ts` imports `lintCase` at `src/domain/layout.test.ts:7` — `lintCase`, which is
`test/helpers/lint.ts:7` — `lintCase`; it lints a code string as if it lived at a given path and
returns the sorted rule ids. Its shipped launcher cases are at `src/domain/layout.test.ts:251`,
`:262-277` and `:279`, and each is the template for the case below.

Add, each as a separate `it`:

1. `"assertSignallable and requireSignallable agree on which pid can name a group"` — in
   `src/domain/pid.test.ts`. `assert.doesNotThrow(() => assertSignallable(2))` and the same for
   `99999`; `assert.throws(() => assertSignallable(v), /a supervised pid must be greater than 1/)` for
   each of `0`, `1`, `-1`, `1.5` and `undefined`. `assert.equal(requireSignallable(2), 2)` and
   `assert.equal(requireSignallable(99999), 99999)`; `assert.throws(() => requireSignallable(v))` with
   the same message for the same five values. The file names `isSignallable` in no line.

2. `"the process interface imports no node builtin"` — in `src/domain/layout.test.ts`.
   `await lintCase({ filePath: "src/services/process/index.ts", code: 'import { spawn } from "node:child_process";' })`
   includes `"no-restricted-imports"`.

3. `"src/services/ holds exactly the twenty-one capabilities plus home-lock"` — the amended shipped
   case at `src/domain/layout.test.ts:101`. `readdirSync` over `../services/` deep-equals exactly
   `["agent", "blob", "clock", "config", "crypto", "document", "event", "execution", "git", "graph", "home-lock", "ids", "model-catalog", "plan", "process", "provider-auth", "readiness", "revision", "secret", "storage", "verify", "worker-health"]`
   — twenty-two names, `"process"` between `"plan"` and `"storage"`. In the same case,
   `existsSync("src/services/process/index.ts")` is `true` and
   `readFileSync` of that file does not include the string `"implements "`.

4. `"the moved launcher may create a process and the git modules may not"` — in
   `src/domain/layout.test.ts`, the amended cases at `:251` and `:279`.
   `lintCase({ filePath: "src/services/process/launcher.ts", code: 'import { spawn } from "node:child_process";' })`
   excludes `"no-restricted-imports"`, and the same for
   `"src/services/process/launcher.test.ts"`. `lintCase` with the same code at
   `"src/services/git/probe.ts"` and at `"src/services/git/run.ts"` each includes
   `"no-restricted-imports"`.

5. `"the moved launcher is still inside a no-restricted-imports block"` — in
   `src/domain/layout.test.ts`, the amended loop at `:262-266`.
   `lintCase({ filePath: "src/services/process/launcher.ts", code: 'import git from "isomorphic-git";' })`
   includes `"no-restricted-imports"`. The exemption block of `eslint.config.js:447` — `files`
   restricts `gitLibraries` and nothing else, so an exempted path that fell out of every block would
   fail this case.

6. `"the git launcher is gone and no file under src/services/git/ resolves it"` — in
   `src/domain/layout.test.ts`. `existsSync("src/services/git/launcher.ts")` is `false` and
   `existsSync("src/services/git/launcher.test.ts")` is `false`. Reading every `*.ts` file under
   `src/services/git/`, none holds the specifier `"./launcher.ts"`. The control: the same matcher over
   the same directory finds `"../process/launcher.ts"` in `src/services/git/child.test.ts`, so the
   assertion is proven to detect a nearby present specifier and is not vacuous.

7. `"the capability matrix names the moved launcher"` — a build-only check.
   `grep -c 'src/services/process/launcher.ts' docs/proposal/phase-1/runtime-capability-matrix.md`
   prints exactly `1`, and
   `grep -c 'src/services/git/launcher.ts' docs/proposal/phase-1/runtime-capability-matrix.md`
   prints exactly `0`. The control: the same two greps over `eslint.config.js` print `4` and `0`, so
   the matcher is proven to read a file that does hold the new path.

8. `"pnpm run lint exits 0"` — a build-only check. `pnpm run lint` exits `0`, closing the window
   EPIC 050.6 Story 1 (`00-groundwork`) opened.

9. `"the moved launcher suite still proves the handshake and the group signal"` —
   `node --test src/services/process/launcher.test.ts` exits `0` with nineteen passing cases: the
   twenty of `src/services/git/launcher.test.ts` less the `assertSignallable` case that moved to
   `src/domain/pid.test.ts` in case 1.

10. `"the git suites still pass over the moved launcher"` —
    `node --test src/services/git/child.test.ts src/services/git/run.test.ts` exits `0`, and
    `src/services/git/child.test.ts:362` still asserts the message
    `"a supervised pid must be greater than 1"` through `stopChild`, now sourced from
    `src/domain/pid.ts`.

`pnpm run verify` exits 0.

Proof: gate rows 2, 3, 4, 5, 6 and 7 delivered — `src/domain/pid.test.ts`,
`src/domain/layout.test.ts`, `src/services/process/launcher.test.ts` and
`src/services/git/child.test.ts` in `PASS EPIC-050.6`.
