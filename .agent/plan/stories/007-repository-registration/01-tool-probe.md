# Story 01 — Tool probe

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: EPIC 006 Story 01 (`GitPaths`), EPIC 006 Story 04 (`spawnSupervised`).

Three binaries become configuration, resolve to absolute paths, and report a version. Startup refuses when one is absent or when `git` is below the floor. The story ends with one `GitPaths` record the rest of the epic injects.

## Change

### 1. `src/services/config/index.ts` — the tool settings

Insert after `HttpSettings` (`:1-6`):

```ts
export type ToolSettings = Readonly<{
  git: string;
  ssh: string;
  sshKeyscan: string;
}>;
```

Add `tools` to `Settings` (`:8-14`), **between `http` and `attemptLimit`**:

```ts
export type Settings = Readonly<{
  home: string;
  actor: string;
  masterKey: Buffer;
  http: HttpSettings;
  tools: ToolSettings;
  attemptLimit: number;
}>;
```

### 2. `src/services/config/convict.ts` — three keys and one format

Add the format function beside `positiveInteger` (`:28-32`):

```ts
function absolutePath(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("must be a non-empty string");
  }
  if (!path.isAbsolute(value)) {
    throw new Error("must be an absolute path");
  }
}
```

Register it in the `convict.addFormats` call (`:143-147`) as `absolutePath`.

Add to `buildSchema()` (`:34-64`), **between `http` (`:44-57`) and `attemptLimit` (`:58-62`)**:

```ts
    tools: {
      git: {
        format: "absolutePath",
        default: "/usr/bin/git",
        env: "KANTHORD_TOOLS_GIT",
      },
      ssh: {
        format: "absolutePath",
        default: "/usr/bin/ssh",
        env: "KANTHORD_TOOLS_SSH",
      },
      sshKeyscan: {
        format: "absolutePath",
        default: "/usr/bin/ssh-keyscan",
        env: "KANTHORD_TOOLS_SSH_KEYSCAN",
      },
    },
```

Each key has a default, so a configuration file that names none still validates. `allowed: "strict"` (`:160`) is what makes the keys mandatory before any other story can read a path.

Add `tools` to the returned literal (`:212-229`), in the same position:

```ts
      tools: {
        git: config.get("tools.git"),
        ssh: config.get("tools.ssh"),
        sshKeyscan: config.get("tools.sshKeyscan"),
      },
```

### 3. `src/services/git/probe.ts` (new)

```ts
import { accessSync, constants } from "node:fs";

import type { GitPaths } from "./index.ts";
import { spawnSupervised } from "./launcher.ts";

export const MINIMUM_GIT_VERSION = "2.34.0";
export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeToolName = "git" | "ssh" | "sshKeyscan";

export type ProbeErrorCode =
  "tool-missing" | "tool-unreadable" | "tool-too-old";

export class ToolProbeError extends Error {
  readonly code: ProbeErrorCode;
  readonly tool: ProbeToolName;
  constructor(code: ProbeErrorCode, tool: ProbeToolName, message: string);
}

export type ProbedTools = Readonly<{
  git: string;
  ssh: string;
  sshKeyscan: string;
  gitVersion: string;
  sshVersion: string;
}>;

export type ProbeInput = Readonly<{
  tools: Readonly<{ git: string; ssh: string; sshKeyscan: string }>;
  runDirectory: string;
  timeoutMs?: number;
}>;

export function parseGitVersion(text: string): string | null;
export function parseSshVersion(text: string): string | null;
export function compareVersions(left: string, right: string): number;
export function probeTools(input: ProbeInput): Promise<ProbedTools>;

export type BuildGitPathsInput = Readonly<{
  probed: ProbedTools;
  home: string;
}>;

export function buildGitPaths(input: BuildGitPathsInput): GitPaths;
```

`probeTools` runs three steps in the fixed order `git`, `ssh`, `sshKeyscan`. The order is asserted, so a report always names the first missing tool rather than an arbitrary one.

1. For each of the three, `accessSync(path, constants.X_OK)`. `ENOENT` throws `ToolProbeError("tool-missing", <tool>, `${path} does not exist`)`; any other failure throws `ToolProbeError("tool-unreadable", <tool>, `${path} is not executable`)`.
2. `git --version`, then `ssh -V`. Each runs through `spawnSupervised` with `command` the absolute path, `env` exactly `{ PATH: "", LC_ALL: "C" }`, `cwd` `input.runDirectory`, and `pidFile` `join(input.runDirectory, `probe-${randomUUID()}.pid`)`. The pid file is removed with `rmSync({ force: true })` in a `finally`, because this caller mints it. A run exceeding `input.timeoutMs ?? PROBE_TIMEOUT_MS` calls `signalGroup("SIGKILL")` and throws `ToolProbeError("tool-unreadable", <tool>, `${path} did not answer a version within ${PROBE_TIMEOUT_MS}ms`)`.
3. `ssh-keyscan` gets step 1 only. It has no portable version flag.

`parseGitVersion` matches `/^git version (\d+)\.(\d+)\.(\d+)/` against stdout and returns the triple, dropping any vendor suffix. Measured: `git version 2.50.1 (Apple Git-155)` yields `2.50.1`.

`parseSshVersion` matches `/^OpenSSH_([^,\s]+)/` against **stderr**. `ssh -V` writes to standard error, not standard output. Measured: `OpenSSH_10.2p1, LibreSSL 3.3.6` yields `10.2p1`.

An unparseable version throws `ToolProbeError("tool-unreadable", <tool>, `${path} reported no recognisable version`)`.

`compareVersions` compares the three numeric components left to right and returns a negative, zero or positive number. It is used on `gitVersion` alone; `sshVersion` is recorded and never compared, because `10.2p1` is not a triple and the proposal names no ssh floor.

`compareVersions(gitVersion, MINIMUM_GIT_VERSION) < 0` throws:

```
ToolProbeError("tool-too-old", "git",
  `${path} is git ${found}; kanthord needs ${MINIMUM_GIT_VERSION} or newer`)
```

The message names both the found and the wanted version, which is the epic coverage line.

`input.timeoutMs` is a declared member rather than a hidden seam, because the hanging-tool case below cannot be reached without it. No production caller sets it; `src/main.ts` passes the two required members only.

`buildGitPaths` returns the seven-member `GitPaths` of EPIC 006 Story 01, naming three members from `probed` and deriving four from `input.home`:

```ts
{
  git: probed.git,
  ssh: probed.ssh,
  sshKeyscan: probed.sshKeyscan,
  home: join(input.home, "git", "home"),
  keyDirectory: join(input.home, "git", "keys"),
  knownHosts: join(input.home, "git", "known_hosts"),
  runDirectory: join(input.home, "git", "run"),
}
```

It creates `home`, `keyDirectory` and `runDirectory` with `mkdirSync({ recursive: true, mode: 0o700 })`, and creates `knownHosts` empty with mode `0o600` when it is absent. It never truncates an existing `known_hosts`, because Story 08 writes pinned keys into it and a truncate on every start would unpin every host.

Never spread `probed` into `GitPaths`. The record has seven named members, and a spread would carry `gitVersion` and `sshVersion` into a record the child `PATH` is derived from.

### 4. `src/main.ts` — the probe runs after the home lock

In the `serve` action, insert between `held.publishIdentity(...)` (ends `:53`) and `process.stdout.write("kanthord: ready\n")` (`:54`):

```ts
const probed = await probeTools({
  tools: settings.tools,
  runDirectory: join(settings.home, "git", "run"),
});
const gitPaths = buildGitPaths({ probed, home: settings.home });
```

`gitPaths` is unused by this story and is consumed by Story 10's wiring. Declare it and pass it nowhere yet; the later story adds the call site.

Extend both `catch` blocks (`:57` and `:123-127`) so `ToolProbeError` joins `ConfigError`, `HomeLockError` and `StorageError`. The written line is the existing shape, `kanthord: ${error.code}: ${error.message}\n`, and `process.exitCode = 1`.

The probe runs **after** the home lock, so two daemons never probe one home concurrently, and **before** the ready line, so no route can be reached with an unresolved tool.

## Constraints

- `src/services/config/**` gains no `node:child_process` import and no process spawn. The probe lives under `src/services/git/`, and it reaches a process only through `launcher.ts`. EPIC 006 Story 01's lint rule permits `node:child_process` in `launcher.ts` alone, and `probe.ts` imports the launcher rather than the module.
- `probe.ts` holds no `127.` and no `"localhost"` literal. EPIC 004 Story 07's single-classifier assertion fails on any other `src/` file carrying either.
- The four derived directories are never read from configuration. `docs/proposal/phase-1/git-foundation.md:62` requires a daemon-owned `HOME`, and deriving it from `settings.home` is what keeps one operator setting from splitting the daemon's own tree.
- `parseSshVersion` reads stderr only. Reading stdout returns the empty string and would classify every present `ssh` as unreadable.

## Verify

`node --test src/services/config/convict.test.ts src/services/git/probe.test.ts src/services/home-lock/startup.test.ts`

### `src/services/config/convict.test.ts` — edits to the existing file

- `validFile()` (`:20-37`) is unchanged. The three `tools.*` keys have defaults, so an existing fixture still validates, and that is asserted directly: `config.load(...)` on the unchanged `validFile()` yields `settings.tools` deep-equal to `{ git: "/usr/bin/git", ssh: "/usr/bin/ssh", sshKeyscan: "/usr/bin/ssh-keyscan" }`.
- `:107-113` becomes `["home", "actor", "masterKey", "http", "tools", "attemptLimit"]`.
- New: a config file carrying `tools: { git: "git" }` throws `config-invalid`, and the message includes `must be an absolute path`.
- New: a config file carrying `tools: { git: "" }` throws `config-invalid` with `must be a non-empty string`.
- New: a config file carrying `tools: { unknownTool: "/bin/x" }` throws `config-invalid` — the `allowed: "strict"` path (`:160`) covers a nested unknown key.
- New: `env: { KANTHORD_TOOLS_GIT: "/opt/git/bin/git" }` yields `settings.tools.git === "/opt/git/bin/git"`, and the two other members keep their defaults.
- New: a relative path in `KANTHORD_TOOLS_SSH` throws `config-invalid`. An environment override is validated by the same format, not bypassed.

### `src/services/git/probe.test.ts` (new)

Every case builds its own `mkdtempSync` directory and removes it. Fake tools are executable `/bin/sh` scripts the test writes, which is how a version string is pinned without depending on the host toolchain.

- `parseGitVersion("git version 2.50.1 (Apple Git-155)\n")` equals `"2.50.1"`. `parseGitVersion("git version 2.34.0\n")` equals `"2.34.0"`. `parseGitVersion("garbage\n")` is `null`.
- `parseSshVersion("OpenSSH_10.2p1, LibreSSL 3.3.6\n")` equals `"10.2p1"`. `parseSshVersion("OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13\n")` equals `"9.6p1"`. `parseSshVersion("")` is `null`.
- `compareVersions` table, asserted exactly: `("2.34.0","2.34.0")` is `0`; `("2.33.9","2.34.0")` is negative; `("2.50.1","2.34.0")` is positive; `("2.4.0","2.34.0")` is negative — the last row is the assertion that the compare is numeric and not lexicographic.
- `probeTools` with three fake scripts printing `git version 2.50.1` and `OpenSSH_10.2p1, LibreSSL 3.3.6` resolves `{ gitVersion: "2.50.1", sshVersion: "10.2p1" }` and the three paths unchanged.
- **A missing tool refuses and names it.** Point `tools.ssh` at a path inside the temporary directory that does not exist. `probeTools` rejects with `ToolProbeError`, `code === "tool-missing"`, `tool === "ssh"`, and a message containing that path.
- **A non-executable tool refuses.** Write a file with mode `0o600` and assert `code === "tool-unreadable"`.
- **The probe order is fixed.** Make all three paths absent. Assert `error.tool === "git"`. Then make only `git` present and assert `error.tool === "ssh"`.
- **A git below the floor refuses and names both versions.** A fake printing `git version 2.33.9` rejects with `code === "tool-too-old"` and a message containing both `2.33.9` and `2.34.0`.
- **`ssh-keyscan` is probed for presence only.** A fake `ssh-keyscan` that exits `1` and prints nothing still resolves, and `ProbedTools` carries no keyscan version member.
- **A hanging tool is killed and classified.** A fake `git` running `sleep 30` and `timeoutMs: 1500` rejects with `code === "tool-unreadable"`, and the test asserts within five seconds that `process.kill(pid, 0)` throws `ESRCH` for the recorded pid — the group was signalled, not merely abandoned.
- **The probe leaves no pid file.** After a resolved probe and after a rejected one, `fs.readdirSync(runDirectory)` contains no entry beginning with `"probe-"`.
- `buildGitPaths` returns exactly the seven keys, asserted with `assert.deepEqual(Object.keys(paths).sort(), ["git","home","keyDirectory","knownHosts","runDirectory","ssh","sshKeyscan"])`, every value absolute, and the four derived values equal to the four `join` expressions above.
- `buildGitPaths` creates the three directories with mode `0700`, asserted as `(statSync(p).mode & 0o777).toString(8) === "700"`, and creates `known_hosts` with `"600"`.
- **`buildGitPaths` never truncates `known_hosts`.** Write `"pinned\n"` into the path, call `buildGitPaths` again, and assert the content is still `"pinned\n"`.

### `src/services/home-lock/startup.test.ts` — one new case

- A configuration naming `tools: { git: "/nonexistent/git" }` launches the daemon through `launchDaemon`, and `proc.exited()` yields `code === 1` with `proc.stderr()` matching `/^kanthord: tool-missing: [^\n]+\n$/`. `proc.stdout()` is the empty string — the daemon does not reach the ready line, and therefore reaches no route. This is the epic coverage line "The daemon does not reach a route."

### E2E — scenario `E7-01`, real tools on the host

Runs only after Story 02 lands the harness. File `scripts/e2e/007/01-tool-probe.e2e.ts`.

- `probeTools` against the host's real `git`, `ssh` and `ssh-keyscan`, resolved from the same defaults the schema declares, resolves and reports a `gitVersion` satisfying `compareVersions(gitVersion, MINIMUM_GIT_VERSION) >= 0`.
- The same call twice returns deep-equal records. The probe reads a version; it never mints one.
- `buildGitPaths` under a `mkdtempSync` home creates the four directories, and the scenario removes the home afterwards.

The E2E case is not a duplicate of the unit case: the unit case pins parsing against written fixtures, and this one proves the two default paths and the version floor hold on a real machine, which no fake can show.

`npm run verify` exits 0.

Proof: contributes `src/services/git/probe.test.ts` to the epic Proof, and extends `src/services/config/convict.test.ts` and `src/services/home-lock/startup.test.ts`, both already inside `npm test`.
