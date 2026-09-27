# Plan 04: Repository component

## Scope

Creates `src/repository/` as a stateless shared transport module.
Delivers `RepositoryComponent`: a class whose constructor runs the startup tool gate and whose `gitLsRemote` method performs the SSH reachability check used by the Project Service in a binding write.
No table, no migration, no configuration section.
`octokit` is not needed for ERD 1: the only ERD 1 call is `git ls-remote` (covered by `simple-git`, already in `package.json`); the GitHub platform connector (`octokit`) is an ERD 2 concern.
The ls-remote worker-host coverage HANDOFF item is open; this plan implements no worker-host check.
The platform connector, payload decoders and all write operations (node-branch push, configured-action write) belong to ERD 2.

## Sources

- `docs/brainstorm/repository.impl.md#repository-connector` → startup version requirements: git 2.40+, OpenSSH 9.0+, bash present; timeout plugin bounds each operation by the remaining resource budget; abort plugin binds to the `Context` of the caller; SSH environment: inherit host SSH config, set no `GIT_SSH_COMMAND` or `GIT_SSH`, pass no credential on a process command line.
- `docs/brainstorm/project-service.impl.md#the-network-git-operations` → `gitLsRemote` is called before the `BEGIN IMMEDIATE` transaction; a 30 s deadline is supplied by the caller; the connector throws on failure; the Project Service maps the failure to `project.bindings.repository.ssh_unreachable`.
- `docs/reference/erd/01-setup.md` (Owners without a table) → "The Repository component owns no table. It is stateless transport."
- `docs/brainstorm/architecture.impl.md:17–20` → every comparison against a fixed string or number uses a named constant.
- `docs/brainstorm/architecture.impl.md:339–349` → error code form `<namespace>.<component>[.<component>...].<error>`, minimum three parts.
- `docs/brainstorm/architecture.impl.md:382` → "Service and component collaborators receive `Context`, not a native `AbortSignal`. Native signals are bridged at transport boundaries."
- `engine/.agents/plan/00-index.md` ownership table → Plan 04 adds `src/repository` as a separate non-service element type to `eslint.config.js`; Plan 04 adds `src/repository/` to `AGENTS.md`.
- `engine/.agents/plan/07-gateway-server.md:39,85,95` → Plan 07 constructs `new RepositoryComponent()` and calls no lifecycle method on it; names the injected method `gitLsRemote`.

## Depends on

None.

## Provides

| Seam                  | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                      | Owner file                | Consumer plans                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `RepositoryComponent` | `class RepositoryComponent { constructor(dependencies: { health?: HealthRegistry } = {}) — calls checkRepositoryTools() synchronously; gitLsRemote(sshUrl: string, context: Context, deadlineMs: number): Promise<void> — throws Error when the git command fails, the context is cancelled, or the deadline elapses; healthcheck(context: Context = background): Promise<Healthcheck> }` | `src/repository/index.ts` | 05 (declares matching interface type inline in its `contract.ts`), 07 (constructs and injects) |

## Tasks

### 04.1 Create startup check module and update ESLint boundaries

- Files:
  - `src/repository/check.ts` (create)
  - `src/repository/check.test.ts` (create)
  - `eslint.config.js` (edit)

- Do:
  1. Create `src/repository/check.ts`.
     a. Import `spawnSync` from `node:child_process`.
     Import `Diagnostic` from `../kernel/errors.ts`.
     b. Declare constants:
     `const GIT_MIN_MAJOR = 2`
     `const GIT_MIN_MINOR = 40`
     `const SSH_MIN_MAJOR = 9`
     `const SSH_MIN_MINOR = 0`
     `const ENOENT_CODE = "ENOENT"`
     `const EXIT_SUCCESS = 0`
     c. Declare `export const CheckErrorCode = { ToolMissing: "repository.connector.tool_missing", ToolVersion: "repository.connector.tool_version" } as const`.
     d. Declare a module-private helper `runTool(cmd: string, args: string[]): { stdout: string; stderr: string }`.
     Call `spawnSync(cmd, args, { encoding: "utf8" })`.
     When `result.error` exists, check its `code` property; when the code equals `ENOENT_CODE`, throw `new Diagnostic(CheckErrorCode.ToolMissing, \`${cmd}: not found\`)`.
        When `result.error` exists for any other reason, throw `new Diagnostic(CheckErrorCode.ToolMissing, \`${cmd}: spawn failed\`)`.
 When `result.status !== EXIT_SUCCESS`or`result.signal !== null`, throw `new Diagnostic(CheckErrorCode.ToolMissing, \`${cmd}: exited with status ${result.status}\`)`.
 Return `{ stdout: result.stdout ?? "", stderr: result.stderr ?? "" }`.
e. Export `parseGitVersion(output: string): [number, number]`.
 Match `output`against`/^git version (\d+)\.(\d+)/`.
 When the string does not match, throw `new Diagnostic(CheckErrorCode.ToolMissing, "git: unrecognized version output")`.
 Parse major and minor as integers.
 When `major < GIT_MIN_MAJOR || (major === GIT_MIN_MAJOR && minor < GIT_MIN_MINOR)`, throw `new Diagnostic(CheckErrorCode.ToolVersion, \`git: version ${major}.${minor} is below 2.40\`)`.
 Return `[major, minor]`.
f. Export `parseSshVersion(output: string): [number, number]`.
 Match `output`against`/OpenSSH_(\d+)\.(\d+)/`.
 When the string does not match, throw `new Diagnostic(CheckErrorCode.ToolMissing, "ssh: unrecognized version output")`.
 Parse major and minor as integers.
 When `major < SSH_MIN_MAJOR || (major === SSH_MIN_MAJOR && minor < SSH_MIN_MINOR)`, throw `new Diagnostic(CheckErrorCode.ToolVersion, \`ssh: version ${major}.${minor} is below 9.0\`)`.
 Return `[major, minor]`.
g. Export `checkRepositoryTools(): void`.
 Call `runTool("bash", ["--version"])`to prove bash is present; the helper throws on ENOENT or non-zero exit.
 Call`runTool("git", ["--version"])`and pass`stdout`to`parseGitVersion`.
 Call `runTool("ssh", ["-V"])`and pass`stderr`to`parseSshVersion` (ssh writes version to stderr).

  2. Create `src/repository/check.test.ts`.
     Import `test` from `node:test`.
     Import `assert` from `node:assert/strict`.
     Import `parseGitVersion`, `parseSshVersion`, `checkRepositoryTools`, `CheckErrorCode` from `./check.ts`.
     Import `Diagnostic` from `../kernel/errors.ts`.
     Tests:
     - `parseGitVersion("git version 2.40.0")` returns `[2, 40]`.
     - `parseGitVersion("git version 2.41.0")` returns `[2, 41]` (above minimum accepted).
     - `parseGitVersion("git version 2.39.3")` throws `Diagnostic` whose `.code` equals `CheckErrorCode.ToolVersion`.
     - `parseGitVersion("not a git version string")` throws `Diagnostic` whose `.code` equals `CheckErrorCode.ToolMissing`.
     - `parseSshVersion("OpenSSH_9.0p1, OpenSSL 3.0.8 5 Feb 2023")` returns `[9, 0]`.
     - `parseSshVersion("OpenSSH_9.1p1, LibreSSL 3.3.6")` returns `[9, 1]` (above minimum accepted).
     - `parseSshVersion("OpenSSH_8.9p1, OpenSSL 1.1.1n 15 Mar 2022")` throws `Diagnostic` whose `.code` equals `CheckErrorCode.ToolVersion`.
     - `parseSshVersion("not an ssh version string")` throws `Diagnostic` whose `.code` equals `CheckErrorCode.ToolMissing`.
     - `checkRepositoryTools()` does not throw when git 2.40+, OpenSSH 9.0+ and bash are installed on the host (smoke integration test).

  3. Edit `eslint.config.js`.
     a. Add `{ type: "repository", pattern: "src/repository" }` to the `"boundaries/elements"` array.
     b. Add `{ from: element("repository"), allow: allow("kernel") }` to the `policies` array.
     c. Extend the existing `from: element("service")` policy: add `{ to: element("repository") }` to its `allow` list.
     d. Extend the existing `from: element("apps-server")` policy: add `{ to: element("repository") }` to its `allow` list.
     e. Extend the existing caller-mint denylist (`to: element("kernel", { fileInternalPath: "caller-mint.ts" })`): add `{ from: element("repository") }` to its `disallow` list.
     f. Extend the existing service-contract denylist (`from: serviceEntry("contract.ts")`): add `{ to: element("repository") }` to its `disallow` list.

- Rules:
  - Every numeric and string comparison uses a named constant (`architecture.impl.md:17–20`).
  - Error codes `repository.connector.tool_missing` and `repository.connector.tool_version` each have three parts (`architecture.impl.md:339`).
  - No credential, no `GIT_SSH_COMMAND`, no `GIT_SSH` on any process command line (`repository.impl.md#the-ssh-environment`).
  - Exit-status and signal checks use named constants (`EXIT_SUCCESS`, `null` check) (`architecture.impl.md:17–20`).
  - After the edit, ESLint resolves every file in `src/repository/` to the `repository` element; the `repository` element cannot import `caller-mint.ts`; service contracts cannot import from `repository`.

- Done when:
  - `pnpm run verify` passes in `engine/` with no new ESLint violation.
  - `node --test --test-timeout=30000 src/repository/check.test.ts` reports all assertions passed.
  - The version-below-minimum tests each assert code `CheckErrorCode.ToolVersion`; the malformed-output tests assert code `CheckErrorCode.ToolMissing`.

### 04.2 Create connector, RepositoryComponent, and update AGENTS.md

- Files:
  - `src/repository/connector.ts` (create)
  - `src/repository/connector.test.ts` (create)
  - `src/repository/index.ts` (create)
  - `AGENTS.md` (edit)

- Do:
  1. Create `src/repository/connector.ts`.
     Import `simpleGit` from `simple-git`.
     Import `type Context` from `../kernel/context.ts`.
     Export `gitLsRemote(sshUrl: string, context: Context, deadlineMs: number): Promise<void>`.
     Inside the function:
     a. Create `const controller = new AbortController()`.
     b. Register context cancellation: `const unsubscribe = context.onCancel(() => controller.abort())`.
     c. Create `const timer = setTimeout(() => controller.abort(), deadlineMs)`.
     d. In a `try/finally` block: call `clearTimeout(timer)` and `unsubscribe()` in `finally`.
     e. Call `simpleGit({ abort: controller.signal, timeout: { block: deadlineMs } })` to configure simple-git 3.36.0. The `abort` option takes the `AbortSignal` from `controller.signal`; the `timeout.block` option sets the timeout in milliseconds. Both options are confirmed in `dist/cjs/index.js:4730–4732`.
     f. Call `git.raw(["ls-remote", sshUrl])` to run `git ls-remote <sshUrl>`.
     g. Let any thrown error propagate as-is; do not map to a `Diagnostic`.
     Set no environment variable `GIT_SSH_COMMAND` or `GIT_SSH`.

  2. Create `src/repository/connector.test.ts`.
     Import `test`, `after` from `node:test`.
     Import `assert` from `node:assert/strict`.
     Import `mkdtempSync`, `rmSync` from `node:fs`.
     Import `tmpdir` from `node:os`.
     Import `simpleGit` from `simple-git`.
     Import `gitLsRemote` from `./connector.ts`.
     Import `background` from `../kernel/context.ts`.
     Tests:
     a. Create a temp directory with `mkdtempSync`. Call `simpleGit(dir).init()` to make it a git repository. Call `gitLsRemote("file://" + dir, background, 5000)` and assert it resolves without throwing. Remove the temp directory in an `after` hook.
     b. Call `gitLsRemote("file:////nonexistent_kanthord_plan04_test", background, 5000)` and assert it throws.
     c. Create the same temp git directory as test (a). Call `gitLsRemote("file://" + dir, background, 1)` and assert it throws (a 1 ms deadline fires before the git subprocess can respond on any host). Remove the temp directory in an `after` hook.

  3. Create `src/repository/index.ts`.
     Import `checkRepositoryTools` from `./check.ts`.
     Import `gitLsRemote` from `./connector.ts`.
     Import `type Context` from `../kernel/context.ts`.
     Declare and export `class RepositoryComponent`.
     Constructor: call `checkRepositoryTools()`. Throw if any tool check fails.
     Method `gitLsRemote(sshUrl: string, context: Context, deadlineMs: number): Promise<void>`: delegate to the imported `gitLsRemote` function.

  4. Edit `engine/AGENTS.md`.
     Add `src/repository/` to the project structure between `src/kernel/` and `src/project/`, with the description: "Repository shared component: startup version gate and SSH reachability connector."

- Rules:
  - No `octokit` import or dependency; the GitHub platform connector belongs to ERD 2 (`repository.impl.md#platform-connector-and-platform-implementations`).
  - No `GIT_SSH_COMMAND`, no `GIT_SSH`, no credential on any process command line (`repository.impl.md#the-ssh-environment`).
  - `gitLsRemote` propagates `Error` on failure without mapping to a `Diagnostic`; the Project Service (Plan 05) maps to `project.bindings.repository.ssh_unreachable` (`project-service.impl.md:247–251`).
  - The abort plugin receives `controller.signal` (an `AbortSignal`), not `controller` (an `AbortController`) (`repository.impl.md:46`; `architecture.impl.md:382`).
  - `RepositoryComponent` has no lifecycle and no migrations; Plan 07 must not add it to `services` or `releases`.

- Done when:
  - `pnpm run verify` passes in `engine/`.
  - `node --test --test-timeout=30000 src/repository/connector.test.ts` reports all tests passed.
  - Test (a) proves `gitLsRemote` resolves for a valid local git repository.
  - Test (b) proves `gitLsRemote` throws for a nonexistent path.
  - Test (c) proves `gitLsRemote` throws when the deadline is 1 ms (deadline enforcement is present).
  - `src/repository/index.ts` exports `RepositoryComponent`; `tsc --noEmit` resolves the class and its `gitLsRemote` method.

### 04.3 Add component healthcheck to RepositoryComponent

- Files:
  - `src/repository/check.ts` (edit)
  - `src/repository/index.ts` (edit)
  - `src/repository/check.test.ts` (edit)

- Do:
  1. Edit `src/repository/check.ts`.
     Import `execFile` from `node:child_process`.
     Import `promisify` from `node:util`.
     Import `type Context` from `../kernel/context.ts`.
     Declare `const execFileAsync = promisify(execFile)`.
     Export `async function probeRepositoryTools(context: Context): Promise<boolean>`.
     Inside:
     a. Create `const controller = new AbortController()`.
     b. Register context cancellation: `const unsubscribe = context.onCancel(() => controller.abort())`.
     c. In a `try` block:
     Call `await execFileAsync("bash", ["--version"], { signal: controller.signal })`.
     Call `await execFileAsync("git", ["--version"], { signal: controller.signal })` and pass `stdout` to `parseGitVersion`.
     Call `await execFileAsync("ssh", ["-V"], { signal: controller.signal })` and pass `stderr` to `parseSshVersion`.
     Return `true`.
     d. In the `catch` block return `false`.
     e. In the `finally` block call `unsubscribe()`.

  2. Edit `src/repository/index.ts`.
     Import `type Healthcheck` and `HealthStatus` from `../kernel/service.ts`.
     Import `type HealthRegistry` from `../kernel/health.ts`.
     Import `background, type Context` from `../kernel/context.ts`.
     Import `probeRepositoryTools` from `./check.ts`.
     Declare `interface Dependencies { health?: HealthRegistry }`.
     Change the constructor signature to `constructor(dependencies: Dependencies = {})`.
     Keep the existing `checkRepositoryTools()` call as the first constructor statement.
     Add `dependencies.health?.register("repository", (context) => this.healthcheck(context))` after the tool check.
     Add method `async healthcheck(context: Context = background): Promise<Healthcheck>`.
     Inside: call `await probeRepositoryTools(context)`.
     Return `{ toolchain: HealthStatus.Healthy }` when the result is `true`.
     Return `{ toolchain: HealthStatus.Unavailable }` when the result is `false`.

  3. Edit `src/repository/check.test.ts`.
     Import `RepositoryComponent` from `./index.ts`.
     Import `HealthRegistry` from `../kernel/health.ts`.
     Import `background, CancellationContext` from `../kernel/context.ts`.
     Add tests:
     - Call `probeRepositoryTools(background)` and assert it resolves to `true` on a conformant host.
     - Create `const ctx = new CancellationContext()`. Call `ctx.cancel()`. Call `probeRepositoryTools(ctx)` and assert it resolves to `false` (cancelled context resolves false, no throw).
     - Construct `new HealthRegistry()`. Construct `new RepositoryComponent({ health: registry })`. Call `registry.check(background)` and assert the result contains a key `"repository"` whose value is `{ toolchain: HealthStatus.Healthy }`.

- Rules:
  - `probeRepositoryTools` uses `execFile` (async), not `spawnSync`; it does not block the event loop.
  - Bridge the `Context` to `AbortSignal` via `controller.signal` (`architecture.impl.md:382`).
  - Reuse `parseGitVersion` and `parseSshVersion` from the same module.
  - A failed or cancelled probe resolves `false`; it never throws.
  - `"toolchain"` names only the Repository-required tools: `git` 2.40+, `OpenSSH` 9.0+ and `bash`.
  - `RepositoryComponent` is not a `Service`; Plan 07 must not add it to `services` or call lifecycle methods on it.

- Done when:
  - `pnpm run verify` passes in `engine/`.
  - `node --test --test-timeout=30000 src/repository/check.test.ts` reports all assertions passed.
  - A cancelled context resolves `false` without throwing.
  - A conformant host resolves `{ toolchain: HealthStatus.Healthy }`.
  - `registry.check(background)` returns a map that contains `"repository": { toolchain: HealthStatus.Healthy }`.

## Blockers

None. Plan 04 uses `repository.connector.tool_missing` and `repository.connector.tool_version`, both three-part codes. The `RepositoryComponent.gitLsRemote` seam is recorded in the `00-index.md` Seams table. The `00-index.md` Plan 04 boundary no longer mentions `octokit`.
