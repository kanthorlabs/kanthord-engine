# EPIC 051 — The workspace branch and the first claim

Status: **draft**. It follows EPIC 050.5 by sequence order, and it runs before EPIC 051.1. It consumes EPIC 050's run, fence and exclusion rules, EPIC 050.1's claim and expiry pass, and EPIC 050.4's lease-free claim.

This epic is the first of five that replace the single EPIC 051 authored before `.agents/plan/authoring.md`. That document held sixteen story entries and twenty-two sequence diagrams, and the standard refuses both: an epic holds no diagram, and an epic holds no more than ten stories. The five epics are EPIC 051, EPIC 051.1, EPIC 051.2, EPIC 051.3 and EPIC 051.4. They carry decimal numbers because EPIC 052 through EPIC 057 are authored and numbered, and renumbering them would break every cross-reference between them.

It needs neither EPIC 050.6 nor the re-authored EPIC 107. The only story of the family that needs a working `Verify` is the command gate, and that is EPIC 051.2.

## Goal

An objective owns a branch record, and the first execution claim creates it:

- `workspace_branch` holds one row per objective, with an immutable `origin` and a moving `head`;
- the first execution claim on an objective cuts `refs/heads/<objectiveId>` from `repository.branch` as a journaled write, and writes the record in its settle;
- every later claim reads the record in one transaction and passes `head_oid` as the run's base oid, so `run_base` is inserted atomically with the run;
- a crash between the two transactions of a first claim is reconciled at startup from the `cut` journal row.

## Non-goals

- **No checkpoint, and no `checkpoint` table.** EPIC 051.3 creates the table with migration `14` and writes the first row. This epic's migration creates `workspace_branch` alone.
- **No candidate, no acceptance and no land.** EPIC 051.1 ingests a candidate, EPIC 051.2 runs the declared commands, EPIC 051.3 lands, and EPIC 051.4 composes the ordered gate and wires the route.
- **No advance of `head_oid`.** The column is written once, at creation, by this epic. `plan.setWorkspaceBranchHead` is declared here and EPIC 051.3 is its only caller.
- **No worker loop.** Nothing produces a commit here.
- **No change to the shipped `workspace` table.** The branch facts live in their own table, and `workspaceRow` at `src/domain/workspace.ts:7` is untouched.
- **No lift of `review-head-unavailable`.** EPIC 050.1's guard stays. EPIC 053 owns the review claim and the judged checkpoint.
- **No attempt-workspace disposal.** This range creates no attempt workspace, and no `Workspace` service exists to remove one. See the blocker in `## Amendments this epic asks of other epics`.

## Decisions

- **The branch record is its own table, `workspace_branch`, and the shipped `workspace` table is not touched.** `docs/proposal/database/workspace.md:3` answers "which clone do the tasks of this objective work in", and `:21` states a row exists for an internal run only, because an external harness owns its own working tree. The family lands external candidates too, and an external run has no clone, so the branch facts cannot live on a row an external run never owns. `path`, `clone_base_oid`, `upstream_oid_at_clone`, `profile_blob`, `convention_version` and `state` are all `NOT NULL` at `migration-0003-execution-and-journal.ts:7-19`, and relaxing them would make `src/commands/startup/sweep-remnants.ts:45-47` assert `path: string` over a nullable column. Migration `13` therefore creates:

  ```sql
  CREATE TABLE workspace_branch (
    node_id    TEXT PRIMARY KEY REFERENCES node(id),
    origin_oid TEXT NOT NULL,
    head_oid   TEXT NOT NULL
  ) STRICT
  ```

- **Three columns, and the other two are derived.** `ref` is `refs/heads/<node_id>`, a pure function of the key, so storing it invites drift with nothing to detect it. `repository_id` joins from `node`, and `migration-0002-graph-and-plan.ts:33` carries `CHECK ((kind = 'objective') = (repository_id IS NOT NULL))`, so an objective always has one and the join is constraint-backed. `state` is not carried: neither this family nor `worker.md` defines a transition for the branch record, and a column with no transitions is a column nobody can write correctly.

- **Both columns are `NOT NULL` from migration `13`, so no later epic tightens them.** The row is written inside the claim, where the branch tip is already resolved, so neither value is ever unknown. An earlier draft added three nullable columns to `workspace` and said EPIC 057 would make them `NOT NULL`. That was false: `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` enumerates every column that migration tightens, and it names no workspace column at all.

- **`workspace_branch.origin_oid` is immutable, and the row is not deletable while a checkpoint names it.** A trigger refuses an `UPDATE` that changes `origin_oid`, because a CHECK cannot compare against the old row. A second trigger refuses a `DELETE` of a `workspace_branch` row referenced by a `checkpoint` row, because delete-and-reinsert would defeat the first trigger. **The second trigger is created by migration `14`, not by migration `13`**: `checkpoint` does not exist yet, and a trigger naming an absent table is not creatable. EPIC 051.3 owns it.

- **Migration `13` rebuilds `git_operation`, and it declares `rebuild: true`.** Cutting the objective branch is a durable write to the bare home, so it carries a journal row, and `git_operation.intent` at `migration-0003-execution-and-journal.ts:130` is `CHECK (intent IN ('merge', 'sync', 'publish', 'revert'))`. SQLite cannot widen a CHECK in place. Adding `cut` therefore needs the `ALTER TABLE git_operation RENAME TO git_operation_old` rebuild that `migration-0006-revision-origin.ts:8` and `migration-0007-external-execution.ts:8-9` already use, which makes `src/services/storage/sqlite.ts:77` set `PRAGMA foreign_keys = OFF` and `PRAGMA legacy_alter_table = ON` for this migration. **The superseded draft asserted the opposite three times** — "additive", "no table is rebuilt", "`sqlite.ts:77` never turns it off" — and every shipped rebuild test asserts `PRAGMA legacy_alter_table` is back to `0` afterwards, so this migration does too. Every index, trigger and row of `git_operation` is asserted present and identical after the rebuild.

- **The branch is cut inside the claim, on the first claim that needs it.** `worker.md` section 7 states it: "The daemon initializes the workspace on the first claim that needs the branch. The daemon initializes it inside the claim." No readiness command cuts a branch, and a node reaching `ready` creates nothing. The cut point is the oid `repository.branch` names in the bare home at claim time, recorded as `workspace_branch.origin_oid`.

- **The claim therefore becomes the journaled write, and its nested units are `claim.begin` and `claim.settle`.** `AGENTS.md:105` gives a journaled write exactly two transactions and gives no other command two. A claim that called a self-contained two-transaction `workspace.cut` and then opened its own transaction would open three, so the cut cannot be a nested command with its own journal pair. The claim's reads join the begin, the ref creation sits between, and the claim's writes join the settle beside `plan.writeWorkspaceBranch`.

- **`git.resolveRef:branch` runs before the begin transaction, not inside it.** `AGENTS.md` forbids git I/O inside a storage transaction because the transaction holds the write lock across it. The branch tip is read first, and the value is carried into the begin.

- **A claim that finds a branch record is one transaction, so the operation has two paths.** The first execution claim is the journaled write above. Every later claim reads the record and opens one transaction, exactly as EPIC 050.4 drew it. The two differ in seam set and in transaction count, so each is its own diagram, and the branch read is what selects between them.

- **Two concurrent first claims both reach the ref creation, and the loser refuses the claim.** The git write sits between the two transactions, so the begin transaction cannot serialise it, and `worker.md`'s claim that two first claims never race does not survive the journaled shape. It does not need to: both claims resolve the same `repository.branch` tip and create the same ref at the same oid, so the ref is correct whichever wins. The loser fails in its settle on the `workspace_branch` primary key, discards its journal row, writes nothing, and **refuses the claim with the shipped `objective-busy` code**. The caller retries, and the retry takes the ordinary one-transaction path where `objectiveBusy` refuses it properly. **The superseded draft carried a second, contradictory decision** claiming `BEGIN IMMEDIATE` serialised the two claims so the loser never reached the ref creation. That is false for a two-transaction command, and it is deleted here.

- **That primary-key failure is the only enforcement point for objective exclusion on the first claim, and this epic states it.** `objectiveBusy` at `src/domain/run-exclusion.ts` enforces one active run per objective branch, and the journaled claim evaluates it in `claim.begin` while the run is opened in `claim.settle`. Two concurrent first claims on two tasks of one objective therefore both pass exclusion: neither has opened a run when the other reads. `run_one_active` at `migration-0007-external-execution.ts:33` is unique on `node_id`, and the two tasks are different nodes, so it does not fire either. The `workspace_branch` primary key is what stops the second run. The window exists on the first claim of an objective only, because every later claim is one transaction. **A change that let the loser recover and continue would silently open the window**, and this decision is why no such change is legal without a new enforcement point.

- **The claim's branch read is conditional on the run kind, and it takes the objective id.** `runKindFor(node.deliverable)` selects `execution`, and the record is keyed on the objective, so the read takes `objectiveScopeId(node)` at `src/commands/node/claim-node.ts:201`. A structural or review claim makes no such read: EPIC 050 gives neither kind a base row.

- **A crash between the ref creation and the settle is reconciled at startup.** The journal row is `open` with its `proposed_head_oid`. `src/commands/startup/reconcile-journal.ts` reads every `open` `cut` row, compares the ref to `proposed_head_oid`, and either completes the row or marks it `discarded`. A `cut` row needs no pending transition: the claim's effects all sit in the settle, so a discarded row leaves the node `ready` and the caller reclaims.

- **`workspace.openWorkspace` leaves the claim.** The workspace exists before the claim runs, and the claim reads the branch record instead.

## Sequence

This epic draws no diagram. A path is drawn by the story that changes it, under `.agents/plan/authoring.md`. The claim path is drawn by EPIC 050.4, so the story that changes it declares `Supersedes:` and carries no `baseline-` diagram. The three paths this epic writes from nothing — the two nested units and the composed outer — have an empty prior set and draw the ship diagram alone.

### Seam keys this epic introduces

New method signatures, for cross-reference only; the stories carry the interface decisions.

- `claim.begin` / `claim.settle` — nested unit functions injected into the claim; their composed outer is `claim-first-execution`. They exist because the claim is a journaled write, not because a workspace command does; there is no `workspace.cut` command.
- `git.resolveRef` — present since EPIC 006; `:branch` labels the read of `repository.branch` that gives the cut point.
- `git.refUpdate` — present since EPIC 006; `:cut` labels the branch cut.
- `plan.readWorkspaceBranch(transaction, nodeId): WorkspaceBranchRow | null` — new method on `PlanStore`.
- `plan.writeWorkspaceBranch(transaction, input): WorkspaceBranchRow` — new method on `PlanStore`.
- `plan.setWorkspaceBranchHead(transaction, input: { nodeId, headOid }): void` — new method on `PlanStore`. Declared here, and called first by EPIC 051.3.
- `journal.open:cut` / `journal.complete:cut` — present in `GitJournal`; the labels project the `intent` field.

## Stories

Each entry is a name and the output it contributes. The story file holds the change, the tasks and the diagrams, and it declares its kind. A `story-foundation` draws nothing; a `story-implement` draws one path. `.agents/plan/authoring.md` is the standard.

1. **Migration 13.** Add `src/services/storage/migration-0013-workspace-branch.ts` at version `13` with `rebuild: true`: create `workspace_branch` with its three columns, both oids `NOT NULL`; add the `origin_oid` immutability trigger; rebuild `git_operation` to widen the `intent` CHECK with `cut`, preserving every column, index, trigger and row. Register it in `src/services/storage/migrations.ts`. `story-foundation`.

2. **The workspace branch record.** Add `workspaceBranchRow` to `src/domain/workspace.ts` with `nodeId`, `originOid` and `headOid`, none nullable, and register `workspace_branch: workspaceBranchRow` in `src/domain/rows.ts`, which is what `src/services/storage/schema-parity.test.ts:90` then covers. Add `plan.readWorkspaceBranch`, `plan.writeWorkspaceBranch` and `plan.setWorkspaceBranchHead` to the plan store. `workspaceRow` at `src/domain/workspace.ts:7` is not changed. `story-foundation`.

3. **The claim reads the workspace head.** Draws `claim-branch-base-task`, superseding EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`) `claim-lease-free-task`. `plan.readWorkspaceBranch` joins the claim transaction and its `head_oid` becomes the run's base oid, so `run_base` is written atomically with the run. `story-implement`.

4. **The claim's begin.** Draws `claim-cut-begin`. The branch tip is resolved before the transaction; the transaction reads the claim state, finds no branch record, and opens the `cut` journal row. `story-implement`.

5. **The claim's settle.** Draws `claim-cut-settle`. One transaction writes the branch record, the assignment, the run, its base row, the three node transitions, the four events, and completes the journal row. `story-implement`.

6. **The first execution claim.** Draws `claim-first-execution`, the composed outer of `claim.begin`, `git.refUpdate:cut` and `claim.settle`. It composes only, so it declares `Diagrams:` and no `Seams:` line. `story-implement`.

7. **The loser of two first claims refuses.** Draws `claim-cut-settle-contested`, the settle path whose `plan.writeWorkspaceBranch` fails on the primary key. The transaction rolls back, the journal row is discarded, nothing is written, and the claim refuses `objective-busy`. `story-implement`.

8. **Startup reconciles an open `cut` row.** Extend `src/commands/startup/reconcile-journal.ts` to reconcile a `cut` row by comparing the ref to `proposed_head_oid`: a matching ref completes the row, a missing one discards it. Neither applies a transition. `story-implement`.

9. **The proposal records the workspace branch.** Amend `docs/proposal/database/workspace.md` with the branch record, its two triggers, the derived `ref` and `repository_id`, and the journaled first claim. `story-foundation`.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 050.1 Story 2 (`02-the-expiry-pass`)** — `:98-100` delegates the fourth candidate-ref deletion to "EPIC 051". It now resolves to EPIC 051.1 Story 5. A human repoints the reference, because `/author` may not write outside its own epic's directory.

- **EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`)** — its `claim-lease-free-task` diagram gains `Superseded by: EPIC 051 claim-branch-base-task`, and `test/sequence/scenarios/claim-lease-free-task.ts` is deleted. `/author` applies this as the standard supersession, and it is named here so a reviewer expects the edit.

- **EPIC 050.5** — its gate rows 5b and 10b seed two `run_base` rows for one run. Those rows are query-isolation tests and not a claim that two bases are a valid product state; EPIC 051.1 tightens the refine to exactly one, so both rows need restating before that refine lands.

- **A blocker, not an amendment: the attempt workspace has no owner.** The superseded draft carried a story removing a failed attempt's workspace directory. `src/services/` holds no `workspace` service, `src/commands/startup/sweep-remnants.ts` reports remnants and removes none, and this family's Non-goals state no worker loop, so nothing in this range creates an attempt workspace to remove. The story is dropped from the family, and the epic that creates an attempt workspace owns its disposal.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/services/storage/migration-0013-workspace-branch.test.ts \
  src/services/storage/schema-parity.test.ts \
  src/domain/workspace.test.ts \
  src/services/plan/sqlite.test.ts \
  src/commands/node/claim-node.test.ts \
  src/commands/startup/reconcile-journal.test.ts \
  test/sequence/conformance.test.ts \
  && echo "PASS EPIC-051"
```

Hermetic coverage required beyond the Proof. **Every assertion below names exactly one owning story.**

| #   | assertion                                                                                                                                                                                                                                                       | story |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `workspace_branch.origin_oid` and `head_oid` each refuse a null insert. Both `NOT NULL` from migration `13`, so no later epic tightens them and none is named.                                                                                                  | 1     |
| 2   | The `origin_oid` trigger refuses an `UPDATE` that changes it, asserted against real SQLite by refusal message.                                                                                                                                                  | 1     |
| 3   | The shipped `workspace` table is unchanged by migration `13`: its column set, its null constraints and its row contents are identical before and after. `docs/proposal/database/workspace.md` needs no amendment and this asserts it.                           | 1     |
| 4   | `git_operation` survives the rebuild whole: every column, index, trigger and row is present and identical afterwards, and `intent = 'cut'` inserts while an unknown intent is still refused. `migration-0007-external-execution.test.ts:1104` is the precedent. | 1     |
| 5   | `PRAGMA foreign_keys` and `PRAGMA legacy_alter_table` are both back to their pre-migration values after migration `13` runs, asserted by value.                                                                                                                 | 1     |
| 6   | `schema-parity` finds the migrated table set equal to `Object.keys(rows)` with `workspace_branch` in it.                                                                                                                                                        | 2     |
| 7   | A round trip through `plan.writeWorkspaceBranch` and `plan.readWorkspaceBranch` returns the written row field by field, and `plan.readWorkspaceBranch` returns null for an objective with no record.                                                            | 2     |
| 8   | The derived `ref` equals `refs/heads/<nodeId>` and the repository id joins from `node`, both asserted by value.                                                                                                                                                 | 2     |
| 9   | A claim on an objective that already holds a branch record passes the record's `head_oid` as the run's base oid, asserted by reading `run_base`.                                                                                                                | 3     |
| 10  | The claim's branch read takes the objective id for a task claim, asserted by claiming a task under an objective and reading the row the objective owns.                                                                                                         | 3     |
| 11  | A review claim still refuses `review-head-unavailable`, and a structural claim makes no branch read, the second asserted by a plan store double whose branch-read count is zero. Two cases.                                                                     | 3     |
| 12  | A second claim on an objective that already holds a branch record opens one transaction and writes no journal row. The control is the first claim on the same fixture, which opens two and writes one.                                                          | 3     |
| 13  | The `cut` journal row is `open` before the ref creation, asserted by reading the row at that point.                                                                                                                                                             | 4     |
| 14  | A first claim resolves `repository.branch` before it opens any transaction, asserted by a git service double whose call ordinal precedes the first `storage.transact`.                                                                                          | 4     |
| 15  | A first claim creates `refs/heads/<objectiveId>` in the loopback repository at the resolved branch oid, asserted by value.                                                                                                                                      | 6     |
| 16  | After a first claim, `origin_oid` equals the resolved branch oid and `head_oid` equals `origin_oid`, and the run's base oid equals both.                                                                                                                        | 5     |
| 17  | The `cut` journal row is `complete` after the settle, asserted by reading the row.                                                                                                                                                                              | 5     |
| 18  | For an internal run, `workspace_branch.origin_oid` equals `workspace.clone_base_oid` after the claim. SQLite cannot constrain this across tables, so the assertion is the whole enforcement.                                                                    | 5     |
| 19  | Two concurrent first claims on one objective produce exactly one branch record and one ref, at the resolved branch tip, and the loser writes nothing. The sequential case of row 12 is asserted separately and does not stand in for it.                        | 7     |
| 20  | The loser refuses `objective-busy`, and a retry of that claim then succeeds on the one-transaction path. Two cases, the second being the control that the refusal is recoverable.                                                                               | 7     |
| 21  | The loser's journal row is `discarded` and no `run` row exists for its node, asserted by count.                                                                                                                                                                 | 7     |
| 22  | Startup completes an `open` `cut` row whose ref exists at `proposed_head_oid`, and discards one whose ref is absent. Two cases, and neither applies a node transition, asserted by comparing the node state before and after.                                   | 8     |
| 23  | `docs/proposal/database/workspace.md` states the branch record, its triggers, the derived `ref` and `repository_id`, and the journaled first claim, asserted by the shipped document tests.                                                                     | 9     |
| 24  | The conformance runner replays each of the six diagrams of this epic by equality, and the comparison fails when any step is removed from or reordered in the implementation.                                                                                    | 6     |
| 25  | `claim-lease-free-task` carries `Superseded by: EPIC 051 claim-branch-base-task`, `claim-branch-base-task` carries the matching `Supersedes:`, and no scenario file exists for `claim-lease-free-task`. The gate asserts this triple.                           | 3     |
