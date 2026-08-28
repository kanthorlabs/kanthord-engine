# Story 1 — git service probes write access

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`

## Change

### `src/services/git/index.ts`

**Add `"empty-remote"` to `GitFailure`** (line 97, after `"unknown"`):

```ts
  | "empty-remote"
```

The union becomes lines 87–98.

**Add `ProbePushInput`** after `PushPreflight` (after line 132):

```ts
export type ProbePushInput = Readonly<{
  remoteUrl: string;
  branch: string | null;
  credential: GitCredential;
}>;
```

**Add `probePush` to the `Git` interface** after `canPush` (after line 163):

```ts
  probePush(input: ProbePushInput): Promise<PushPreflight>;
```

### New file `src/services/git/push-probe.ts`

Exports one function:

```ts
export async function probePush(
  runner: GitRunner,
  paths: GitPaths,
  input: ProbePushInput,
): Promise<PushPreflight>;
```

Implementation in exact order:

1. If `input.branch === null` return `{ allowed: false, failure: "empty-remote", detail: "" }` immediately without touching the filesystem.
2. `const tempDir = mkdtempSync(join(tmpdir(), "kanthord-probe-"))`.
3. Build probe-local paths to confine all credential files and run directory inside the temp dir:
   ```ts
   const probePaths: GitPaths = {
     ...paths,
     keyDirectory: join(tempDir, "keys"),
     runDirectory: join(tempDir, "run"),
   };
   ```
   Do NOT override `knownHosts` — the probe uses the caller's known-hosts file so that an already-trusted SSH host key remains trusted.
4. Wrap steps 5–10 in `try { ... } finally { rmSync(tempDir, { recursive: true, force: true }) }`.
5. `await runner({ args: ["init", "--bare", "--template=", "--object-format=sha1", \`--initial-branch=${input.branch}\`, "--", tempDir] })`.
6. `await runner({ args: [\`--git-dir=${tempDir}\`, "remote", "add", "origin", "--", input.remoteUrl] })`.
7. `await runner({ args: [\`--git-dir=${tempDir}\`, "config", "remote.origin.fetch", TRACKING_REFSPEC] })`.
8. `await fetchTracking(runner, probePaths, { gitDir: tempDir, credential: input.credential, pidFile: join(tempDir, "fetch.pid") })`.
9. `const upstreamOid = await resolveRef(runner, { gitDir: tempDir, ref: trackingRefOf(input.branch) })`.
10. If `upstreamOid === null` return `{ allowed: false, failure: "unknown", detail: \`tracking ref \${trackingRefOf(input.branch)} not found after fetch\` }`.
11. `return await canPush(runner, probePaths, { gitDir: tempDir, remoteUrl: input.remoteUrl, publishRef: publishRefOf(input.branch), proposedOid: upstreamOid, credential: input.credential })`.

The `finally` block runs on every path, including thrown `GitError`. `{ force: true }` on `rmSync` silences errors if the temp dir was not fully created.

Imports needed:

- `mkdtempSync`, `rmSync` from `"node:fs"`
- `tmpdir` from `"node:os"`
- `join` from `"node:path"`
- `TRACKING_REFSPEC`, `type GitPaths`, `type ProbePushInput`, `type PushPreflight` from `"./index.ts"`
- `fetchTracking` from `"./fetch.ts"`
- `canPush` from `"./preflight.ts"`
- `resolveRef` from `"./ref-read.ts"`
- `type GitRunner` from `"./run.ts"`
- `trackingRefOf`, `publishRefOf` from `"../../domain/repository.ts"`

### `src/http/server/repository/refusals.test.ts`

`everyGitFailure` at line 37 is a `Readonly<Record<GitFailure, true>>` exhaustive map. Add `"empty-remote": true` to it so that TypeScript fails if `GitFailure` grows without updating the map.

### `src/services/git/binary.test.ts`

The test at line 71 asserts `keys.length === 18` and lists all 18 member names. After adding `probePush` to the interface and factory:

- Change `keys.length === 18` to `keys.length === 19`.
- Insert `"probePush"` into the bytewise-sorted list at its correct position (between `"listPidFiles"` and `"refUpdate"`).
- Add a delegation test in the `"each member delegates to its module"` describe block (line 112+): call `git.probePush({ remoteUrl: "https://x.test/r.git", branch: "main", credential: writerCredential() })` with a recording runner that returns `code: 0` for all commands, and assert the runner received a `fetch` command containing `TRACKING_REFSPEC`.

### New file `src/services/git/push-probe.test.ts`

Test suite name: `"src/services/git/push-probe.ts"`. Uses `node:test` (`describe`, `it`, `before`, `after`) and `node:assert/strict`.

**Imports** (all relative from `src/services/git/`):

- `probePush` from `"./push-probe.ts"`
- `buildGitPaths` from `"./probe.ts"` — the tools-probe file (NOT this new file)
- `createGitRunner` from `"./run.ts"`
- `{ createHttpRemote }` from `"../../../test/helpers/remote/index.ts"`
- `existsSync`, `mkdtempSync`, `rmSync` from `"node:fs"`
- `tmpdir` from `"node:os"`
- `join` from `"node:path"`
- `GitError` from `"./index.ts"`

**Helper `writerCredential()`**: builds `GitCredential` from `httpRemote.credentials.writer.username`, `httpRemote.credentials.writer.token`.
**Helper `readerCredential()`**: builds `GitCredential` from `httpRemote.credentials.reader.username`, `httpRemote.credentials.reader.token`.

**Module-level setup**: `before` — `createHttpRemote()`, `buildGitPaths(probed)`, `createGitRunner(paths, gitSchedule)`. Use the same pattern as `preflight.test.ts` — create a temp base dir with `mkdtempSync` for runner state; add to `after` cleanup.

**Test cases**:

1. `"branch null returns empty-remote without creating a temp directory"`:
   - Record all dirs in `tmpdir()` matching `kanthord-probe-` before the call.
   - Call `probePush(runner, paths, { remoteUrl: httpRemote.url("fixture.git"), branch: null, credential: writerCredential() })`.
   - `assert.deepEqual(result, { allowed: false, failure: "empty-remote", detail: "" })`.
   - Record dirs again; assert the count is unchanged (no dir was created).

2. `"writer credential may push — temp dir is removed after success"`:
   - Build a tracking runner that wraps the real runner and captures args. Extract `tempDir` from the args of the first `init` command (the last argument of the args array where `args[0] === "init"`).
   - Call `probePush(runner, paths, { remoteUrl: httpRemote.url("fixture.git"), branch: "main", credential: writerCredential() })`.
   - `assert.deepEqual(result, { allowed: true })`.
   - `assert.equal(existsSync(capturedTempDir), false)` — temp dir removed.
   - `assert.ok(capturedTempDir.startsWith(tmpdir()))` — created under system tmpdir, not paths.home.

3. `"reader credential push advertisement returns auth-failed verdict — temp dir is removed"`:
   - Same tracking runner.
   - Call with `credential: readerCredential()`.
   - `assert.equal(result.allowed, false)` and `assert.equal(result.failure, "auth-failed")` — `preflight.test.ts:432-433` confirms HTTP fixture returns `auth-failed` for a read-only credential on `receive-pack`.
   - `assert.equal(existsSync(capturedTempDir), false)` — temp dir removed.

4. `"thrown GitError during fetch — temp dir is removed"`:
   - Build a throwing runner: a `GitRunner` that returns `{ code: 0, stdout: "", stderr: "", args: [] }` for `init`, `remote`, and `config` commands, but throws `new GitError("transport-failed", "simulated fetch failure", "")` when `args` contains `"fetch"`. Detect fetch by checking `request.args.includes("fetch")`. Capture the `tempDir` from the init command args (last element of the init args array).
   - Call `probePush(throwingRunner, paths, { remoteUrl: httpRemote.url("fixture.git"), branch: "main", credential: writerCredential() })`.
   - `assert.rejects(...)` — the call throws `GitError` with `failure === "transport-failed"`.
   - `assert.equal(existsSync(capturedTempDir), false)` — temp dir removed despite throw.

5. `"probe uses probe-local keyDirectory, not paths.keyDirectory"`:
   - Use the tracking runner from test 2.
   - After a successful call, assert `capturedTempDir` (from init args) is not a prefix of `paths.keyDirectory` and that the probe wrote its credential helper into a path starting with `capturedTempDir`. Verify by checking runner args: the `GIT_CONFIG_COUNT`/`credential.helper` env should name a path inside the init-derived temp dir.

   Simpler alternative: call `probePush` with writer credential, observe the `extraEnv` in the runner requests captured by the tracking runner; assert `JSON.stringify(requests)` does not contain `paths.keyDirectory`.

## Constraints

- `push-probe.ts` imports no vendor package. Its only non-`node:` imports are named git-service modules and `domain/repository.ts`.
- `probePush` passes `probePaths` (not `paths`) to `fetchTracking` and `canPush` so credential files go inside `tempDir`, not `paths.keyDirectory`.
- `push-probe.test.ts` uses `httpRemote.credentials.writer`, `httpRemote.credentials.reader`, and `httpRemote.wrongCredential` — NOT `httpRemote.credentials.wrongCredential` (that member does not exist; `wrongCredential` is a top-level field).

## Verify

```
node --test src/services/git/push-probe.test.ts
node --test src/services/git/preflight.test.ts
node --test src/services/git/binary.test.ts
node --test src/http/server/repository/refusals.test.ts
npm run verify
```

- All five suites pass.
- `npm run verify` exits 0.

Proof: The epic's Proof block names `src/services/git/probe.test.ts` — this is a typo in the epic for the tool-probe suite. This story creates `src/services/git/push-probe.test.ts`. The Proof line delivered is the `push-probe.test.ts` suite. Report this discrepancy to Ulrich as a suggestion: the epic's Proof command must be corrected to reference `push-probe.test.ts` instead of `probe.test.ts`.
