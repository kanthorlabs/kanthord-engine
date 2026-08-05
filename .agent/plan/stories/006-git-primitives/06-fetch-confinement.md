# Story 06 — Fetch confinement

Epic: `.agent/plan/epics/006-git-primitives.md`
Depends on: Story 01 (`createGitRunner`, `stripUserinfo`), Story 03 (`runAuthenticated`, `classifyFailure`).

**The contract is exact: a fetch writes no ref outside `refs/remotes/origin/*`.** It is not "a fetch writes nothing else". A fetch writes objects, it writes `FETCH_HEAD`, and it may write `refs/remotes/origin/HEAD`; `docs/proposal/phase-1/git-foundation.md:46` names all three as remote observations the ref-role table permits. The confinement this story delivers is over the ref namespace, and the refspec alone does not achieve even that.

## Change

### 1. `src/services/git/index.ts` — the pid file and the refspec constant

At `src/services/git/index.ts:111-113`, widen the `fetch` member of `Git`:

```ts
fetch(
  input: Readonly<{
    gitDir: string;
    credential: GitCredential;
    pidFile: string;
  }>,
): Promise<void>;
```

Append the constant:

```ts
export const TRACKING_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
```

`TRACKING_REFSPEC` is one exported literal because two stories write it — this one on the command line, and EPIC 007's seeding into `remote.origin.fetch`. Two copies of a refspec is two chances for one of them to drop the leading `+`.

### 2. `src/services/git/fetch.ts` (new)

```ts
import {
  GitError,
  TRACKING_REFSPEC,
  type GitCredential,
  type GitPaths,
} from "./index.ts";
import { classifyFailure } from "./credential.ts";
import { stripUserinfo } from "./redact.ts";
import { runAuthenticated } from "./authenticated.ts";
import type { GitRunner } from "./run.ts";

export type FetchInput = Readonly<{
  gitDir: string;
  credential: GitCredential;
  pidFile: string;
}>;

export function fetchTracking(
  runner: GitRunner,
  paths: GitPaths,
  input: FetchInput,
): Promise<void>;
```

`fetchTracking` calls `runAuthenticated` with these arguments, in this order:

```
--git-dir=<gitDir> fetch origin --prune --no-tags <TRACKING_REFSPEC>
```

The refspec is on the command line as well as in `<home>/config`. A command-line refspec overrides the configured one, so the confinement does not depend on a configuration file the daemon wrote earlier and that a human could edit.

On `code === 0` it resolves. On a non-zero code it throws `GitError(classifyFailure({ code, stderr, eraseObserved }), `git fetch failed with code ${code}`, stripUserinfo(stderr))`.

Three measured facts fix the argument list:

- `--no-tags` is required, and the refspec does not replace it. Tag auto-follow writes `refs/tags/*` on a plain fetch whatever the refspec says. Measured: with `--no-tags` against a remote holding `refs/tags/v1`, the home's `refs/tags` count is `0`.
- A force-push on the remote force-updates `refs/remotes/origin/*` and does not touch `refs/heads/*`. Measured: after a remote force-push from `C2` to `C3`, `refs/remotes/origin/main` reports `C3` and `refs/heads/<landing>` still reports the earlier value. The leading `+` on the refspec is what allows the tracking side to move.
- A fetch also writes `FETCH_HEAD`, and may write `refs/remotes/origin/HEAD`. Both are remote observations and the ref-role table permits them, so neither is a failure. The daemon never depends on `refs/remotes/origin/HEAD` existing.

`--no-write-fetch-head` is deliberately **not** passed. `git-foundation.md:46` permits `FETCH_HEAD` explicitly, and suppressing a write the proposal permits would be a new policy rather than this story's confinement.

## Constraints

- Never call `fetch` without `--no-tags`, and never add `--tags`.
- Never omit `--prune`. A deleted remote branch must not leave a tracking ref that a later read treats as live.
- Never write a refspec whose right side is `refs/heads/*`. The one refspec this service uses is `TRACKING_REFSPEC`.
- Never pass `--update-head-ok`, `--force` or `--all`.
- The raised error carries `stripUserinfo(stderr)` and never the raw `stderr`. Story 03 owns the strip.
- **`fetchTracking` never removes `input.pidFile`.** It is the caller's path, and Story 01 §5 puts it under the `git_operation` row that `.agent/plan/epics/007.5-startup-recovery.md:23` owns. Removing it destroys the evidence the reap reads. `refUpdate` removes nothing either, and the two journaled writes must agree. A caller that retries mints a fresh path per attempt: the launcher runs under `set -C`, so a surviving path makes the next spawn exit `111`. The test helper mints `fetch-${randomUUID()}.pid` for this reason.

## Verify

`node --test src/services/git/fetch.test.ts` — new file, suite `"src/services/git/fetch.test"`.

Unit case, no process: `TRACKING_REFSPEC` is exactly `"+refs/heads/*:refs/remotes/origin/*"`.

Integration cases. Each takes `await createHttpRemote()` from `test/helpers/remote/index.ts` (EPIC 005 Story 05) and builds its own bare home by hand — `git init --bare --template=`, `remote add origin <remote.url("fixture.git")>`, `config remote.origin.fetch <TRACKING_REFSPEC>` — through `runGit`. Seeding as a product operation is EPIC 007; this story seeds inside its own test file. The credential is `remote.credentials.writer`, mapped to a `GitCredential` of transport `http-basic`. `after` awaits `remote.dispose()`.

The fixture repository `fixture.git` holds `refs/heads/main` at `fixtureObjectIds.commit2` and `refs/tags/v1`, so the tag case needs no extra setup. The remote is moved with `remote.seed.git("fixture.git", [...])`, which is the harness's own write path — `.agent/plan/stories/005-test-infrastructure/index.md:141`.

- **A fetch writes the tracking namespace only.** After `fetchTracking`, `git --git-dir=<home> for-each-ref --format=%(refname)` lists `refs/remotes/origin/main` and lists no `refs/heads/*`. Assert the full list, sorted, rather than the absence of one name. Filter nothing: an `refs/remotes/origin/HEAD` entry is permitted, so accept a list that is either `["refs/remotes/origin/main"]` or that plus `refs/remotes/origin/HEAD`, and assert every entry begins with `refs/remotes/origin/`. That predicate is the contract; an exact list would encode one git version's choice about `origin/HEAD`.
- **A tagged remote leaves `refs/tags` empty.** The fixture repository carries `refs/tags/v1`. After the fetch, `for-each-ref refs/tags` reports an empty list. This is the epic coverage line "A fetch against a tagged fixture repository writes no `refs/tags/*`."
- **A force-push moves the tracking ref and not the landing branch.** After the first fetch, write `refs/heads/land` at `commit2` with `runGit({ args: ["--git-dir=<home>", "update-ref", "refs/heads/land", commit2, ""] })`. This story tests `fetch.ts`, so the landing write is fixture setup through the runner and not a call into `ref-update.ts`. Then rewind the remote with `remote.seed.git("fixture.git", ["update-ref", "refs/heads/main", commit1, commit2])`. A rewind is a non-fast-forward, which is exactly the force case, and it needs no third commit. Fetch again. Assert `rev-parse refs/remotes/origin/main` is `commit1` — the tracking ref moved backwards, which only a `+` refspec permits — and `rev-parse refs/heads/land` is still `commit2`. Both are `fixtureObjectIds` literals. This is the epic coverage line "A force-push on the HTTP fixture remote, then a fetch: the tracking ref moved and `refs/heads/<landing>` did not."
- **A second fetch after the landing write does not move the landing branch.** Repeat the fetch with no remote change and assert `refs/heads/land` is unchanged and the command exits `0`.
- **A transport failure throws a classified error and writes nothing.** After a successful first fetch, repoint `remote.origin.url` at `http://127.0.0.1:1/fixture.git` — a dead port — and fetch again. `fetchTracking` rejects with a `GitError` whose `failure` is `"transport-failed"`, and the home's tracking refs are byte-identical to what they were before the call, compared through the sorted `for-each-ref` output.

  This case does **not** assert `auth-failed`. The EPIC 005 HTTP fixture gates its `401` on a write request (`test/helpers/remote/http.ts:196`), so it serves every read anonymously and no credential presented to a fetch can be wrong. A fetch therefore cannot produce `auth-failed` against the fixture, and the `auth-failed` verdict is proved on the push path instead — `authenticated.test.ts:173` asserts it comes from the helper observing the `erase`, including when `stderr` is empty. Do not teach the fixture to authenticate reads to recover this case: real forges serve some reads anonymously, and the epic's coverage list never asks for a wrong-credential fetch.

- **The error carries no userinfo.** Set a second home's `remote.origin.url` to `remote.authenticatedUrl("fixture.git", remote.wrongCredential)`, which embeds the userinfo, force the failure, and assert `error.detail` includes neither `"writer@"` nor `"bad-tok"`, and does include `127.0.0.1`. The token half is Story 03's assertion; this is the url half.
- **`FETCH_HEAD` is not a failure.** After a successful fetch, `fs.existsSync(join(home, "FETCH_HEAD"))` is `true` and the call resolved. The assertion records that the file is expected, so a later reviewer does not add a check that forbids it.

`npm run verify` exits 0.

Proof: contributes `src/services/git/fetch.test.ts` to `node --test src/services/git/**/*.test.ts`.
