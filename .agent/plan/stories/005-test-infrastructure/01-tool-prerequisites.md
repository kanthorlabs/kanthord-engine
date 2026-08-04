# Story 01 — Tool prerequisites

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Depends on: EPIC 004 (sequence order).

## Change

Create `test/helpers/remote/tools.ts`. It resolves four absolute binary paths from
the environment, probes them, and returns one frozen record. It never reads
`PATH`.

Exports, exactly:

```ts
export type ToolName = "git" | "ssh" | "sshd" | "sshKeyscan" | "sshKeygen";

export type ToolPaths = Readonly<Record<ToolName, string>>;

export type Tools = Readonly<{
  paths: ToolPaths;
  gitVersion: string;
  sshVersion: string;
  execPath: string;
  httpBackend: string;
}>;

export class ToolError extends Error {
  readonly tool: ToolName;
  constructor(tool: ToolName, message: string);
}

export const toolEnvironmentNames: Readonly<Record<ToolName, string>>;
export const toolDefaults: ToolPaths;
export const minimumGitVersion: string;

export function resolveTools(
  env?: Readonly<Record<string, string | undefined>>,
): Tools;
```

Fixed data:

```ts
export const toolEnvironmentNames = {
  git: "KANTHORD_TEST_GIT",
  ssh: "KANTHORD_TEST_SSH",
  sshd: "KANTHORD_TEST_SSHD",
  sshKeyscan: "KANTHORD_TEST_SSH_KEYSCAN",
  sshKeygen: "KANTHORD_TEST_SSH_KEYGEN",
} as const;

export const toolDefaults = {
  git: "/usr/bin/git",
  ssh: "/usr/bin/ssh",
  sshd: "/usr/sbin/sshd",
  sshKeyscan: "/usr/bin/ssh-keyscan",
  sshKeygen: "/usr/bin/ssh-keygen",
} as const;

export const minimumGitVersion = "2.34.0";

export const toolTimeoutMilliseconds = 10000;
```

`sshKeygen` is the **fifth** tool. Story 04 generates four key pairs with it, and
every spawn in this epic passes `env: {}`, so no ambient `PATH` can find it. A
fifth tool is therefore a prerequisite, not an optional extra.

`resolveTools(env = process.env)` behaviour, in this order per tool, iterating
`git`, `ssh`, `sshd`, `sshKeyscan`, `sshKeygen` in that exact order:

1. Take `env[toolEnvironmentNames[name]]`; when it is absent or the empty string,
   take `toolDefaults[name]`.
2. Throw `ToolError(name, ...)` when the resolved value is not absolute
   (`node:path.isAbsolute`). Message: `` `${name} path is not absolute: ${value}` ``.
3. `fs.accessSync(value, fs.constants.X_OK)`. On throw, raise
   `ToolError(name, ...)` with message
   `` `${name} is missing or not executable at ${value}; set ${toolEnvironmentNames[name]}` ``.

Then the probes:

- `git`: `execFileSync(paths.git, ["--version"], { encoding: "utf8", env: {} })`.
  Match `/^git version (\d+)\.(\d+)\.(\d+)/`. No match throws
  `ToolError("git", "git --version is unparseable: " + raw.trim())`.
  `gitVersion` is the `"<major>.<minor>.<patch>"` triple only, with any vendor
  suffix dropped — on this machine `git version 2.50.1 (Apple Git-155)` yields
  `"2.50.1"`. Compare the triple numerically against `minimumGitVersion`; below
  it, throw `ToolError("git", ...)` with message
  `` `git ${found} is below the tested minimum ${minimumGitVersion}` ``.
- `ssh`: `ssh -V` writes to **stderr** and exits 0. Run
  `execFileSync(paths.ssh, ["-V"], { encoding: "utf8", env: {}, stdio: ["ignore", "pipe", "pipe"] })`
  and read the captured stderr. Match `/^OpenSSH_(\S+)/`; `sshVersion` is capture
  group 1 with any trailing comma removed — on this machine
  `OpenSSH_10.2p1, LibreSSL 3.3.6` yields `"10.2p1"`. No match throws
  `ToolError("ssh", ...)`. **No range is enforced**; the version is recorded only.
- `sshd`, `sshKeyscan` and `sshKeygen`: presence and executability only, already
  covered by step 3. No version probe. `ssh-keyscan` exits non-zero with a usage
  banner when given no arguments, so it must never be run to probe it.
- `execPath` is `execFileSync(paths.git, ["--exec-path"], { encoding: "utf8", env: {} }).trim()`.
  `httpBackend` is `join(execPath, "git-http-backend")`, and it is checked with
  the same `X_OK` access check, throwing `ToolError("git", ...)` with message
  `` `git-http-backend is missing or not executable at ${httpBackend}` ``.

Every `execFileSync` call in this epic passes `env: {}` — no inherited
environment, matching `test/helpers/daemon.ts:39-43` — **and**
`timeout: toolTimeoutMilliseconds, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024`.

The timeout is mandatory and applies to every external command in every story of
this epic. A `node:test` timeout cannot interrupt a synchronous `execFileSync`
blocked inside a child process, so without a per-command timeout a hung `ssh` or
`sshd` hangs the whole suite instead of failing it. `maxBuffer` bounds a runaway
`git` that streams; the default 1 MiB is too small for a pack.

`resolveTools` returns a value built with `Object.freeze` on `paths` and on the
result. It **never** returns a partial record and **never** signals absence by a
return value, so no caller can skip a test.

## Constraints

- No production code. This story creates no file under `src/`.
- No `PATH` lookup, no `which`, no `command -v`, no shell. `execFileSync` only,
  never `execSync` or `exec`.
- Absence throws. Never call `t.skip`, never return a nullable tool, and never
  guard a later test on a boolean.
- `resolveTools` is a pure function of its `env` argument plus the file system. It
  reads `process.env` only through the default parameter.

## Verify

`node --test test/helpers/remote/tools.test.ts`, asserting exactly:

- `resolveTools()` returns `paths.git === "/usr/bin/git"`, `paths.ssh === "/usr/bin/ssh"`,
  `paths.sshd === "/usr/sbin/sshd"`, `paths.sshKeyscan === "/usr/bin/ssh-keyscan"`
  and `paths.sshKeygen === "/usr/bin/ssh-keygen"` when the five environment names
  are absent from the passed `env`.
- `Object.keys(tools.paths)` deep-equals
  `["git", "ssh", "sshd", "sshKeyscan", "sshKeygen"]`, so a sixth binary cannot be
  spawned by a later story without appearing here first.
- `resolveTools({ KANTHORD_TEST_GIT: "/usr/bin/git" })` returns the same
  `paths.git`, proving the override path is read.
- `gitVersion` matches `/^\d+\.\d+\.\d+$/` and contains no space and no `(`.
- `sshVersion` matches `/^\d+\.\d+/` and does not start with `OpenSSH_`.
- `execPath` is an absolute path, and `fs.statSync(httpBackend).isFile()` is true.
- `resolveTools({ KANTHORD_TEST_SSHD: "/nonexistent/sshd" })` throws `ToolError`
  with `tool === "sshd"` and a message containing both `/nonexistent/sshd` and
  `KANTHORD_TEST_SSHD`. Asserted with `assert.throws` on the class, not on a
  string alone.
- `resolveTools({ KANTHORD_TEST_GIT: "relative/git" })` throws `ToolError` with
  `tool === "git"` and a message containing `is not absolute`.
- A missing `git` is reported before a missing `ssh`: with **both**
  `KANTHORD_TEST_GIT` and `KANTHORD_TEST_SSH` pointing at `/nonexistent/x`, the
  thrown error has `tool === "git"`. This pins the iteration order.
- `minimumGitVersion === "2.34.0"`, and the comparison is numeric rather than
  lexical: a helper-visible compare of `"2.9.0"` against `"2.34.0"` reports
  `"2.9.0"` as lower. Export the comparator or assert it through a `resolveTools`
  call against a stub script; the assertion must fail for a `localeCompare`
  implementation.
- `resolveTools` never returns a value whose `paths` is mutable:
  `assert.throws(() => { (tools.paths as Record<string, string>).git = "x"; })`.

`npm run verify` exits 0.

Proof: prerequisite of `PASS EPIC-005`. `tools.test.ts` is inside the Proof glob
`test/helpers/remote/*.test.ts`.

## Note for the reviewer

`minimumGitVersion = "2.34.0"` is **not** fixed by any file under
`docs/proposal/`. `docs/proposal/open-items.md:53` defers the floor to a release
decision, and this story does not make that decision — it provides the one place
the decision lands.

Do **not** justify `2.34.0` by the flag set. Every flag this phase uses
(`--no-tags`, `--no-hardlinks`, `--initial-branch`, `mktag`, `-c protocol.allow`)
predates 2.34, so the flags imply a far lower floor. `2.34.0` is a placeholder
chosen because it is the `git` in Ubuntu 22.04 LTS, and it is recorded as one
exported constant asserted in one place so ratifying a different number is a
one-line edit. See open item S1 in `index.md`.

This story also does **not** deliver the enumerated tested set of
`docs/proposal/open-items.md:61-63` — the supported minimum, the version in the
shipped image, and the newest tested. That is a continuous-integration matrix and
a release artifact. What this story delivers is narrower and is all a `node:test`
run can deliver: it **records** the version it actually ran against, and it
refuses a version below the floor. Do not describe it as pinning the test
environment.
