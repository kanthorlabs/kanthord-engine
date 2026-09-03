# EPIC 051.5 — The targeted post-expiry candidate cleanup — stories

Epic: `.agents/plan/epics/051.5-the-targeted-post-expiry-candidate-cleanup.md`
Prereq: EPIC 051.4 by sequence order, and EPIC 051 and EPIC 051.1 **shipped**. Story 1 reads
`src/domain/candidate-ref.ts` and `CANDIDATE_REF_PREFIX` from EPIC 051.1 Story 2
(`02-the-candidate-ref-is-missing`); Stories 3 to 5 read `git.listRefs` from EPIC 051.1 Story 1
(`01-the-five-git-primitives`) and `discardCandidate` from EPIC 051.1 Story 4
(`04-the-candidate-ref-is-deleted`); Stories 6 to 9 read the composed asynchronous claim, `claimBegin`
and `claim.settle` from EPIC 051 Stories 4, 6 and 7. Story 9 appends `"051.5"` to `shippedEpics`, and
`test/sequence/conformance.test.ts:267` — `slice` requires that list to stay a prefix of
`authoredEpics`, so every earlier epic of the range ships first.

A candidate ref of a run that `node.claim` expires is deleted by that same claim, after the claim's
last transaction commits and before it returns or refuses.

## One story, one path

A story that changes a path draws a pair; a story that changes no path draws nothing.
`.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` enforces it.

Ten stories. Six carry a diagram — 3, 4, 5, 6, 7 and 8. Stories 1, 2, 9 and 10 carry none.

**Three prior sets are empty and three are a live diagram of an earlier epic.** `reapRunCandidates`
exists nowhere in `src/` today, so Stories 3, 4 and 5 each draw a branch written from nothing: each
ship diagram stands alone, draws no `baseline-` diagram, and every one of its tokens is `+`. Stories 6,
7 and 8 each change a path an earlier epic already drew, so each declares `Supersedes:` where a first
change declares `Baselines:`, and each declares the one token it adds.

**No diagram of this epic draws a `baseline-`, and that is the rule and not a shortcut.** A `baseline-`
diagram for `claim-branch-base-task`, `claim-first-execution` or `claim-lease-free-initiative` would
claim EPIC 051 and EPIC 050.4 never landed.

**No diagram of this epic pins a tail.** Each draws its whole path to a terminal.

**No story holds a groundwork slot.** `scripts/lane-check.sh` was run against every path this epic
edits — `src/domain/run.ts`, `src/domain/candidate-ref.ts`, `src/services/execution/index.ts`,
`src/services/execution/sqlite.ts`, `src/commands/checkpoint/reap-run-candidates.ts`,
`src/commands/node/claim-node.ts`, `src/main.ts`, `scripts/epic-sequence-range.ts`,
`scripts/verify-epic-sequence.ts`, `scripts/verify-epic-sequence.test.ts`,
`test/sequence/conformance.test.ts`, `test/sequence/scenarios/**`, `test/helpers/execution.ts`,
`test/helpers/rows.ts` and the four test files of the Proof — and each one is allowed to exactly one of
the `test-engineer` and the `software-engineer`. There is no locked path, so there is no
`00-groundwork.md`, and none is manufactured.

## The six diagrams

| story | diagram                          | steps | prior set                                | terminal |
| ----- | -------------------------------- | ----- | ---------------------------------------- | -------- |
| 3     | `reap-candidates-no-expired-run` | 0     | empty                                    | `ok`     |
| 4     | `reap-candidates-no-ref`         | 3     | empty                                    | `ok`     |
| 5     | `reap-candidates-one-ref`        | 4     | empty                                    | `ok`     |
| 6     | `claim-branch-base-reap`         | 21    | EPIC 051 `claim-branch-base-task`        | `ok`     |
| 7     | `claim-first-execution-reap`     | 19    | EPIC 051 `claim-first-execution`         | `ok`     |
| 8     | `claim-initiative-reap`          | 13    | EPIC 050.4 `claim-lease-free-initiative` | `ok`     |

Story 3's diagram holds zero steps, and that is the strongest statement available about it: any seam
the implementation reaches on an empty expired list fails the comparison. It is also why Story 3
declares no `Seams:` line — a zero-token diagram has no sign to declare.

Stories 6, 7 and 8 each add exactly one token, `candidate.reap`, at the end of a path an earlier epic
fixed. Two source statements serve the three: one on the record-present arm, which Stories 6 and 8 both
take, and one below the settle, which Story 7 takes and Story 9's contended arm reaches on the same
line.

**A fourth live claim diagram is widened and not superseded.**
`claim-lease-free-objective-busy` of EPIC 050.4 Story 3
(`03-the-objective-busy-refusal-drops-the-lease`) is due throughout this epic and its scenario builds
`ClaimNodeDependencies`, so Story 6 adds the `candidate` key to it. Its trace does not move: the
sibling refusal throws from inside the transaction at
`src/commands/node/claim-node.ts:303` — `ClaimNodeError` and returns through neither arm, so it
reaches no reap. Story 6 case 8 asserts that.

## Dispatch order

**Story 10 dispatches first.** It carries the per-diagram supersession that Stories 6, 7 and 8 need to
swap one scenario each and stay green, and it inserts `"051.5"` into `authoredEpics`, which
`scripts/verify-epic-sequence.ts:505` — `knownEpicIds` needs before any story of this epic can add a
scenario file or declare a supersession.

**Story 9 is last.** It appends `"051.5"` to `shippedEpics`, which makes all six diagrams due, so
every scenario file must already be on disk.

Stories 1 and 2 are foundation and precede the command. Stories 3, 4 and 5 build one command, one
layer per story, each reading the layer before it. Stories 6, 7 and 8 wire the three claim paths;
Story 6 carries the dependency key, the `claimBegin` amendment and the `src/main.ts` binding, so it
precedes the other two, and Story 8 writes no production code at all.

**Story 6 retires two scenarios, not one.** One `claimNode` statement serves both
`claim-branch-base-task` and `claim-lease-free-initiative`, because both return through
`begun.kind === "claimed"`, so Story 6 changes both traces and must delete both scenario files. Story
8 adds the replacement it retired the predecessor for. Story 10's third supersession clause — a
predecessor whose own scenario is gone is retired — is what keeps the two stories separable; without
it Story 6 could not be green.

The serial order is **10 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**. No story depends on a later one. This
is the epic's stated order with one change: the `authoredEpics` insert moves from Story 3 to Story 10.

## Stories

- 1 — `ExpiredRun` is a domain type → `01-the-expired-run-is-a-domain-type.md` — draws nothing
- 2 — The run's base home is one read → `02-the-run-base-home-is-one-read.md` — draws nothing
- 3 — An expiry pass that ended no run reaps nothing → `03-an-expiry-pass-that-ended-no-run-reaps-nothing.md` — draws `reap-candidates-no-expired-run`
- 4 — An ended run with no candidate ref reaches no deletion → `04-an-ended-run-with-no-candidate-ref-reaches-no-deletion.md` — draws `reap-candidates-no-ref`
- 5 — An ended run's candidate ref is deleted → `05-an-ended-runs-candidate-ref-is-deleted.md` — draws `reap-candidates-one-ref`
- 6 — The branch-base claim reaps → `06-the-branch-base-claim-reaps.md` — draws `claim-branch-base-reap`
- 7 — The first execution claim reaps → `07-the-first-execution-claim-reaps.md` — draws `claim-first-execution-reap`
- 8 — The initiative claim reaps → `08-the-initiative-claim-reaps.md` — draws `claim-initiative-reap`
- 9 — The contended cut reaps before it refuses → `09-the-contended-cut-reaps-before-it-refuses.md` — draws nothing
- 10 — The conformance harness admits an incremental supersession → `10-the-conformance-harness-admits-an-incremental-supersession.md` — draws nothing

## Gate ownership

| rows            | story |
| --------------- | ----- |
| 1, 2, 3         | 1     |
| 4               | 2     |
| 5               | 3     |
| 6, 7            | 4     |
| 8, 9, 10        | 5     |
| 11, 12          | 6     |
| 13              | 7     |
| 14              | 8     |
| 15, 15b, 16, 17 | 9     |
| 16b, 16c        | 10    |

## Facts, verified against the source

Each fact was read out of the tree before a story was written, and each one changed a story.

- **The tree is at EPIC 050.1.** `scripts/epic-sequence-range.ts:12` — `shippedEpics` is
  `["050", "050.1"]`, and `src/commands/node/claim-node.ts:141` — `claimNode` is still synchronous and
  still one `storage.transact` callback. `src/commands/checkpoint/`, `src/services/candidate/`,
  `src/domain/candidate-ref.ts`, `git.listRefs`, `claimBegin` and `claim.settle` do not exist. Every
  citation in these stories is either to code that ships today or to the epic or story file that
  decides the symbol.

- **`authoredEpics` ends at `"051.3"` and holds neither `"051.1"` nor `"051.4"`.** The epic's Story 3
  entry says to insert `"051.5"` "after `"051.4"`". Each epic's own story appends its own id — EPIC
  051.1 Story 4 (`04-the-candidate-ref-is-deleted`) and EPIC 051.4 Story 9
  (`09-the-contract-and-the-proposal`) — so the position is correct at dispatch and unreachable today.
  Story 10 appends after the last element rather than at a named position, and raises `OPEN:` if a
  predecessor is missing.

- **`scripts/verify-epic-sequence.ts` exists, and it is a second implementation of the same rule.**
  EPIC 051.4's index records it as unbuilt; it is 754 lines and it runs on the real tree through
  `scripts/verify-epic-sequence.test.ts:882` — `doesNotThrow` under `pnpm test`.
  `scripts/verify-epic-sequence.ts:723` — `due` and
  `scripts/verify-epic-sequence.ts:713` — `supersededBy` carry the shipped-keyed predicates
  independently of `test/sequence/conformance.test.ts`. Story 10 changes both files, which the epic's
  Story 10 entry does not say.

- **The tree is red today, and Story 10 is what clears it.** A human applied the three
  `Superseded by: EPIC 051.5 …` lines in commit `4f4c82c`, and
  `scripts/verify-epic-sequence.ts:505` — `knownEpicIds` refuses a supersession naming an epic outside
  `authoredEpics`. `node --test scripts/verify-epic-sequence.test.ts` fails at
  `scripts/verify-epic-sequence.test.ts:880` with
  `supersession names an epic outside the authored set: EPIC 051.5`. EPIC 051.4's index at `:318`
  documents this exact failure mode and avoided it by not applying its own line.

- **`claim-branch-base-task` and `claim-lease-free-initiative` both return from inside `claimBegin`,
  and neither variant of its result carries the expiry list.**
  `.agents/plan/stories/051-the-workspace-branch/04-the-claims-begin.md:138` — `ClaimBegunClaimed` is
  `{ kind, result }` and `:143` — `ClaimBegunCut` names twelve members, none of them the expired runs,
  and `:171` — `claimed` returns from the record-found branch. The epic's snippet places the reap
  between the settle and the raise, which is the **cut** path alone. Two of the three superseded paths
  never reach a settle, so the reap needs a second statement and `claimBegin` must return what its
  transaction ended. See the amendment below.

- **`claim.settle` is synchronous, and `git.removePidFile` is guarded.**
  `.agents/plan/stories/051-the-workspace-branch/06-the-first-execution-claim.md:119` — `settle`
  declares `(input: ClaimSettleInput) => ClaimSettleResult`, so the epic's `await` on it is wrong, and
  the pid removal sits inside `if (settled.clearedToken !== null)`. Story 7 therefore places the reap
  **after that block**, not after the removal line, or gate row 14's unconditional call fails on the
  arm where the token is `null`.

- **The contended `objective-busy` details is one field, not four.**
  `.agents/plan/stories/051-the-workspace-branch/07-the-loser-of-two-first-claims-refuses.md:206` —
  `details` asserts `{ objectiveId: "objective_a" }` for the contended arm, while its case 9 parses the
  same value against the widened `objectiveBusyDetails` "with the three run-scoped members `null`". The
  four-field details belongs to the sibling-busy raise at
  `src/commands/node/claim-node.ts:303` — `ClaimNodeError`. Gate row 15 says "four-field"; Story 9
  asserts invariance against a control refusal instead, so its case is right whichever shape EPIC 051
  ships.

- **`projections` holds no `git` entry, and two unshipped stories disagree about the one this epic
  needs.** `test/helpers/sequence-conformance.ts:50` — `projections` has fifteen rows and no `git.*`.
  `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:129` —
  `git.listRefs` declares a `refNamespace` projection, while
  `.agents/plan/stories/051-the-workspace-branch/06-the-first-execution-claim.md:242` — `refNamespace`
  asks EPIC 051.1 to alias by value instead. The epic asserts "the projection table does not change",
  which holds under the first reading only. Story 4 states all three shipped states and the exact edit
  for each, so `git.listRefs:candidate` is producible either way.

- **`run_base`'s primary key is composite.**
  `src/services/storage/migration-0012-run-model.ts:36` — `run_base` declares
  `PRIMARY KEY (run_id, repository_id)`, so `ORDER BY run_id` alone admits two traces. Story 2 orders
  by `run_id, repository_id`; the bytewise property the epic requires comes from SQLite's default
  collation on a `STRICT` `TEXT` column, not from a JavaScript sort.

- **No `run_base` to `repository` join exists.** The only `run_base` join in the tree is
  `src/commands/startup/recover-expired-leases.ts:55` — `run_base`, which reaches `repository_id`
  through `workspace` and reads `w.path`. An ended run's workspace says nothing about its base, so
  Story 2 joins `repository` directly and reads
  `src/services/storage/migration-0001-core-entities.ts:45` — `home_path`.

- **`test/helpers/execution.ts` holds two fakes and one duplicates the service's SQL.**
  `test/helpers/execution.ts:31` — `createExecutionFake` throws by name for an unneeded member;
  `test/helpers/execution.ts:220` — `createBackedExecutionFake` mirrors every statement of
  `src/services/execution/sqlite.ts` against real SQLite, and has already drifted at `endRun`. Story 2
  adds `runBaseHomes` to both — a refusing arm in the first, the real statement in the second — and
  case 5 pins the two copies to one string.

- **No storage or git double exists in `test/helpers/`.** The only transaction spy in the repository is
  `src/commands/project/create-project.test.ts:59` — `transactionSpy`, and it records transaction
  identities rather than spans. Gate row 10 needs both the length-one span list and the enter/exit
  ordering, so Story 5 writes the shared-log double locally.

- **A command cannot import another command.** `eslint.config.js:174` — `boundaries/dependencies`
  defaults to `disallow` and lists no command-to-command policy, and no command imports another today.
  `reapRunCandidates` therefore declares its own `CandidateDiscard`, and `claimNode` its own
  `CandidateReap` returning `Promise<unknown>` — the same shape
  `src/commands/node/claim-node.ts:79` — `unknown` carried for the expiry result.

- **`candidate` is a fifteen-times-over local name in the claim.**
  `src/commands/node/claim-node.ts:150` — `candidate` and about fourteen more are lambda parameters of
  array predicates. Story 6 adds `dependencies.candidate` and renames none of them.

- **A zero-step diagram still needs a terminal, and only the ends are exempt from the participant
  check.** `test/helpers/sequence-conformance.ts:172` — `sequenceEnds` exempts `Command`, `Client` and
  `Caller`; every other declared participant must be a capitalized dependency key. Story 3's diagram
  declares the two ends and nothing else.

- **`ExpireDueRunsInput` is outside the epic's closure, and seven sites name it.**
  `src/services/execution/index.ts:52`, `:99`, `src/services/execution/sqlite.ts:13`, `:142`,
  `test/helpers/execution.ts:11`, `:49` and `:291`. The epic deletes `ExpireDueRun` alone, so Story 1
  leaves the input type where it is and says so in a constraint. Three names for
  `Readonly<{ now: number }>` is a separate defect this epic does not own.

- **`seedExpiredRun` is a substring false positive.** `src/commands/run/expire-runs.test.ts:48` —
  `seedExpiredRun` and its nine call sites contain `ExpiredRun`. Story 1 repoints imports, never a
  substring.

- **`src/main.ts` names neither moved type.** It binds `Expiry` structurally at
  `src/main.ts:388` — `Expiry`, so Story 1 leaves it untouched and Story 6 is its only editor.

## Decisions taken during authoring, and now recorded in the EPIC

- **The `authoredEpics` insert moves from Story 3 to Story 10.** The tree is red before either runs,
  and only the first story in dispatch order can honour the `pnpm run verify` promise every story
  makes. `scripts/verify-epic-sequence.ts:505` — `knownEpicIds` **Applied to the epic** — its dispatch
  paragraph and its Story 3 and Story 10 entries. See
  `10-the-conformance-harness-admits-an-incremental-supersession.md`.

- **Story 10 changes `scripts/verify-epic-sequence.ts` and `scripts/verify-epic-sequence.test.ts` as
  well as `test/sequence/conformance.test.ts`.** The gate script carries an independent copy of the
  shipped-keyed rule and runs on the real tree under `pnpm test`.
  `scripts/verify-epic-sequence.ts:723` — `due` See
  `10-the-conformance-harness-admits-an-incremental-supersession.md`.

- **`ClaimBegunClaimed` and `ClaimBegunCut` each gain `expired: readonly ExpiredRun[]`, and `claimNode`
  reaps on two source statements rather than one.** The record-present arm returns from inside
  `claimBegin`, so it reaches no settle.
  `.agents/plan/stories/051-the-workspace-branch/04-the-claims-begin.md:171` — `claimed` This is an
  amendment to EPIC 051 Story 4 (`04-the-claims-begin`) and a human ratifies it. See
  `06-the-branch-base-claim-reaps.md`.

- **`ReapFinding` is `reap-run-candidates.ts`'s own type, shaped
  `{ code; runId: string | null; ref: string | null; detail: string }`.** The epic names the four codes
  and what each knows, and leaves the shape open. `src/domain/recovery.ts:31` — `RecoveryFinding` keys
  on a startup step and a repository id, and this command knows neither. `detail` is the caught value's
  `message` when it is an `Error` and `String(error)` otherwise, so every bucket is assertable by whole
  value. See `03-an-expiry-pass-that-ended-no-run-reaps-nothing.md` and
  `05-an-ended-runs-candidate-ref-is-deleted.md`.

- **`reapRunCandidates` walks `expired`, not the rows `runBaseHomes` returned.** The caller's list is
  already in bytewise run-id order, and walking it gives a run with no base row a position of its own
  rather than dropping it silently. `src/services/execution/sqlite.ts:156` — `Buffer.compare` See
  `03-an-expiry-pass-that-ended-no-run-reaps-nothing.md`.

- **`execution.runBaseHomes` orders by `run_id, repository_id`, and dedupes nothing.**
  `src/services/storage/migration-0012-run-model.ts:36` — `run_base` See
  `02-the-run-base-home-is-one-read.md`.

- **A predecessor is retired when its own scenario file is gone, and Story 10's rule gains that third
  clause.** One statement changes two traces, so Story 6 must delete two scenarios while only one
  replacement exists. `test/sequence/conformance.test.ts:85` — `has` The clause requires an authored
  `Superseded by:` naming a declared diagram, so it retires nothing a story has not promised to
  replace, and Story 9 case 4 catches a promise never kept. See
  `10-the-conformance-harness-admits-an-incremental-supersession.md` and
  `06-the-branch-base-claim-reaps.md`.

- **Story 6 widens `claim-lease-free-objective-busy`'s scenario, and Aelita found this only after the
  adversarial review.** A required `candidate` key breaks every scenario that builds
  `ClaimNodeDependencies`, and that diagram is superseded by nothing in this epic, so no story would
  otherwise have touched it. `src/commands/node/claim-node.ts:303` — `ClaimNodeError` See
  `06-the-branch-base-claim-reaps.md`.

- **`reapRunCandidates` groups the homes of one run into a list and lists each, rather than collapsing
  them into one map entry.** Story 2 rules that `execution.runBaseHomes` does not dedupe, and a
  `Map<string, string>` would silently keep whichever row sorted last and leave the other home's ref
  forever. `src/services/storage/migration-0012-run-model.ts:36` — `run_base` See
  `03-an-expiry-pass-that-ended-no-run-reaps-nothing.md`.

- **The unresolved-home branch and the four finding buckets are carried by cases and by no diagram,
  and the epic's "same seam set" wording was wrong.** Each is a strict prefix of a drawn path, not the
  same set. The ruling stands because they are branches a guard adds, and
  `.agents/plan/authoring.md:327` — `guard` proves such a branch by a case: a second live diagram in
  one story is refused by `scripts/verify-epic-sequence.ts:487` — `two`. The epic's Decision now says
  prefix. See `04-an-ended-run-with-no-candidate-ref-reaches-no-deletion.md`.

- **The contended `details` is four fields with three `null`, and EPIC 051 Story 7's case 3 is the
  defect.** `.agents/plan/stories/051-the-workspace-branch/07-the-loser-of-two-first-claims-refuses.md:144` —
  `contendedObjectiveDetails` returns all four keys, and the widened schema at `:130` — `nullable`
  makes each one **required and nullable**, never optional, so a one-key object does not parse. Case 9
  of that story agrees; its case 3 asserts `deepEqual({ objectiveId: "objective_a" })`, which
  `node:assert/strict` refuses against a four-key object. **Aelita's first reading had this backwards**
  and rewrote gate row 15 to assert invariance instead; row 15's original "four-field" was right, and
  it is restored. Story 9 case 1 now asserts the literal, and the one-line fix to EPIC 051 is applied
  at `.agents/plan/stories/051-the-workspace-branch/07-the-loser-of-two-first-claims-refuses.md:144`
  — `contendedObjectiveDetails`. See `09-the-contended-cut-reaps-before-it-refuses.md`.

- **The snapshot race EPIC 051.1 delegates here is closed by construction, and Story 5 proves it.**
  `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/08-the-candidate-namespace-is-enumerated.md:153` —
  `snapshot` hands the runtime window to this epic. The reap's input is a list of runs the expiry pass
  already committed as `ended`, so no member can become active and the command needs no liveness read.
  Story 5 case 11 asserts it reads none. See `05-an-ended-runs-candidate-ref-is-deleted.md`.

- **Story 4 states three shipped states for the `git.listRefs` projection and the exact edit for
  each.** Two unshipped stories disagree about whether `refNamespace` lands.
  `.agents/plan/stories/051-the-workspace-branch/06-the-first-execution-claim.md:242` — `refNamespace`
  See `04-an-ended-run-with-no-candidate-ref-reaches-no-deletion.md`.
