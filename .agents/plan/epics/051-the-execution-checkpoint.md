# EPIC 051 — The execution checkpoint

Status: **draft**. It follows EPIC 050 by sequence order.

## Goal

An accepted commit is the checkpoint of an execution run:

- the objective owns a workspace record with an immutable `origin` and a moving `head`;
- a worker delivers its candidate to a pinned ref in the bare home, and the daemon ingests and verifies it;
- the daemon verifies ancestry from the recorded base, verifies the diff touches declared paths only, and runs each declared command against an immutable checkout of the pinned commit;
- the daemon lands the candidate on the objective branch by compare and swap, advances the workspace head, and writes the checkpoint, the transition and the event in one transaction;
- a failed swap is `contended`: it consumes no attempt, ends the run, and the node repeats from the new head.

## Non-goals

- **No worker loop.** Nothing produces a commit here. A test pushes a candidate into the hermetic loopback repository of EPIC 005 and reports its oid.
- **No structural or review checkpoint.** EPIC 052 and EPIC 053 own them. This epic creates the whole `checkpoint` table, and only the `execution` kind has a writer.
- **No parent-objective state, and no aggregation.** An accepted checkpoint on a task gives its own terminal state, and on an atomic objective it gives `awaiting_approval` through the shipped `objectiveOutcome` at `src/domain/outcome.ts:26`. EPIC 053 adds the pair-driven dispatch, the aggregation and the precedence.
- **No cross-repository landing.** A run records a `base` set. This epic lands one repository per objective, and a report naming a second repository refuses `multi-repository-unsupported`.
- **No publish.** The landing is on the objective branch inside the bare home. Remote origin is EPIC 113.
- **No candidate removal.** The shipped `candidate` table stays unused. EPIC 057 drops it.

## Decisions

- **A worker delivers its candidate to a pinned ref, and the daemon never fetches from a worker.** `worker.md` section 8 step 2 says the daemon ingests and pins the reported head, and it does not say how the object arrives. The daemon owns the bare home, so the worker writes into it: an internal worker's attempt workspace has the bare home as its origin, and an external client is given the same path at claim. Before it reports, the worker pushes its candidate to `refs/kanthord/candidate/<runId>/<attemptNo>`. That ref **is** the pin. A `node.report` naming an oid that ref does not reach refuses `candidate-unreachable`.

- **The pin is created by the worker and owned by the daemon.** The daemon deletes the candidate ref on acceptance, on rejection and on contention. A ref left behind would keep a rejected object alive and let a later report name it.

- **The candidate ref is a convention, and the epic does not pretend it is a boundary.** `refs/kanthord/candidate/<runId>/<attemptNo>` is where a worker writes, with the run id and the attempt number taken from its own active run. Nothing enforces it. The fetch-confinement rule of EPIC 006 is the refspec `+refs/heads/*:refs/remotes/origin/*` on the daemon's **own fetch**, and it restricts no worker, so this epic makes no claim on it.

- **A worker that writes another ref is not detected, and `worker.md` section 11 records that.** A worker holds file system access to the bare home, so it could write `refs/heads/<objectiveId>` and skip every check of section 8. No hook stops that: a hook binds a push, and a worker with a local path can write a ref directly. The daemon's defence is that it reads no such ref. It accepts the candidate the report names, it verifies ancestry from the recorded base, and it moves the objective branch itself by compare and swap. An internal worker is engine code, and an external worker is trusted-client execution. A test asserts the daemon ignores a ref outside the candidate namespace rather than asserting the worker cannot write one.

- **The `checkpoint` table is enumerated here, and every column is stated.** Migration `13` creates it. `kind` in `('execution', 'structural', 'review')`. Binding columns, all `NOT NULL`: `id`, `node_id`, `run_id`, `attempt_id`, `caller`, `subject`, `fence`, `created_at`. Execution columns: `repository_id`, `base_oid`, `accepted_oid`, `landed_oid`. Structural columns: `graph_revision`, `patch_blob`. Review columns: `verdict`, `judged_oid`, `reason_blob`, which EPIC 053 adds. The CHECK clauses are one per group: `(kind = 'execution') = (accepted_oid IS NOT NULL)`, `(kind = 'execution') = (repository_id IS NOT NULL)`, `(kind = 'structural') = (patch_blob IS NOT NULL)`, and the same shape for the review group. `FOREIGN KEY (attempt_id, run_id) REFERENCES attempt(id, run_id)` ties the attempt to the run, mirroring the composite key style of `migration-0007-external-execution.ts:52`.

- **A checkpoint binds five facts as columns, not as a blob.** `worker.md` section 8 step 4 names the run, the attempt, the caller, the subject and the fence. The audit trail is exactly this tuple, and a blob makes it unqueryable.

- **Cutting the objective branch is a durable write to the bare home, so it carries a journal row.** `AGENTS.md` and `100-phase-2-overview.md` require the journal for every durable git write, and a branch cut is one. Migration `13` adds `cut` to the `git_operation.intent` CHECK at `migration-0003-execution-and-journal.ts:130`. The order is: insert the `open` row and commit it; create the ref; then insert the `workspace` row and complete the journal row in one transaction. A crash between the ref creation and the workspace insert leaves an `open` `cut` row that startup recovery reconciles by reading the ref.

- **Two first claims are serialised by the claim transaction, not by a unique constraint alone.** `workspace.node_id` is `UNIQUE` at `migration-0003-execution-and-journal.ts:9`, and the claim runs inside the `BEGIN IMMEDIATE` transaction of EPIC 050. The loser therefore never reaches the ref creation. The epic asserts the concurrent case, not only the sequential one.

- **The branch is cut from `repository.branch`, resolved in the bare home.** EPIC 029 left one branch field on the repository. The cut point is the oid that ref names at claim time, and it is recorded as `workspace.origin_oid`.

- **`workspace.origin_oid` is immutable, and the workspace row is not deletable while a checkpoint names it.** A trigger refuses an `UPDATE` that changes `origin_oid`, because a CHECK cannot compare against the old row. A second trigger refuses a `DELETE` of a workspace row referenced by a `checkpoint` row, because delete-and-reinsert would defeat the first trigger.

- **A successful land advances `workspace.head_oid` in the same transaction as the checkpoint.** `worker.md` section 7 states `head` records the current branch head, and section 8 step 7 states the next task starts from the accepted head. The workspace update, the checkpoint insert, the node transition and the event are one storage transaction. A separate update would let the next claim take a stale base.

- **Acceptance is an ordered gate, and the first failure names itself.** `acceptExecution` runs the steps of `worker.md` section 8 in order: reachability, repository cardinality, ancestry, declared paths, commands, land. The refusal codes are `candidate-unreachable`, `multi-repository-unsupported`, `ancestry-broken`, `path-undeclared`, `command-failed` and `contended`. An earlier failure short-circuits, because running a command against a commit that is not a descendant of the base proves nothing.

- **Ancestry is verified against the recorded base, not against the branch head.** The base is what the worker started from. A head that moved is the contention case, detected at the swap. Verifying ancestry against a moved head would report `ancestry-broken` for work that is merely late.

- **The declared-path check compares exact file paths, and it names every violation.** A `verify.paths` entry matches a changed file path bytewise; it is not a directory prefix. A rename counts as two changed paths, the old and the new, and both must be declared. The refusal lists every undeclared path, sorted with `comparePaths`, so a worker sees the whole gap in one report rather than one path per attempt.

- **An empty `paths` list refuses every change.** A node that declares no path declares no write set. `worker.md` section 2 states an empty `commands` list asserts nothing, and it states nothing of the kind about `paths`. The two lists are not symmetric, and the epic says so: an execution node whose `verify.paths` is empty and whose diff is non-empty refuses `path-undeclared`.

- **Immutable means one fresh checkout per command.** A single checkout is writable, so command one can change what command two reads. The daemon checks the pinned commit out to a new `mktemp` directory for each command, runs it, and removes the directory. `worker.md` section 8 step 5 says the commands run against an immutable checkout, and a shared writable tree is not one.

- **A command carries its own expectation, and the daemon asserts a zero exit.** `worker.md` section 2 states it. A `test` node's command begins with `! `, so the shell inverts it and a failing test exits zero. The daemon applies one rule to every node, and it never inspects the command text.

- **The land is a compare and swap on the objective branch, with three named fields.** `ref` is the objective branch, `expected` is the run's recorded base for that repository, and `next` is the pinned and verified head. The `refUpdate` primitive of EPIC 006 performs it, bracketed by a `merge` journal row.

- **A crash between the ref move and the transaction is reconciled at startup, not ignored.** The journal row is `open` with its `proposed_head_oid`. `src/commands/startup/` reads every `open` `merge` and `cut` row, compares the ref to `proposed_head_oid`, and either completes the row and applies the pending transition, or marks it `discarded`. EPIC 007.5 already owns startup recovery, and this epic extends it rather than inventing a second recovery path.

- **Contention ends the run, and the node repeats under a new claim.** `worker.md` section 8 states a failed swap discards the candidate, repeats the node from the new head, and consumes no attempt. A run's `base` is immutable, so the same run cannot retry against a moved head. The daemon therefore: deletes the candidate ref, records `outcome = 'cancelled'` on the attempt, ends the run, raises the fence, and returns the node to `ready`. The next claim opens a new run whose `run_base` is the new `workspace.head_oid`. Contention consumes no attempt, and the attempt counter is asserted unchanged.

- **`node.report` is wired to `acceptExecution` through the authority gate of EPIC 050.** The handler calls `assertRunAuthority` first, then `acceptExecution`, and maps each refusal to its contract error. `worker.md` section 11 lists the active run, the fence, the claimed subtree and the verified diff as daemon-enforced, and a command-level test does not prove the route enforces them. An integration case drives the route.

- **A failed attempt's workspace directory is removed, and the daemon never rewrites an accepted ref.** `worker.md` section 8 steps 7 and 8 state both. The discard removes the attempt directory from disk and leaves `workspace.head_oid` at its last accepted value.

- **Migration `13` is additive.** `workspace.ref`, `origin_oid` and `head_oid` are added nullable and backfilled: `ref` from `refs/heads/<node_id>`, `origin_oid` and `head_oid` from the existing `clone_base_oid` at `migration-0003-execution-and-journal.ts:12`. EPIC 057 makes them `NOT NULL`. `worker.md` section 13 puts enforcement at step 8.

## Stories

1. **Migration 13.** Add `src/services/storage/migration-0013-checkpoint.ts` at version `13`: create `checkpoint` with the enumerated columns and CHECK clauses; add `ref`, `origin_oid` and `head_oid` to `workspace`, nullable, with the stated backfill; add the two workspace triggers; add `cut` to the `git_operation.intent` CHECK. Register it at `src/services/storage/migrations.ts:13`. Add its test asserting an insert per kind, asserting each cross-kind column combination is refused, asserting the composite attempt foreign key refuses an attempt of another run, asserting the backfill values row by row, asserting the `origin_oid` update trigger, and asserting the workspace delete trigger refuses while a checkpoint names it.

2. **The checkpoint row.** Add `src/domain/checkpoint.ts` with `checkpointRow` and one refine per CHECK. Add `src/domain/checkpoint.test.ts` with a case per refine.

3. **The workspace record.** Extend `workspaceRow` at `src/domain/workspace.ts:7` with `ref`, `originOid` and `headOid`, each nullable. Add cases to `src/domain/workspace.test.ts`. Extend the workspace read and write paths of the plan store and assert a round trip.

4. **The workspace opens inside the claim.** Extend `src/commands/node/claim-node.ts` to cut `refs/heads/<objectiveId>` from `repository.branch` under an `open` `cut` journal row and insert the workspace row, when the run kind is `execution` and no workspace exists. Add cases asserting the ref exists in the loopback repository, asserting `origin_oid` equals the resolved branch oid, asserting `head_oid` equals `origin_oid` at creation, asserting the journal row is `complete`, asserting a second claim finds the workspace and cuts no ref, and asserting two concurrent first claims produce one workspace and one ref.

5. **Candidate delivery and ingestion.** Add `src/commands/checkpoint/ingest-candidate.ts` resolving `refs/kanthord/candidate/<runId>/<attemptNo>`, asserting the reported oid is reachable from it, and exposing a delete. Add its test against the loopback fixture asserting a reachable oid passes, an unreachable oid refuses `candidate-unreachable`, a missing ref refuses `candidate-unreachable`, and the delete removes the ref.

6. **Ancestry, repository cardinality and the declared-path check.** Add `src/domain/execution-acceptance.ts` with `ancestryVerdict`, `repositoryVerdict` and `declaredPathVerdict`, each pure. Add the two git reads that feed them to `src/commands/checkpoint/accept-execution.ts`: an ancestry query of the candidate from the recorded base, and a name-only diff of the recorded base against the candidate that produces `changedPaths`. The pure functions read no git. Add `src/domain/execution-acceptance.test.ts` asserting: a descendant head passes and a non-descendant refuses `ancestry-broken`; a second repository refuses `multi-repository-unsupported`; a diff inside the declared set passes; two undeclared paths refuse and the refusal lists both, sorted; a directory prefix does not match a file beneath it; a rename with only the new path declared refuses; an empty declared set with a non-empty diff refuses; an empty declared set with an empty diff passes.

7. **The command gate.** Add `src/commands/checkpoint/run-declared-commands.ts` checking the pinned commit out to a fresh `mktemp` directory per command, running it through `services/verify`, and removing the directory. Add its test asserting the run order matches the declared list, asserting each command receives a different directory, asserting a command that writes a file cannot affect the next command, asserting a non-zero exit refuses `command-failed` naming the index and the command string, asserting an empty list makes no verify call, and asserting every directory is removed on both paths.

8. **The land.** Add `src/commands/checkpoint/land-execution.ts` performing the compare and swap under a `merge` journal row, then writing the checkpoint, the `workspace.head_oid` update, the node transition and the event in one storage transaction. Add its test asserting the three swap fields, asserting the journal row is `open` before the git write and `complete` after, asserting `workspace.head_oid` equals the landed oid, asserting the checkpoint carries the five binding facts, and asserting a failure injected after the checkpoint insert leaves the workspace head, the node state and the event count unchanged.

9. **Contention.** Extend `land-execution.ts` so a failed swap deletes the candidate ref, records `outcome = 'cancelled'`, ends the run, raises the fence and returns the node to `ready`. Add cases asserting the attempt counter is unchanged, asserting the accepted ref is unchanged, asserting the candidate ref is gone, asserting the fence rose by one, and asserting a new claim then opens a run whose `run_base` equals the new `workspace.head_oid`.

10. **Startup reconciles an open journal row.** Extend `src/commands/startup/` to read every `open` `merge` and `cut` row, compare the ref to `proposed_head_oid`, and complete or discard it with its transition. Add cases asserting a moved ref completes the row and applies the transition, and asserting an unmoved ref discards the row and leaves the node state unchanged.

11. **Accept execution end to end.** Add `src/commands/checkpoint/accept-execution.ts` composing stories 5 to 9 in the fixed order. Add its test asserting the ordered short-circuit across all six refusal codes, asserting a successful acceptance moves a task to `done`, and asserting a successful acceptance on an atomic objective moves it to `awaiting_approval` through `objectiveOutcome`.

12. **The report route enforces the gate.** Wire `node.report` to `assertRunAuthority` and then `acceptExecution` in `src/http/server/`, mapping each refusal to its contract error. Extend the `node.report` schemas in `src/http/contract/outcome.ts` with the reported head and its repository, and add the six refusal codes to `src/http/contract/errors.ts`. Add an integration case per refusal driving the real route, and a case asserting a report with a stale fence is refused before any git read.

13. **The attempt workspace is discarded.** Add the disposal to the failure path and assert the directory is absent on disk after a rejected attempt, and that `workspace.head_oid` is unchanged.

14. **The proposal records the execution checkpoint.** Add `docs/proposal/phase-2/checkpoints.md` stating the candidate ref contract, the checkpoint schema, the ordered acceptance gate, the three compare-and-swap fields, the contention lifecycle, the per-command immutable checkout, the exact-path rule, the empty-`paths` rule, the workspace head advance, and the journal recovery rule.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/checkpoint.test.ts \
  src/domain/workspace.test.ts \
  src/domain/execution-acceptance.test.ts \
  src/services/storage/migration-0013-checkpoint.test.ts \
  src/commands/node/claim-node.test.ts \
  src/commands/checkpoint/ingest-candidate.test.ts \
  src/commands/checkpoint/run-declared-commands.test.ts \
  src/commands/checkpoint/land-execution.test.ts \
  src/commands/checkpoint/accept-execution.test.ts \
  src/commands/startup/recover-journal.test.ts \
  src/http/server/outcome/report-outcome.test.ts \
  && echo "PASS EPIC-051"
```

Hermetic coverage required beyond the Proof:

- A reported oid that the candidate ref does not reach refuses `candidate-unreachable`, and no git read of the objective branch happens.
- The candidate ref is deleted on acceptance, on rejection and on contention. Three cases, each asserting the ref is absent. EPIC 050 covers the expiry path and EPIC 054 covers the operator handoff.
- A ref the worker wrote outside `refs/kanthord/candidate/` changes no outcome. The case writes `refs/heads/<objectiveId>` directly, then reports, and asserts the daemon still lands by compare and swap from the recorded base. The assertion is that the daemon ignores the ref, not that the worker cannot write it.
- The changed-path set comes from a name-only diff of the recorded base against the candidate. The assertion drives the real git service against the loopback fixture, so `declaredPathVerdict` is never fed a hand-built list in the end-to-end case.
- The `origin_oid` trigger refuses an `UPDATE` that changes it, and the delete trigger refuses a `DELETE` while a checkpoint names the workspace. Both against real SQLite, by refusal message.
- Two concurrent first claims on one objective produce exactly one workspace row and one ref. The sequential case is asserted separately and does not stand in for it.
- The `cut` journal row is `open` before the ref creation and `complete` after, asserted by reading the row at both points.
- Two undeclared paths refuse `path-undeclared` and the refusal lists both, sorted with `comparePaths`.
- A `verify.paths` entry naming a directory does not match a file beneath it, asserted by value.
- A rename with only the new path declared refuses. Both sides of a rename must be declared.
- An execution node whose `verify.paths` is empty refuses a non-empty diff and passes an empty one. Both are asserted.
- Each declared command runs in its own directory. The assertion records the working directory per call and asserts the set has no duplicate.
- A command that writes a file into its checkout cannot affect the next command. The second command asserts the file is absent.
- Every checkout directory is removed after the run, on the passing and the failing path.
- A non-zero exit refuses `command-failed` and names the command index and the command string verbatim.
- A command beginning with `! ` that exits zero is accepted, alongside a plain command in the same case, proving one rule applied to both.
- The compare and swap is asserted by its three fields: `ref` equals the objective branch, `expected` equals the run's `run_base` oid, `next` equals the pinned head.
- A successful land advances `workspace.head_oid` to the landed oid, in the same transaction as the checkpoint. A failure injected after the checkpoint insert leaves the head, the node state and the event count unchanged.
- A contended land leaves the accepted ref unchanged, leaves the attempt counter unchanged, deletes the candidate ref, ends the run and raises the fence by exactly one. All five in one case.
- After a contention, a new claim opens a run whose `run_base` equals the new `workspace.head_oid`.
- Startup completes an `open` `merge` row whose ref moved, and discards one whose ref did not. Two cases.
- The `node.report` route refuses a stale fence before any git read, asserted by a git service double whose call count is zero.
- Every one of the six refusal codes is reachable over the real route, one integration case each.
