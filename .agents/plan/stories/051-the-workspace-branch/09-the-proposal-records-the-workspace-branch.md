# Story 9 — The proposal records the workspace branch

Epic: `.agents/plan/epics/051-the-workspace-branch.md`
Depends on: Story 1 (`01-migration-13`) for the schema it documents and Story 8 (`08-startup-reconciles-an-open-cut-row`) for the reconciliation it describes. It is last, so the document describes a shape no later story of this epic moves.
Kind: story-foundation

## Change

### 1 — `docs/proposal/database/workspace.md`

Add a second section after the existing walkthrough at
`docs/proposal/database/workspace.md:44`, holding the branch record, its two triggers, the two
derived fields and the journaled first claim.

**The first ` ```sql ` fence of the file is not touched.**
`test/helpers/proposal.ts:8` — `proposalStatements` reads the **first** SQL fence only, and
`src/services/storage/migration-0003-execution-and-journal.test.ts:476` — `proposalStatements`
deep-equals it against migration `3`'s own `workspace` statement. A change to that fence breaks a
shipped test this story does not name; a second fence is invisible to it.

The second fence holds the statements of Story 1 (`01-migration-13`) verbatim — the
`workspace_branch` table and the `workspace_branch_origin_immutable` trigger — plus the delete
trigger `workspace_branch_checkpoint_guard`, marked as belonging to migration `14`:

- **`ref` is not a column.** It is `refs/heads/<node_id>`, a pure function of the key, and
  `src/domain/repository.ts` — `objectiveRefOf` of Story 2 (`02-the-workspace-branch-record`) is the
  one renderer. Storing it would invite drift with nothing to detect it.
- **`repository_id` is not a column.** It joins from `node`, and
  `src/services/storage/migration-0011-deliverable.ts:28` — `CHECK` makes an objective the only kind
  carrying one, so the join is constraint-backed and total.
- **`state` is not a column.** Neither this family nor `docs/workflow/worker.md` section 7 defines
  a transition for the record.
- **`origin_oid` is immutable and the row is not deletable while a checkpoint names it.** The first
  trigger belongs to migration `13`; the second belongs to migration `14`, because a trigger naming
  an absent table is not creatable. Name the owning epic for the second, so a reader does not look
  for it in migration `13`.
- **The record is created inside the first execution claim, as a journaled write.** State the three
  phases in prose: one transaction reads the claim state and opens a `cut` journal row at
  `base_oid` and `proposed_head_oid` both zero; the branch tip is resolved and
  `refs/heads/<objectiveId>` is created at it, in no transaction; one transaction writes the record,
  the run and its base, the transitions and the events, and completes the row. State that a crash
  between them leaves an `open` row that startup reconciles by the ref's existence, and that a
  concurrent loser fails on the primary key and refuses `objective-busy`.
- **`origin_oid` equals `workspace.clone_base_oid` for an internal run.** SQLite cannot constrain it
  across tables, so state that the assertion of Story 5 (`05-the-claims-settle`) case 7 is the whole
  enforcement.

The shipped prose at `docs/proposal/database/workspace.md:8` says a `workspace` row exists for an
internal run only. Leave it. The branch facts live in their own table **because** of it: an external
run owns no clone and therefore no `workspace` row, and it still lands on the objective branch.

### 2 — `docs/proposal/database/git_operation.md`

`docs/proposal/database/git_operation.md:9` — `intent` declares four intents and
`docs/proposal/database/git_operation.md:47` narrates them. Migration `13` widened the CHECK to five,
so both lines are stale the moment Story 1 lands.

Add `'cut'` to the CHECK literal in the SQL fence, in the SQL order, and add one sentence to the
prose naming what a `cut` row journals: the creation of `refs/heads/<objectiveId>` inside a first
execution claim, with both oids zero because the ref must not exist.

**That edit breaks a shipped test, and this story repairs it.**
`src/services/storage/migration-0003-execution-and-journal.test.ts:483` — `proposalStatements`
deep-equals migration `3`'s `git_operation` statement against the document, and migration `3` still
declares four intents. Introduce a module-level `historicalGitOperationStatement` constant holding
migration `3`'s text verbatim, and name it in place of `proposalStatements("git_operation")`,
following `src/services/storage/migration-0003-execution-and-journal.test.ts:71` —
`historicalLeaseStatement`, which is the shipped pattern for exactly this drift. Four such constants
already exist in that file; this is the fifth.

## Constraints

- Do not change the first SQL fence of `docs/proposal/database/workspace.md`, and do not change
  migration `3`.
- Add the `historicalGitOperationStatement` constant rather than editing migration `3` to match the
  document. The document records the live schema; the constant records what migration `3` created.
- `workspace_branch` is documented in `docs/proposal/database/workspace.md` and not in a new file.
  One file per table is the convention of `docs/proposal/database/README.md`, and the branch record
  is the same subject as the workspace: which tree the tasks of an objective work in.
- Do not restate the epic's Decisions. The document states the behaviour and the schema; the epic
  states why.
- Do not amend `docs/proposal/phase-1/domain.md` here. Story 2
  (`02-the-workspace-branch-record`) adds `workspace_branch` to its table line, and
  `src/domain/rows.test.ts:62` — `it` already pins it.

## Verify

```
node --test src/services/storage/migration-0003-execution-and-journal.test.ts src/domain/rows.test.ts test/helpers/proposal.test.ts src/services/storage/migration-0013-workspace-branch.test.ts
```

Add, each as a separate `it`:

1. `"workspace.md declares the workspace_branch table and its two triggers"` — read the document,
   assert the second SQL fence holds `CREATE TABLE workspace_branch`,
   `workspace_branch_origin_immutable` and `workspace_branch_checkpoint_guard`, and that the second
   trigger's paragraph names migration `14`.

2. `"the second fence of workspace.md reproduces migration 13's workspace_branch statements"` —
   `deepEqual` the normalized second fence against the two `workspace_branch` statements of
   `migration0013WorkspaceBranch.statements`, in order. The delete trigger is excluded, because
   migration `13` does not create it; assert it appears in the fence and not in the comparison.

3. `"the first fence of workspace.md is unchanged"` — assert
   `test/helpers/proposal.ts:8` — `proposalStatements` still deep-equals migration `3`'s
   `workspace` statement, which is the shipped case at
   `src/services/storage/migration-0003-execution-and-journal.test.ts:476` — `proposalStatements`.
   This is the control that the second fence is invisible to the helper.

4. `"workspace.md states the derived ref and the derived repository id"` — assert the prose holds
   `refs/heads/<node_id>` and names `node.repository_id` as the join, and that neither appears as a
   column in the second fence. The oracle is absence, so the control is `origin_oid`, which does
   appear in the fence.

5. `"workspace.md states the journaled first claim in three phases"` — assert the prose names the
   `cut` journal row, the ref creation outside every transaction, the settle, the startup
   reconciliation by the ref's existence, and the `objective-busy` refusal of the loser. Five
   substrings, one assertion each.

6. `"git_operation.md declares five intents in the SQL order"` — assert the fence's `intent` CHECK
   literal list equals `["merge", "sync", "publish", "revert", "cut"]`, and that it equals
   `src/domain/git-operation.ts:7` — `gitIntents` element by element.

7. `"git_operation.md narrates the cut intent"` — assert the prose at
   `docs/proposal/database/git_operation.md:47` names `cut` and the objective ref it creates.

8. `"migration 3's git_operation statement is compared against the historical constant"` — assert
   `historicalGitOperationStatement` deep-equals migration `3`'s statement, that it declares four
   intents, and that `proposalStatements("git_operation")` declares five. The third assertion is the
   control that the two sources genuinely diverged.

9. `"the migrated git_operation table matches the document, not migration 3"` — over a fully migrated
   database, `deepEqual` `test/helpers/schema.ts:5` — `tableDdl` normalized against
   `proposalStatements("git_operation")`. This is what binds the document to the live schema rather
   than to a historical statement.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/storage/migration-0003-execution-and-journal.test.ts` and
`src/services/storage/migration-0013-workspace-branch.test.ts` in `PASS EPIC-051`.
