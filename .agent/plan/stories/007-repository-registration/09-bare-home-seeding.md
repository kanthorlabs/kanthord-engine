# Story 09 — Bare home seeding

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 07 (`canPush`), Story 08 (`trustHostKey`), EPIC 006 Stories 05 and 06 (`refUpdate`, `fetchTracking`).

Init bare into a staging directory, add the remote, set the refspec, fetch with prune and `--no-tags`, read the upstream object id from the tracking ref, write the landing branch against an empty expected value, then rename into place. A bare clone of the remote is forbidden, and a partially seeded home is never visible. This story also assembles `BinaryGit`.

## Change

### 1. `src/services/git/seed.ts` (new)

```ts
import type { GitCredential, GitPaths, SeedHomeInput } from "./index.ts";
import type { GitRunner } from "./run.ts";

export type SeedHomeResult = Readonly<{
  homePath: string;
  fetchedUpstreamOid: string;
  landingOid: string;
}>;

export type SeedStep =
  | "host-key"
  | "init"
  | "remote-add"
  | "refspec"
  | "fetch"
  | "read-upstream"
  | "preflight"
  | "landing"
  | "rename";

export type SeedHomeExtended = SeedHomeInput &
  Readonly<{
    publishRef: string;
    remoteUrl: string;
    hostKey: HostKey | null;
    pidFile: string;
    failAfter?: SeedStep;
  }>;

export function stagingPathFor(gitDir: string): string;

export function seedHome(
  runner: GitRunner,
  paths: GitPaths,
  input: SeedHomeExtended,
): Promise<SeedHomeResult>;
```

`SeedHomeInput` at `src/services/git/index.ts:14-20` already carries `gitDir`, `remoteUrl`, `upstreamBranch`, `landingBranch` and `credential`. `SeedHomeExtended` adds the publish ref the preflight needs, the confirmed host key, and the caller's `pidFile`.

`stagingPathFor(gitDir)` is `join(dirname(gitDir), `.staging-${randomUUID()}`)`. The `.staging-` prefix is load-bearing: EPIC 007.5's sweep matches it, and a different prefix leaves a directory nothing removes.

`failAfter` is a test seam and it is a required part of the contract, not a convenience. The epic requires an assertion that a failure injected after the fetch leaves no visible home, and there is no other way to reach that state deterministically. It defaults to `undefined`, it is never set by any production caller, and `seedHome` throws `GitError("unknown", `seed aborted after ${step}`, "")` immediately after the named step completes.

`SeedStep` is declared in execution order, and the nine steps below are that order. The preflight sits between the upstream read and the landing write, because a push needs a local object: before the fetch there is none, so a preflight ahead of it could only fail on its own refspec. The epic states the same placement at `:20`.

The sequence, in this exact order. Step 0 is a guard and has no `SeedStep` member.

0. Refuse when `input.gitDir` already exists: `GitError("unknown", "the repository home already exists", "")`. The check is `existsSync`, and it precedes the staging create so a re-registration cannot start work it will discard.
1. **`host-key`.** When `input.hostKey` is not `null`, `trustHostKey(paths, { remoteUrl: input.remoteUrl, hostKey: input.hostKey })`. It runs before any connection that is not the scan itself, so both the fetch and the preflight run under `StrictHostKeyChecking=yes`.
2. **`init`.** `["init", "--bare", "--template=", "--object-format=sha1", "--initial-branch=" + input.landingBranch, "--", staging]`. `--template=` installs no hook, per `docs/proposal/phase-1/git-foundation.md:184`. `--initial-branch` names the landing branch so `HEAD` points at it; the branch itself does not exist until step 7.
3. **`remote-add`.** `["--git-dir=" + staging, "remote", "add", "origin", "--", input.remoteUrl]`.
4. **`refspec`.** `["--git-dir=" + staging, "config", "remote.origin.fetch", TRACKING_REFSPEC]`. `TRACKING_REFSPEC` is EPIC 006 Story 06's exported literal, `+refs/heads/*:refs/remotes/origin/*`. It is imported, never retyped.
5. **`fetch`.** `fetchTracking(runner, paths, { gitDir: staging, credential: input.credential, pidFile: input.pidFile })`.
6. **`read-upstream`.** `U = resolveRef(runner, { gitDir: staging, ref: "refs/remotes/origin/" + input.upstreamBranch })`. A `null` result throws `GitError("unknown", `the branch ${input.upstreamBranch} does not exist on the remote`, "")`. `git-foundation.md:48` requires registration to fail and change nothing when the confirmed branch no longer exists after the fetch, and it requires the landing object id to come from the tracking ref rather than from the earlier symref detection.
7. **`preflight`.** `canPush(runner, paths, { gitDir: staging, remoteUrl: input.remoteUrl, publishRef: input.publishRef, proposedOid: U, credential: input.credential })`. An `allowed: false` verdict throws `GitError(verdict.failure, `the credential may not push to ${input.publishRef}`, verdict.detail)`.
8. **`landing`.** `refUpdate(runner, { gitDir: staging, ref: "refs/heads/" + input.landingBranch, expectedOid: null, nextOid: U, pidFile: input.pidFile })`. An `updated: false` result throws `GitError("unknown", `refs/heads/${input.landingBranch} already exists in the new home`, "")`. `expectedOid: null` asserts the ref does not exist, per `git-foundation.md:50`.
9. **`rename`.** Flush, then `renameSync(staging, input.gitDir)`, then flush the parent directory. The flush is `openSync(dir, "r")` followed by `fsyncSync(fd)` and `closeSync(fd)` — first on `staging`, then on `dirname(input.gitDir)` after the rename. `git-foundation.md:44` requires that a home visible after a power loss is complete on disk.

**Cleanup.** Every failure from step 2 onward runs `rmSync(staging, { recursive: true, force: true })` and rethrows. A crash leaves the staging directory for EPIC 007.5's sweep. `input.gitDir` is never removed by this function.

`seedHome` never runs `git clone`. `git-foundation.md:28` forbids a bare clone of the remote, because it copies remote heads directly into `refs/heads/*`.

### 2. `src/services/git/binary.ts` (new) — assemble the interface

```ts
import type { Git, GitPaths } from "./index.ts";
import type { GitRunner } from "./run.ts";

export type BinaryGitDependencies = Readonly<{
  runner: GitRunner;
  paths: GitPaths;
}>;

export function createBinaryGit(dependencies: BinaryGitDependencies): Git;
```

Twelve members, each a delegation and no logic of its own:

| member               | delegates to                                    | owner           |
| -------------------- | ----------------------------------------------- | --------------- |
| `remoteUrlVerdict`   | `remoteUrlVerdict` from `./url.ts`              | EPIC 006 St. 02 |
| `fetch`              | `fetchTracking` from `./fetch.ts`               | EPIC 006 St. 06 |
| `resolveRef`         | `resolveRef` from `./ref-read.ts`               | EPIC 006 St. 07 |
| `refUpdate`          | `refUpdate` from `./ref-update.ts`              | EPIC 006 St. 05 |
| `checkOutsideWriter` | `checkOutsideWriter` from `./outside-writer.ts` | EPIC 006 St. 07 |
| `clone`              | `cloneObjective` from `./clone.ts`              | EPIC 006 St. 08 |
| `scanHostKeys`       | `scanHostKeys` from `./host-key.ts`             | Story 05        |
| `confirmHostKey`     | `confirmHostKey` from `./host-key.ts`           | Story 08        |
| `trustHostKey`       | `trustHostKey` from `./host-key.ts`             | Story 08        |
| `remoteInfo`         | `remoteInfo` from `./remote-info.ts`            | Story 06        |
| `canPush`            | `canPush` from `./preflight.ts`                 | Story 07        |
| `seedHome`           | `seedHome` from `./seed.ts`                     | this story      |

`Git.seedHome` at `src/services/git/index.ts:100` returns `Promise<void>`. Widen it to `Promise<SeedHomeResult>` and to `SeedHomeExtended`: the caller needs `fetchedUpstreamOid` for the `repository` row and `landingOid` for the baseline journal row, and a command that had to re-read them would run two more processes to recover a value the seed already held.

`createBinaryGit` is a function returning an object literal, not a class. `AGENTS.md` forbids no class, and the record is chosen because twelve one-line delegations in a literal cannot accumulate state, which is the whole risk a class here would carry.

This is the story `.agent/plan/stories/006-git-primitives/index.md:127` names: five of the interface members were EPIC 007's, and the class could not exist until the last one landed.

### 3. `src/domain/layout.test.ts` — no new service directory

`src/services/` still holds thirteen directories, so `:66-80` needs no edit. Assert that explicitly in the story so no one adds one.

## Constraints

- `seedHome` runs no `git clone`, ever.
- The refspec is `TRACKING_REFSPEC`, imported from `./fetch.ts`. Never a literal in this file.
- `--no-tags` reaches the fetch through `fetchTracking`, which pins it. Never call `fetch` directly here.
- `refUpdate` is called with `expectedOid: null`, never with a zero-filled string.
- `input.gitDir` is never created, written or removed by this function. Only `renameSync` makes it exist.
- The staging directory is named by `stagingPathFor` and its prefix is `.staging-`.
- `trustHostKey` runs before the fetch and before the preflight. Reordering it makes the two connections run against an unpinned host.
- `failAfter` has no production caller. Assert that by construction: a test reads every file under `src/commands/` and `src/http/` and asserts none contains the string `failAfter`.
- No `127.` and no `"localhost"` literal in `seed.ts` or `binary.ts`.

## Verify

`node --test src/services/git/seed.test.ts src/services/git/binary.test.ts`

### The command sequence, no process

Drive `seedHome` with a recording runner that returns `code: 0` and, for the `rev-parse` call, the fixture object id.

- The recorded `args[0]` arrays, in order, deep-equal the nine-step sequence above, with `TRACKING_REFSPEC` appearing as the value of `remote.origin.fetch` and `--template=` and `--object-format=sha1` present in the `init` vector.
- No recorded vector contains `"clone"`.
- No recorded vector contains `"--tags"`, `"--force"`, `"--all"` or `"--update-head-ok"`.
- The `fetch` vector precedes the `rev-parse` vector, which precedes the `push --dry-run` vector, which precedes the `update-ref` vector. Four ordering assertions by index, which is what pins the preflight between the read and the landing write.
- With `hostKey: null`, `paths.knownHosts` is unchanged and the `init` vector is first.
- With a `hostKey`, `paths.knownHosts` holds the line before the `fetch` vector was recorded. Assert by reading the file inside the recording runner on the `fetch` call.

### Against the HTTP fixture

`await createHttpRemote()`, disposed in `after`. `paths` from `buildGitPaths` under a `mkdtempSync` home.

- **A registration produces the tracking namespace and exactly one landing branch.** `seedHome` with `upstreamBranch: "main"`, `landingBranch: "main"` and `remote.credentials.writer` resolves, and then on the visible home:
  - `for-each-ref refs/remotes/origin` reports at least `refs/remotes/origin/main`, and every reported ref begins with `refs/remotes/origin/`. EPIC 005 measured that a fetch writes `refs/remotes/origin/HEAD` as well, so the assertion is a namespace predicate rather than a one-entry list.
  - `for-each-ref refs/heads` reports exactly `["refs/heads/main"]`, and its object id equals `fixtureObjectIds.commit2`, `251c92d5a215053aea80432f179653f99072835d`.
  - `result.fetchedUpstreamOid` and `result.landingOid` both equal that object id, and `result.homePath` equals the requested `gitDir`.
- **A branch mode writes one landing branch under another name.** With `landingBranch: "kanthord/main"`, `for-each-ref refs/heads` reports exactly `["refs/heads/kanthord/main"]` at the same object id, and `refs/heads/main` does not exist.
- **No tag is written against a tagged fixture.** `for-each-ref refs/tags` on the seeded home reports nothing. EPIC 005 seeds `refs/tags/v1`, and `--no-tags` is what keeps it out. This is the epic coverage line.
- **`<home>/config` is a closed set.** Read it and assert it contains `remote "origin"`, `url`, `fetch`, and none of `include`, `includeIf`, `alternates`, `partialclonefilter`, `gpgsign`. `git-foundation.md:85` fixes the set.
- **A failure after the fetch leaves no visible home, only a staging directory.** `seedHome` with `failAfter: "fetch"` rejects, `existsSync(gitDir)` is `false`, and `readdirSync(dirname(gitDir))` holds no entry beginning with `.staging-` — the cleanup ran. Then run it again with a runner wrapper that throws before the `rmSync` can execute, and assert `existsSync(gitDir)` is still `false` while one `.staging-` entry remains. The two halves are the epic coverage line "leaves no visible home, only a staging directory": the first proves the ordinary path cleans up, the second proves the crash path leaves the sweep's own prefix.
- **A missing upstream branch fails and changes nothing.** `upstreamBranch: "does-not-exist"` rejects with a message naming that branch, `existsSync(gitDir)` is `false`, and the remote is untouched — `remoteRefValue` for `refs/heads/main` is unchanged.
- **An existing home is refused before any work.** Create `gitDir` as an empty directory, call `seedHome`, and assert it rejects with `"the repository home already exists"` and that the directory is still empty and no `.staging-` entry was created.
- **A read-only credential is refused by the preflight and leaves no home.** `remote.credentials.reader` fetches successfully and then fails step 7. `seedHome` rejects with a `GitError` whose `failure` is `"auth-failed"`, `existsSync(gitDir)` is `false`, and the fetch is proved to have succeeded by asserting the rejection message names the publish ref rather than the fetch.
- **The rename is the only thing that makes the home visible.** Wrap the runner so that on the `update-ref` call it asserts `existsSync(gitDir) === false` while `existsSync(staging) === true`. The staging path is recovered from the recorded `--git-dir=` argument.
- **The token appears nowhere.** After a successful seed, assert the token is absent from `<home>/config`, from every recorded `args` array, and from `fs.readdirSync(paths.keyDirectory)` contents.

### Against the ssh fixture

`await createSshRemote()`, disposed in `after`.

- **An ssh url seeds with a confirmed host key.** Confirm with `remote.hostKeys[0].fingerprint`, pass the returned key as `input.hostKey`, and assert the seed resolves, that `paths.knownHosts` holds the matching line, and that `refs/heads/<landing>` is at `fixtureObjectIds.commit2`.
- **A wrong host key refuses.** Pass `remote.wrongHostKey` as `input.hostKey`. `trustHostKey` writes it, the fetch then fails, and `seedHome` rejects with `failure === "host-key-mismatch"`. `existsSync(gitDir)` is `false`, and `paths.knownHosts` still holds the wrong line — this story does not undo a pin it was told to write, and the epic's `409` guard is Story 10's, which never reaches `seedHome` on a mismatch. Pass an explicit `timeoutMs` below the default so a hang fails as `timed-out`.
- **A credential whose transport disagrees with the url refuses before any process.** An `ssh://` url with an `http-basic` credential rejects with `failure === "url-refused"` and the recording runner records no request.

### `src/services/git/binary.test.ts`

- `Object.keys(createBinaryGit({ runner, paths }))` bytewise sorted deep-equals the twelve member names, and its length is `12`. The interface holds eleven members today at `src/services/git/index.ts:95-119`, and Story 08 adds `confirmHostKey`.
- Every member is a function, and `createBinaryGit` returns a new object each call.
- For each member, a recording runner proves the delegation reached the right module: assert on the first token of the recorded `args` — `remoteUrlVerdict` records nothing, `fetch` records `fetch`, `resolveRef` records `rev-parse`, `refUpdate` records `update-ref`, `clone` records `clone`, `remoteInfo` records `ls-remote`, `canPush` records `push`, `scanHostKeys` records no `git` call at all. Eight assertions, one per delegating member with a process.
- `createBinaryGit(...)` type-checks as `Git`. Assert by assigning it to a `const git: Git` in the test; `tsc --noEmit` is the mechanism and the assignment is what invokes it.
- **`failAfter` reaches no production caller.** Walk `src/commands/`, `src/queries/`, `src/http/` and `src/cli/`, and assert no `.ts` file contains the string `failAfter`.

### E2E — scenario `E7-09`, real `github.com`

File `scripts/e2e/007/09-bare-home-seeding.e2e.ts`.

- `seedHome` against `httpsUrl(env)` with `upstreamBranch: env.ghBaseBranch`, `landingBranch: env.ghBaseBranch`, `publishRef: scratchRef(env, "seed")` passed through `assertScratchRef`, and `writerCredential(env)`, resolves into a `mkdtempSync` home.
- `result.fetchedUpstreamOid` equals `remoteRefValue` for `` `refs/heads/${env.ghBaseBranch}` `` read independently, and matches `/^[0-9a-f]{40}$/`.
- `for-each-ref refs/heads` on the seeded home reports exactly one ref, `` `refs/heads/${env.ghBaseBranch}` ``, at that object id. This is the goal line "exactly one landing branch at the detected default", against the real remote.
- `for-each-ref refs/remotes/origin` reports more than one ref and every one begins with `refs/remotes/origin/`. The real repository holds sixteen branches, so this is the assertion the single-branch fixture cannot make: a real fetch fills the tracking namespace and writes exactly one head.
- `for-each-ref refs/tags` reports nothing.
- **The remote is unchanged.** The scratch publish ref is absent before and after, and the base branch object id is equal before and after. The seed's own preflight is a dry run.
- **A missing upstream branch fails and leaves no home.** `upstreamBranch: "kanthord-e2e-does-not-exist"` rejects, and `existsSync(home)` is `false`.
- **A wrong token fails at the preflight, after a successful fetch.** With `wrongCredential(env)` the fetch itself fails first — a private repository refuses a read — so the scenario instead uses `writerCredential(env)` for the seed and asserts the wrong-token preflight refusal in Story 07's scenario, where it stands alone. Assert here only that `seedHome` with `wrongCredential(env)` rejects and leaves no visible home, whatever step failed.
- `<home>/git/home` and the seeded `gitDir` are removed in an `after` hook, and `deleteScratchRefs` runs even though the scenario expects to have created none.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/services/git/seed.test.ts` and `src/services/git/binary.test.ts`. Story 13 records the Proof widening.
