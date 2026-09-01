# Story 4 — An objective clone creates its feature branch

Epic: `.agents/plan/epics/029-one-branch-field-and-objective-feature-branches.md`
Depends on: Story 1 (the proposal states the rule).

The objective clone checks out the repository branch, creates `feature/<node id>` from it, and asserts
that branch is checked out. Every existing isolation assertion still runs, in the order
`docs/proposal/phase-1/git-foundation.md` states.

Independent of Story 2 and Story 3. `cloneObjective` is reachable only from the `Git` interface and its own tests
— every call site is `src/services/git/clone.ts:9`, `src/services/git/binary.ts:4` and `:31`,
`src/services/git/clone.test.ts` and `src/services/git/binary.test.ts:175` — so no command, query,
handler or CLI observes this change.

## Change

### 1. `src/domain/repository.ts` — two renderers

Append two functions at the end of the file:

```ts
export function featureBranchOf(nodeId: string): string {
  return `feature/${nodeId}`;
}

export function featureRefOf(nodeId: string): string {
  return `refs/heads/feature/${nodeId}`;
}
```

They live beside the other ref renderers because this file is where a ref string is rendered, and a
second home for the same concern would make the answer depend on the reader. The argument is the
objective's node id, which is `objective_<ULID>` as minted by
`src/services/ids/ulid.ts:9-13` — the function does not validate it, and the domain stays pure.

`featureBranchOf` renders the `checkout -b` argument. `featureRefOf` renders the fully-qualified ref
that `mr@1` reads in phase 2. Both ship now, because a caller that concatenates `refs/heads/` onto
`featureBranchOf` is the duplication this file exists to prevent.

### 2. `src/services/git/index.ts` — `CloneInput` names the objective

Replace `CloneInput` at lines 60-64 with:

```ts
export type CloneInput = Readonly<{
  sourceGitDir: string;
  targetDir: string;
  ref: string;
  objectiveId: string;
}>;
```

`ref` keeps its meaning — the branch to clone and check out first. `objectiveId` is the objective's
node id, and `clone.ts` renders the branch name from it with `featureBranchOf`.

**The input carries the objective identity, not a branch string.** A `featureBranch: string` member
would let any caller pass `"anything"` and produce a workspace that violates the naming rule the EPIC
establishes, which is the one thing this story exists to guarantee. Deriving inside the service is
also the pattern Story 3 already uses: `src/services/git/seed.ts` calls `landingRefOf(input.branch)`
rather than accepting a pre-rendered ref. A service implementation may import `domain/`, so the rule
is consistent in both places.

No phase-1 caller exists — see the note at the top of this story — so `clone.test.ts` and
`binary.test.ts` are the only sites that supply the member.

### 3. `src/services/git/clone.ts` — one command and one assertion

Import `featureBranchOf` and `featureRefOf` from `../../domain/repository.ts`, and bind the name once
at the top of the `try` block, immediately after the `staging` assignment at line 18:

```ts
const featureBranch = featureBranchOf(input.objectiveId);
```

**The command.** Insert a new runner call immediately after the clone-failure check at line 38, before
the `git remote remove origin` call at line 39:

```ts
const branchResult = await runner({
  args: ["-C", staging, "checkout", "-b", featureBranch],
});
if (branchResult.code !== 0) {
  throw new GitError(
    "unknown",
    `git checkout -b failed with code ${branchResult.code}`,
    stripUserinfo(branchResult.stderr),
  );
}
```

**The assertion.** Insert immediately after the partial-clone check at line 82, before
`renameSync(staging, input.targetDir)` at line 83:

```ts
const headResult = await runner({
  args: ["-C", staging, "symbolic-ref", "--quiet", "HEAD"],
});
const expectedRef = featureRefOf(input.objectiveId);
if (headResult.code !== 0) {
  throw new GitError(
    "unknown",
    `the clone has no symbolic HEAD; git symbolic-ref exited ${headResult.code}`,
    stripUserinfo(headResult.stderr),
  );
}
if (headResult.stdout.trim() !== expectedRef) {
  throw new GitError(
    "unknown",
    `the clone HEAD is ${headResult.stdout.trim()} and not ${expectedRef}`,
    "",
  );
}
```

`symbolic-ref --quiet HEAD` and not `rev-parse --abbrev-ref HEAD`: the assertion compares the exact
fully-qualified ref that `HEAD` points at, rather than asking git to abbreviate a ref and then
comparing the abbreviation. It is also the check that fails loudly on a detached HEAD, which
`--abbrev-ref` reports as the string `HEAD`. This is why the story ships `featureRefOf` and not only
`featureBranchOf`.

The assertion sits **after** the three existing assertions and before the rename, so the order
`git-foundation.md` states is unchanged: no remote, no alternates, no partial clone, then the branch,
then the rename. The `finally` block at 85-87 already removes the staging directory on any throw.

Change nothing else in the file. The `existsSync` guard at 13-15, the staging path at 16-18, the
clone argument vector at 20-31, and the three assertions at 57-59, 60-66 and 67-82 stay
byte-identical.

### 4. `src/services/git/binary.ts`

No change. `clone: (input) => cloneObjective(runner, input)` at line 31 passes the input through, and
the new member travels with it.

## Constraints

- **Do not change the clone argument vector.** `--no-hardlinks`, `--no-local`, `--branch`, `--` and
  the two paths at `clone.ts:20-31` stay exactly as they are. This story adds a branch inside the
  clone; it does not change how the clone is made.
- **Do not weaken an isolation assertion.** The three checks at `clone.ts:57-59`, `:60-66` and
  `:67-82` keep their conditions and their exact messages.
- **`checkout -b` runs before `remote remove`**, matching the sequence in
  `git-foundation.md`. Do not reorder.
- **The clone still configures no remote.** `checkout -b` creates a local branch with no upstream, so
  no `branch.<name>.remote` config appears. The existing "no remote" assertion proves it and needs no
  extension.
- **Render the branch, never concatenate.** No file outside `src/domain/repository.ts` writes the
  literal `feature/`.
- Do not add a readable alias for the feature branch. The EPIC ships the ULID form and names the alias
  an open item.
- Do not push a `feature/*` branch anywhere. That capability is a declared non-goal.

## Verify

### `src/services/git/clone.test.ts`

The file has no shared "checked-out branch" helper and this story adds none — it uses the existing
file-local `workspaceGit` at `:86-92` with `["symbolic-ref", "--quiet", "HEAD"]`. The nearest existing
pattern is `["rev-parse", "--abbrev-ref", "HEAD"]` at `:159-165`, which this story replaces.

Every existing `cloneObjective` call — `:150-154`, `:173-177`, `:218-222`, and those at `:239`,
`:263`, `:280`, `:301`, `:320` and `:339` — gains
`objectiveId: "objective_01JQ8Z4A2B"`. Use that one literal everywhere, so the assertions
are exact strings and no test derives a name.

**Rewrite the test at `:145-166`.** It asserts today that the clone carries the landing branch. It
becomes:

```ts
it("the clone starts at the landing branch and works on the feature branch", async () => {
```

- `published` still equals `targetDir`.
- `rev-parse HEAD` still equals `c2` — the feature branch starts at the landing tip, so the commit is
  unchanged. This is the assertion that proves `checkout -b` created the branch rather than an empty
  one.
- `symbolic-ref --quiet HEAD` now equals `"refs/heads/feature/objective_01JQ8Z4A2B"`, **not** `"refs/heads/land"`.
- Add `rev-parse --verify refs/heads/land` and assert code `0` and stdout `c2` — the landing branch
  still exists in the clone, which is what makes the phase-2 merge base available.
- Add `for-each-ref refs/heads` and assert the names deep-equal
  `["refs/heads/feature/objective_01JQ8Z4A2B", "refs/heads/land"]` — bytewise, `f` before `l`. Two
  local heads and no more.

**Leave the isolation tests unchanged in meaning.** `:168-187` (link count), `:189-211` (the
hard-link control) and `:213-...` (no remote) keep every assertion; only the `featureBranch` member is
added to their `cloneObjective` calls. The link-count test is the EPIC gate's isolation proof and its
`assert.equal(statSync(file).nlink, 1, file)` loops must not move.

**Add five tests:**

- `a feature branch name already in the source is refused`: write
  `refs/heads/feature/objective_01JQ8Z4A2B` in the home, clone with the same `objectiveId`, and assert
  `cloneObjective` rejects with a `GitError` whose message contains
  `git checkout -b failed with code`. Assert also that
  `existsSync(targetDir)` is `false` and that `stagingEntries(root)` is empty — a refused clone
  publishes nothing and leaves no staging directory.
- `a clone on the wrong branch is refused before the rename`: wrap the real runner so the
  `symbolic-ref --quiet HEAD` request answers stdout `"refs/heads/land\n"` with code `0`, exactly as
  `answeringRemoteRunner` at `:130-137` wraps the `remote` request. Assert the rejection message
  equals
  `the clone HEAD is refs/heads/land and not refs/heads/feature/objective_01JQ8Z4A2B`, and that
  `existsSync(targetDir)` is `false`.
- `a detached HEAD is refused`: wrap the runner so the `symbolic-ref --quiet HEAD` request answers
  code `1` with empty stdout, which is what git reports for a detached HEAD. Assert the message
  contains `the clone has no symbolic HEAD`. This is the case `rev-parse --abbrev-ref` could not
  distinguish, because it reports the literal string `HEAD` with exit code `0`.
- `the feature branch carries no upstream`: after a successful clone, run
  `config --get branch.feature/objective_01JQ8Z4A2B.remote` and assert a non-zero code. This is what
  proves `checkout -b` added no remote tracking to a clone that has no remote.
- `the checkout runs before the remote is removed`: with a recording runner, assert the recorded
  argument vectors appear in this order — `clone`, then `checkout -b`, then `remote remove`, then
  `remote`, then `config --get-regexp`, then `symbolic-ref --quiet`. Assert the full ordered list of
  the six subcommands by value, not by `includes`.

### `src/services/git/binary.test.ts`

`git.clone({...})` at `:175` gains `objectiveId: "objective_01JQ8Z4A2B"`.

### `src/domain/repository.test.ts`

Exact-string tests, one assertion each:

- `featureBranchOf("objective_01JQ8Z4A2B")` equals `"feature/objective_01JQ8Z4A2B"`.
- `featureRefOf("objective_01JQ8Z4A2B")` equals `"refs/heads/feature/objective_01JQ8Z4A2B"`.
- `featureRefOf(id)` equals `` `refs/heads/${featureBranchOf(id)}` `` for
  `id = "objective_01JQ8Z4A2B"` — the two renderers agree by construction.

### Commands

```bash
node --test \
  src/domain/repository.test.ts \
  src/services/git/clone.test.ts \
  src/services/git/binary.test.ts
```

`npm run verify` exits 0.

Proof — the EPIC's `## Verification Gate`, its fourth check: _an objective clone reports
`feature/<node id>` as its checked-out branch, and the object-file link count still proves
isolation._ The rewritten test at `clone.test.ts:145` delivers the first clause and the untouched
test at `:168-187` delivers the second.
