# EPIC 054.3 — The report members pay their attempt — stories

Epic: `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md`
Prereq: EPIC 054.2 (sequence order), for `endAttempt`'s `attempt.end` seam key, its harness
projection and the `boundEndAttempt` binding at the composition root. It also reads EPIC 054's
`worker-reported-failure` and `daemon-rejected` evidence values, EPIC 054 Story 7's
`accountAttempts().semanticCount` and its closing-attempt projection, EPIC 050.4's collapsed attempt
read, EPIC 051.1's candidate primitives and attempt-aware sweep, EPIC 051.5's `runBaseHomes`,
EPIC 051.6's capture-reap-raise block, EPIC 052.1's structural acceptance, EPIC 052.2's structural
report route and EPIC 053.1's review checkpoint — a superseding story cannot dispatch before the
diagram it replaces is on disk.

Every report a worker or the daemon does not accept charges the class the daemon observed, all four
charged arms settle in the transaction `reportOutcome` already owns, and the three accepted arms close
through the same command so every close appends one event.

## One story, one path

A story that changes a path draws a pair; a story that changes no path draws nothing.
`.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1
Story 8 (`08-the-range-gate`) enforces it.

Ten stories, which is the cap of `.agents/plan/authoring.md:60` — `no more than ten stories`. Eight
carry a diagram — 1 to 8. Stories 9 and 10 carry none.

**Three kinds of prior set appear, and the declared lines follow the kind.** Story 1 writes a path
from nothing and declares neither `Baselines:` nor `Supersedes:` —
`.agents/plan/authoring.md:148` — `A path this epic writes from nothing` is the one case where an
implement story holds a single diagram. Stories 2 to 5 declare `Baselines:`, because no epic has drawn
a failure or a rejection arm of `node.report`: `report-lease-free` of EPIC 050.4 Story 6
(`06-the-report-drops-the-lease`) drew the **accepted** arm and every later report diagram supersedes
an accepted arm, and `.agents/plan/authoring.md:252` — `shipped code is drawn once` admits the four
because no earlier epic drew those paths. Stories 6 to 8 declare `Supersedes:` and none declares
`Baselines:`.

**No diagram of this epic pins a tail.** Each draws its whole path to a terminal.

**No story holds a groundwork slot.** `scripts/lane-check.sh` was run against every path this epic
edits. `scripts/epic-sequence-range.ts`, `docs/proposal/phase-2/attempts-and-classification.md` and
every file under `src/` are allowed to the `software-engineer`; `test/sequence/conformance.test.ts`,
`test/helpers/**` and every scenario file are allowed to the `test-engineer`. There is no locked path
this epic may grant, so there is no `00-groundwork.md`, and none is manufactured.

## The nested unit, the two worker paths, the two rejection paths and the three accepted paths

Story 1 draws the command this epic creates. Its prior set is empty, so all three tokens are `+`:

| story | ship diagram            | prior set | steps | terminal |
| ----- | ----------------------- | --------- | ----- | -------- |
| 1     | `discard-run-candidate` | empty     | 3     | `ok`     |

Stories 2 and 3 draw the arm of `reportOutcome` no epic had drawn, and the attempt limit is what
separates them:

| story | ship diagram                           | baseline                                   | steps | terminal |
| ----- | -------------------------------------- | ------------------------------------------ | ----- | -------- |
| 2     | `report-worker-failure-paid`           | `baseline-report-worker-failure`           | 13    | `ok`     |
| 3     | `report-worker-failure-exhausted-paid` | `baseline-report-worker-failure-exhausted` | 14    | `ok`     |

Stories 4 and 5 convert the two nested accepts to a returned rejection, and each adds two steps to a
path of eight:

| story | ship diagram                  | baseline                               | steps | terminal                           |
| ----- | ----------------------------- | -------------------------------------- | ----- | ---------------------------------- |
| 4     | `report-structural-rejection` | `baseline-report-structural-rejection` | 10    | `refuse:patch-unparsable`          |
| 5     | `report-review-rejection`     | `baseline-report-review-rejection`     | 10    | `refuse:judged-checkpoint-unknown` |

Stories 6 to 8 swap one token each, and every ordinal of all three stays:

| story | ship diagram                             | supersedes                                     | changed step                                       |
| ----- | ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| 6     | `accept-structural-success-paid`         | EPIC 052.1 `accept-structural-success`         | 11 `execution.closeAttempt:A` → 11 `attempt.end:A` |
| 7     | `accept-review-success-with-reason-paid` | EPIC 053.1 `accept-review-success-with-reason` | 6 `execution.closeAttempt:A` → 6 `attempt.end:A`   |
| 8     | `accept-review-success-no-reason-paid`   | EPIC 053.1 `accept-review-success-no-reason`   | 5 `execution.closeAttempt:A` → 5 `attempt.end:A`   |

**`candidate.reap` is signed `+` on Stories 4 and 5 and is a context token on Stories 2 and 3.** A
sign is relative to the path — `.agents/plan/authoring.md:285` — `A sign is relative to the path`.
The worker baselines reach the reap; the two rejection baselines do not, because the thrown error
escapes the capture block that admits only `AcceptExecutionError`.

**`candidate.reap` is renumbered on both worker paths and moved on neither**, so it stays a context
token there. `.agents/plan/authoring.md:289` — `renumbered` is the rule.

## Dispatch order

Story 1 adds the run-scoped discard unit and its two harness projections, and it goes first because
Story 2 calls it. Story 2 opens the report boundary — the `attempt` dependency key, the `discardRun`
method on the existing `candidate` key, the composition-root wiring and the range entry — and Story 3
adds one fixture over the same statements. Story 4 adds the returned rejection, the third `decided`
member and the widened `settled` union; Story 5 reuses all three and widens one field. Story 6 moves
the structural close, Story 7 the review close, and Story 8 draws the second review path over
Story 7's edit. Story 9 fills the checkpoint pair at all three writers, which Stories 6 to 8 have
already left in place. Story 10 records the behaviour and ships the range.

The serial order is **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**. No story depends on a later one.

## Stories

- 1 — The run-scoped candidate discard → `01-the-run-scoped-candidate-discard.md` — draws `discard-run-candidate`
- 2 — The worker's own failure member pays its attempt → `02-the-worker-failure-pays-its-attempt.md` — draws `report-worker-failure-paid` and `baseline-report-worker-failure`
- 3 — An exhausted worker report ends its run and pays its attempt → `03-an-exhausted-worker-report-ends-its-run.md` — draws `report-worker-failure-exhausted-paid` and `baseline-report-worker-failure-exhausted`
- 4 — A structural rejection pays its attempt → `04-a-structural-rejection-pays-its-attempt.md` — draws `report-structural-rejection` and `baseline-report-structural-rejection`
- 5 — A review rejection pays its attempt → `05-a-review-rejection-pays-its-attempt.md` — draws `report-review-rejection` and `baseline-report-review-rejection`
- 6 — The accepted structural patch closes through the command → `06-the-accepted-patch-closes-through-the-command.md` — draws `accept-structural-success-paid`
- 7 — The accepted review attestation with a reason closes through the command → `07-the-attestation-with-a-reason-closes-through-the-command.md` — draws `accept-review-success-with-reason-paid`
- 8 — The accepted review attestation with no reason closes through the command → `08-the-attestation-with-no-reason-closes-through-the-command.md` — draws `accept-review-success-no-reason-paid`
- 9 — The checkpoint pair is derived → `09-the-checkpoint-pair-is-derived.md` — draws nothing
- 10 — The proposal records the report arms → `10-the-proposal-records-the-report-arms.md` — draws nothing

## The gate rows, and who owns them

Every row names exactly one owner, and every owner carries the whole assertion of its row.

| rows  | owner                                                                    |
| ----- | ------------------------------------------------------------------------ |
| 0–0b  | Story 1 (`01-the-run-scoped-candidate-discard`)                          |
| 1–4   | Story 2 (`02-the-worker-failure-pays-its-attempt`)                       |
| 4a    | Story 3 (`03-an-exhausted-worker-report-ends-its-run`)                   |
| 5–7   | Story 4 (`04-a-structural-rejection-pays-its-attempt`)                   |
| 8–10  | Story 5 (`05-a-review-rejection-pays-its-attempt`)                       |
| 10a   | Story 6 (`06-the-accepted-patch-closes-through-the-command`)             |
| 10b   | Story 7 (`07-the-attestation-with-a-reason-closes-through-the-command`)  |
| 10c   | Story 8 (`08-the-attestation-with-no-reason-closes-through-the-command`) |
| 11–12 | Story 9 (`09-the-checkpoint-pair-is-derived`)                            |
| 13    | Story 10 (`10-the-proposal-records-the-report-arms`)                     |

**Row 8 belongs to Story 5 and not to Story 4.** It asserts all eleven refusal diagrams of EPIC 052.1
and EPIC 053.1, and Story 4 converts seven of their scenario files while Story 5 converts the other
four, so only a case running after both conversions can assert the set. Story 4 case 8 stays as the
local regression proof of its own seven, and it says in the case that it does not own the row.

## Facts, verified against the source

Each fact was read out of the tree before a story was written, and each one changed a story.

- **The tree is at EPIC 050.1.** `scripts/epic-sequence-range.ts:20` — `shippedEpics` holds
  `["050", "050.1"]`, `src/commands/checkpoint/` does not exist, `src/commands/attempt/` does not
  exist, and a grep for `acceptStructural`, `acceptReview` and `checkpoint` over `src/` and `test/`
  returns nothing. Every `acceptStructural`, `acceptReview`, `endAttempt`, `landSettle` and
  `candidate.*` citation in this tree is to the epic or story file that decides the symbol, never to
  shipped code.

- **`authoredEpics` ends at `"052.2"`, not at `"054.2"`.**
  `scripts/epic-sequence-range.ts:1` — `authoredEpics` holds seventeen ids and stops there, and
  `test/sequence/conformance.test.ts:255` — `authoredEpics` pins a matching literal. EPIC 053,
  EPIC 053.1, EPIC 054, EPIC 054.1 and EPIC 054.2 each insert their own id first, so Story 2's
  insertion goes after `"054.2"` only once that chain has landed.

- **The worker arm of `reportOutcome` is untouched by the gate epics, and that is why it has a
  shipped baseline.** `report-checkpoint-gate` of EPIC 051.4 Story 8
  (`08-the-report-route-enforces-the-gate`) removes `execution.closeAttempt:A`,
  `plan.setNodeState:T:outcome-accepted`, `execution.stampRunHead:R`, `execution.endRun:R`,
  `events.append:outcome.reported:T:null` and `plan.readAllNodes` from **its own** path — the
  `accepted` member on an execution node, per
  `.agents/plan/epics/052.2-the-structural-report-route.md:22` — `No supersession`. The
  `rejected`, `failed` and `cancelled` members still run the shipped tail at
  `src/commands/outcome/report-outcome.ts:234-341`, so Stories 2 and 3 draw real code.

- **The four baselines are forecasts of six unshipped epics, and each story says so.** Steps that do
  not exist in this tree — `expiry.expireRuns`, `execution.runById`, `plan.readSubtree`,
  `candidate.reap`, `accept.structural`, `accept.review` — cite the story that decides them, and the
  rest cite `src/commands/outcome/report-outcome.ts`. Each of Stories 2 to 5 carries a **re-verify
  clause** instructing the implementer to read the real file at dispatch, confirm the trace, replace
  each plan-cited caller anchor with its `src/**` line, and report a divergence rather than edit the
  diagram. No gate checks a forecast baseline against the code that later ships.

- **A throw from a nested accept reaches no reap, and the review story says so.**
  `.agents/plan/stories/053.1-the-review-checkpoint/10-the-report-route-carries-a-verdict.md:159` —
  `AcceptReviewError` states that a throw inside the transaction rolls the expiry pass back and
  therefore reaches no reap, "which is why every refusal diagram of Stories 3 to 6 ends before it".
  The capture block at
  `.agents/plan/stories/051.6-the-post-expiry-reap-on-the-run-operations/03-the-report-reaps-on-every-settled-terminal.md:185`
  — `AcceptExecutionError` re-throws anything else. So `baseline-report-structural-rejection` and
  `baseline-report-review-rejection` hold eight steps and not nine, and the returned disposition adds
  `candidate.reap` as a `+` token on both. The epic's `## Decisions` now rules it.

- **`execution.runBases:R` is on the accepted-execution arm alone.**
  `.agents/plan/stories/052.2-the-structural-report-route/02-the-report-route-carries-a-patch.md:155`
  — `no `execution.runBases`` states it for the structural arm, and
  `.agents/plan/stories/053.1-the-review-checkpoint/10-the-report-route-carries-a-verdict.md:57` —
  `execution.runBases:R` is absent for the review arm. The four baselines of this epic therefore hold
  no such step, and none of the four had to invent one.

- **`reportOutcome` holds no git seam and reads no repository home.**
  `src/commands/outcome/report-outcome.ts:52` — `ReportOutcomeDependencies` names `storage`, `plan`,
  `lease`, `execution`, `events` and `clock`, and `lease` is deleted by EPIC 050.4 Story 6
  (`06-the-report-drops-the-lease`). `candidate.discard` takes `{ gitDir, ref }` —
  `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:51`
  — `DiscardCandidateInput` — so the caller cannot supply one. That is why the discard is a
  run-scoped nested command with its own diagram, and Story 1 owns it.

- **`candidate.discardRun` is a path, not a helper.** Its unit opens a transaction, reads
  `runBaseHomes` and calls `candidate.discard` per home, and
  `.agents/plan/authoring.md:208` — `A nested command is one step` gives such a command its own
  diagram and its own scenario. `reapRunCandidates` has EPIC 051.5's diagrams and `discardCandidate`
  has EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`)'s, so drawing it follows the tree rather
  than adding a rule. Folding it into Story 2 would give that story two paths, which
  `.agents/plan/authoring.md:147` — `More than one pair is too big` refuses.

- **`candidate.sweep` skipped every ref of an active run, and a below-limit worker failure leaves the
  run active.** `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/08-the-candidate-namespace-is-enumerated.md:141`
  — `active.has(runId)` is the skip. Conditions 3 and 5 of the six-condition rule of `AGENTS.md`
  therefore failed for Story 2's arm as the sweep shipped: a run still active is not eligible, and no
  startup step retried an attempt-scoped remnant of it. **The repair is applied**: that story now
  deletes a ref whose attempt number is below the run's open attempt, whatever the run state, and
  builds an `openAttemptNo` map beside `active` in the same transaction. Story 1 names it as a
  dispatch prerequisite. Story 3's arm never needed it, because an exhausted report ends the run.

- **`candidate.reap` is total, and the discard unit must be too.**
  `.agents/plan/epics/051.6-the-post-expiry-reap-on-the-run-operations.md:66` — `candidate.reap` is
  total states that the contract, and not a caller's catch, is what protects every terminal. The
  discard runs after the settlement commits, so a throw there would turn a settled report into a
  `500`. Story 1 gives `discardRunCandidate` the same contract, and its cases 3 and 4 prove it.

- **`EndAttemptResult` carries `exhausted` as well as `semanticCountAfter`, and `reportOutcome` reads
  neither.** `.agents/plan/stories/054.1-the-end-attempt-command/01-a-semantic-ending-and-an-accepted-one.md:167`
  — `exhausted` declares it. `taskReportEffect` takes an `AttemptAccounting` and reads only
  `exhausted` from it — `src/domain/outcome-report.ts:57` — `exhausted` — so feeding it the closer's
  numbers would mean fabricating the other five fields. The projection stays the one source, and
  Story 2 case 5 asserts the two agree.

- **The accounting projection is EPIC 054 Story 7's, and the repair is applied there.** That story's
  site 4 rewrote `src/commands/outcome/report-outcome.ts:244` — `.map` to pass `row.termination`
  through, and EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`) had already collapsed the read so
  the row is the still-**open** attempt, whose termination is null. With `exhausted` equal to
  `semanticCount >= limit`, the pass-through priced the charge at zero and left the `attempt-limit`
  branch of `src/domain/outcome-report.ts:57` — `exhausted` unreachable on this route. **Site 4 now
  projects `termination: "semantic" as const` onto the closing attempt**, mirroring its own release
  site at `src/commands/node/release-node.ts:116` — `.map`, and that story gained case 8a to prove
  it. Story 2 change step 3 therefore confirms the statement and edits nothing.

- **`daemon-rejected` carried no field, and it now carries its refusal code.**
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:65` — `daemon-rejected`
  carries widens the member to `{ kind: "daemon-rejected"; refusal: string }`, and EPIC 054 Story 6
  (`06-the-evidence-union-and-the-classifiers`) carries the union edit. Without it EPIC 054.2's five
  gate codes, the ten structural codes and the five review codes wrote one indistinguishable audit
  value. It is `string` and not a union of the three refusal types, because
  `src/domain/termination.ts` is domain and may not import a command. **EPIC 054.2 must pass it
  too**, and the epic's `## Amendments` section carries that ask.

- **`worker-reported-failure` stays fieldless here, and EPIC 110 widens it.**
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:113` — `No member carries a top-level`
  already rules that EPIC 110's frozen `attemptFailureReasons` lands inside that member when that
  epic ships. Widening it now would pre-empt a decision another epic owns.

- **`WriteCheckpointInput` is a three-member union and every member writes both columns `NULL`
  today.** `.agents/plan/stories/051.3-the-checkpoint-and-the-land/02-the-checkpoint-row.md:129` —
  `The input carries no` is the sentence Story 9 makes false, and the three writers are
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:190` —
  `writeCheckpoint`,
  `.agents/plan/stories/052.1-the-structural-acceptance/09-the-accepted-patch.md:191` —
  `writeCheckpoint` and
  `.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:113` —
  `writeCheckpoint`.

- **`subject` needs a new input field on three types and a new read on none.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:133` —
  `LandSettleInput` carries `actorId` and no worker;
  `.agents/plan/stories/053.1-the-review-checkpoint/03-an-oversized-reason-reaches-no-seam.md:64` —
  `AcceptReviewInput` carries `actorId` and no run row; and `acceptExecution` holds no `execution`
  key, so it must receive and forward the value. Only
  `.agents/plan/stories/052.1-the-structural-acceptance/02-an-unparsable-patch-reaches-no-seam.md:73`
  — `run` already holds it. This is exactly the field/read split the epic states at
  `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md:75` —
  `Every checkpoint writer records`.

- **`AcceptReviewInput` needs `attemptNo` too, and for a second reason.**
  `.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:218` —
  `attempt.attemptNo` builds the `outcome.reported` payload from the closed record. `endAttempt`
  returns no record, so the field has to arrive on the input; `AcceptStructuralInput` already carries
  it at
  `.agents/plan/stories/052.1-the-structural-acceptance/02-an-unparsable-patch-reaches-no-seam.md:75`
  — `attemptNo`. Story 7 change step 2 adds it.

- **`acceptStructural`'s shipped close passes no `headOid` and `acceptReview`'s passes `null`.**
  `.agents/plan/stories/052.1-the-structural-acceptance/09-the-accepted-patch.md:215` —
  `closeAttempt` omits the key and
  `.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:193` —
  `headOid: null` writes it. The accepted member of `EndAttemptInput` requires
  `headOid: string | null`, so both pass `null` and neither invents a value from the patch blob or
  the judged oid.

- **`acceptReview` has five refusals and four of them are judged.**
  `.agents/plan/stories/053.1-the-review-checkpoint/03-an-oversized-reason-reaches-no-seam.md:125`
  — `AcceptReviewRefusal` holds `reason-too-large` plus four `judged-` codes, because
  `.agents/plan/stories/053.1-the-review-checkpoint/index.md:172` —
  `judged-checkpoint-unaccepted` deleted the fifth as unreachable. The epic's Story 5 entry and its
  gate row 9 now say "five refusals, four of them judged".

- **`AcceptStructuralRefusal` declares nine codes and the stories throw ten.**
  `.agents/plan/stories/052.1-the-structural-acceptance/02-an-unparsable-patch-reaches-no-seam.md:109`
  — `AcceptStructuralRefusal` lists nine and omits `patch-delete-ineligible`, which
  `.agents/plan/stories/052.1-the-structural-acceptance/08-an-ineligible-delete-refuses.md:103` —
  `patch-delete-ineligible` throws. Story 4 change step 1 lists the ten sites by full path and tells
  the implementer to enumerate them against the file rather than trust a count, and the epic's
  `## Amendments` asks EPIC 052.1 Story 2 to add the tenth code.

- **`resultTerminal` reads a returned rejection as well as a thrown error.**
  `test/helpers/sequence-conformance.ts:310` — `value.ok === false` takes
  `value.code ?? value.refusal`, so a rejection shaped `{ ok: false, refusal, details }` keeps each
  refusal diagram's terminal at `refuse:<code>`. This is what makes the eleven refusal diagrams of
  EPIC 052.1 and EPIC 053.1 replay unchanged after Stories 4 and 5 convert their commands, and it is
  the shape EPIC 054.2 already chose.

- **The harness has no projection for `execution.runBaseHomes`, `candidate.discard`,
  `candidate.discardRun`, `candidate.reap` or `blobs.put`.**
  `test/helpers/sequence-conformance.ts:50` — `projections` holds fifteen entries and none of the
  five. Story 1 adds the first two, because `discard-run-candidate` needs a run alias and a stable
  ref label; the other three draw a bare token, and every path of this epic makes at most one of
  each, so no further entry is added.

- **`candidate.discard` may not project the ref itself.** The ref carries a run id and an attempt
  number, so projecting it would put both inside the compared token and split one drawn path per
  attempt — the same hazard
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:113` — `No member carries a top-level`
  names for the event payload. Story 1 projects the ref's **namespace** through
  `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:105`
  — `refNamespaces`, which maps `refs/kanthord/candidate/` to the literal `candidate`.

- **`attempt.end` has no projection today, and EPIC 054.2 Story 1 owns adding it.**
  `.agents/plan/stories/054.2-the-execution-accept-pays-its-attempt/01-the-unreachable-candidate-pays-its-attempt.md:221`
  — `attempt.end` is the entry, and EPIC 054.4 Story 1
  (`01-the-expiry-pass-ends-the-attempt`) at `:140` — `owns it` assigns it to that story. This epic
  draws the token seven times and adds no entry.

- **The plan tree is locked to all three engineer roles.**
  `scripts/lane-check.sh test-engineer`, `software-engineer` and `groundwork-engineer` each answer
  `the plan tree is locked` for `.agents/plan/**`. The three `Superseded by:` lines are therefore a
  human edit and a dispatch prerequisite of Story 10
  (`10-the-proposal-records-the-report-arms`).

- **`events.append` puts the report's reason inside the compared token.**
  `test/helpers/sequence-conformance.ts:81` — `reason` appends `String(payload.reason)` whenever the
  payload holds a `reason` key, and `src/commands/outcome/report-outcome.ts:302` — `reason` is one of
  the nine keys the shipped payload writes. The two worker fixtures therefore state the reason as the
  literal `"boom"`, and the token is `events.append:outcome.reported:T:boom`. The shipped test's
  `REASON` constant at `src/commands/outcome/report-outcome.test.ts:60` — `REASON` holds a newline
  and non-ASCII bytes and cannot be a diagram label.

- **Only three scenario files are deleted, not eight.** The four `baseline-` diagrams hold none —
  `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` refuses a scenario whose id
  starts with `baseline-` — and `discard-run-candidate` supersedes nothing, so Story 10's deletion
  set is the three superseded live diagrams of EPIC 052.1 and EPIC 053.1.

## Decisions taken during authoring, and now recorded in the EPIC

Each was forced by a diagram or by a citation, and each is now a Decision or a Non-goal of
`.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md`.

- **1 — The run-scoped discard is a drawn nested command, and it takes the tenth story slot.** See
  `01-the-run-scoped-candidate-discard.md`.

- **2 — The two rejection arms reach `candidate.reap`, and that is a consequence of committing the
  settlement rather than a choice.** Suppressing it would leave two arms of one command reaping and
  two not, for no product reason. See `04-a-structural-rejection-pays-its-attempt.md`.

- **3 — `decided` gains a third member rather than a nullable field.** The transaction callback
  returns `{ kind: "raise", expired, discard: null, raise }` on a rejection, so no arm carries a
  nullable result and the `settled` union keeps its one throw site at
  `.agents/plan/stories/051.6-the-post-expiry-reap-on-the-run-operations/03-the-report-reaps-on-every-settled-terminal.md:192`
  — `throw settled.error`. A second raise site would make the discard-and-reap order per-arm. See
  `04-a-structural-rejection-pays-its-attempt.md`.

- **4 — `reportOutcome` raises `AcceptStructuralError` and `AcceptReviewError`, not
  `ReportOutcomeError`.** `src/commands/outcome/report-outcome.ts:79` — `ReportOutcomeRefusal` is a
  closed union of six codes and holds none of the structural or review codes, and EPIC 052.2 and
  EPIC 053.1 map both classes at the handler. Translating them would need fifteen new members on a
  refusal union the wire does not use. The `settled` union's `error` field therefore widens to three
  classes and `src/http/server/node/refusals.ts` is untouched. See
  `04-a-structural-rejection-pays-its-attempt.md`.

- **5 — `daemon-rejected` carries its refusal code, and `worker-reported-failure` stays fieldless.**
  The first repairs twenty codes collapsing to one audit value; the second is EPIC 110's to widen. See
  `04-a-structural-rejection-pays-its-attempt.md` and
  `05-a-review-rejection-pays-its-attempt.md`.

- **6 — `reason-too-large` charges a semantic attempt, and only an EPIC amendment changes that.** It
  is a `400` on the caller's own body, which is the argument for exempting it; against that, the body
  passed the route schema and reached `acceptReview`, the code is a member of `AcceptReviewRefusal`,
  and an unpriced refusal lets a client retry a malformed report without limit. The epic's gate row 9
  charges all five and Story 5 follows it. The cost is stated: a client bug can exhaust a node's
  attempt limit and block the node with `attempt-limit` as the reason. See
  `05-a-review-rejection-pays-its-attempt.md`.

- **7 — A rejection writes no node state and ends no run, and the expiry is the recovery path.**
  `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md:50` —
  `A gate refusal writes no node state` already ruled it for this family, and this epic adopts it as a
  Non-goal rather than re-deciding it. The residual product question — whether a worker may hand back
  a run it can no longer report on — stays recorded once, in EPIC 054.2's tree. See
  `04-a-structural-rejection-pays-its-attempt.md` and
  `05-a-review-rejection-pays-its-attempt.md`.

- **8 — The review rejection diagram is drawn against a judged refusal.**
  `judged-checkpoint-unknown` is unambiguously a daemon verdict, where `reason-too-large` is a `400`
  on the request shape. All five produce the same outer trace, so one diagram covers them; the fixture
  chooses the one whose charge is not in question. See
  `05-a-review-rejection-pays-its-attempt.md`.

## Still open

Nothing in this tree waits on a ruling. Four of the six blockers this tree first raised are settled by
the Decisions above, and the other two were resolved by applying the repair — the sweep predicate in
EPIC 051.1 Story 8 (`08-the-candidate-namespace-is-enumerated`) and the accounting projection in
EPIC 054 Story 7 (`07-accounting-by-class`).

**One dispatch prerequisite remains, and it is a human edit to the plan tree.**
`scripts/lane-check.sh` denies `.agents/plan/**` to every engineer role, so no role of `/work` may
apply it.

1. **The three `Superseded by: EPIC 054.3 <ship-id>` lines** on
   `.agents/plan/stories/052.1-the-structural-acceptance/09-the-accepted-patch.md:33` —
   `accept-structural-success`,
   `.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:20` —
   `accept-review-success-with-reason` and
   `.agents/plan/stories/053.1-the-review-checkpoint/08-the-attestation-with-no-reason.md:18` —
   `accept-review-success-no-reason`. A human applies them after Story 2
   (`02-the-worker-failure-pays-its-attempt`) puts `"054.3"` in `authoredEpics`, because
   `scripts/verify-epic-sequence.ts` refuses a supersession naming an epic outside the authored set.
   Story 10 (`10-the-proposal-records-the-report-arms`) cannot delete the three scenario files without
   them.

2. **Nothing else.** Every amendment this tree asked of another epic is applied, and
   `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md` —
   `## Amendments this epic asks of other epics` lists the nine edits with their bullets deleted, as
   `.agents/plan/authoring.md:52` — `An amendment asked of another epic lives until it is applied`
   requires.

## Suggestions, not blockers

- **S1 — every control of this tree is executable, and four were rewritten to make that true.**
  Story 1 case 5 and Story 7 case 6 named an alternate implementation as their control; both
  assertions are positive — a count and an index comparison — so
  `.agents/plan/authoring.md:317` — `a proof whose only oracle is absence` asks for no control, and
  both now say so. Story 2 case 5 and Story 4 case 4 replaced a source mutation with a substituted
  double. Every remaining control is a bound double, an injected failure or a second fixture.

- **S2 — `at` reaches `endAttempt` from a clock read taken at the top of the prelude.**
  `src/commands/outcome/report-outcome.ts:108` — `now` is read before the authority check, so on the
  structural arm the patch validation and the graph render run between the read and the close. The
  skew is one transaction and no proposal defines `ended_at` as post-verification wall time, so this
  is not a blocker. Giving either nested accept a `Clock` would add a token to eleven refusal
  diagrams.

- **S3 — Stories 3 and 8 ship no production statement, and each says so in its `## Change`.** Story 3
  draws the exhausted worker branch, which calls `execution.endRun` where Story 2's does not; Story 8
  draws the reasonless attestation, which omits `blobs.put`. Both differences are call sets and
  therefore diagrams, both edits were made by an earlier story, and both stories tell the implementer
  to verify the statement and report a divergence rather than re-apply it. `.agents/plan/authoring.md`
  measures one pair per story, which both satisfy, and EPIC 053.1 Stories 7 and 8 are the shipped
  precedent for the shape.

## Defects in the EPIC, now repaired

- The story count read nine in the header and the story list held nine; both now read ten, and the
  header names the cap.
- The dispatch-prerequisite paragraph named Story 1 as the inserter of `"054.3"`; it now names
  Story 2.
- "the five judged refusals" was written twice and four are judged; the Story 5 entry and gate row 9
  now read "five refusals, four of them judged".
- Gate row 13 counted seven ship diagrams and implied four scenario deletions; it now counts eight
  and states three deletions.
- Gate row 8 named an owner whose story cannot carry the whole assertion; it now names Story 5.
- The Proof block omitted `src/main.test.ts` and
  `src/commands/checkpoint/discard-run-candidate.test.ts`; both are added.
- The epic had no gate row for the discard unit; rows 0, 0a and 0b are added and owned by Story 1.
- The Decision asserting the six conditions hold cited the sweep's return value; it now states the
  predicate the sweep needed and names the amendment that applied it.

## Defects in the EPIC, still for a human to repair

- **Five citations into EPIC 054 have drifted by two to four lines.** The epic writes
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:36`, `:40`, `:52`, `:105` and
  `:107`, and the current lines are `:38`, `:42`, `:54`, `:109` and `:111`. The gate reports a
  relocated citation rather than refusing it, so this is a repair and not a blocker. This tree cites
  the current lines.

- **`.agents/plan/stories/054.2-.../01-the-unreachable-candidate-pays-its-attempt.md:206` is cited
  for `attempt.end` and holds `attemptOutcomes`.** The projection entry is at `:221`. This tree cites
  `:221`.
