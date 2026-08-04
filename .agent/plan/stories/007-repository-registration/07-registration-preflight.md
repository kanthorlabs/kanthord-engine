# Story 07 — The registration preflight

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 01 (`GitPaths`), EPIC 006 Story 03 (`runAuthenticated`, `classifyFailure`).

`git push --dry-run` against the publish ref, from the staging home, after the fetch and before the rename. It proves write-advertisement access and no more. It asserts the remote ref did not move.

## Change

### 1. `src/services/git/preflight.ts` (new)

```ts
import type { GitCredential, GitPaths, PushPreflight } from "./index.ts";
import type { GitRunner } from "./run.ts";

export type CanPushInput = Readonly<{
  gitDir: string;
  remoteUrl: string;
  publishRef: string;
  proposedOid: string;
  credential: GitCredential;
}>;

export function canPush(
  runner: GitRunner,
  paths: GitPaths,
  input: CanPushInput,
): Promise<PushPreflight>;
```

`PushPreflight` at `src/services/git/index.ts:75-77` is already `{ allowed: true } | { allowed: false; failure; detail }`.

`CanPushInput` widens the interface member. Change `Git.canPush` at `src/services/git/index.ts:104-110` to take `CanPushInput`. The interface signature today names `remoteUrl`, `publishRef` and `credential` and omits the two the primitive cannot work without: a push needs a local repository, which `gitDir` names, and a local object, which `proposedOid` names.

The single command:

```
--git-dir=<gitDir> push --dry-run -- <remoteUrl> <proposedOid>:<publishRef>
```

- `--dry-run` is what makes the call safe. Measured against `github.com`: a dry run with a valid token printed `* [new branch]` and exited `0`, and a following `ls-remote` reported no such ref.
- `--` ends the option list, so a url or a ref beginning with `-` cannot become a flag.
- The refspec is built by string concatenation in TypeScript, never by a shell. Measured: in `zsh`, `"$U:refs/heads/x"` is expanded as `${U:r}` followed by `efs/heads/x`, because `:r` is a parameter modifier. No refspec in this product is ever built in a shell.
- Never `--force`, never `--force-with-lease`, never `--atomic`, never `--delete`. The preflight asks a question; it proposes no policy.

The verdict:

- `code === 0` yields `{ allowed: true }`.
- A non-zero code yields `{ allowed: false, failure: classifyFailure({ code, stderr, eraseObserved }), detail: stripUserinfo(stderr) }`.

`canPush` returns a verdict and never throws for a remote condition. It throws `GitError("url-refused", verdict.reason, "")` from `remoteUrlVerdict` before any process starts, and it throws `GitError("url-refused", "the url transport and the credential transport disagree", "")` when the two disagree.

**The four classifications this call must distinguish**, measured against the real forge with the ambient credential chain reset by `credentialArgs`:

| credential                        | exit  | stderr                                                                               | verdict       |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------ | ------------- |
| a token that may push             | `0`   | `* [new branch]` on stdout                                                           | `allowed`     |
| a syntactically valid wrong token | `128` | `remote: Invalid username or token…` and `fatal: Authentication failed for …`        | `auth-failed` |
| an empty token (git level only)   | `128` | the same two lines                                                                   | `auth-failed` |
| no credential at all              | `128` | `fatal: could not read Username for 'https://github.com': terminal prompts disabled` | `unknown`     |

The fourth row is why a credential is mandatory rather than optional. `classifyFailure` (EPIC 006 Story 03) matches none of its five rule sets against that message, so it returns `unknown`. The daemon never reaches that state: `repository.register` requires a `credentialId`, Story 03's schema requires a non-empty `token`, and the empty-token case is the third row and not the fourth. The row is recorded so no one adds a sixth `classifyFailure` pattern for a state the product cannot enter.

`auth-failed` in rows two and three does not depend on the wording. `classifyFailure` tests `eraseObserved` first, and `git` issues `erase` to the helper on a rejected credential, so the verdict is structured evidence. The `Authentication failed` match is the second path to the same answer.

### 2. `src/services/git/preflight.ts` — the did-not-move assertion

```ts
export type RemoteRefProbe = Readonly<{
  before: string | null;
  after: string | null;
}>;

export function remoteRefValue(
  runner: GitRunner,
  paths: GitPaths,
  input: Readonly<{
    remoteUrl: string;
    ref: string;
    credential: GitCredential;
  }>,
): Promise<string | null>;
```

One command, `["ls-remote", "--", remoteUrl, ref]`. A matching line yields its object id; no line yields `null`; a non-zero exit throws `GitError(classifyFailure(...), …)`.

`canPush` does **not** call it. The assertion "the remote ref did not move" is a property of `--dry-run` and it is proved by the test, not re-proved by production code on every registration: a second network round trip on every register would cost a request and could itself fail, and a mismatch would have no remedy — the dry run already wrote nothing. `remoteRefValue` exists because Stories 07, 09 and 13 assert with it, and because Story 11's projection reads a tracking tip.

## Constraints

- `--dry-run` is present in every invocation. There is no code path in this file that pushes for real.
- The token never enters the argument vector. `runAuthenticated` prepends `credentialArgs`, and the secret reaches the helper through the child environment.
- `canPush` runs from a `gitDir` that already holds the object. It is called after the fetch and before the rename, which Story 09 sequences.
- The publish ref is never `refs/heads/<the upstream branch>` by accident. `canPush` takes it as given; Story 10 validates the body.
- `detail` passes through `stripUserinfo`. A `fatal: Authentication failed for 'https://…'` line carries a url.
- No `127.` and no `"localhost"` literal in the file.

## Verify

`node --test src/services/git/preflight.test.ts`

### The argument vector, no process

- `canPush` with a runner that records its request and returns `{ code: 0, stdout: "", stderr: "", args: [] }` produces `args` deep-equal to `["--git-dir=/tmp/s.git", "push", "--dry-run", "--", "https://forge.test/r.git", "abc…:refs/heads/main"]`, with the object id and the ref concatenated by a single `:`.
- The recorded `args` contain `"--dry-run"`, and contain none of `"--force"`, `"--force-with-lease"`, `"--atomic"`, `"--delete"`.
- A `publishRef` of `"-refs/heads/x"` still appears after `"--"`, asserted by index.
- `canPush` against a refused url rejects with `GitError("url-refused")` and the recording runner records no request.
- `canPush` with an `https` url and an `ssh` credential rejects with the disagreement message, and no request is recorded.

### The verdict table, no process

Drive `canPush` with a runner returning each row, and assert the verdict exactly:

| runner result                                                                                               | expected                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `code: 0`                                                                                                   | `{ allowed: true }`                        |
| `code: 128`, `stderr: "fatal: Authentication failed for 'https://f/r.git/'"`                                | `allowed: false`, `failure: "auth-failed"` |
| `code: 128`, `stderr: "remote: error: pre-receive hook declined"`                                           | `failure: "permission-denied"`             |
| `code: 128`, `stderr: "remote: error: protected branch hook declined"`                                      | `failure: "permission-denied"`             |
| `code: 128`, `stderr: "fatal: unable to access 'https://f/r.git/'"`                                         | `failure: "transport-failed"`              |
| `code: 128`, `stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled"` | `failure: "unknown"`                       |
| `eraseObserved: true`, `code: 128`, `stderr: "Connection refused"`                                          | `failure: "auth-failed"`                   |

The last row is the precedence assertion: the helper's evidence outranks a network-looking message.

- `detail` for the `Authentication failed` row equals `"fatal: Authentication failed for 'https://f/r.git/'"`, and for a url carrying userinfo the userinfo is stripped.

### Against the HTTP fixture

`await createHttpRemote()`, disposed in `after`. The staging home is built in the test with `runGit` directly, not with the product `seedHome` — Story 09 owns that, and a preflight test that depended on it would prove two units at once.

Build: `init --bare --template=`, `remote add origin`, `config remote.origin.fetch <TRACKING_REFSPEC>`, `fetch origin --prune --no-tags` with `remote.credentials.writer`, then read `U = rev-parse refs/remotes/origin/main`, which EPIC 005 pins at `251c92d5a215053aea80432f179653f99072835d`.

- **A write credential is allowed.** `canPush` with `remote.credentials.writer` and `publishRef: "refs/heads/main"` and `proposedOid: U` resolves `{ allowed: true }`.
- **A read-only credential that fetches successfully is refused.** `remote.credentials.reader` fetches (EPIC 005 serves reads to anyone), and `canPush` with it resolves `allowed: false` with `failure === "auth-failed"`. This is the epic coverage line and the whole argument for a write advertisement: assert in the same test that a fetch with the same credential resolved `code === 0`, so the two verdicts sit side by side.
- **A wrong token is refused.** `remote.wrongCredential` resolves `allowed: false`, `failure === "auth-failed"`. Then re-run `classifyFailure` with the observed exit code and `stderr: ""` and assert the verdict is still `auth-failed`, which proves it does not depend on the fixture's wording.
- **The remote ref did not move.** For each of the three cases above, capture `remoteRefValue(..., "refs/heads/main")` before and after and assert the two are equal and equal to `U`. This is the epic line "It asserts the remote ref did not move."
- **A new ref is not created.** `canPush` with `publishRef: "refs/heads/kanthord/preflight"` and the writer credential resolves `allowed: true`, and `remoteRefValue` for that ref is `null` both before and after.
- **The token appears nowhere.** After a failing case, assert neither `error`-side value nor `verdict.detail` includes the token, and `fs.readFileSync(join(stagingDir, "config"), "utf8")` does not include it.
- **No pid file survives.** `fs.readdirSync(paths.runDirectory)` holds no entry beginning with `"git-"` after each case. `canPush` supplies no `pidFile`, so the runner mints and removes one.

### E2E — scenario `E7-07`, real `github.com`

File `scripts/e2e/007/07-registration-preflight.e2e.ts`. This is the scenario the fixture cannot replace: only a real forge proves the advertisement.

Build a staging home in a `mkdtempSync` directory with the product primitives — `init --bare --template=`, `remote add`, `config remote.origin.fetch <TRACKING_REFSPEC>`, `fetchTracking` with `writerCredential(env)` — then `U = resolveRef(refs/remotes/origin/<env.ghBaseBranch>)`.

- `U` matches `/^[0-9a-f]{40}$/`, and `refs/tags` is empty after the fetch. Measured: `--no-tags` leaves no tag against this repository.
- `publishRef` is `scratchRef(env, "preflight")`, passed through `assertScratchRef` first. The base branch is never a publish ref in this gate.
- **The real token is allowed.** `canPush` with `writerCredential(env)` resolves `{ allowed: true }`. Measured exit `0` with `* [new branch]`.
- **Nothing was written.** `remoteRefValue` for that scratch ref is `null` before and after. Then `listRemoteRefs(paths, env, "refs/heads/kanthord-e2e/007/*")` reports no ref of this run. This is the assertion that makes `--dry-run` a fact rather than a documented intention.
- **The base branch did not move.** `remoteRefValue` for `` `refs/heads/${env.ghBaseBranch}` `` is equal before and after, and equal to `U`.
- **A dry run against the base branch is also harmless.** `canPush` with `proposedOid: U` and `publishRef: refs/heads/<base>` resolves `{ allowed: true }` and the ref is unchanged. Measured: `Everything up-to-date`, exit `0`. The scenario calls `assertScratchRef` **not** on this ref and instead names it through an explicit `baseBranchRef(env)` helper whose only caller is this one assertion, so the safety guard is not weakened for the rest of the gate.
- **A wrong token is `auth-failed`.** `canPush` with `wrongCredential(env)` resolves `allowed: false` with `failure === "auth-failed"`, and `detail` includes `Authentication failed` and does **not** include `env.ghToken` or the wrong token.
- **An empty token is `auth-failed` at the git level.** `canPush` with `emptyTokenCredential(env)` resolves `allowed: false` with `failure === "auth-failed"`. Measured: `remote: Invalid username or token`. `canPush` takes a `GitCredential` and validates nothing, so this case is reachable here and **only** here: Story 03 declares `token: z.string().min(1)`, so no empty token survives `provider.register`. The assertion proves the primitive classifies it, not that a user can produce it.
- **The ambient credential chain does not participate.** Run the wrong-token case a second time with `process.env.HOME` pointing at the operator's real home. It still resolves `auth-failed`. Without the empty `-c credential.helper=` entry of EPIC 006 Story 03, a developer's own keychain answers and the case passes for the wrong reason — measured while writing this story: a dry run with no credential and the ambient chain intact created a real branch on the remote. This assertion is the guard against that.
- **A read-only credential is not covered here.** One personal access token cannot present two permission levels, so the read-only-yet-fetching case stays a fixture case and this scenario asserts nothing about it. Story 13's report records the coverage boundary.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/services/git/preflight.test.ts`. Story 13 records the Proof widening.
