# Story 02 — The end-to-end harness

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 01 (`buildGitPaths`).

One loader, one remote helper and one npm script. Every later story adds exactly one scenario file to `scripts/e2e/007/` and asserts against the real GitHub repository named in `.env.e2e`. This story adds no scenario of its own beyond the two that prove the harness.

The harness lives outside `src/` and outside `test/` because `npm test` is bare `node --test`, and Node's default pattern collects **every** file under a directory named `test` — measured: `npm test` collects 89 files today, including `test/helpers/cli.ts`. A network scenario under `test/` would therefore run inside `npm run verify` and break the hermetic rule of `AGENTS.md`.

## Change

### 1. `scripts/e2e/env.ts` (new)

```ts
export type E2eEnv = Readonly<{
  ghToken: string;
  ghRepo: string;
  ghBaseBranch: string;
  runId: string;
}>;

export const E2E_ENV_FILE = ".env.e2e";

export const E2E_REQUIRED_KEYS = [
  "E2E_GH_TOKEN",
  "E2E_GH_REPO",
  "E2E_GH_BASE_BRANCH",
] as const;

export class E2eEnvError extends Error {
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[]);
}

export function parseDotEnv(text: string): Readonly<Record<string, string>>;

export function loadE2eEnv(
  overrides?: Readonly<{ file?: string; runId?: string }>,
): E2eEnv;
```

`parseDotEnv` reads a `KEY=value` file. It ignores an empty line and a line whose first non-space character is `#`, splits on the **first** `=`, trims the key, and keeps the value verbatim with no quote stripping and no escape handling. A `github_pat_…` value contains `_` and `.` and no quoting, so a parser that strips quotes would corrupt a token that happened to start with one. A line with no `=` is ignored.

`loadE2eEnv` resolves the file relative to the repository root, which is `resolve(import.meta.dirname, "../..")`. An absent file throws `E2eEnvError("<path> is absent; the end-to-end gate needs a real remote", E2E_REQUIRED_KEYS)`. A present file with any of the three keys absent or empty throws `E2eEnvError("<path> is missing: <names joined by ", ">", <those names>)`.

**Absence refuses; it never skips.** `t.skip` on a missing credential turns a gate that proved nothing into a passing run, which is the failure mode `AGENTS.md` names for a fixture. The refusal is the same rule EPIC 005 Story 01 applies to a missing tool.

`runId` is `overrides?.runId ?? process.env.E2E_RUN_ID`, and it throws `E2eEnvError("E2E_RUN_ID is not set; the gate driver mints it", ["E2E_RUN_ID"])` when both are absent.

**The run id is minted by the parent driver, never by a scenario.** Each scenario file is its own process, so `Date.now()` inside `loadE2eEnv` would give every file a different suffix, and one scenario's cleanup would then miss another's refs. Story 13's driver mints one ULID-shaped id and exports `E2E_RUN_ID` into every child, and a scenario run by hand without it refuses rather than inventing one.

`loadE2eEnv` also refuses an `E2E_GH_REPO` that does not match `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`, and an `E2E_GH_BASE_BRANCH` containing a `/` or a `*`. A malformed repository name would otherwise reach a url, and a wildcard base branch would defeat the guard below.

### 2. `scripts/e2e/remote.ts` (new)

```ts
import type { E2eEnv } from "./env.ts";
import type { GitCredential } from "../../src/services/git/index.ts";

export const E2E_REF_PREFIX = "refs/heads/kanthord-e2e/007";

export class E2eSafetyError extends Error {}

export function httpsUrl(env: E2eEnv): string;
export function scratchRef(env: E2eEnv, scenario: string): string;
export function assertScratchRef(env: E2eEnv, ref: string): void;
export function writerCredential(env: E2eEnv): GitCredential;
export function wrongCredential(env: E2eEnv): GitCredential;
export function emptyTokenCredential(env: E2eEnv): GitCredential;
export function listRemoteRefs(
  paths: GitPaths,
  env: E2eEnv,
  pattern: string,
  credential?: GitCredential,
): Promise<Readonly<Record<string, string>>>;

export function pushScratchRef(
  paths: GitPaths,
  env: E2eEnv,
  input: Readonly<{ ref: string; oid: string; credential?: GitCredential }>,
): Promise<void>;
export function deleteScratchRefs(
  paths: GitPaths,
  env: E2eEnv,
): Promise<readonly string[]>;
```

`httpsUrl` is `` `https://github.com/${env.ghRepo}.git` `` and carries **no** userinfo. The credential travels through EPIC 006's helper, and a url with a token in it is refused by EPIC 006 Story 02 anyway.

`scratchRef(env, scenario)` is `` `${E2E_REF_PREFIX}/${scenario}-${env.runId}` ``.

`assertScratchRef` throws `E2eSafetyError` unless the ref starts with `E2E_REF_PREFIX + "/"`, and throws unconditionally when the ref equals `` `refs/heads/${env.ghBaseBranch}` ``. Every scenario that names a publish ref passes it through this function first. `E2E_GH_BASE_BRANCH` is read-only for the whole gate, and the guard is what makes that structural rather than a habit.

`writerCredential` returns `{ transport: "http-basic", forge: "github", username: "x-access-token", token: env.ghToken }`. The username is `x-access-token` because a fine-grained personal access token authenticates as the password of an arbitrary username, and `forgeConventions.github` (EPIC 006 Story 03) sends the credential's own username unchanged.

`wrongCredential` is the same record with `token: "github_pat_" + "0".repeat(22)`. `emptyTokenCredential` is the same record with `token: ""`.

`listRemoteRefs` runs `ls-remote <httpsUrl> <pattern>` through `runAuthenticated` with `credential ?? writerCredential(env)` and returns a ref-to-object-id record. The parameter exists because scenario `E7-00a` proves a wrong credential is rejected against the same repository, and a helper hard-wired to the writer could not express it. A non-zero exit throws the `GitError` `classifyFailure` produced.

`pushScratchRef` calls `assertScratchRef(env, input.ref)` **first**, then runs `push -- <httpsUrl> <oid>:<ref>` through `runAuthenticated`. It is the only function in the harness that pushes without `--dry-run`, and the guard precedes the process. Story 13 asserts it is the only one. `deleteScratchRefs` lists `` `${E2E_REF_PREFIX}/*` ``, pushes a deletion refspec for every ref whose name ends with `` `-${env.runId}` ``, and returns the deleted names. It deletes **only** refs of the current run, so a concurrent run's refs survive.

### 3. `scripts/e2e/007/00-harness.e2e.ts` (new)

Two scenarios, ids `E7-00a` and `E7-00b`, which prove the harness before any story trusts it.

### 4. `package.json` — one script

Add after `"test"`:

```json
    "e2e:007": "node scripts/e2e/007/run.ts",
```

`run.ts` is Story 13's parent driver. It is **not** `node --test scripts/e2e/007/*.e2e.ts`: `node --test` runs each file in its own process and may run several at once, so a glob gives no ordering, no shared run id, and no before-and-after measurement around the whole suite. Story 13 specifies the driver.

The file suffix `.e2e.ts` matches none of Node's default test patterns, so `npm test` never collects one whichever way the gate is invoked.

Do **not** add `e2e:007` to `verify`. `npm run verify` stays hermetic.

### 5. `tsconfig.json` — include the harness

`include` becomes `["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]`. Without this the harness is neither type-checked nor covered by `npm run typecheck`, and a signature drift in `src/services/git/` would surface only when someone ran the gate.

### 6. `eslint.config.js` — one new block

Append a final configuration object:

```js
  {
    // The end-to-end harness is an out-of-tree consumer, not production code.
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
```

It carries no `boundaries` plugin and no `no-restricted-imports`. The harness reaches an implementation on purpose: it is the only consumer that proves the real binary against the real forge, and a boundary that forbade that would leave the epic with no end-to-end evidence. Without the block, ESLint parses a `.ts` file under `scripts/` with the default parser and fails on the first type annotation.

### 7. `src/domain/layout.test.ts` — the hermetic fence

Append one test:

```ts
  it("no file under scripts/ is collected by the default test runner", () => { … });
```

Walk `scripts/` recursively. Assert, for every file:

- no path segment is exactly `test`, and
- the basename matches none of `/\.test\.[cm]?[jt]s$/`, `/-test\.[cm]?[jt]s$/`, `/_test\.[cm]?[jt]s$/`, `/^test-/`, `/^test\.[cm]?[jt]s$/`.

The failure message names the offending path and states that `npm test` would run it.

Append a second test: walk `src/` and `test/` and assert no `.ts` file contains the substring `"scripts/e2e"` or the substring `".env.e2e"`. Placement alone does not prove hermeticity — a hermetic test that imported a harness module, or read the credential file, would pass the first assertion and make a network call anyway. Those five patterns plus a `test` directory segment are Node's default collection set, which is why the list is exact rather than "anything test-shaped".

## Constraints

- `.env.e2e` is never read by anything under `src/` or `test/`. `.gitignore` already covers `.env.*`, and the file stays untracked.
- No secret reaches an argument vector. `writerCredential` builds a `GitCredential`, and delivery is EPIC 006 Story 03's helper. Never interpolate `env.ghToken` into a url, a ref or a command string.
- Every scenario writes only under `E2E_REF_PREFIX`. `assertScratchRef` is the only sanctioned path to a ref name.
- No scenario writes `refs/heads/<E2E_GH_BASE_BRANCH>` or any tag.
- The harness never prints `env.ghToken`. A helper that echoes a failure passes `stderr` through `stripUserinfo` from `src/services/git/redact.ts` first.
- `scripts/e2e/**` imports exactly two files under `test/`: `test/helpers/daemon.ts` and `test/helpers/home.ts`. Both are named here because Stories 04 onward boot a real daemon, and a second daemon-spawning mechanism would drift from the one the hermetic suite uses. Any other `test/` import is refused, and Story 13's gate asserts it.
- No file under `src/` or `test/` imports anything under `scripts/`, and none mentions `.env.e2e`. Story 13's gate asserts both.

## Verify

`node --test scripts/e2e/007/00-harness.e2e.ts` for the scenarios, and `node --test src/domain/layout.test.ts` for the fence.

### Unit-shaped cases inside `00-harness.e2e.ts`, no network

- `parseDotEnv` on `"# c\nA=1\n\nB=x=y\nnoequals\nC=\n"` deep-equals `{ A: "1", B: "x=y", C: "" }`. The `B` row is the split-on-first-`=` assertion, and the `C` row proves an empty value parses rather than throwing, so the emptiness check belongs to `loadE2eEnv`.
- `parseDotEnv` on a line whose value is `'quoted'` returns the value **with** the quotes. Quote stripping is not performed, asserted directly.
- `loadE2eEnv({ file: <a path that does not exist> })` throws `E2eEnvError` whose `missing` deep-equals `E2E_REQUIRED_KEYS`.
- `loadE2eEnv({ file: <a written file holding only E2E_GH_TOKEN=x> })` throws `E2eEnvError` whose `missing` deep-equals `["E2E_GH_REPO", "E2E_GH_BASE_BRANCH"]`, and whose message contains both names.
- `loadE2eEnv({ file: <a file whose E2E_GH_REPO is empty> })` throws, and `missing` contains `"E2E_GH_REPO"`. An empty value is a missing value.
- `assertScratchRef(env, "refs/heads/main")` throws `E2eSafetyError`. So does `assertScratchRef(env, "refs/heads/kanthord-e2e/other")` — the prefix must match `refs/heads/kanthord-e2e/007/`. `assertScratchRef(env, scratchRef(env, "probe"))` returns `undefined`.
- With `env.ghBaseBranch === "kanthord-e2e/007/x"`, `assertScratchRef(env, "refs/heads/kanthord-e2e/007/x")` still throws. The base-branch guard runs after the prefix check and is not shadowed by it.
- `httpsUrl(env)` contains neither `"@"` nor `env.ghToken`.
- `scratchRef(env, "seed")` ends with `` `-${env.runId}` ``, and two calls in one process return the same string.

### Scenario `E7-00a` — the real remote answers

- `loadE2eEnv()` with no override resolves the three keys from `.env.e2e`.
- `listRemoteRefs(paths, env, "refs/heads/*")` resolves a record containing the key `` `refs/heads/${env.ghBaseBranch}` ``, whose value matches `/^[0-9a-f]{40}$/`. That is the proof the token reads the named repository, and it asserts the base branch exists before any later scenario fetches it.
- The same call with `wrongCredential` rejects with a `GitError` whose `failure` is `"auth-failed"`. Both halves run against the same repository in one scenario, so a passing read is not confused with an unauthenticated read.

### Scenario `E7-00b` — the cleanup is real

- `pushScratchRef(paths, env, { ref: scratchRef(env, "harness"), oid: <the base branch object id> })`, then assert `listRemoteRefs` reports that ref at that object id. This is the only scenario in the epic that creates a remote ref on purpose, and `pushScratchRef` is the only harness function that pushes without `--dry-run`; every other scenario reads or dry-runs.
- `deleteScratchRefs(paths, env)` returns an array containing that ref name, and a following `listRemoteRefs(paths, env, "refs/heads/kanthord-e2e/007/*")` reports no ref ending in `` `-${env.runId}` ``.
- The scenario registers the deletion in an `after` hook as well, so a failed assertion still removes the ref.
- `pushScratchRef` refuses a ref outside the prefix: call it with `refs/heads/${env.ghBaseBranch}` and assert it throws `E2eSafetyError` **and** that `listRemoteRefs` reports the base branch at its original object id. The guard runs before the process, so the refusal costs no network call and the base branch is provably untouched.

### `src/domain/layout.test.ts`

- The new test passes against the tree this story creates: `scripts/e2e/env.ts`, `scripts/e2e/remote.ts` and `scripts/e2e/007/00-harness.e2e.ts` are all outside the default collection set.
- The test's own negative control: build the same predicate over the literal list `["scripts/e2e/test/x.ts", "scripts/e2e/x.test.ts", "scripts/e2e/test-x.ts"]` and assert every entry is reported. The walk and the predicate are separate functions so the predicate is testable without writing a file that would then be collected.

`npm run verify` exits 0. `npm run e2e:007` exits 0 on a machine holding `.env.e2e`, and exits non-zero naming the missing keys on one that does not.

Proof: contributes no file to the epic Proof line. It extends `src/domain/layout.test.ts`, which is already inside `npm test`, and it establishes the `npm run e2e:007` gate that Story 13 closes.
