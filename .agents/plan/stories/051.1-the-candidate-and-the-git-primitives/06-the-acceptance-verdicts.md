# Story 6 — The acceptance verdicts

Epic: `.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md`
Depends on: EPIC 050 Story 3 (`runRow` and its `baseCount` refine), EPIC 051 (the claim that writes the one `run_base` row the tightened refine describes). Nothing in this epic depends on this story; it runs independently of Stories 1 to 5.
Kind: story-foundation

This story adds three pure functions and tightens one schema refine. It has no caller: EPIC 051.4
adds `acceptExecution`, which is the ordered gate that calls all three. It changes no drawn path, so
it draws nothing.

## Change

**Create `src/domain/execution-acceptance.ts`.** Three pure functions, no zod on the inputs, results
as discriminated unions of `Readonly<{}>`, matching `src/domain/node-write-legality.ts:32 — `refusal``
and `src/domain/attempt-accounting.ts:15 — `AttemptVerdict``.

### 1 — `ancestryVerdict`

```ts
export type AncestryVerdict =
  Readonly<{ ok: true }> | Readonly<{ ok: false; refusal: "ancestry-broken" }>;

export function ancestryVerdict(
  input: Readonly<{ baseIsAncestorOfHead: boolean }>,
): AncestryVerdict;
```

It reads no git. The boolean is what `git.isAncestor` of Story 1 returns, and EPIC 051.4 is where the
call site that produces it exists.

### 2 — `repositoryVerdict`

```ts
export type RepositoryVerdict =
  | Readonly<{ ok: true; repositoryId: string }>
  | Readonly<{
      ok: false;
      refusal: "multi-repository-unsupported";
      reported: string;
      base: readonly string[];
    }>;

export function repositoryVerdict(
  input: Readonly<{
    reportedRepositoryId: string;
    baseRepositoryIds: readonly string[];
  }>,
): RepositoryVerdict;
```

It passes when `baseRepositoryIds` holds exactly one entry and that entry equals
`reportedRepositoryId`. Every other case refuses, and `base` carries `baseRepositoryIds` sorted with
`comparePaths` (`src/domain/plan-path.ts:106 — `comparePaths``) so the refusal is reproducible.

The refusal compares **the repository the report names against the single stored `run_base` row**. It
never compares two stored rows. The primary key `(run_id, repository_id)` at
`src/services/storage/migration-0012-run-model.ts:40 — `PRIMARY`` forbids only a **duplicate pair**;
it permits two rows for one run under two repository ids, so it proves nothing on its own. What makes
a two-row base set unproducible is the writer: `src/services/storage/migration-0002-graph-and-plan.ts:33 — `CHECK``
gives an objective exactly one `repository_id`, and EPIC 051's claim inserts one row inside its own
transaction. The invariant is therefore an application guarantee, not a database one, which is also
why Story 6's refine is documentation.

### 3 — `declaredPathVerdict`

```ts
export type DeclaredPathVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      refusal: "path-undeclared";
      undeclared: readonly string[];
    }>;

export function declaredPathVerdict(
  input: Readonly<{
    declared: readonly string[];
    changed: readonly string[];
  }>,
): DeclaredPathVerdict;
```

- `declared` is the node's `verify.paths` value. Every entry is **absolute**: `verifyPath` at
  `src/domain/verify-block.ts:5 — `verifyPath`` refuses a path that does not start with `/`, and it
  refuses a trailing `/`.
- `changed` is what `git.changedPaths` of Story 1 returns, and every entry is **repository-relative**.
- A changed path `p` is declared when `declared` holds the exact string `` `/${p}` ``. Comparison is
  exact string equality, so a `verify.paths` entry naming a directory matches no file beneath it.
- `undeclared` holds every changed path that is not declared, in its repository-relative form, sorted
  with `comparePaths`. The refusal names **every** violation in one report, not the first.
- An empty `declared` list therefore refuses every non-empty `changed` list and passes an empty one.
  `src/domain/verify-block.ts:28 — `paths`` makes `paths` a required array that may be empty, and
  nothing in `docs/proposal/` says an empty `paths` asserts nothing. A node that declares no path
  declares no write set.

`src/domain/` is pure, so this module imports `comparePaths` and nothing else outside `domain/`.

**`src/domain/run.ts` — tighten the refine.** At `src/domain/run.ts:37 — `baseCount``, replace
`row.baseCount <= 1` with `row.baseCount === 1`. At `src/domain/run.ts:42 — `message``, replace the
message with:

```
an execution run holds exactly one run_base row, and a structural or review run holds none
```

The refine states the invariant and enforces nothing. `runRow` is imported into
`src/domain/rows.ts:43 — `runRow`` and into two tests, and no production file calls `parse` or
`safeParse` on it. What enforces the cardinality is EPIC 051's claim, which writes exactly one row
inside its own transaction.

**The refine consumers.** Two test files construct a `runRow` value and must move with it:

- `src/domain/run.test.ts:29 — `baseCount`` sets `baseCount: 0` in the shared `validRun` fixture.
  Change it to `1`, so every case that is not about cardinality still parses.
- `src/domain/run.test.ts:164 — `refine`` is `"refine: an execution run holding no run_base row passes"`.
  It flips: rename it and assert the failure. Cases at `src/domain/run.test.ts:172`, `:180`, `:188`,
  `:196` and `:203` keep their verdicts.
- `src/domain/run.test.ts:215 — `message`` asserts the refine message by value. Update the literal.
- `src/services/storage/migration-0007-external-execution.test.ts:1226 — `runRow`` parses a row built
  from a migrated database. Set its `baseCount` to `1` for an execution run, or to `0` with the run
  kind it already uses, whichever the existing fixture holds.

## Constraints

- `src/domain/` is pure. None of the three functions reads git, the clock, the file system or a
  transaction.
- The three refusal names are `ancestry-broken`, `multi-repository-unsupported` and `path-undeclared`.
  None of them exists in the tree today, and none of them is registered on the wire here: EPIC 051.4
  carries every contract edit of the family.
- `declaredPathVerdict` compares by exact string equality. Never treat a declared entry as a prefix.
- Do not change `runBaseRow` at `src/domain/run.ts:48 — `runBaseRow``, and do not add a `base_count`
  column. `baseCount` is a validation-only field and no table carries it.

## Verify

```
node --test src/domain/execution-acceptance.test.ts src/domain/run.test.ts src/services/storage/migration-0007-external-execution.test.ts
```

Create `src/domain/execution-acceptance.test.ts`, suite name
`"src/domain/execution-acceptance.test"`, on `node:test` with `node:assert/strict`, matching
`src/domain/run.test.ts:10 — `describe``.

Add, each as a separate `it`:

1. `"a descendant head passes the ancestry verdict"` — assert
   `ancestryVerdict({ baseIsAncestorOfHead: true })` deep-equals `{ ok: true }`.

2. `"a head that is not a descendant refuses ancestry-broken"` — assert
   `ancestryVerdict({ baseIsAncestorOfHead: false })` deep-equals
   `{ ok: false, refusal: "ancestry-broken" }`.

3. `"a reported repository equal to the sole base entry passes"` — assert
   `repositoryVerdict({ reportedRepositoryId: "repo_a", baseRepositoryIds: ["repo_a"] })` deep-equals
   `{ ok: true, repositoryId: "repo_a" }`. This is the control for case 4: without it the refusal
   passes for a verdict that refuses everything.

4. `"a reported repository that is not the sole base entry refuses"` — assert
   `repositoryVerdict({ reportedRepositoryId: "repo_b", baseRepositoryIds: ["repo_a"] })` deep-equals
   `{ ok: false, refusal: "multi-repository-unsupported", reported: "repo_b", base: ["repo_a"] }`.

5. `"a run with no base entry refuses the repository verdict"` — assert
   `repositoryVerdict({ reportedRepositoryId: "repo_a", baseRepositoryIds: [] })` deep-equals
   `{ ok: false, refusal: "multi-repository-unsupported", reported: "repo_a", base: [] }`.

6. `"two undeclared paths refuse and the refusal lists both in comparePaths order"` — assert
   `declaredPathVerdict({ declared: ["/src/a.ts"], changed: ["src/z.ts", "src/b.ts"] })` deep-equals
   `{ ok: false, refusal: "path-undeclared", undeclared: ["src/b.ts", "src/z.ts"] }`. Both the
   completeness and the order are asserted by value.

7. `"a declared entry naming a directory does not match a file beneath it"` — assert
   `declaredPathVerdict({ declared: ["/src"], changed: ["src/a.ts"] })` deep-equals
   `{ ok: false, refusal: "path-undeclared", undeclared: ["src/a.ts"] }`.

8. `"a rename with only the new path declared refuses"` — assert
   `declaredPathVerdict({ declared: ["/src/b.ts"], changed: ["src/a.ts", "src/b.ts"] })` deep-equals
   `{ ok: false, refusal: "path-undeclared", undeclared: ["src/a.ts"] }`. Both sides of a rename must
   be declared, and `git.changedPaths` of Story 1 emits both.

9. `"an empty declared list refuses a non-empty diff"` — assert
   `declaredPathVerdict({ declared: [], changed: ["src/a.ts"] })` deep-equals
   `{ ok: false, refusal: "path-undeclared", undeclared: ["src/a.ts"] }`.

10. `"an empty declared list passes an empty diff"` — assert
    `declaredPathVerdict({ declared: [], changed: [] })` deep-equals `{ ok: true }`. With case 9 this
    pins both halves of the asymmetry between `paths` and `commands`.

11. `"every declared changed path passes"` — assert
    `declaredPathVerdict({ declared: ["/src/a.ts", "/src/b.ts"], changed: ["src/b.ts", "src/a.ts"] })`
    deep-equals `{ ok: true }`. The declared list is a set, so the changed order does not matter.

In `src/domain/run.test.ts`, add or amend:

12. `"refine: an execution run holding no run_base row fails"` — parse `validRun` with
    `baseCount: 0` and assert `success === false`. This replaces the passing case at
    `src/domain/run.test.ts:164 — `refine``.

13. `"refine: an execution run holding one run_base row passes"` — the case at
    `src/domain/run.test.ts:172 — `refine`` keeps its verdict; assert it against the amended
    `validRun`.

14. `"refine: an execution run holding two run_base rows fails"` — the case at
    `src/domain/run.test.ts:180 — `refine`` keeps its verdict.

15. `"refine: message equals the stated cardinality sentence"` — the case at
    `src/domain/run.test.ts:215 — `message`` asserts
    `result.error!.issues[0]!.message` equals
    `"an execution run holds exactly one run_base row, and a structural or review run holds none"`.
    The refine is documentation, so this is a schema test and not a claim that production validates a
    live row.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/execution-acceptance.test.ts` and `src/domain/run.test.ts`
in `PASS EPIC-051.1`.
