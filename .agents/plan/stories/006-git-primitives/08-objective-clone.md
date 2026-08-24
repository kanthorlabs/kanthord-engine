# Story 08 — Objective clone

Epic: `.agents/plan/epics/006-git-primitives.md`
Depends on: Story 01 (`createGitRunner`, `stripUserinfo`). It does **not** depend on Story 03: a local clone authenticates nothing.

A clone that shares **no inode and no object store** with the bare home, and carries no remote. None of that is a property of cloning, so each half is asserted rather than assumed.

State the acceptance precisely. A link count of one proves no ordinary hard link, and `docs/proposal/phase-1/git-foundation.md:245` chooses that as the acceptance. It does not prove that the two files share no storage block: a copy-on-write filesystem can share extents behind two independent inodes. That residual sharing is invisible to `git`, cannot be observed through a ref or an object read, and is not what the isolation argument depends on — the two repositories being independent object stores is. The other two paths to a shared object store, `objects/info/alternates` and a partial-clone promisor, are asserted absent because they **are** observable at read time.

## Change

### 1. `src/services/git/clone.ts` (new)

```ts
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { GitError, type CloneInput } from "./index.ts";
import { stripUserinfo } from "./redact.ts";
import type { GitRunner } from "./run.ts";

export function cloneObjective(
  runner: GitRunner,
  input: CloneInput,
): Promise<string>;
```

`CloneInput` at `src/services/git/index.ts:38-42` is unchanged: `sourceGitDir`, `targetDir`, `ref`. `cloneObjective` returns the absolute path of the published workspace, which is `input.targetDir`.

The sequence, in this order:

1. Throw `GitError("unknown", `${input.targetDir} already exists`, "")` when `input.targetDir` exists. A workspace is published once.
2. `staging = join(dirname(input.targetDir), `.staging-${randomUUID()}`)`. It is a sibling of the target, so the rename of step 8 stays on one filesystem. `mkdirSync(dirname(input.targetDir), { recursive: true })` first.
3. `git clone --no-hardlinks --no-local --branch <ref> -- <sourceGitDir> <staging>`.
4. `git -C <staging> remote remove origin`.
5. `git -C <staging> remote` — assert `stdout.trim()` is the empty string.
6. Assert `existsSync(join(staging, ".git", "objects", "info", "alternates"))` is `false`.
7. Assert the promisor configuration is absent with one command: `git -C <staging> config --get-regexp "^(remote\..*\.(promisor|partialclonefilter)|extensions\.partialclone)$"` exits non-zero and writes an empty `stdout`. `config --get-regexp` exits `1` when nothing matches, so one call covers the three keys a partial clone sets.
8. `renameSync(staging, input.targetDir)`.

Any failure between steps 2 and 7 removes the staging directory with `rmSync(staging, { recursive: true, force: true })` and rethrows. A `GitError` from a failed step carries `stripUserinfo(stderr)` as its detail. A crash leaves the staging directory in place, and EPIC 007.5's sweep removes it.

A failed assertion in steps 5, 6 or 7 throws `GitError("unknown", <the exact message below>, "")`:

| Step | Message                                           |
| ---- | ------------------------------------------------- |
| 5    | `the clone still carries a remote`                |
| 6    | `the clone carries objects/info/alternates`       |
| 7    | `the clone carries a partial-clone configuration` |

Three measured facts fix the assertions:

- `--no-hardlinks --no-local` against a local path produces a **packfile** in the workspace, not a copy of the source's loose object files. The isolation assertion is therefore over every regular file under `<workspace>/.git/objects`, and each must have a link count of `1`. Measured: `1` for every file with both flags, and `2` for a `--local` clone, where the workspace and the bare home share one inode.
- `clone` configures `origin` pointing at the source, so step 4 always has something to remove.
- A local `clone` from a bare home succeeds against a plain path argument. No `file://` url is needed, and `--` before the two path arguments stops a path that begins with `-` from being read as an option.

`--branch <ref>` takes a branch name, not a full ref. The caller passes `<landingBranch>`, which is what `docs/proposal/phase-1/git-foundation.md:235` writes.

## Constraints

- Never drop `--no-hardlinks`, and never drop `--no-local`. Each defends a different half: `--no-hardlinks` stops the inode sharing, and `--no-local` forces the transport path so no other local optimisation applies.
- Never add `--shared`, `--reference`, `--dissociate`, `--filter` or `--depth`. The first three create the alternates file step 6 forbids, and the last two create the promisor step 7 forbids.
- Never publish the workspace before step 7. The rename is the publication, and a visible workspace is always a finished one.
- Never remove `input.targetDir`. This function creates a workspace; removing one is the caller's operation.
- The staging name begins with `.staging-`. EPIC 007.5's sweep matches that prefix, and a different prefix leaves a directory nothing removes.

## Verify

`node --test src/services/git/clone.test.ts` — new file, suite `"src/services/git/clone.test"`.

Each case copies `seedRepositories(resolveTools()).repositories["fixture.git"].path` into its own `mkdtemp` root as the bare home, writes `refs/heads/land` at `fixtureObjectIds.commit2` with `runGit`, and creates the workspace parent under that same root. The tree is removed in `after`. One root matters for the positive control below.

- **The clone carries the landing branch.** After `cloneObjective({ ref: "land" })`, `git -C <workspace> rev-parse HEAD` reports `"251c92d5a215053aea80432f179653f99072835d"`, and `git -C <workspace> rev-parse --abbrev-ref HEAD` reports `"land"`.
- **Isolation, by link count.** Walk `<workspace>/.git/objects` recursively with `fs.readdirSync(..., { withFileTypes: true })`, collect every regular file, assert the collection is not empty, and assert `fs.statSync(file).nlink === 1` for every one. Then walk `<home>/objects` and assert `nlink === 1` for every file there as well — the bare home's own object files are unchanged. This is the epic coverage line "A clone from a bare home yields object files with a link count of one, and the bare home's own object files are unchanged."
- **The positive control for the link count.** In the same file, run `git clone --local <home> <other>` through `runGit` directly, where `<other>` is under the **same** `mkdtemp` root as `<home>`, and assert at least one object file under `<other>/.git/objects` has `nlink === 2`. One root is required: a cross-filesystem `--local` clone cannot hard-link and would make this case fail for a reason that is not the one it tests. When no file reports `nlink === 2`, fail with the message `"this filesystem does not hard-link; the isolation control cannot run here"` rather than with a bare assertion — a flaky-looking failure that names its cause is a diagnosis, and a silent skip would let the real assertion prove nothing. The control clone is not produced by `cloneObjective` and is removed in the case's own cleanup.
- **No remote.** `git -C <workspace> remote` reports an empty string, and `git -C <workspace> config --get remote.origin.url` exits non-zero.
- **No alternates and no promisor.** `join(workspace, ".git", "objects", "info", "alternates")` does not exist, and `git -C <workspace> config --get-regexp "^remote\..*\.promisor$"` exits non-zero.
- **A hostile source path.** A source directory whose name begins with `-` clones successfully, which proves the `--` separator is present. Build it as `<parent>/-dash.git`.
- **An existing target refuses.** With `targetDir` already created, `cloneObjective` rejects with a `GitError` whose message ends with `" already exists"`, and the existing directory's contents are unchanged.
- **A failure leaves no visible workspace.** Call `cloneObjective` with a `ref` that does not exist in the source. Assert it rejects, assert `existsSync(targetDir)` is `false`, and assert no entry beginning with `.staging-` remains under the parent directory. The rename is what makes this assertion possible.
- **An injected assertion failure removes the staging directory.** Wrap the real runner in a hand-written `GitRunner` that forwards every call except one whose `args` end with `["remote"]`, which it answers with `{ code: 0, stdout: "upstream\n", stderr: "", args: ["remote"] }`. Call `cloneObjective` with that runner, assert it rejects with the message `"the clone still carries a remote"`, assert `existsSync(targetDir)` is `false`, and assert no entry beginning with `.staging-` survives under the parent. The stub is the deterministic way to reach step 5's cleanup, because a real `remote remove origin` always succeeds.
- **The detail carries no userinfo.** Force a clone failure with a source path containing `user@` in a url-shaped string and assert `error.detail` does not include `"user@"`.

`npm run verify` exits 0.

Proof: contributes `src/services/git/clone.test.ts` to `node --test src/services/git/**/*.test.ts`.
