# Story 8 — Command validation pass

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Stories 6 and 7 (`ConversionResult`, `ConvertedNode`, `applyTemplate` exist)

## Change

**Step A — Add `"process-unavailable"` to `VerifyErrorCode` at `src/services/verify/index.ts:22`**

The current line reads:

```ts
export type VerifyErrorCode = "not-implemented";
```

Change it to:

```ts
export type VerifyErrorCode = "not-implemented" | "process-unavailable";
```

**Step B — Create `src/services/verify/node-spawn.ts`** (greenfield)

This module is the first real `Verify` implementation beside `NotImplementedVerify`. It imports `node:child_process` and is added to the process-creation exemption list (see Step D).

```ts
import { spawnSync } from "node:child_process";
import type { CheckRequest, CheckOutput } from "./index.ts";
import { VerifyError, type Verify } from "./index.ts";
```

Export:

```ts
export class NodeSpawnVerify implements Verify {
  private readonly available: boolean;

  constructor(available?: boolean) {
    this.available = available ?? NodeSpawnVerify.probe();
  }

  async run(request: CheckRequest): Promise<CheckOutput> {
    if (!this.available) {
      throw new VerifyError(
        "process-unavailable",
        "process creation is unavailable in this runtime",
      );
    }
    // implementation: spawnSync the command array, capture output,
    // return CheckOutput with result based on exit code
  }

  private static probe(): boolean {
    try {
      const r = spawnSync("true", [], { timeout: 2000 });
      return r.error === undefined;
    } catch {
      return false;
    }
  }
}
```

`run` implementation details:

- Call `spawnSync(request.command[0], request.command.slice(1), { cwd: request.cwd, env: { ...process.env, ...request.env }, timeout: request.timeoutMs, maxBuffer: request.outputLimitBytes, encoding: "buffer" })`.
- If the result has `error` set or `status === null`: return `CheckOutput` with `result: "error"`, `exitCode: null`, `output: ""`, `envIdentity: ""`, `toolchainVersion: ""`, `endedAt: Date.now()`.
- If `status === 0`: return `result: "passed"`, `exitCode: 0`.
- Otherwise: return `result: "failed"`, `exitCode: status`.
- `output` is the UTF-8 string of `stdout` concatenated with `stderr`, truncated to `outputLimitBytes`.
- `envIdentity` and `toolchainVersion` are empty strings.
- `endedAt` is `Date.now()` after `spawnSync` returns.

**Step C — Create `src/services/verify/spawn-at-commit.ts`** (greenfield)

This module extracts one git commit into a temporary directory, runs one command through an injected `Verify`, and removes the temporary directory in a `finally`. It does NOT import `node:child_process`; all subprocess work goes through `Verify`.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verify } from "./index.ts";
```

Export:

```ts
export type SpawnAtCommitParams = Readonly<{
  command: string;
  repoPath: string;
  commitRef: string;
  gitPath: string;
}>;

export async function spawnAtCommit(
  verify: Verify,
  params: SpawnAtCommitParams,
): Promise<{ kept: boolean }>;
```

Implementation steps:

1. Create `tmpDir = mkdtempSync(join(tmpdir(), "kanthord-at-commit-"))`.
2. Wrap steps 3-5 in `try/finally`. The `finally` block calls `rmSync(tmpDir, { recursive: true, force: true })`.
3. Extract the commit: call `verify.run({ checkName: "git-archive", command: ["sh", "-c", `${params.gitPath} archive ${params.commitRef} | tar -x -C ${tmpDir}`], cwd: params.repoPath, env: {}, timeoutMs: 30000, outputLimitBytes: 1024 * 1024 })`. If `output.result !== "passed"`: return `{ kept: false }` (the `finally` removes the dir).
4. Run the command: call `verify.run({ checkName: "run-command", command: ["sh", "-c", params.command], cwd: tmpDir, env: {}, timeoutMs: 60000, outputLimitBytes: 1024 * 1024 })`.
5. Return `{ kept: output.result === "passed" }`.

The git archive command extracts the commit tree into `tmpDir` without touching the source repository's index. This is guaranteed by using `git archive` rather than `git --work-tree <dir> checkout`.

**Step D — Add `src/services/verify/node-spawn.ts` to the process-creation exemption list**

`eslint.config.js` lines 240-263 contain:

```js
{
  files: ["src/**/*.ts"],
  ignores: ["src/services/git/launcher.ts", "src/**/*.test.ts"],
  rules: {
    "no-restricted-imports": [
      2,
      {
        patterns: [
          ...
          {
            group: ["node:child_process"],
            message:
              "only src/services/git/launcher.ts creates a process; see .agents/plan/stories/006-git-primitives/04-supervised-spawn.md",
          },
```

Edit the `ignores` array of that block from:

```js
ignores: ["src/services/git/launcher.ts", "src/**/*.test.ts"],
```

to:

```js
ignores: ["src/services/git/launcher.ts", "src/services/verify/node-spawn.ts", "src/**/*.test.ts"],
```

No other change to `eslint.config.js`.

## Constraints

- `node-spawn.ts` imports `node:child_process`. `spawn-at-commit.ts` does not; it uses the injected `Verify`.
- The temp directory is always removed before `spawnAtCommit` returns, whether the command passes, fails, or throws. A test asserts `fs.existsSync(tmpDir) === false` in both paths.
- The `available` constructor parameter of `NodeSpawnVerify` is the only mechanism for constructing an unavailable instance in tests. Pass `false` to construct one.
- `spawnAtCommit` receives `gitPath` as an explicit parameter so the test can pass the hermetic git binary path from `resolveTools`.

## Verify

```
node --test src/services/verify/node-spawn.test.ts src/services/verify/spawn-at-commit.test.ts
```

**`src/services/verify/node-spawn.test.ts`** — suite name `"src/services/verify/node-spawn.test"`.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeSpawnVerify } from "./node-spawn.ts";
import { VerifyError } from "./index.ts";
```

Add the following `it` blocks:

1. `"run returns passed for a zero-exit command"` — `new NodeSpawnVerify()`. Call `run({ checkName: "t", command: ["true"], cwd: process.cwd(), env: {}, timeoutMs: 5000, outputLimitBytes: 1024 })`. Assert `output.result === "passed"`.

2. `"run returns failed for a non-zero-exit command"` — same verifier, command `["false"]`. Assert `output.result === "failed"`.

3. `"run throws VerifyError with code process-unavailable when unavailable"` — `new NodeSpawnVerify(false)`. Call `run(...)`. Assert throws `VerifyError` with `err.code === "process-unavailable"`. This is the EPIC hermetic coverage line: asserted by error code against a constructed-unavailable instance.

**`src/services/verify/spawn-at-commit.test.ts`** — suite name `"src/services/verify/spawn-at-commit.test"`.

Use the EPIC 005 hermetic fixture. Import `resolveTools` from `"../../test/helpers/remote/tools.ts"` and `seedRepositories` from `"../../test/helpers/remote/seed.ts"`. `resolveTools` (at `test/helpers/remote/tools.ts:102`) returns `Tools<Name>` which satisfies the `GitTools` interface expected by `seedRepositories` (at `test/helpers/remote/seed.ts:124`). Call `resolveTools(process.env, ["git"])` to get the tools. Call `seedRepositories(tools)` to get a `SeedRoot`.

`SeedRoot` (from `test/helpers/remote/seed.ts:19`) has:

- `path: string` — root temp directory
- `repositories: Readonly<Record<string, SeededRepository>>` — keyed by repo name
- `git(repository, args): string` — runs git in the named repository
- `dispose(): void` — removes the root temp directory

`SeededRepository` (from `test/helpers/remote/seed.ts:12`) has `name`, `path`, `head`, `refs`. Use `seed.repositories["fixture.git"].path` as `repoPath` and `seed.repositories["fixture.git"].head` as `commitRef`.

Setup:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveTools } from "../../test/helpers/remote/tools.ts";
import { seedRepositories } from "../../test/helpers/remote/seed.ts";
import { NodeSpawnVerify } from "./node-spawn.ts";
import { spawnAtCommit } from "./spawn-at-commit.ts";

let seed: ReturnType<typeof seedRepositories>;
let repoPath: string;
let commitRef: string;
let gitPath: string;

before(() => {
  const tools = resolveTools(process.env, ["git"]);
  seed = seedRepositories(tools);
  repoPath = seed.repositories["fixture.git"].path;
  commitRef = seed.repositories["fixture.git"].head;
  gitPath = tools.paths.git;
});

after(() => seed.dispose());
```

Add the following `it` blocks:

1. `"a passing command is kept and the temp dir is removed"` — `command: "true"`. Assert `result.kept === true`. Store `tmpDir` by wrapping `spawnAtCommit` to capture it (or assert indirectly by confirming no kanthord-at-commit- dir exists in `tmpdir()` after the call). Simpler: run the command, then assert that the result's `kept` is true and that no directory matching the pattern exists. Because the `finally` always removes the dir before returning, `result.tmpDir` is not exposed — assert liveness by calling the function and observing no exception. For the temp-dir removal assertion: modify `spawnAtCommit` to return `{ kept: boolean; tmpDir: string }` for testability, where `tmpDir` names the directory that was created and then removed. Assert `existsSync(result.tmpDir) === false`.

2. `"a non-zero exit drops the command and returns kept: false"` — `command: "false"`. Assert `result.kept === false`.

3. `"the temp directory is removed when the command fails"` — same as case 2. Assert `existsSync(result.tmpDir) === false`.

4. `"the source repository is unchanged after a run"` — `git status --porcelain` cannot run on a bare repository. Instead, record the list of refs before the run with `seed.git("fixture.git", ["for-each-ref", "--format=%(refname) %(objectname)"])` and after the run; assert the two strings are equal. This confirms `git archive` did not write to the source repository.

Note on Step B amendment: `spawnAtCommit`'s return type should be `Promise<{ kept: boolean; tmpDir: string }>` so that tests can assert cleanup without relying on `os.tmpdir()` listing. The `tmpDir` field names the directory that was created and then removed.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/services/verify/node-spawn.test.ts` and `src/services/verify/spawn-at-commit.test.ts` in `PASS EPIC-049`. Hermetic coverage: passing command kept; non-zero exit → `kept: false`; temp dir removed on both paths; source repository unchanged after a run; `VerifyError` code `process-unavailable` from a constructed-unavailable `NodeSpawnVerify`.
