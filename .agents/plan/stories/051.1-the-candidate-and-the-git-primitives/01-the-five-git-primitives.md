# Story 1 — The six git primitives

Epic: `.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md`
Depends on: EPIC 006 (`GitRunner`, `createBinaryGit`, `buildGitPaths`, the seeded bare fixture). Stories 2, 3, 4, 5, 7 and 8 of this epic each need a method it adds, and EPIC 051.2 needs `checkout` and `removeWorktree`; implement this story first.
Kind: story-foundation

**The file stem stays `01-the-five-git-primitives`.** EPIC 051.2's story tree cites it four times, and
`.agents/plan/authoring.md` makes a stem an address. The title is the six methods; the stem is the
address.

This story adds six methods and one `GitPaths` member, and one git invocation to `sweepHome`. It
changes no drawn path, so it draws nothing.

## Change

### 1 — the interface

**`src/services/git/index.ts` — declare six methods on `interface Git`.** Import each input type from
its implementation file, exactly as `SweepHomeInput` and `WorktreeCleanInput` are imported at
`src/services/git/index.ts:5 — `SweepHomeInput`` and `src/services/git/index.ts:6 — `WorktreeCleanInput``.
Insert the six declarations after `refUpdate` at `src/services/git/index.ts:182 — `refUpdate``, in this
order:

```ts
  isAncestor(input: IsAncestorInput): Promise<boolean>;
  changedPaths(input: ChangedPathsInput): Promise<readonly string[]>;
  checkout(input: CheckoutInput): Promise<string>;
  removeWorktree(input: RemoveWorktreeInput): Promise<void>;
  deleteRef(input: DeleteRefInput): Promise<void>;
  listRefs(input: ListRefsInput): Promise<readonly string[]>;
```

`listRefs` and `changedPaths` return `readonly string[]`, not `string[]`. The EPIC writes
`Promise<string[]>` in prose; `listPidFiles` at `src/services/git/index.ts:187 — `listPidFiles``
already returns `Promise<readonly string[]>`, and the house form wins.

Every implementation takes `(runner: GitRunner, input)` and passes `--git-dir=${input.gitDir}` as an
argument, matching `src/services/git/ref-read.ts:4 — `resolveRef``. No implementation imports
`node:child_process`: `eslint.config.js` bans it for every `src/**/*.ts` except
`src/services/git/launcher.ts`. `node:fs` and `node:os` are permitted in a service —
`src/services/git/sweep.ts:1 — `Dirent`` already imports the first — and `checkout` needs both.

### 2 — `src/services/git/is-ancestor.ts`

```ts
export type IsAncestorInput = Readonly<{
  gitDir: string;
  ancestorOid: string;
  descendantOid: string;
}>;

export async function isAncestor(
  runner: GitRunner,
  input: IsAncestorInput,
): Promise<boolean>;
```

Argv: `[`--git-dir=${input.gitDir}`, "merge-base", "--is-ancestor", input.ancestorOid, input.descendantOid]`.
Exit `0` returns `true`. Exit `1` returns `false`. Every other exit throws
`new GitError("unknown", `git merge-base --is-ancestor failed in ${input.gitDir}`, result.stderr)`,
matching the raw-stderr form of `src/services/git/worktree.ts:15 — `GitError``. An oid equal to its
descendant is an ancestor, which is `git merge-base --is-ancestor`'s own rule and the case the
reachability check of Story 3 and Story 7 depends on.

### 3 — `src/services/git/changed-paths.ts`

```ts
export type ChangedPathsInput = Readonly<{
  gitDir: string;
  baseOid: string;
  headOid: string;
}>;

export async function changedPaths(
  runner: GitRunner,
  input: ChangedPathsInput,
): Promise<readonly string[]>;
```

Argv: `[`--git-dir=${input.gitDir}`, "diff", "--name-status", "-M", "-C", "-z", input.baseOid, input.headOid]`.
`-M` and `-C` are explicit, so the result does not depend on the ambient `diff.renames` default. `-z`
makes the record separator `\0`, so a path holding a tab or a newline is still one field.

Parse the NUL-separated stream as a state machine: read one status field; when it begins `R` or `C`,
read **two** path fields and emit both; otherwise read **one** path field and emit it. A non-zero exit
throws `new GitError("unknown", `git diff failed in ${input.gitDir}`, result.stderr)`.

Deduplicate the emitted paths, then sort them with `Buffer.compare` over `Buffer.from(path)`. The sort
is not decoration: `AGENTS.md` requires an explicit order, and the callers of Story 6 compare the
result by value.

### 4 — `src/services/git/checkout.ts`

```ts
export type CheckoutInput = Readonly<{ gitDir: string; oid: string }>;

export async function checkout(
  runner: GitRunner,
  paths: GitPaths,
  input: CheckoutInput,
): Promise<string>;
```

**It takes no `targetDir` and it returns the path it created.** Every caller is a command under
`src/commands/`, where `eslint.config.js` bans `node:fs`, so a caller can neither allocate a
directory nor remove one. A caller-derived name is also not atomically fresh: a crash leaves the
derived path occupied and `git worktree add` then refuses it.

**Body, in this order:**

1. `const targetDir = mkdtempSync(join(paths.worktreeDirectory, "wt-"));`
2. Run `[`--git-dir=${input.gitDir}`, "worktree", "add", "--detach", targetDir, input.oid]`.
3. On a non-zero exit, `rmSync(targetDir, { recursive: true, force: true })` **before** throwing
   `new GitError("unknown", `git worktree add failed in ${input.gitDir}`, result.stderr)`. A path that
   never became a registered worktree cannot be removed by `git worktree remove`, so the allocation is
   rolled back here or it leaks.
4. Return `targetDir`.

It takes `paths` as its second parameter, matching `remoteInfo` at
`src/services/git/binary.ts:37 — `remoteInfo``, which is the shipped shape for an implementation that
needs `GitPaths`.

### 5 — `src/services/git/remove-worktree.ts`

```ts
export type RemoveWorktreeInput = Readonly<{
  gitDir: string;
  targetDir: string;
}>;

export async function removeWorktree(
  runner: GitRunner,
  input: RemoveWorktreeInput,
): Promise<void>;
```

Argv: `[`--git-dir=${input.gitDir}`, "worktree", "remove", "--force", input.targetDir]`. A non-zero
exit throws `new GitError("unknown", `git worktree remove failed for ${input.targetDir}`, result.stderr)`.

**`--force` is required.** A declared command of EPIC 051.2 runs arbitrary shell in that tree, and
`git worktree remove` refuses a dirty one. One invocation deletes the directory **and** removes the
`${gitDir}/worktrees` entry, so a caller disposes of both halves with one call. It is **not**
idempotent: a second call on the same path exits `128`. It runs once per `checkout`, and no caller
retries it.

### 6 — `src/services/git/delete-ref.ts`

```ts
export type DeleteRefInput = Readonly<{ gitDir: string; ref: string }>;

export async function deleteRef(
  runner: GitRunner,
  input: DeleteRefInput,
): Promise<void>;
```

Argv: `[`--git-dir=${input.gitDir}`, "update-ref", "-d", input.ref]`. Unconditional: no
compare-and-swap and no expected oid. `git update-ref -d` on an absent ref exits `0`, so the call is
idempotent. A non-zero exit throws
`new GitError("unknown", `git update-ref -d failed for ${input.ref}`, result.stderr)`.

Do not widen `RefUpdateInput.nextOid` at `src/services/git/index.ts:51 — `nextOid`` to `string | null`.
A null would force conditional argv construction inside `src/services/git/ref-update.ts:15 — `runner``.

### 7 — `src/services/git/list-refs.ts`

```ts
export type ListRefsInput = Readonly<{ gitDir: string; prefix: string }>;

export async function listRefs(
  runner: GitRunner,
  input: ListRefsInput,
): Promise<readonly string[]>;
```

Argv: `[`--git-dir=${input.gitDir}`, "for-each-ref", "--format=%(refname)", "--sort=refname", input.prefix]`.
Split stdout on `\n` and drop the empty trailing field, so a prefix with no ref returns `[]`.
`for-each-ref` exits `0` for an empty match, so an empty result is not an error. A non-zero exit throws
`new GitError("unknown", `git for-each-ref failed in ${input.gitDir}`, result.stderr)`. The order comes
from `--sort=refname` and never from the file system.

### 8 — `GitPaths.worktreeDirectory`

**`src/services/git/index.ts:25 — `GitPaths`` gains an eighth member**, `worktreeDirectory: string`,
after `runDirectory` at `src/services/git/index.ts:32 — `runDirectory``.

**`src/services/git/probe.ts:215 — `buildGitPaths`` creates and returns it.** Add
`const worktreeDirectory = join(input.home, "git", "worktrees");`, put it in the `mkdirSync` loop that
already runs at mode `0o700`, and return it. `mkdirSync` is called with `{ recursive: true }`, so a
second call on the same home is a no-op and throws nothing.

**Fifteen hand-written `GitPaths` builders gain the member**, or type checking fails. Fourteen are a
local `function makePaths()`:

`src/services/git/outside-writer.test.ts:100`, `binary.test.ts:24`, `seed.test.ts:63`,
`environment.test.ts:23`, `run.test.ts:42`, `ref-update.test.ts:51`, `remote-info.test.ts:47`,
`authenticated.test.ts:54`, `credential.test.ts:44`, `host-key.test.ts:57`, `ref-read.test.ts:38`,
`preflight.test.ts:50`, `worktree.test.ts:34`, `fetch.test.ts:51`.

The fifteenth is `makeHome()` at `src/services/git/clone.test.ts:49 — `makeHome``, which builds the
object inline. Each one creates its own temporary directory set, so each adds a `worktrees` sibling
and returns it.

**Two sites need no edit, and this is why the set is fifteen and not seventeen.**
`src/services/git/push-probe.ts:27 — `probePaths`` and `src/services/git/remote-info.test.ts:185 — `paths``
both spread an existing `GitPaths` and override two members, so a new member flows through.

### 9 — `sweepHome` prunes a crashed worktree

`sweepHome` runs no git today: `src/services/git/sweep.ts:1 — `Dirent`` imports `node:fs` alone, and
`src/services/git/binary.ts:45 — `sweepHome`` binds it without the runner. Both change.

- Change the signature at `src/services/git/sweep.ts:68 — `sweepHome`` to
  `sweepHome(runner: GitRunner, input: SweepHomeInput): Promise<SweepHomeReport>`.
- As the **first** statement of the body, before `collectCandidates` at
  `src/services/git/sweep.ts:71 — `collectCandidates``, iterate `input.boundaries` in the given order
  and, for every boundary whose `kind` is `"bare-home"`, await
  `runner({ args: [`--git-dir=${boundary.root}`, "worktree", "prune", "--expire=now"] })`. A non-zero
  exit throws `new GitError("unknown", `git worktree prune failed in ${boundary.root}`, result.stderr)`.
- A boundary whose `kind` is `"workspace"` is skipped. A workspace is a checkout, not the bare home
  that owns the `worktrees/` administrative directory.
- The prune adds **no** entry to `removed` and none to `refused`. `git worktree prune` reports no
  structured removal, and inventing a `SweepRemoval` would put a value in an event payload that
  `src/commands/startup/sweep-remnants.ts:72 — `removal`` cannot source. `SweepRemoval["class"]` stays
the three-member union at `src/services/git/sweep.ts:37 — `SweepRemoval``.

**`prune` reclaims only an entry whose working tree is missing.** A crash that left the directory in
place keeps both the directory and its entry, and the prune does not reach them. That residue is a
stated non-goal of this epic, and case 21 is the control that pins the limit.

`SweepHomeInput`, `SweepHomeReport` and the `Git.sweepHome` declaration at
`src/services/git/index.ts:191 — `sweepHome`` are unchanged, so
`src/commands/startup/sweep-remnants.ts:58 — `sweepHome`` needs no edit.

### 10 — `src/services/git/binary.ts` — bind the six

Add six imports beside `src/services/git/binary.ts:11 — `resolveRef``, keeping the file's
alphabetical-by-module order, and six bindings after `src/services/git/binary.ts:30 — `refUpdate``:

```ts
    isAncestor: (input) => isAncestor(runner, input),
    changedPaths: (input) => changedPaths(runner, input),
    checkout: (input) => checkout(runner, paths, input),
    removeWorktree: (input) => removeWorktree(runner, input),
    deleteRef: (input) => deleteRef(runner, input),
    listRefs: (input) => listRefs(runner, input),
```

and change `sweepHome: (input) => sweepHome(runner, input)` at
`src/services/git/binary.ts:45 — `sweepHome``. `paths` is already destructured at
`src/services/git/binary.ts:24 — `createBinaryGit``, and `src/main.ts:237 — `createBinaryGit`` already
passes the `GitPaths` that `src/main.ts:234 — `buildGitPaths`` built, so the composition root needs no
edit.

### 11 — the eight hand-written `Git` stubs

`interface Git` gains six members, so every hand-written stub fails type checking until it declares
them. Add all six to each, in the style that file already uses — a thrower where the surrounding stub
throws, a recorder where it records:

- `src/queries/repository/show-repository.test.ts:103 — `sweepHome``
- `src/queries/repository/list-repository.test.ts:85 — `sweepHome``
- `src/queries/repository/inspect-repository.test.ts:212 — `sweepHome``
- `src/commands/repository/register-repository.test.ts:323 — `sweepHome``
- `src/commands/outcome/close-objective.test.ts:558 — `sweepHome`` (this one records; use `record`)
- `src/commands/startup/reconcile-journal.test.ts:100 — `sweepHome``
- `src/commands/startup/reap-orphans.test.ts:110 — `sweepHome``
- `src/commands/startup/sweep-remnants.test.ts:82 — `sweepHome``

That list is the complete consumer set of `interface Git` outside `src/main.ts:237 — `createBinaryGit``
and `src/services/git/binary.ts:24 — `createBinaryGit``, resolved against the current tree.

## Constraints

- No implementation imports `node:child_process`, `isomorphic-git`, `simple-git` or `nodegit`. Every
  one goes through `GitRunner`.
- `isAncestor` throws on any exit that is neither `0` nor `1`. A `false` for an unknown failure would
  report an unreachable candidate as merely unreachable.
- `checkout` allocates with `mkdtempSync` and never from a caller-supplied or derived name, and it
  removes its own allocation when `worktree add` fails.
- `removeWorktree` uses `--force` and runs exactly once per `checkout`. Do not make it idempotent and
  do not retry it.
- `deleteRef` never takes an expected oid. `refUpdate` stays the compare-and-swap path.
- `changedPaths` emits both sides of a rename and of a copy, and one path for every other status.
- `sweepHome` prunes only a `bare-home` boundary, and its report shape does not change.
- Do not add a `pidFile` to any of the six. The runner mints one when the request omits it
  (`src/services/git/run.ts:57 — `pidFile``), and none of the six is a durable remote write.
- Do not add a sweeper for a worktree whose directory survived a crash. The EPIC states it as a
  non-goal and names EPIC 051.4 as the owner.

## Verify

```
node --test src/services/git/is-ancestor.test.ts src/services/git/changed-paths.test.ts src/services/git/checkout.test.ts src/services/git/remove-worktree.test.ts src/services/git/delete-ref.test.ts src/services/git/list-refs.test.ts src/services/git/sweep.test.ts src/services/git/probe.test.ts
```

Create six test files, suite name `"src/services/git/<basename>.test"`. Two fixture idioms already
exist and both are used here:

- **A private copy of the seeded bare repository** — `resolveTools` at `test/helpers/remote/tools.ts:102`,
  `seedRepositories` at `test/helpers/remote/seed.ts:124`, `fixtureObjectIds` at
  `test/helpers/remote/seed.ts:26`, and the local `makePaths()` with
  `cpSync(fixturePath, home, { recursive: true })` at `src/services/git/ref-update.test.ts:64 — `cpSync``.
It gives `commit1` as the parent of `commit2` (`test/helpers/remote/seed.ts:170 — `commit-tree``) and
  `refs/heads/main` at `commit2`.
- **A working repository built in the test** — `gitIn` at `src/services/git/worktree.test.ts:62 — `gitIn``
and `initWorkRepository` at `src/services/git/worktree.test.ts:76 — `initWorkRepository``, driving
  `execFileSync` with `pinnedGitConfigArguments` (`test/helpers/remote/seed.ts:52`) and
  `pinnedGitEnvironment` (`test/helpers/remote/seed.ts:36`). Use it wherever a rename or a second branch
  is needed: `test/helpers/remote/seed.ts` seeds one linear history over one path named `README.md` and
  produces no rename, no addition and no deletion.

Add, each as a separate `it`:

1. `"an oid equal to its descendant is an ancestor"` — in `is-ancestor.test.ts`, over a private copy of
   the bare fixture, assert
   `await isAncestor(runner, { gitDir, ancestorOid: fixtureObjectIds.commit2, descendantOid: fixtureObjectIds.commit2 }) === true`.

2. `"a parent commit is an ancestor of its child"` — assert `isAncestor` with
   `ancestorOid: fixtureObjectIds.commit1` and `descendantOid: fixtureObjectIds.commit2` is `true`.

3. `"a sibling branch tip is not an ancestor"` — build a parentless sibling with
   `gitIn(gitDir, ["commit-tree", "-m", "sibling", fixtureObjectIds.tree1])`, capture its oid from
   stdout, and assert `isAncestor(..., { ancestorOid: sibling, descendantOid: fixtureObjectIds.commit2 })`
   is `false`. The sibling oid is not asserted by value: the production git environment pins no
   committer date (`src/services/git/environment.ts:75 — `GIT_COMMITTER_NAME``), so only the boolean is
   deterministic.

4. `"a malformed oid throws"` — `assert.rejects` over
   `isAncestor(runner, { gitDir, ancestorOid: "zz", descendantOid: fixtureObjectIds.commit2 })`, and
   assert the rejection is a `GitError` whose `failure` is `"unknown"`. `git merge-base` exits `128`
   for an unresolvable revision, which is the "neither 0 nor 1" case.

5. `"a rename returns both the old path and the new path"` — in `changed-paths.test.ts`, build a work
   repository, commit `a.txt`, then `gitIn(workDir, ["mv", "a.txt", "b.txt"])` and commit. Capture the
   two commit oids with `rev-parse`. Assert the result deep-equals `["a.txt", "b.txt"]`.

6. `"a plain modification returns one path"` — the control for case 5. Rewrite `a.txt` in place and
   commit; assert the result deep-equals `["a.txt"]`. Without it, case 5 passes for an implementation
   that emits every path of the tree.

7. `"a path named on both sides of two renames is returned once"` — commit `a.txt` and `c.txt`, then in
   one commit `gitIn(workDir, ["mv", "a.txt", "b.txt"])` and `gitIn(workDir, ["mv", "c.txt", "a.txt"])`.
   The diff emits `R` twice, once as `a.txt -> b.txt` and once as `c.txt -> a.txt`, so `a.txt` appears
   in two records. Assert the result deep-equals `["a.txt", "b.txt", "c.txt"]`. Two commits that each
   modify one file do **not** exercise this: `git diff` between two commits reports a path once
   whatever happened in between.

8. `"listRefs returns full ref names under a prefix in bytewise order"` — in `list-refs.test.ts`, over a
   private copy of the bare fixture, create `refs/kanthord/candidate/run_b/1` then
   `refs/kanthord/candidate/run_a/1`, both at `fixtureObjectIds.commit2`, in that order. Assert
   `await listRefs(runner, { gitDir, prefix: "refs/kanthord/candidate/" })` deep-equals
   `["refs/kanthord/candidate/run_a/1", "refs/kanthord/candidate/run_b/1"]`. Creating them in reverse
   order is what proves the sort comes from `--sort=refname`.

9. `"listRefs returns an empty array for a prefix with no ref"` — assert `listRefs` over the untouched
   fixture deep-equals `[]`.

10. `"deleteRef removes a ref whose oid the caller never names"` — in `delete-ref.test.ts`, create
    `refs/kanthord/candidate/run_a/1`, call `deleteRef`, and assert `resolveRef` for that ref returns
    `null`. The call names no expected oid, which is the distinction from `refUpdate`.

11. `"deleting an absent ref succeeds"` — call `deleteRef` on a ref that was never created and assert
    the promise resolves. This is what makes the sweep of Story 5 safe to re-run.

12. `"checkout allocates under worktreeDirectory, returns the path, and checks the commit out there"` —
    in `checkout.test.ts`, over a private copy of the bare fixture, `const dir = await checkout(runner, paths, { gitDir, oid: fixtureObjectIds.commit2 })`.
    Assert `dirname(dir)` equals `paths.worktreeDirectory`, assert
    `readFileSync(join(dir, "README.md"), "utf8")` equals the fixture's second blob content, and assert
    `readdirSync(join(gitDir, "worktrees"))` has length `1`.

13. `"two checkouts of one commit return two distinct paths"` — call `checkout` twice with the same
    `oid` and assert the two returned paths differ and both exist. This is what `mkdtemp` buys over a
    derived name.

14. `"a failed checkout leaves worktreeDirectory empty"` — call `checkout` with an oid the repository
    does not hold. Assert it rejects with a `GitError`, and assert
    `readdirSync(paths.worktreeDirectory)` deep-equals `[]`. The control is case 12, which leaves
    exactly one entry; without it this passes for a `checkout` that allocates nothing.

15. `"removeWorktree deletes a dirty worktree and its administrative entry in one call"` — in
    `remove-worktree.test.ts`, `checkout` a commit, modify the tracked `README.md` in the returned
    directory and write an untracked file beside it, then `await removeWorktree(runner, { gitDir, targetDir: dir })`.
    Assert `existsSync(dir)` is `false` **and** `readdirSync(join(gitDir, "worktrees"))` deep-equals
    `[]`. Both halves are asserted, because one call is claimed to do both.

16. `"a second removeWorktree on the same path rejects"` — call it again and `assert.rejects`. This is
    why no caller retries it.

17. `"a sibling worktree survives a removal"` — the control for case 15. `checkout` twice, remove the
    first, and assert the second directory still exists and `readdirSync(join(gitDir, "worktrees"))`
    has length `1`.

18. `"buildGitPaths returns exactly the eight members with absolute values"` — amend the shipped case
    at `src/services/git/probe.test.ts:324 — `seven``. The key set gains `worktreeDirectory`, and the
    title says eight.

19. `"buildGitPaths derives worktreeDirectory from home"` — amend the shipped case at
    `src/services/git/probe.test.ts:341 — `derives``. Assert `paths.worktreeDirectory` equals
    `join(dir, "git", "worktrees")`, and say "five" where the title says "four".

20. `"buildGitPaths creates the four directories at 0700"` — amend the shipped case at
    `src/services/git/probe.test.ts:353 — `directories``. Add `paths.worktreeDirectory` to the loop, and
    add a second call on the same home asserting it returns the same value and throws nothing, which
    `{ recursive: true }` guarantees.

21. `"sweepHome prunes a worktrees entry whose working tree is missing"` — in `sweep.test.ts`,
    `checkout` a commit, `rmSync` the returned directory to simulate the crash, then call
    `await sweepHome(runner, { boundaries: [{ kind: "bare-home", root: gitDir, repositoryId: "repo_a" }], keyDirectory })`.
    Assert `readdirSync(join(gitDir, "worktrees"))` deep-equals `[]` afterwards, and assert
    `report.removed` deep-equals `[]` — the prune contributes no removal.

22. `"sweepHome removes no worktrees entry while the working tree is present"` — the control for case
    21, and the measured limit of `prune`. Same fixture, but leave the directory in place. Assert
    `readdirSync(join(gitDir, "worktrees"))` still has length `1` after the sweep, and that the
    directory still exists. This is the residue the EPIC states as a non-goal.

23. `"a bare home with no worktrees directory sweeps unchanged"` — call `sweepHome` on the untouched
    fixture and assert `report.removed` and `report.refused` both deep-equal `[]`, and that
    `existsSync(join(gitDir, "worktrees"))` is `false`. A prune of a repository that never held a
    worktree is not an error.

`pnpm run verify` exits 0. Type checking is what proves the eight `Git` stubs and the fifteen
`GitPaths` builders were updated; a missing member fails `pnpm run typecheck`.

Proof: PASS line delivered — `src/services/git/is-ancestor.test.ts`, `src/services/git/changed-paths.test.ts`,
`src/services/git/checkout.test.ts`, `src/services/git/remove-worktree.test.ts`,
`src/services/git/delete-ref.test.ts`, `src/services/git/list-refs.test.ts`,
`src/services/git/sweep.test.ts` and `src/services/git/probe.test.ts` in `PASS EPIC-051.1`.
