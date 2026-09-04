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
- **No lift of `review-head-unavailable`.** EPIC 050.1's guard stays. EPIC 053.1 owns the review claim and the judged checkpoint.
- **No attempt-workspace disposal.** This range creates no attempt workspace, and no `Workspace` service exists to remove one. `src/commands/startup/sweep-remnants.ts` reports remnants and removes none, and this family declares no worker loop. **The epic that creates an attempt workspace owns its disposal.**

## Decisions

- **The branch record is its own table, `workspace_branch`, and the shipped `workspace` table is not touched.** `docs/proposal/database/workspace.md:3` answers "which clone do the tasks of this objective work in", and `:21` states a row exists for an internal run only, because an external harness owns its own working tree. The family lands external candidates too, and an external run has no clone, so the branch facts cannot live on a row an external run never owns. `path`, `clone_base_oid`, `upstream_oid_at_clone`, `profile_blob`, `convention_version` and `state` are all `NOT NULL` at `migration-0003-execution-and-journal.ts:7-19`, and relaxing them would make `src/commands/startup/sweep-remnants.ts:45-47` assert `path: string` over a nullable column. Migration `13` therefore creates:

  ```sql
  CREATE TABLE workspace_branch (
    node_id    TEXT PRIMARY KEY REFERENCES node(id),
    origin_oid TEXT NOT NULL,
    head_oid   TEXT NOT NULL
  ) STRICT
  ```

- **Three columns, and the other two are derived.** `ref` is `refs/heads/<node_id>`, a pure function of the key, so storing it invites drift with nothing to detect it. `repository_id` joins from `node`, and `src/services/storage/migration-0002-graph-and-plan.ts:33` carries `CHECK ((kind = 'objective') = (repository_id IS NOT NULL))`, so an objective always has one and the join is constraint-backed. `state` is not carried: neither this family nor `worker.md` defines a transition for the branch record, and a column with no transitions is a column nobody can write correctly.

- **Both columns are `NOT NULL` from migration `13`, so no later epic tightens them.** The row is written inside the claim, where the branch tip is already resolved, so neither value is ever unknown. An earlier draft added three nullable columns to `workspace` and said EPIC 057 would make them `NOT NULL`. That was false: `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` enumerates every column that migration tightens, and it names no workspace column at all.

- **`workspace_branch.origin_oid` is immutable, and the row is not deletable while a checkpoint names it.** A trigger refuses an `UPDATE` that changes `origin_oid`, because a CHECK cannot compare against the old row. A second trigger refuses a `DELETE` of a `workspace_branch` row referenced by a `checkpoint` row, because delete-and-reinsert would defeat the first trigger. **The second trigger is created by migration `14`, not by migration `13`**: `checkpoint` does not exist yet, and a trigger naming an absent table is not creatable. EPIC 051.3 owns it.

- **Migration `13` rebuilds `git_operation`, and it declares `rebuild: true`.** Cutting the objective branch is a durable write to the bare home, so it carries a journal row, and `git_operation.intent` at `src/services/storage/migration-0003-execution-and-journal.ts:130` is `CHECK (intent IN ('merge', 'sync', 'publish', 'revert'))`. SQLite cannot widen a CHECK in place. Adding `cut` therefore needs the `ALTER TABLE git_operation RENAME TO git_operation_old` rebuild that `src/services/storage/migration-0006-revision-origin.ts:8` and `migration-0007-external-execution.ts:8-9` already use, which makes `src/services/storage/sqlite.ts:77` set `PRAGMA foreign_keys = OFF` and `PRAGMA legacy_alter_table = ON` for this migration. **The superseded draft asserted the opposite three times** — "additive", "no table is rebuilt", "`sqlite.ts:77` never turns it off" — and every shipped rebuild test asserts `PRAGMA legacy_alter_table` is back to `0` afterwards, so this migration does too. Every index, trigger and row of `git_operation` is asserted present and identical after the rebuild.

- **The branch is cut inside the claim, on the first claim that needs it.** `worker.md` section 7 states it: "The daemon initializes the workspace on the first claim that needs the branch. The daemon initializes it inside the claim." No readiness command cuts a branch, and a node reaching `ready` creates nothing. The cut point is the oid `repository.branch` names in the bare home at claim time, recorded as `workspace_branch.origin_oid`.

- **The claim therefore becomes the journaled write, and its nested units are `claim.begin` and `claim.settle`.** `AGENTS.md:105` gives a journaled write exactly two transactions and gives no other command two. A claim that called a self-contained two-transaction `workspace.cut` and then opened its own transaction would open three, so the cut cannot be a nested command with its own journal pair. The claim's reads join the begin, the ref creation sits between, and the claim's writes join the settle beside `plan.writeWorkspaceBranch`.

- **`git.resolveRef:branch` runs between the two transactions, not before the first.** `AGENTS.md` forbids git I/O inside a storage transaction because the transaction holds the write lock across it, so the read cannot sit inside the begin. It cannot sit before it either: `src/commands/node/claim-node.ts:105` — `ClaimNodeInput` carries `nodeId`, `actorId`, `actorKind` and `available` only, so the command cannot know a `gitDir` or a branch name until it has read the database, and `migration-0003-execution-and-journal.ts:136-137` make `base_oid` and `proposed_head_oid` both `NOT NULL`, so `journal.open` cannot be deferred past the read either. The begin transaction therefore reads the claim state, the objective's `home_path` and its `branch`, and opens the `cut` row at `base_oid` and `proposed_head_oid` both `ZERO_OID`. The tip is resolved after that transaction commits and before the ref is created. **An earlier draft of this decision put the read before the begin and is deleted here.**

- **A claim that finds a branch record is one transaction, so the operation has two paths.** The first execution claim is the journaled write above. Every later claim reads the record and opens one transaction, exactly as EPIC 050.4 drew it. The two differ in seam set and in transaction count, so each is its own diagram, and the branch read is what selects between them.

- **Two concurrent first claims both reach the ref creation, and the loser refuses the claim.** The git write sits between the two transactions, so the begin transaction cannot serialise it, and `worker.md`'s claim that two first claims never race does not survive the journaled shape. It does not need to: the ref is correct whichever wins, because the objective ref is created once and never moved by a claim. **The two claims do not necessarily resolve the same tip**: `repository.branch` can advance between them, so the loser resolves a later oid than the ref holds. The claim therefore reads `refs/heads/<objectiveId>` back after the compare and swap and records **that** oid, never the tip it resolved; see the decision below. The loser fails in its settle on the `workspace_branch` primary key, discards its journal row, writes nothing, and **refuses the claim with the shipped `objective-busy` code**. The caller retries, and the retry takes the ordinary one-transaction path where `objectiveBusy` refuses it properly. **The superseded draft carried a second, contradictory decision** claiming `BEGIN IMMEDIATE` serialised the two claims so the loser never reached the ref creation. That is false for a two-transaction command, and it is deleted here.

- **The claim reads the objective ref back after the cut, and that oid is what it records.** Without the read-back a claim whose create-only swap lost stores the tip it resolved while the ref holds the tip the winner resolved: claim A cuts `refs/heads/objective_a` at `commit1`, `repository.branch` advances to `commit2`, claim B resolves `commit2`, B's swap loses, and B's settle wins the branch-record insert — leaving `workspace_branch`, `run_base` and the journal row all naming `commit2` while the ref stands at `commit1`. The swap's own verdict cannot repair it: `src/services/git/ref-update.ts:28` — `parseObservedOid` matches `is at <oid> but expected`, which git's create-only "already exists" failure never emits, so `observedOid` is `null` on exactly the losing branch. The read-back is unconditional, so the path keeps one trace. `origin_oid`, `head_oid`, `run_base.oid` and the journal row's `result_head_oid` are all that one value.

- **A `cut` journal row carries `ZERO_OID` in both oid columns, and startup reconciles it by the ref's existence.** The tip is not known when the row is inserted, and `src/domain/recovery.ts:1` — `ZERO_OID` is the shipped sentinel for "the ref must not exist", which is exactly what `expectedOid: null` means at `src/services/git/index.ts:50`. A ref that exists is a cut that happened, whatever oid it holds, because the settle adopts the oid the ref actually carries. **An earlier draft compared the ref to `proposed_head_oid` and is deleted here.**

- **Contention is a typed store result, never a caught SQLite error.** `plan.writeWorkspaceBranch` carries `ON CONFLICT (node_id) DO NOTHING RETURNING` and returns `null`; the settle branches on `null` and discards its journal row in the same transaction, so the journaled write still opens exactly two. A command that read `errcode & 0xff === 19` would import a vendor semantic the import matrix of `AGENTS.md` keeps out of `commands/`, and that mask matches every constraint class, so a foreign-key, CHECK or NOT NULL defect would be swallowed as contention.

- **`objectiveBusyDetails` gains three nullable members, and no new refusal code is registered.** `src/http/contract/error-details.ts:168` is a `z.strictObject` requiring `objectiveId`, `siblingNodeId`, `siblingRunId` and `expiresAt`, and a contended first claim has no sibling run to name: the winner's run is opened in a transaction the loser cannot see, and the loser's own transaction wrote nothing. The three run-scoped members become nullable and the shipped raise at `src/commands/node/claim-node.ts:302` keeps filling all four. A new code with its own status, exit code, handler arm and details schema would touch six files and contradict the decision above that the loser refuses with the shipped code.

- **`claim.begin` is a direct call and `claim.settle` is an injected nested command.** A fully composed `claimNode` collapses its trace to one token on **every** path, which breaks EPIC 050.4's initiative diagram and its `objective-busy` refusal as well as `claim-lease-free-task` — two supersessions this epic has no room for. Injecting neither leaves two bare `storage.transact` tokens in one diagram, which the parser refuses. The asymmetry is what the notation forces, and it is why `claim-first-execution` is a long diagram carrying a `Seams:` line rather than a three-step composition.

- **`plan.readObjectiveRepository` is added, because the begin transaction must hand the composer a `gitDir` and a ref.** `src/services/plan/index.ts:94` — `readRepositoryName` returns the name only. It is read on the cut branch alone, so the record-found path gains no seam.

- **The settle reads no clock.** `src/commands/node/claim-node.test.ts:2526` asserts one claim reads the clock once. The begin's `now` is carried into the settle, so the journaled path and the one-transaction path both read it once.

- **`reconcileCut` is an exported nested unit of `reconcile-journal.ts`.** `reconcileJournal` opens one transaction for `journal.listOpen` and one per settled row, so its own trace holds two bare `storage.transact` tokens. The `cut` arm is the smallest decomposition that makes the path drawable, and it mirrors the module-private `settle` the file already uses.

- **`claimNode` becomes `async`.** It is the first command in the repository to sequence a git write with a database effect, and `src/services/git/index.ts:179` — `resolveRef` and `:182` — `refUpdate` both return promises. The change reaches `src/main.ts:553` and the two call helpers of `src/commands/node/claim-node.test.ts`.

- **That primary-key failure is the only enforcement point for objective exclusion on the first claim, and this epic states it.** `objectiveBusy` at `src/domain/run-exclusion.ts` enforces one active run per objective branch, and the journaled claim evaluates it in `claim.begin` while the run is opened in `claim.settle`. Two concurrent first claims on two tasks of one objective therefore both pass exclusion: neither has opened a run when the other reads. `run_one_active` at `src/services/storage/migration-0007-external-execution.ts:33` is unique on `node_id`, and the two tasks are different nodes, so it does not fire either. The `workspace_branch` primary key is what stops the second run. The window exists on the first claim of an objective only, because every later claim is one transaction. **A change that let the loser recover and continue would silently open the window**, and this decision is why no such change is legal without a new enforcement point.

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

1. **Migration 13.** Add `src/services/storage/migration-0013-workspace-branch.ts` at version `13` with `rebuild: true`, and widen `src/domain/git-operation.ts` — `gitIntents` and `src/services/git/index.ts:197` — `GitIntent` with `cut` in lockstep: create `workspace_branch` with its three columns, both oids `NOT NULL`; add the `origin_oid` immutability trigger; rebuild `git_operation` to widen the `intent` CHECK with `cut`, preserving every column, index, trigger and row. Register it in `src/services/storage/migrations.ts`. `story-foundation`.

2. **The workspace branch record.** Add `workspaceBranchRow` to `src/domain/workspace.ts` with `nodeId`, `originOid` and `headOid`, none nullable, and register `workspace_branch: workspaceBranchRow` in `src/domain/rows.ts`, which is what `src/services/storage/schema-parity.test.ts:90` then covers. Add `plan.readWorkspaceBranch`, `plan.writeWorkspaceBranch` and `plan.setWorkspaceBranchHead` to the plan store. `workspaceRow` at `src/domain/workspace.ts:7` is not changed. `story-foundation`.

3. **The claim reads the workspace head.** Draws `claim-branch-base-task`, superseding EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`) `claim-lease-free-task`. `plan.readWorkspaceBranch` joins the claim transaction and its `head_oid` becomes the run's base oid, so `run_base` is written atomically with the run. `story-implement`.

4. **The claim's begin.** Draws `claim-cut-begin`. One transaction reads the claim state, finds no branch record, reads the objective's `home_path` and `branch` through the new `plan.readObjectiveRepository`, and opens the `cut` journal row at both oids `ZERO_OID`. No git call. `story-implement`.

5. **The claim's settle.** Draws `claim-cut-settle`. One transaction writes the branch record at the oid the objective ref was read back at, then the assignment, the run, its base row, the three node transitions, the four events, and completes the journal row. It reads no clock. `story-implement`.

6. **The first execution claim.** Draws `claim-first-execution`, the whole `node.claim` path that finds no record: the begin's calls, `git.resolveRef:branch`, `git.refUpdate:cut`, `git.resolveRef:cut`, `claim.settle` and `git.removePidFile`. `claim.begin` is a direct call and only `claim.settle` is injected, so the diagram is a long one and it declares both `Diagrams:` and `Seams:`. It also makes `claimNode` asynchronous. `story-implement`.

7. **The loser of two first claims refuses.** Draws `claim-cut-settle-contested`, the settle path whose `plan.writeWorkspaceBranch` fails on the primary key. The transaction rolls back, the journal row is discarded, nothing is written, and the claim refuses `objective-busy`. `story-implement`.

8. **Startup reconciles an open `cut` row.** Extend `src/commands/startup/reconcile-journal.ts` with an exported `reconcileCut` unit that reconciles a `cut` row by the ref's **existence**: a ref that exists completes the row, a missing one discards it. Neither applies a transition. It also appends `"051"` to `shippedEpics`. `story-implement`.

9. **The proposal records the workspace branch.** Amend `docs/proposal/database/workspace.md` with the branch record, its two triggers, the derived `ref` and `repository_id`, and the journaled first claim. Amend `docs/proposal/database/git_operation.md` with the fifth intent, and add `historicalGitOperationStatement` to `src/services/storage/migration-0003-execution-and-journal.test.ts`, because that test deep-equals migration `3` against the document. `story-foundation`.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/services/storage/migration-0013-workspace-branch.test.ts \
  src/services/storage/migration-0003-execution-and-journal.test.ts \
  src/services/storage/schema-parity.test.ts \
  src/domain/workspace.test.ts \
  src/domain/git-operation.test.ts \
  src/domain/repository.test.ts \
  src/domain/rows.test.ts \
  src/domain/run.test.ts \
  src/services/plan/sqlite.test.ts \
  src/services/execution/sqlite.test.ts \
  src/commands/node/claim-node.test.ts \
  src/commands/startup/reconcile-journal.test.ts \
  src/main.test.ts \
  test/sequence/conformance.test.ts \
  && echo "PASS EPIC-051"
```

Hermetic coverage required beyond the Proof. **Every assertion below names exactly one owning story.**

| #   | assertion                                                                                                                                                                                                                                                                            | story |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1   | `workspace_branch.origin_oid` and `head_oid` each refuse a null insert. Both `NOT NULL` from migration `13`, so no later epic tightens them and none is named.                                                                                                                       | 1     |
| 2   | The `origin_oid` trigger refuses an `UPDATE` that changes it, asserted against real SQLite by refusal message.                                                                                                                                                                       | 1     |
| 3   | The shipped `workspace` table is unchanged by migration `13`: its column set, its null constraints and its row contents are identical before and after. `docs/proposal/database/workspace.md` needs no amendment and this asserts it.                                                | 1     |
| 4   | `git_operation` survives the rebuild whole: every column, index, trigger and row is present and identical afterwards, and `intent = 'cut'` inserts while an unknown intent is still refused. `src/services/storage/migration-0007-external-execution.test.ts:1104` is the precedent. | 1     |
| 5   | `PRAGMA foreign_keys` and `PRAGMA legacy_alter_table` are both back to their pre-migration values after migration `13` runs, asserted by value.                                                                                                                                      | 1     |
| 6   | `schema-parity` finds the migrated table set equal to `Object.keys(rows)` with `workspace_branch` in it.                                                                                                                                                                             | 2     |
| 7   | A round trip through `plan.writeWorkspaceBranch` and `plan.readWorkspaceBranch` returns the written row field by field, and `plan.readWorkspaceBranch` returns null for an objective with no record.                                                                                 | 2     |
| 8   | The derived `ref` equals `refs/heads/<nodeId>` and the repository id joins from `node`, both asserted by value.                                                                                                                                                                      | 2     |
| 9   | A claim on an objective that already holds a branch record passes the record's `head_oid` as the run's base oid, asserted by reading `run_base`.                                                                                                                                     | 3     |
| 10  | The claim's branch read takes the objective id for a task claim, asserted by claiming a task under an objective and reading the row the objective owns.                                                                                                                              | 3     |
| 11  | A review claim still refuses `review-head-unavailable`, and a structural claim makes no branch read, the second asserted by a plan store double whose branch-read count is zero. Two cases.                                                                                          | 3     |
| 12  | A second claim on an objective that already holds a branch record opens one transaction and writes no journal row. The control is the first claim on the same fixture, which opens two and writes one.                                                                               | 6     |
| 13  | The `cut` journal row is `open` before the ref creation, asserted by reading the row at that point.                                                                                                                                                                                  | 4     |
| 14  | A first claim resolves `repository.branch` **after** its begin transaction commits and **before** the ref creation, asserted by a git service double whose call ordinal falls between the two recorded transaction spans and inside neither.                                         | 6     |
| 15  | A first claim creates `refs/heads/<objectiveId>` in the loopback repository at the resolved branch oid, asserted by value.                                                                                                                                                           | 6     |
| 16  | After a first claim, `origin_oid` equals the resolved branch oid and `head_oid` equals `origin_oid`, and the run's base oid equals both.                                                                                                                                             | 5     |
| 17  | The `cut` journal row is `complete` after the settle, asserted by reading the row.                                                                                                                                                                                                   | 5     |
| 18  | For an internal run, `workspace_branch.origin_oid` equals `workspace.clone_base_oid` after the claim. SQLite cannot constrain this across tables, so the assertion is the whole enforcement.                                                                                         | 5     |
| 19  | Two concurrent first claims on one objective produce exactly one branch record and one ref, at the resolved branch tip, and the loser writes nothing. The sequential case of row 12 is asserted separately and does not stand in for it.                                             | 7     |
| 20  | The loser refuses `objective-busy`, and a retry of that claim then succeeds on the one-transaction path. Two cases, the second being the control that the refusal is recoverable.                                                                                                    | 7     |
| 21  | The loser's journal row is `discarded` and no `run` row exists for its node, asserted by count.                                                                                                                                                                                      | 7     |
| 22  | Startup completes an `open` `cut` row whose ref **exists**, whatever oid it holds, and discards one whose ref is absent. Two cases, and neither applies a node transition, asserted by comparing the node state before and after.                                                    | 8     |
| 23  | `docs/proposal/database/workspace.md` states the branch record, its triggers, the derived `ref` and `repository_id`, and the journaled first claim, asserted by the shipped document tests.                                                                                          | 9     |
| 24  | The conformance runner replays each of the six diagrams of this epic by equality, and the comparison fails when any step is removed from or reordered in the implementation. Story 8 owns it, because it dispatches after every scenario file exists.                                | 8     |
| 25  | `claim-lease-free-task` carries `Superseded by: EPIC 051 claim-branch-base-task`, `claim-branch-base-task` carries the matching `Supersedes:`, and no scenario file exists for `claim-lease-free-task`. The gate asserts this triple.                                                | 3     |
| 26  | `docs/proposal/database/git_operation.md` declares five intents in the SQL order and narrates `cut`, and `historicalGitOperationStatement` holds migration `3`'s four-intent statement, so the two sources are asserted to have diverged deliberately.                               | 9     |
| 27  | `gitIntents` and the migrated `git_operation.intent` CHECK agree element by element and in order, asserted by `assertClauseAgrees`. The control is a reversed local copy, which makes the same call throw.                                                                           | 1     |
| 28  | A claim whose source branch advanced between two first claims records the oid `refs/heads/<objectiveId>` holds, not the tip it resolved, asserted by value over a fixture where the two differ. The control is the resolved tip, asserted to be the other oid.                       | 6     |
| 29  | A retry after a reconciled `cut` row adopts the oid the objective ref holds, asserted by value with `repository.branch` advanced between the crash and the retry.                                                                                                                    | 8     |
| 30  | `plan.writeWorkspaceBranch` returns `null` on a conflict and raises nothing, and a foreign-key failure still throws. Two cases, the second being the control that the store narrows to the primary key.                                                                              | 2     |
| 31  | The contended refusal's details parse against `objectiveBusyDetails` with the three run-scoped members `null`, the shipped four-field raise still parses, and an unknown member is still refused. Three assertions in two cases.                                                     | 7     |
| 32  | A first execution claim removes the pid file its begin recorded, on the accepted arm and on the contended arm. Two cases, each asserting the file existed after the begin and does not exist after the command returns or throws.                                                    | 6     |
