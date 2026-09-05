# EPIC 054.2 — The execution accept pays its attempt — stories

Epic: `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md`
Prereq: EPIC 054.1 (sequence order), for `endAttempt`, its two-member input and its three drawn paths.
It also reads EPIC 054's `daemon-rejected` and `contended` evidence values and its `attempt.ended`
payload, EPIC 051.4's ordered acceptance gate, EPIC 051.3's land and EPIC 053's accepted settle —
a superseding story cannot dispatch before the diagram it replaces is on disk.

Every daemon rejection of the execution gate charges a semantic attempt, a contended land charges an
infrastructure one, and the accepted land closes through the same command so every close appends one
event.

## One story, one path

A story that changes a path draws a pair; a story that changes no path draws nothing.
`.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1
Story 8 (`08-the-range-gate`) enforces it.

Eight stories. Seven carry a diagram — 1 to 7. Story 8 carries none.

**Every one of the seven prior sets is a live diagram of an earlier epic**, so each story declares
`Supersedes:` and none declares `Baselines:`.
`.agents/plan/authoring.md:252` — `The two lines never appear together` states it, and drawing a
`baseline-` diagram for a path an earlier epic owns would claim that epic never landed.

**No diagram of this epic pins a tail.** Each draws its whole path to a terminal.

**No story holds a groundwork slot.** `scripts/lane-check.sh` was run against every path this epic
edits. `scripts/epic-sequence-range.ts` and `docs/proposal/phase-2/attempts-and-classification.md` are
allowed to the `software-engineer`; `test/helpers/sequence-conformance.ts`,
`test/sequence/conformance.test.ts` and every scenario file are allowed to the `test-engineer`. There
is no locked path this epic may grant, so there is no `00-groundwork.md`, and none is manufactured.

## The five gate diagrams are one shape, cut at five points, each plus two steps

Stories 1 to 5 insert the same two steps into the five refusal diagrams of EPIC 051.4, at five
different depths. That is the epic's whole claim about the gate: the order did not move, and one
settlement joined it.

| story | ship diagram                                   | supersedes (EPIC 051.4)                | steps | terminal                              |
| ----- | ---------------------------------------------- | -------------------------------------- | ----- | ------------------------------------- |
| 1     | `report-refusal-candidate-unreachable-settled` | `report-refusal-candidate-unreachable` | 3     | `refuse:candidate-unreachable`        |
| 2     | `report-refusal-multi-repository-settled`      | `report-refusal-multi-repository`      | 4     | `refuse:multi-repository-unsupported` |
| 3     | `report-refusal-ancestry-broken-settled`       | `report-refusal-ancestry-broken`       | 5     | `refuse:ancestry-broken`              |
| 4     | `report-refusal-path-undeclared-settled`       | `report-refusal-path-undeclared`       | 6     | `refuse:path-undeclared`              |
| 5     | `report-refusal-command-failed-settled`        | `report-refusal-command-failed`        | 7     | `refuse:command-failed`               |

Stories 6 and 7 swap one token each, and every ordinal of both stays:

| story | ship diagram                 | supersedes                         | changed step                                     |
| ----- | ---------------------------- | ---------------------------------- | ------------------------------------------------ |
| 6     | `land-settle-contended-paid` | EPIC 051.3 `land-settle-contended` | 5 `execution.closeAttempt:A` → 5 `attempt.end:A` |
| 7     | `land-settle-aggregate-paid` | EPIC 053 `land-settle-aggregate`   | 7 `execution.closeAttempt:A` → 7 `attempt.end:A` |

`candidate.discard` is renumbered on four of the five refusal diagrams and moved on none, so it stays
a context token and no story declares it.
`.agents/plan/authoring.md:289` — `renumbered` is the rule.

## Dispatch order

Story 1 opens the boundary — the two dependency keys, the returned rejection, the recorder projection
and the range entry — and Stories 2 to 5 each add one settlement to a file Story 1 already changed.
Story 6 adds the `attempt` key and the two input fields to `landSettle`, and Story 7 reads them. Story 8
asserts the set and ships the range.

The serial order is **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**. No story depends on a later one.

## Stories

- 1 — The unreachable candidate pays its attempt → `01-the-unreachable-candidate-pays-its-attempt.md` — draws `report-refusal-candidate-unreachable-settled`
- 2 — The foreign repository pays its attempt → `02-the-foreign-repository-pays-its-attempt.md` — draws `report-refusal-multi-repository-settled`
- 3 — The broken ancestry pays its attempt → `03-the-broken-ancestry-pays-its-attempt.md` — draws `report-refusal-ancestry-broken-settled`
- 4 — The undeclared path pays its attempt → `04-the-undeclared-path-pays-its-attempt.md` — draws `report-refusal-path-undeclared-settled`
- 5 — The failed command pays its attempt → `05-the-failed-command-pays-its-attempt.md` — draws `report-refusal-command-failed-settled`
- 6 — The contended land pays no attempt → `06-the-contended-land-pays-no-attempt.md` — draws `land-settle-contended-paid`
- 7 — The accepted land closes through the command → `07-the-accepted-land-closes-through-the-command.md` — draws `land-settle-aggregate-paid`
- 8 — The ceiling, the order and the proposal → `08-the-ceiling-the-order-and-the-proposal.md` — draws nothing

## The gate rows, and who owns them

| rows  | owner                                                       |
| ----- | ----------------------------------------------------------- |
| 1–3   | Story 1 (`01-the-unreachable-candidate-pays-its-attempt`)   |
| 4     | Story 2 (`02-the-foreign-repository-pays-its-attempt`)      |
| 5     | Story 3 (`03-the-broken-ancestry-pays-its-attempt`)         |
| 6     | Story 4 (`04-the-undeclared-path-pays-its-attempt`)         |
| 7     | Story 5 (`05-the-failed-command-pays-its-attempt`)          |
| 8–9   | Story 6 (`06-the-contended-land-pays-no-attempt`)           |
| 9a–9b | Story 7 (`07-the-accepted-land-closes-through-the-command`) |
| 10–13 | Story 8 (`08-the-ceiling-the-order-and-the-proposal`)       |

## Facts, verified against the source

Each fact was read out of the tree before a story was written, and each one changed a story.

- **The tree is at EPIC 050.1.** `git log` over `src/` ends at `04376fb feat(epic-050.1)`, and
  `scripts/epic-sequence-range.ts:20` — `shippedEpics` holds `["050", "050.1"]`.
  `src/commands/checkpoint/` does not exist, `src/commands/attempt/` does not exist, and
  `src/domain/termination.ts` does not exist. Every `acceptExecution`, `landSettle` and `endAttempt`
  citation in this tree is to the epic or story file that decides the symbol, never to shipped code.

- **`authoredEpics` ends at `"052.2"`, not at `"054.1"`.**
  `scripts/epic-sequence-range.ts:1` — `authoredEpics` holds seventeen ids and stops there, and
  `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` pins a matching literal. EPIC 053,
  EPIC 053.1, EPIC 054 and EPIC 054.1 each insert their own id first, so Story 1's insertion goes
  after `"054.1"` only once that chain has landed.

- **`resultTerminal` reads a returned rejection as well as a thrown error.**
  `test/helpers/sequence-conformance.ts:310` — `value.ok === false` takes `value.code ?? value.refusal`,
  so a rejection shaped `{ ok: false, refusal, details }` keeps each refusal diagram's terminal at
  `refuse:<code>`. A `{ disposition: … }` shape — the `claimSettle` precedent of
  `.agents/plan/stories/051-the-workspace-branch/07-the-loser-of-two-first-claims-refuses.md:52` —
  `resultTerminal` — would derive `ok` and change all five terminals, which contradicts
  `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:52` —
  `each new diagram is the old one plus two steps`. The shape is Ulrich's ruling of 2026-09-04.

- **The shipped `endAttempt` input carries two fields the epics did not name.**
  `.agents/plan/stories/054.1-the-end-attempt-command/01-a-semantic-ending-and-an-accepted-one.md:143`
  — `EndAttemptCommon` declares `attemptId`, `runId`, `nodeId`, `attemptNo`, **`at`** and
  **`attemptLimit`**, where
  `.agents/plan/epics/054.1-the-end-attempt-command.md:42` — `attemptNo` named only the first four.
  That story states the reason: `attemptLimit` is a payload member that lives only on the run row at
  `src/services/execution/index.ts:16` — `attemptLimit`, and `Execution` declares no read by run id.
  Every call site of this tree therefore passes six common fields.

- **`AcceptExecutionInput` gains `at` and `attemptLimit`, and `LandSettleInput` gains `attemptNo` and
  `attemptLimit`.** `acceptExecution` holds no `Clock` and no `execution` key, so a read of either
  would add a token to all five refusal diagrams or a span past the ceiling; `reportOutcome` holds the
  clock and already reads the run for the limit at
  `src/commands/outcome/report-outcome.ts:245` — `attemptLimit`. `landSettle` reads the clock at its
  step 1, so it needs no `at` field, and
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:133` —
  `LandSettleInput` declares neither of the other two. Story 1
  (`01-the-unreachable-candidate-pays-its-attempt`) adds the first pair and Story 6
  (`06-the-contended-land-pays-no-attempt`) the second.

- **`EndAttemptResult` replaces the accounting re-projection the accepted settle would need.**
  `.agents/plan/stories/054.1-the-end-attempt-command/01-a-semantic-ending-and-an-accepted-one.md:107`
  — `EndAttemptResult` returns `semanticCountAfter`, so Story 7
  (`07-the-accepted-land-closes-through-the-command`) computes `attemptsRemaining` from it rather than
  re-running `accountAttempts` over the step 4 list with a substituted row.

- **The accepted settle loses the value its close returned, and two response fields depend on it.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:225` — `attemptNo`
  builds the `outcome.reported` payload from the closed attempt, and `:242` — `attemptsRemaining`
  takes three fields from it. Story 7 (`07-the-accepted-land-closes-through-the-command`) change
  step 2 reads the input and the step 4 list instead, because a second
  `execution.attemptsOfRun` call would hit
  `test/helpers/sequence-conformance.ts:284` — `duplicate token in diagram`.

- **`AcceptExecutionInput` already carries every field `endAttempt` needs.** `runId` and `attemptNo`
  come from
  `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/01-the-gate-refuses-an-unreachable-candidate.md:109`
  — `ingest.candidate`, and `nodeId` and `attemptId` from
  `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/06-the-gate-refuses-a-contended-land.md:132`
  — `attemptId`. Stories 1 to 5 add no input field.

- **EPIC 054.4 is authored and it already draws `attempt.end`.**
  `.agents/plan/stories/054.4-the-run-lifecycle-pays-its-attempt/01-the-expiry-pass-ends-the-attempt.md:11`
  — `attempt.end:A` and `:140` — `EPIC 054.2 Story 1 owns it` were written by a parallel `/author`
  run while this tree was in progress. The token and the projection ownership are that tree's, and
  this tree adopts both rather than forking the family.

- **`attempt.end` has no projection today.**
  `test/helpers/sequence-conformance.ts:50` — `projections` holds fourteen entries and none for it, so
  the recorder would emit a bare token and every `:A` label would fail. Story 1 change step 4 adds it
  beside `test/helpers/sequence-conformance.ts:64` — `execution.closeAttempt`, which it mirrors, with
  a verify-before-adding clause because EPIC 054.3 and EPIC 054.4 draw the same token.

- **The `execution.closeAttempt` projection must not widen.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/05-the-contended-settle.md:172` —
  `execution.closeAttempt` records that six authored diagrams already draw
  `execution.closeAttempt:A`, so widening it to carry the outcome would change every one of them.

- **`reportOutcome` holds a capture-reap-raise block, not a bare return.**
  `.agents/plan/stories/051.6-the-post-expiry-reap-on-the-run-operations/03-the-report-reaps-on-every-settled-terminal.md:173`
  — `settled` is the shape EPIC 051.6 leaves. Story 1 change step 5 adds the disposition test inside
  its `try` and touches neither the one reap statement nor the one throw site, so
  `report-checkpoint-reap` draws the same tokens in the same order.

- **The plan tree is locked to all three engineer roles.**
  `scripts/lane-check.sh test-engineer`, `software-engineer` and `groundwork-engineer` each answer
  `the plan tree is locked` for `.agents/plan/**`. The seven `Superseded by:` lines are therefore a
  human edit and a dispatch prerequisite of Story 8
  (`08-the-ceiling-the-order-and-the-proposal`), exactly as EPIC 053 Story 8
  (`08-the-accepted-settle-aggregates-the-parent`) case 7 leaves its one line.

- **A `Superseded by:` line naming this epic is refused until Story 1 lands.**
  `scripts/verify-epic-sequence.ts:530` — `outside the authored set` refuses a supersession naming an
  epic that is not in `authoredEpics`. `/author` therefore wrote none of the seven, and
  `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/index.md:249` — `it was reverted`
  records the same collision being hit and undone once already.

- **A superseded scenario file is only free to delete once the superseding epic ships.**
  `scripts/verify-epic-sequence.ts:736` and `test/sequence/conformance.test.ts:72` — `Superseded` both
  gate `superseded` on membership of `shippedEpics`. The seven deletions therefore land in Story 8's
  turn and in no earlier one.

- **`daemon-rejected` carries no fields.**
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:26` — `provider-quota` names
  the payload of the only two kinds that carry one. All five gate refusals therefore write the same
  evidence value, and the refusal code lives on the wire and not in the audit row. This is recorded as
  suggestion S2 below.

- **A gate refusal writes no node state.** `src/commands/outcome/report-outcome.ts:247` —
  `taskReportEffect` is what chooses `ready` or `blocked` under `attempt-limit`, and it runs only on a
  worker-report body. An `accepted` body that the gate refuses reaches none of it, so the epic's gate
  row 6 names a transition this path cannot reach. This is blocker B2 below.

- **Two live diagrams draw `landSettle`'s interior, and this epic supersedes both.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:7` —
  `land-settle-accepted` is already superseded by
  `.agents/plan/stories/053-node-state-ownership/08-the-accepted-settle-aggregates-the-parent.md:12`
  — `Supersedes`, leaving `land-settle-aggregate` and
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/05-the-contended-settle.md:7` —
  `land-settle-contended` as the only two live ones. Stories 7 and 6 take them. **Every other diagram
  that reaches the settle draws it as one token** — `report-execution-checkpoint`,
  `report-refusal-contended`, `report-checkpoint-gate`, `report-checkpoint-reap` and
  `reconcile-merge-land` — so no third `landSettle` story is missing. **The other live diagrams that
  hold `execution.closeAttempt:A` belong to other commands and to other epics of the family**:
  `accept-structural-success` of EPIC 052.1, `accept-review-success-with-reason` and
  `accept-review-success-no-reason` of EPIC 053.1 are EPIC 054.3's, and `expiry-pass-one-due` and
  `release-reap` are EPIC 054.4's.

- **The seven superseded diagrams have no scenario file today.**
  `test/sequence/scenarios/` holds four files, all EPIC 050.1's, because none of EPIC 051.3,
  EPIC 051.4 or EPIC 053 is in `shippedEpics`. Story 8's deletions therefore describe files that will
  exist when this epic dispatches and do not exist now.

## Decisions taken during authoring, and now to be recorded in the EPIC

Each was forced by a diagram, and Ulrich answered each before the story that carries it was final.

- **The nested end-attempt draws `attempt.end`, and the participant is `Attempt`.** A diagram step is
  `<key>.<method>`, so the epic's bare `endAttempt` at
  `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:3` — `endAttempt` is not a
  token. The key is object-valued, because
  `test/helpers/sequence-conformance.ts:113` — `typeof capability` returns a function dependency
  unwrapped and a bare callable would draw no step. **The noun key follows the shipped nested-command
  idiom** — `land.settle`, `candidate.discard`, `objective.aggregate`, `commands.run` and
  `journal.complete` all read noun then verb, and only `accept.execution` and `ingest.candidate` read
  the other way. **EPIC 054.4 had already drawn it** while this tree was being written:
  `.agents/plan/stories/054.4-the-run-lifecycle-pays-its-attempt/01-the-expiry-pass-ends-the-attempt.md:11`
  — `attempt.end:A` declares it, and `:140` — `EPIC 054.2 Story 1 owns it` assigns the projection
  entry to Story 1 (`01-the-unreachable-candidate-pays-its-attempt`) of this tree. Ulrich ruled
  `end.attempt` first, on evidence taken before that tree existed, and reversed it to `attempt.end`
  once the collision was reported. **EPIC 054.3 inherits the token.** See
  `01-the-unreachable-candidate-pays-its-attempt.md`.

- **The returned rejection is `{ ok: false, refusal, details }`.**
  `test/helpers/sequence-conformance.ts:310` — `value.ok === false` derives `refuse:<code>` from it,
  so the five terminals are unchanged and the epic's "old plus two steps" claim holds. See
  `01-the-unreachable-candidate-pays-its-attempt.md`.

- **Only the five gate arms return; the contended arm keeps its throw.** The contended refusal is
  raised after `land.settle:contended` has committed its own transaction, so nothing rolls back and it
  has no reason to move; and
  `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:27` —
  `report-refusal-contended` fences that diagram. `AcceptExecutionError` survives with one throw site
  and `src/http/server/node/refusals.ts:67` — `reportOutcomeRefusal` is unchanged. See
  `01-the-unreachable-candidate-pays-its-attempt.md`, and suggestion S1 below.

## Still open

No blocker below is settled, and none may be handed to `/work`.

- **B0 — RESOLVED, and the tree carries the fix.** The mixed refusal shape contradicted the epic's own
  Decision, and the epic now rules one protocol. `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:34` —
  `never a throw` says a rejection at the accept boundary is a returned disposition and never a throw.
  The `contended` refusal is a rejection at that boundary, and this tree leaves it throwing. The
  defence — that its transaction has already committed, so nothing rolls back — is true and is not
  the epic's stated rule. Converting it costs one arm and changes no drawn token, because
  `test/helpers/sequence-conformance.ts:310` — `value.ok === false` derives the same
  `refuse:contended` terminal from either shape, and `reportOutcome` raises either way.
  `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:36` — `one refusal protocol` now
  converts the sixth arm and deletes `AcceptExecutionError`. Story 1
  (`01-the-unreachable-candidate-pays-its-attempt`) carries the conversion, the consumer closure and
  the collapse of EPIC 051.6's `try`/`catch`, and its cases 7 and 8 prove the untyped-throw property
  and the unchanged `refuse:contended` terminal. **Two amendments follow**, and they are in the epic's
  queue: EPIC 051.4 Stories 1 and 6 lose the error class, and EPIC 051.6 Story 3 loses its `catch`.

- **B1 — RESOLVED as an amendment.** EPIC 051.4 states a ceiling this epic breaks, and the ask is now
  in the epic's queue rather than only here.
  `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/01-the-gate-refuses-an-unreachable-candidate.md:75`
  — `There is no ` declares `acceptExecution` has no `storage` key, and its `## Constraints` at `:133`
  say "Open no transaction, in this story or in any later one" and "Add no `storage`, `execution` or
  `plan` key". Stories 1 to 5 of this epic add `storage` and open one span on every rejection arm.
  EPIC 051.4 gate row 9b stays true — it measures the contended path, which still opens two — but the
  Story 1 text does not. The epic's `## Amendments` section now carries the ask. **A human still
  applies it to EPIC 051.4 Story 1**, because that file is another epic's tree.

- **B2 — the gate row is repaired; the product question under it is still open.** Gate row 6 asked
  that the undeclared-path refusal move the node to `blocked` with `attempt-limit`. No gate refusal
  writes any node state: `endAttempt` closes the attempt and appends the event —
  `.agents/plan/epics/054.1-the-end-attempt-command.md:15` — `endAttempt` names its whole effect — and
  `src/commands/outcome/report-outcome.ts:247` — `taskReportEffect` is the only chooser of `ready` or
  `blocked`, on the worker-report body alone. **The row now asserts the reachable property** — the
  `exhausted` projection, plus the absent writes with a control that moves the node — and Story 4
  (`04-the-undeclared-path-pays-its-attempt`) cases 2 and 3 own it.

  **What is still open is the state the refusal leaves, and it is narrower and worse than first
  reported.** A refused report leaves the run `active`, the node `running` and no open attempt. The
  worker cannot report — `src/commands/outcome/report-outcome.ts:222` — `no open attempt` — and it
  **cannot release either**: `src/commands/node/release-node.ts:16` — `no-open-attempt` refuses a
  release of a run holding none. The only recovery is the expiry pass, which reads no attempt —
  `src/commands/run/expire-runs.ts:30` — `expireDueRuns` — so the node is unreachable by its own worker
  until the run's deadline. Story 4 case 4 asserts both halves by value, so the tree is implementable
  under the current behaviour. **A human rules whether that is acceptable**, and the candidates are: to
  accept it and say so in the proposal; to make `node.release` tolerate a closed attempt; or to end the
  run on the refusal, which would add two steps to all five diagrams and break the epic's own
  two-step claim. **The default if no ruling arrives: a worker whose report is refused holds a dead
  claim until the deadline.**

## Suggestions, not blockers

- **S1 — RESOLVED.** Condition 5 was asserted and not shown; the epic now cites the deletion.
  `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:46` — `The six conditions hold`
  cites
  `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/08-the-candidate-namespace-is-enumerated.md:143`
  — `findings` for condition 5, which requires a startup step **guaranteed to retry the deletion**.
  It does delete: `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/08-the-candidate-namespace-is-enumerated.md:140`
  — `candidate.discard` is the deletion, and
  `.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md:16` — `candidate.sweep` states it
  runs at startup over every ref whose run is not `active`. The epic's condition-5 citation now names
  both. **One gap remains and the epic states it**: the sweep's eligibility is a run that is not
  `active`, which is narrower than condition 3's committed-close, so a remnant this epic leaves is
  swept after the run ends rather than at the next start. The run always ends, so the retry is
  guaranteed and only its timing is later.

- **S2 — `daemon-rejected` carries no field, so seven daemon verdicts write one evidence value.** The
  five gate refusals of this epic and the two report rejections of EPIC 054.3 are indistinguishable in
  the `attempt.ended` payload. The refusal code reaches the client and never the audit row. Widening
  the kind is EPIC 054 Story 6's, not this epic's, and the amendment below carries the ask.

- **S3 — `at` reaches `endAttempt` from a clock read taken before the git work.** `reportOutcome`
  reads the clock in its prelude and that prelude commits before `accept.execution` runs, so on the
  `command-failed` arm the declared commands may run for a long time and the attempt's `ended_at`
  predates the work that caused the rejection. **This is not a blocker**: no proposal defines
  `ended_at` as post-verification wall time, and ending the attempt at report receipt is a defensible
  reading. Giving `acceptExecution` a `Clock` would add a third step to all five diagrams, which the
  epic's "plus two steps" claim forbids, so the fix is not free. A human confirms the reading.

## Defects in the EPIC, now repaired

All three are now repaired in the epic, and each is recorded here because the repair is a change a
reviewer should see rather than discover.

- **The diagram count said six in three places over a seven-row table.** The heading, gate row 12 and
  gate row 13 now all read seven, and row 13 names EPIC 053's diagram beside the six it already had.

- **The Proof block omitted `src/main.test.ts`.** Stories 1, 6 and 7 edit `src/main.ts`, and the Proof
  now lists the test that covers it, so `PASS EPIC-054.2` reaches the composition root.

- **The dispatch-prerequisite paragraph named Story 7 as the last story.** It now names Story 8, which
  is what the story list always said.

## Amendments this tree asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 051.4 Story 1 (`01-the-gate-refuses-an-unreachable-candidate`)** — its `## Change` step 1 and
  its `## Constraints` forbid the `storage` key and every transaction. Both gain the exception this
  epic creates: `acceptExecution` opens exactly one span on a rejection arm and two on an acceptance,
  and it holds `storage` and `end` from EPIC 054.2 on. **The default if no ruling arrives: two story
  trees state opposite constraints on one file**, and the implementing agent obeys whichever it reads
  last.

- **EPIC 051.3 Story 4 (`04-the-accepted-settle`) and Story 5 (`05-the-contended-settle`)** —
  `LandSettleInput` gains `attemptNo: number`, and `LandSettleDependencies` gains `end`. Story 5's
  `## Constraints` bullet "The attempt outcome is `"cancelled"` and no `headOid` is passed" stays
  true; the caller of the close changes and the values do not. **The default if no ruling arrives: the
  settle passes an attempt number it does not have**, and the `attempt.ended` payload names attempt
  zero.

- **EPIC 051.4 Story 1 (`01-the-gate-refuses-an-unreachable-candidate`) and Story 6
  (`06-the-gate-refuses-a-contended-land`)** — Story 1 declares `AcceptExecutionError` and forbids the
  `storage` key and every transaction; Story 6 throws `contended` from that class. This epic adds
  `storage` and an `attempt` key, opens one span on a rejection, deletes the class and returns every
  refusal. Both stories take the exception. **The default if no ruling arrives: two trees state
  opposite constraints on one file**, and the implementing agent obeys whichever it reads last.

- **EPIC 051.6 Story 3 (`03-the-report-reaps-on-every-settled-terminal`)** — its `try`/`catch` at
  `.agents/plan/stories/051.6-the-post-expiry-reap-on-the-run-operations/03-the-report-reaps-on-every-settled-terminal.md:173`
  — `settled` catches a class nothing throws after this epic, and collapses to a straight-line
  disposition test. The one reap and the one throw keep their positions, so `report-checkpoint-reap`
  is unchanged. **The default if no ruling arrives: a `catch` guards against a class with no
  producer**, and a reader cannot tell it is dead.

- **EPIC 054, its Story 6 (the evidence union)** — `daemon-rejected` carries no fields, so the five
  gate refusals and the two report rejections of EPIC 054.3 all write the same evidence value. This
  epic does not widen it, and suggestion S2 states the cost. **The default if no ruling arrives: an
  audit reading `attempt.ended` cannot tell which of seven daemon verdicts charged the attempt.**
