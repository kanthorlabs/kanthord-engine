# EPIC 051.4 — The ordered acceptance gate and the report route — stories

Epic: `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md`
Prereq: EPIC 050.2, EPIC 050.4, EPIC 051, EPIC 051.1, EPIC 051.2 and EPIC 051.3, implemented. Stories 1 to 7 compose the nested units EPIC 051.1, EPIC 051.2 and EPIC 051.3 write, and Story 8 supersedes a live diagram of EPIC 050.4 — a superseding story cannot dispatch before the diagram it replaces is on disk.

A `node.report` on an execution node is judged by an ordered gate, and the daemon lands or refuses.
Seven paths of one new command, one wire path, and the contract that makes six refusals reachable.

## One story, one path

A story that changes a path draws a pair; a story that changes no path draws nothing.
`.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1
Story 8 (`08-the-range-gate`) enforces it.

Nine stories. Eight carry a diagram — 1, 2, 3, 4, 5, 6, 7 and 8. Story 9 carries none.

**Seven of the eight prior sets are empty.** `acceptExecution` exists nowhere in `src/` today, so its
seven paths are written from nothing: each ship diagram stands alone, draws no `baseline-` diagram,
and every one of its tokens is `+`. Story 8 is the one path an earlier epic already drew, so it
declares `Supersedes: EPIC 050.4 report-lease-free` where a first change declares `Baselines:`.

**No diagram of this epic pins a tail.** Each draws its whole path to a terminal.

**No story holds a groundwork slot.** `scripts/lane-check.sh` was run against every path this epic
edits, and each one is allowed to the `test-engineer` or the `software-engineer`. There is no locked
path, so there is no `00-groundwork.md`, and none is manufactured.

## The seven gate diagrams are one shape, cut at seven points

Stories 1 to 7 draw the same ordered prefix and stop at a different step. That is the epic's whole
claim — the gate runs `worker.md` section 8 in order and the first failure names itself — and it is
what makes the diagrams worth drawing: a step that appears on one diagram and not on the earlier one
means the order moved.

| story | diagram                                | steps | terminal                              |
| ----- | -------------------------------------- | ----- | ------------------------------------- |
| 1     | `report-refusal-candidate-unreachable` | 1     | `refuse:candidate-unreachable`        |
| 2     | `report-refusal-multi-repository`      | 2     | `refuse:multi-repository-unsupported` |
| 3     | `report-refusal-ancestry-broken`       | 3     | `refuse:ancestry-broken`              |
| 4     | `report-refusal-path-undeclared`       | 4     | `refuse:path-undeclared`              |
| 5     | `report-refusal-command-failed`        | 5     | `refuse:command-failed`               |
| 6     | `report-refusal-contended`             | 9     | `refuse:contended`                    |
| 7     | `report-execution-checkpoint`          | 9     | `ok`                                  |
| 8     | `report-checkpoint-gate`               | 9     | `ok`                                  |

Story 1's diagram holds one step, and that is the strongest statement available about it: any second
seam the implementation reaches on a missing or unreachable candidate fails the comparison.

## Dispatch order

Stories 1 to 7 build one command, one gate step per story, and each reads the step before it. They run
in numeric order.

**Story 9 dispatches before Story 8**, and that inverts the epic's story list. It is a sequencing rule
and not a preference: `httpError` at `src/http/contract/errors.ts:111` — `httpError` takes an
`ErrorCode`, which is the key set of `src/http/contract/errors.ts:7` — `errorStatuses`, so Story 8's
edit to `src/http/server/node/refusals.ts:67` — `reportOutcomeRefusal` does not compile until Story 9
has added the six codes. `repositoryId` is the same coupling in the other direction: the handler at
`src/http/server/node/report-node.ts:36` — `parsed` passes the parsed body straight to the command, so
the schema and the command's body union move together or `pnpm run typecheck` fails between them.
Every story here ends with `pnpm run verify` exits 0, and that promise is keepable only in this order.

The serial order is **1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 8**. No story depends on a later one.

## Stories

- 1 — The gate refuses an unreachable candidate → `01-the-gate-refuses-an-unreachable-candidate.md` — draws `report-refusal-candidate-unreachable`
- 2 — The gate refuses a foreign repository → `02-the-gate-refuses-a-foreign-repository.md` — draws `report-refusal-multi-repository`
- 3 — The gate refuses broken ancestry → `03-the-gate-refuses-broken-ancestry.md` — draws `report-refusal-ancestry-broken`
- 4 — The gate refuses an undeclared path → `04-the-gate-refuses-an-undeclared-path.md` — draws `report-refusal-path-undeclared`
- 5 — The gate refuses a failed command → `05-the-gate-refuses-a-failed-command.md` — draws `report-refusal-command-failed`
- 6 — The gate refuses a contended land → `06-the-gate-refuses-a-contended-land.md` — draws `report-refusal-contended`
- 7 — The gate accepts and writes the checkpoint → `07-the-gate-accepts-and-writes-the-checkpoint.md` — draws `report-execution-checkpoint`
- 8 — The report route enforces the gate → `08-the-report-route-enforces-the-gate.md` — draws `report-checkpoint-gate`
- 9 — The contract and the proposal → `09-the-contract-and-the-proposal.md` — draws nothing

## Facts, verified against the source

Each fact was read out of the tree before a story was written, and each one changed a story.

- **The tree is at EPIC 050.1.** `git log` ends at `754bc6b feat(epic-050.1)`, and
  `src/commands/outcome/report-outcome.ts:55` — `lease` still holds the node lease. EPIC 050.2 to
  EPIC 051.3 are all unshipped, so every citation in this tree is either to code that ships today or
  to the epic file that decides the symbol. `src/commands/checkpoint/` does not exist, and neither
  does `src/domain/execution-acceptance.ts`.

- **A primitive last argument still gets its projection, after EPIC 050.2.**
  `test/helpers/sequence-conformance.ts:121` — `input` reads the last argument and
  `test/helpers/sequence-conformance.ts:134` — `tokens` emits a bare token when it is not an object,
  so on today's tree `runBases(transaction, runId: string)` would draw no label. EPIC 050.2 Story 2
  (`02-the-authority-seams`) changes the recorder to apply a declared projection whatever the
  argument's type is, and adds `execution.runById` and `execution.attemptsOfRun` entries. Both
  `execution.runBases:R` and EPIC 050.4's `execution.attemptsOfRun:R` are therefore producible, and
  Story 2 adds the `execution.runBases` entry beside them.

- **`Execution` is synchronous throughout.** Every method of
  `src/services/execution/index.ts:95` — `Execution` is transaction-bound and returns a value, not a
  `Promise`. The epic writes `execution.runBases(transaction, runId): Promise<RunBaseRow[]>`; Story 2
  declares it synchronous, matching
  `src/services/execution/index.ts:115` — `attemptsOfRun`, which it mirrors.

- **`SqliteExecution` is one class, not one file per method.**
  `src/services/execution/sqlite.ts:92` — `SqliteExecution` implements the whole interface, so
  `runBases` is a method on it and on `test/helpers/execution.ts:220` — `createBackedExecutionFake`,
  and a refusing stub on `test/helpers/execution.ts:31` — `createExecutionFake`.

- **The composite primary key permits two base rows, and proves nothing about cardinality.**
  `src/services/storage/migration-0012-run-model.ts:36` — `run_base` declares
  `PRIMARY KEY (run_id, repository_id)`, which forbids a duplicate **pair** and allows one run under
  two repository ids. What makes a two-row set unproducible is the writer, and the cardinality rule
  lives in `repositoryVerdict`, which takes `baseRepositoryIds: readonly string[]`, refuses the empty
  list and the multi-entry list alike, and returns `base` as a sorted array. Story 2 matches that
  signature; an earlier draft of it passed a scalar and threw on zero.

- **`objectiveOutcome` is at `src/domain/outcome.ts:17`, not `:26`.** The epic cites `:26`, which is
  the first parameter of `initiativeOutcome`. Story 7 cites the real line.

- **`git.refUpdate` has no `intent` field, so the token is the objective-branch alias.**
  `src/services/git/index.ts:47` — `RefUpdateInput` holds `gitDir`, `ref`, `expectedOid`, `nextOid`
  and `pidFile`, so a `:land` label would name a call site and not a value the call receives.
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/index.md:144` — `git.refUpdate` projects
  `ref` and hands the `:land` correction to this epic. Stories 6 and 7 draw `git.refUpdate:O`, with
  the scenario aliasing `refs/heads/objective_a` to `O` — the alias `land-settle-accepted` already
  uses for `plan.setWorkspaceBranchHead:O`.

- **`land.settle` and `git.refUpdate` both need a projection entry, and Story 6 adds them.**
  `test/helpers/sequence-conformance.ts:50` — `projections` holds neither. `land.settle` projects
  `outcome`, which is on
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:134` — `disposition`, and its full field set. Both carry a verify-before-adding clause, because EPIC 051.3 Story 6
  (`06-startup-reconciles-an-open-merge-row`) draws `land.settle:accepted` and EPIC 051 draws the branch cut.

- **The caller removes the token the settle returned, not the one the begin returned.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:170` —
  `The unit returns the pid-file token` states that `journal.complete` and `journal.discard` each
  return the row's `child_token` before clearing it, and
  `src/commands/startup/reconcile-journal.ts:233` — `removeClearedToken` is the shipped pattern.
  Removing `begun.pidFile` clears the column and leaks the file. That is step 8 of Stories 6 and 7,
  and it is skipped when `clearedToken` is `null`.

- **`commands.run` refuses with `commandIndex`, not `index`.**
  EPIC 051.2 Story 3 (`03-a-declared-command-fails`) declares
  `details: { commandIndex: number; command: string }` and pins it by value, so Story 5 copies that
  key set unchanged.

- **`verify.paths` entries are absolute and changed paths are repository-relative.**
  `src/domain/verify-block.ts:5` — `verifyPath` refuses a path that does not start with `/`, and
  `declaredPathVerdict` declares a changed path `p` when `declared` holds `` `/${p}` ``. Story 4's
  fixture therefore declares `/src/a.ts` against a changed `src/a.ts`.

- **EPIC 051.3 moved three gate rows here, and the epic now lists them.** Rows 9a, 9b and 9c cover the
  compare and swap's three fields, the git write outside a transaction plus the two-span count, and
  the pid-file removal on both paths. Story 6 cases 5, 6, 7 and 9 and Story 7 case 6 carry them.

- **The conformance runner does not await its scenario.**
  `test/sequence/conformance.test.ts:279` — `scenario` destructures synchronously, and
  `test/sequence/conformance.test.ts:275` — `scenario` types the default export as a synchronous
  function. Every diagram of this family is over an `async` command. Story 1 carries the two-line fix
  with a verify-before-editing clause, because EPIC 051 draws the family's first `async` path and may
  land it first.

- **The conformance range already reaches this epic.** **Amended: the whole authored range is already applied.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` holds every id of the family, and `test/sequence/conformance.test.ts:255` — `assert.deepEqual` pins the matching literal. A human applied the range whole rather than one id per epic, and `scripts/verify-epic-sequence.test.ts:880` — `the real plan tree passes the range gate` is green over it. `"051.4"` is in it, so
  every diagram of this epic is discovered and gate row 22 asserts over them. Story 9 no longer
  carries a range edit; it verifies the entry and the pin at
  `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics`.

- **A new proposal document turns a shipped test red on its own.**
  `test/helpers/proposal.test.ts:71` — `it` reads `docs/proposal/phase-2/` and deep-equals it against
  the links in `docs/proposal/phase-2/README.md:19` — `File`. Story 9 adds the row with the document.
  `docs/proposal/phase-2/runs-and-exclusion.md:3` already forward-references `checkpoints.md`.

- **The error-code tables are four, not two.** A new code lands in
  `docs/proposal/api/README.md:243` — `Status`,
  `src/http/contract/errors.ts:7` — `errorStatuses`,
  `src/cli/exit-code.ts:13` — `exitCodes`, and the operation's `errors` record, and it is pinned three
  more times: the ordered list at `src/http/contract/errors.test.ts:41` — `it`, the per-status group
  at `src/http/contract/errors.test.ts:113` — `it`, and the mirror plus two hard-coded counts at
  `src/cli/exit-code.test.ts:17` — `expected`, `src/cli/exit-code.test.ts:70` — `29` and
  `src/cli/exit-code.test.ts:87` — `29`. The epic names two of the seven sites.

- **The 409 exit-code band is full.** `src/cli/exit-code.ts:39` — `subtree-busy` holds `169`, the last
  of `150` to `169`. The six new codes take `170` to `175`.

- **The CLI cannot send an accepted report without the new field.**
  `src/cli/node/report.ts:114` — `objectId` builds the accepted body, and
  `src/cli/node/report.test.ts:335` — `nodeReportRequest` re-parses every sent body. Story 9 adds
  `--repository-id`; the epic's Proof already anticipates it by listing
  `src/cli/node/report.test.ts`.

- **`worker.md` is outside this repository**, at `../docs/workflow/worker.md`, at the monorepo root.
  Section 8 is lines 414 to 452, section 11 is lines 719 to 739. A citation to it is not gate-checkable
  and no story writes one in citation form.

- **The handler holds exactly one key today.**
  `src/http/server/node/report-node.ts:11` — `ReportNodeHandlerDependencies` declares `reportOutcome`
  and nothing else, and `src/http/server/node/report-node.test.ts:330` — `it` already asserts the
  handler branches on no domain rule. Story 8 keeps both properties.

- **`reportOutcome` is synchronous and wraps everything in one transaction.**
  `src/commands/outcome/report-outcome.ts:103` — `reportOutcome` returns a value, and
  `src/commands/outcome/report-outcome.ts:107` — `transact` opens at the first statement and closes at
  `:342`. `accept.execution` writes git, so Story 8 makes the command `async` and moves the git call
  after the callback returns.

## Decisions taken during authoring, and now recorded in the EPIC

Each was forced by a diagram and answered by Ulrich before any story was written.

- **`acceptExecution` owns the whole accepted-execution outcome, and `reportOutcome`'s task tail does
  not run on that branch.** `land.settle:accepted` of EPIC 051.3 Story 4 (`04-the-accepted-settle`) already writes the node
  transition and the event, and `accept.execution` cannot sit inside
  `src/commands/outcome/report-outcome.ts:107` — `transact`, so keeping the tail would need a second
  `storage.transact` token in one diagram, which the parser refuses. The settle returns the
  `NodeReportResult` and `acceptExecution` returns it unchanged. See
  `08-the-report-route-enforces-the-gate.md` and `07-the-gate-accepts-and-writes-the-checkpoint.md`.

- **`acceptExecution` composes the three land steps; there is no composed `land.execution` seam.** The
  epic's seam list and its Story 6 both say so, and
  `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md` agrees that `land.begin` and `land.settle`
  are injected into `AcceptExecutionDependencies`. See `06-the-gate-refuses-a-contended-land.md`.

- **The nested command's seam key is `accept`, and its method is `execution`.** A diagram step is
  `<key>.<method>`, so the epic's bare `acceptExecution` is not a token. `accept.execution` follows
  `ingest.candidate`, `commands.run` and `land.begin`. A function-valued dependency would draw
  `accept.call`, which `.agents/plan/authoring.md` refuses outside a `baseline-` id. See
  `08-the-report-route-enforces-the-gate.md`.

- **An atomic objective reaches `awaiting_approval` under the `objective-land-accepted` trigger, not
  through `objectiveOutcome`.** `src/domain/outcome.ts:17` — `objectiveOutcome` takes a
  `TerminalState` projected from a node's children, and an atomic objective holds none. EPIC 051.4's
  `## Non-goals` still says "through the shipped `objectiveOutcome`" and cites
  `src/domain/outcome.ts:26`, which is the first parameter of `initiativeOutcome`; revised EPIC 051.3
  says the land writes the constant under its own trigger. Story 7 case 3 asserts the trigger by
  value. See `07-the-gate-accepts-and-writes-the-checkpoint.md`.

- **All six refusal codes are 409, and each carries details.**
  `src/http/contract/errors.ts:41` — `PreconditionCode` makes a `details` argument mandatory for a
  409, and each of the six holds a value the worker needs. **This one has not been ratified into the
  epic** and is listed in `## Still open`. See `09-the-contract-and-the-proposal.md`.

- **This epic ships six refusal codes and no seventh.**
  `.agents/plan/epics/051.2-the-command-gate.md` delegates the daemon-fault question here. The answer
  is no: a seventh code needs a retry rule and an attempt-consumption rule, and EPIC 054 owns attempt
  classification. See `05-the-gate-refuses-a-failed-command.md`.

## The supersession is deferred, and the reason is measured

The standard supersession would add `Superseded by: EPIC 051.4 report-checkpoint-gate` to
`.agents/plan/stories/050.4-the-node-lease-removal/06-the-report-drops-the-lease.md`, inside its
`### \`report-lease-free\``section. **It was applied, it turned`scripts/verify-epic-sequence.ts`red, and it was reverted.** The gate refuses with`supersession names an epic outside the authored
set: EPIC 051.4`, at `scripts/verify-epic-sequence.ts:507`—`supersession names an epic outside the authored set`, because
`scripts/epic-sequence-range.ts:1`—`authoredEpics`ends at`"050.5"`.

The line and the range extension therefore land together, and item 7 of `## Still open` holds the
condition. Story 8 of this tree carries the `Superseded by:` edit and the deletion of
`test/sequence/scenarios/report-lease-free.ts`; Story 9 carries the range. Neither can go first.

**The `Add \`test/sequence/scenarios/report-lease-free.ts\`.`line of that story stays either way.**`test/sequence/conformance.test.ts:72`—`Superseded`treats a diagram as superseded only once the
superseding epic is in`shippedEpics`, so `report-lease-free` is live and needs its scenario while
EPIC 050.4 is the head.

This discharges item 4 of
`.agents/plan/stories/050.4-the-node-lease-removal/index.md` — `## Still open`, which records that
EPIC 051.4 Story 8 (`08-the-report-route-enforces-the-gate`) owes the `Supersedes:` line.

## Amendments this tree asks of other epics

One is applied, on Ulrich's instruction, and a human applies each of the rest before dispatch.

- **EPIC 051.3 Story 4 (`04-the-accepted-settle`) — APPLIED.** `LandSettleResult` is now
  `{ clearedToken: string | null; result: NodeReportResult | null }`, the diagram gains
  `13 plan.readAllNodes` before `journal.complete:landed`, its `Seams:` line gains
  `+plan.readAllNodes`, and case 13 asserts the returned value. Story 5
  (`05-the-contended-settle`) returns `result: null` and case 10 is its control; Story 6
  (`06-startup-reconciles-an-open-merge-row`) states that it reads `clearedToken` and ignores
  `result`, so its diagram is unchanged. The epic's Story 4 entry carries the same sentence.
  Verify before re-applying.

- **EPIC 051.4's `git.refUpdate` label — APPLIED.** The epic wrote `git.refUpdate:land` in its
  seam-key list and in gate row 9b. `:land` names the call site, which `.agents/plan/authoring.md`
  refuses, and `src/services/git/index.ts:47` — `RefUpdateInput` carries `gitDir`, `ref`,
  `expectedOid`, `nextOid` and `pidFile` and no field naming it. The seam-key entry is now its own
  bullet at
  `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:66` — `git.refUpdate`,
  stating the `ref` projection, and gate row 9b drops the label. **The stories of this tree already
  drew the alias** — `git.refUpdate:O` in Stories 6 and 7, and `git.refUpdate:land` nowhere — so no
  story changed.

- **EPIC 051.4's six remaining corrections — APPLIED.** `execution.runBases` is declared
  `readonly RunBaseRow[]` and read by `reportOutcome`'s prelude; the `## Non-goals` entry routes an
  atomic objective under `objective-land-accepted` and cites `src/domain/outcome.ts:17`; the
  precedence table moves to `src/commands/checkpoint/accept-execution.test.ts` with the reason; the
  Story 7 entry says it declares `Seams:`; the Proof gains
  `src/http/contract/proposal-amendment-checkpoints.test.ts`; and gate row 22 moves to Story 8, which
  is what adds the eighth scenario.

- **EPIC 051.3's epic file — ALREADY CORRECT.** Its `## Non-goals` at `:19` states there is no
  `land.execute`, and no story entry names `land-execution-success` or `land-execution-contended`.
  Verify, and apply nothing.

## Still open

**Recommendation: settle item 1 with the human, and take item 2 when the family is fully expanded.**
Every other item of the original list is applied, and `## Amendments` records each one. Neither of the
two below blocks a story of this tree.

| #   | issue                                                                    | owner  | blocks               |
| --- | ------------------------------------------------------------------------ | ------ | -------------------- |
| 1   | EPIC 051.1 names this epic the owner of the per-command worktree sweeper | Ulrich | nothing in this tree |
| 2   | the range gate cannot reach this tree until the whole family is expanded | Ulrich | gate row 22, Story 9 |

**2 — resolved: the range gate reaches this tree.** **Amended: the whole authored range is already applied.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` holds every id of the family, and `test/sequence/conformance.test.ts:255` — `assert.deepEqual` pins the matching literal. A human applied the range whole rather than one id per epic, and `scripts/verify-epic-sequence.test.ts:880` — `the real plan tree passes the range gate` is green over it. `"050.6"`, `"051"`,
`"051.1"`, `"051.2"`, `"051.3"`, `"051.5"` and `"051.6"` are all present beside `"051.4"`, every one
of them has a story tree, and the gate is green over the whole range — so
`.agents/plan/authoring.md`'s rule that "The gate enters `pnpm run verify` only when every epic in its
range satisfies it" is satisfied. **The supersession on EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`) may now be
applied**, where it previously could not be, because
`Superseded by: EPIC 051.4 …` makes the gate fail with `supersession names an epic outside the
authored set`, verified by running it. Story 8 carries that edit and Story 9 carries the range, and
both wait on the rest of the family being expanded.

**1 — the per-command worktree sweeper.**
`.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md` states that a crash between
`git.checkout` and `git.removeWorktree` leaks one directory, that `git worktree prune --expire=now`
cannot reclaim it, and that **"the sweeper belongs to the epic that owns startup recovery for the
acceptance gate, which is EPIC 051.4"**. This epic's `## Goal`, `## Stories` and `## Verification
Gate` carry no such story, and the rule it needs — which live worktrees a running daemon still holds —
is undecided. The epic is at nine of ten stories, so one slot remains. **The default if no ruling
arrives: no sweeper, and the residue is one directory per interrupted command**, which EPIC 051.1
measures as inert because `mkdtemp` never reallocates an occupied path.
