# EPIC 053.1 — The review checkpoint — stories

Epic: `.agents/plan/epics/053.1-the-review-checkpoint.md`
Prereq: EPIC 053 (sequence order). Story 1 (`01-the-three-read-seams`) reads its `"053"` entry in
`authoredEpics`, and Story 10 (`10-the-report-route-carries-a-verdict`) reads its
`aggregateObjective` binding and the parent transition it owns. Story 1 reads EPIC 051.3's
`checkpoint` table and `CheckpointRow`; Stories 3 to 8 read EPIC 051.3's `execution.writeCheckpoint`
and EPIC 051.4's `src/commands/checkpoint/` directory; Story 9 reads EPIC 051.4's
`docs/proposal/phase-2/checkpoints.md` and EPIC 052.2's seventh `nodeReportRequest` member; Story 10
reads EPIC 051.4's authority prelude and its `accept` dependency key.

A verdict becomes evidence bound to the commit it judged. A review claim is admitted, a review report
carries a verdict and a judged checkpoint reference, and the daemon refuses a subject the review node
did not declare or that a newer accepted checkpoint supersedes.

## One story, one path

Eight of the ten stories carry a diagram. Stories 1 and 9 are `story-foundation` and draw nothing.

**Every prior set in this epic is empty, so this epic draws no `baseline-` diagram and every token of
every diagram is `+`.** The review member and the review claim's success path are both written from
nothing: every review claim refuses today at
`src/commands/node/claim-node.ts:210` — `review-head-unavailable`, and `acceptReview` does not exist.

| story | diagram                                   | steps | terminal                              |
| ----- | ----------------------------------------- | ----- | ------------------------------------- |
| 2     | `claim-success-review`                    | 19    | `ok`                                  |
| 3     | `accept-review-refusal-reason-too-large`  | 0     | `refuse:reason-too-large`             |
| 4     | `accept-review-refusal-judged-unknown`    | 1     | `refuse:judged-checkpoint-unknown`    |
| 5     | `accept-review-refusal-judged-undeclared` | 2     | `refuse:judged-checkpoint-undeclared` |
| 6     | `accept-review-refusal-judged-superseded` | 3     | `refuse:judged-checkpoint-superseded` |
| 7     | `accept-review-success-with-reason`       | 12    | `ok`                                  |
| 8     | `accept-review-success-no-reason`         | 11    | `ok`                                  |
| 10    | `report-review-gate`                      | 9     | `ok`                                  |

**The four refusal diagrams are a prefix chain, and that is a property of the command, not a
convenience.** Each refusal is decided by the read that precedes it, so a story that adds one read
adds exactly one refusal and one step. `judged-checkpoint-not-execution` shares Story 4's diagram
because it stops at the same step, and the code that separates the two is proven by Story 4's
cases 1 and 2.

**The count is not run backwards from the ten-story cap.** Five conditional seam calls decide the
drawn set, and the drawn set decides the story count. The epic reaches the cap because it also needs
two foundation stories and a claim lift.

## Dispatch order

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`

- 1 first, because every later story names one of its three seams, and because its `authoredEpics`
  entry is what makes this epic's stories visible to `scripts/verify-epic-sequence.ts`.
- 2 next and independently: it needs no new seam, and it opens the run without which no review report
  exists.
- 3 before 4 to 8, because it creates `src/commands/checkpoint/accept-review.ts` and its error class.
- 4 → 5 → 6 → 7 → 8 in that order, because each adds one read to the command the previous one left.
- 9 before 10. **This inverts the epic's story list**, and the reason is stated in Story 9
  (`09-the-contract-the-cli-and-the-proposal`): Story 10's route cases need the eighth
  `nodeReportRequest` member and the five error codes, and Story 10 must be last because it appends
  `shippedEpics`. EPIC 052.2 orders the same pair the same way.
- 10 last, because appending `shippedEpics` makes all eight diagrams scenario-due and every scenario
  file must already exist.

No story depends on a later one.

## Stories

- 1 — the three read seams and the `authoredEpics` entry → `01-the-three-read-seams.md` — draws
  nothing
- 2 — the review claim is admitted → `02-a-review-claim-is-admitted.md` — draws
  `claim-success-review`
- 3 — the command, its error class and the pure byte check →
  `03-an-oversized-reason-reaches-no-seam.md` — draws `accept-review-refusal-reason-too-large`
- 4 — the judged-checkpoint read and its two refusals →
  `04-an-unusable-judged-checkpoint-refuses-after-one-read.md` — draws
  `accept-review-refusal-judged-unknown`
- 5 — the dependency read and the undeclared refusal →
  `05-an-undeclared-subject-refuses-after-the-dependency-read.md` — draws
  `accept-review-refusal-judged-undeclared`
- 6 — the supersession read and the last refusal → `06-a-superseded-subject-refuses-last.md` — draws
  `accept-review-refusal-judged-superseded`
- 7 — the attestation, the terminal tail and the precedence table →
  `07-the-attestation-with-a-reason.md` — draws `accept-review-success-with-reason`
- 8 — the conditional blob write and the two review CHECKs → `08-the-attestation-with-no-reason.md` —
  draws `accept-review-success-no-reason`
- 9 — the contract, the CLI, the registers and the proposal →
  `09-the-contract-the-cli-and-the-proposal.md` — draws nothing
- 10 — the route, the binding and `shippedEpics` → `10-the-report-route-carries-a-verdict.md` — draws
  `report-review-gate`

No story is a groundwork story. `scripts/lane-check.sh test-engineer <path>` or
`scripts/lane-check.sh software-engineer <path>` allows every path this epic edits, so no `Paths:`
line is legal and none is written.

## Facts (needed for implementation)

- **Nothing this epic builds on exists in `src/` yet.** The `shippedEpics` tuple of
  `scripts/epic-sequence-range.ts` is `["050", "050.1"]`, so `src/commands/checkpoint/`, `src/domain/checkpoint.ts`,
  `execution.writeCheckpoint`, the `accept` dependency key and
  `docs/proposal/phase-2/checkpoints.md` are all authored and unshipped. Every story states the
  epic and story that creates what it reads.
- **`execution.readCheckpoint` returns `CheckpointRow`, not `CheckpointRecord`.** EPIC 051.3 Story 2
  (`02-the-checkpoint-row`) declares `CheckpointRecord` with fifteen fields and none of the four
  review columns, so a read returning it could not answer
  `judged-checkpoint-not-execution` or copy `acceptedOid`.
- **The dependency key for the blob store is `blobs`.** `src/main.ts:268` — `blobs` and
  `src/queries/plan/validate-plan.ts:38` — `blobs` are the shipped spellings, and EPIC 052.1 Story 9
  (`09-the-accepted-patch`) draws `blobs.put`. The epic's gate row 22 writes `blob.put`; the diagrams
  use `blobs.put`.
- **`execution.readCheckpoint`, `plan.readDependencies` and `execution.newestExecutionCheckpoint`
  draw bare tokens.** `test/helpers/sequence-conformance.ts:50` — `projections` holds fifteen
  entries and none for any of the three, and each is called once per diagram.
- **A function-valued dependency is invisible to the recorder.**
  `test/helpers/sequence-conformance.ts:112` — `wrapCapability` returns a non-object dependency value unwrapped, so
  `reportObjective` and `closeObjective` appear in no live diagram, while `accept.review` and
  `objective.aggregate` do because both are object keys.
  `.agents/plan/epics/053-node-state-ownership.md:34` — `objective` states that rule for the roll-up.
- **The report route carries no terminal write.**
  `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/08-the-report-route-enforces-the-gate.md:13`
  — `Seams` removes `execution.closeAttempt:A`, `plan.setNodeState:T:outcome-accepted`,
  `execution.stampRunHead:R`, `execution.endRun:R`, `events.append:outcome.reported:T:null` and
  `plan.readAllNodes` from it, so the nested acceptance owns the whole tail.
- **`execution.attemptsOfRun` projects the run id**, per
  `test/helpers/sequence-conformance.ts:61` — `execution.attemptsOfRun`, so the prelude's one call is
  the only authority for selecting the open attempt.
- **`objectIdRequired` has no production reader.** `src/domain/outcome-report.ts:32` —
  `objectIdRequired` is consumed only by `src/domain/outcome-report.test.ts`, so no branch consults
  it and the review path passes `headOid: null` unconditionally.
- **A review checkpoint needs an attempt that no claim opens today.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:49` — `attempt_id`
  declares it `NOT NULL`, `src/commands/node/claim-node.ts:402` — `runKind` opens one only for the
  `execution` kind, and `.agents/plan/epics/050.1-the-claim.md:235` — `openAttempt` asserts that
  absence deliberately. EPIC 052.1 Story 9 (`09-the-accepted-patch`) already closes an attempt on a
  structural run, so the contradiction is inherited and tree-wide.
- **`nodeReportRequest` carries `runId` and `runFence` on every member, and no lease `fence`.**
  EPIC 050.2 Story 7 (`07-the-worker-contract`) adds the two, and EPIC 050.4 Story 6
  (`06-the-report-drops-the-lease`) removes the third from five members.
- **Exit codes 170 to 177 are taken.** EPIC 052.2 Story 1 (`01-the-contract-carries-the-patch`)
  assigns them, so this epic starts at 178 and the code count reaches 42.
- **`edge` holds `UNIQUE (from_node, to_node)`** at
  `src/services/storage/migration-0002-graph-and-plan.ts:48` — `UNIQUE`, so a dependency list needs no
  de-duplication and a duplicate edge cannot be seeded.
- **A checkpoint id is a prefixed 26-character ULID.** `src/domain/identity.ts:49` — `ulidPattern`
  fixes it, so `"checkpoint_a"` is not a usable fixture id once the contract validates one.
- **`closeAttempt` distinguishes a null head from an absent one.**
  `src/services/execution/sqlite.ts:291` — `writesHeadOid` flags on `!== undefined`, so
  `headOid: null` clears `head_oid` and omitting the key leaves it untouched.
- **The refusal mapping lives in `src/http/server/node/refusals.ts`.**
  `src/http/server/node/report-node.ts:41` — `toHttpError` holds one delegation and no switch, and
  `src/http/server/node/refusals.ts:67` — `reportOutcomeRefusal` is where every refusal switch is.
- **Adding a 400 code makes `envelopeCodeForStatus(400)` ambiguous.**
  `src/cli/exit-code.ts:64` — `envelopeCodeForStatus` names a code only when exactly one declares the
  status, so `src/cli/exit-code.test.ts:107` — `invalid-request` moves.
- **A 400 code may carry details.** `src/http/contract/errors.ts:107` — `Exclude` makes `details`
  optional for a non-409 code, and `src/http/contract/error-details.ts:116` —
  `invalidRequestDetails` is the shipped precedent, so `reason-too-large` gets a schema rather than a
  `null` record entry.
- **`from_node` is the dependent and `to_node` is the dependency.**
  `src/services/plan/sqlite.ts:118` — `from_node` fixes the direction, and
  `src/services/plan/sqlite.ts:174` — `to_node` is the statement `readDependencies` issues.
- **The product document is `../docs/workflow/worker.md`, in the superproject**, and it has 741
  lines. `docs/proposal/phase-2/worker.md` does not exist.

## Decisions taken during authoring, and now recorded in the EPIC

Every ruling below is applied to `.agents/plan/epics/053.1-the-review-checkpoint.md`. One ask remains
open against another epic, and the epic's `## Amendments this epic asks of other epics` carries it:
the EPIC 050.1 `judged_oid` decision, whose pin this epic moves to the attestation. Two asks are
resolved: the attempt-lifecycle repair is applied to EPIC 050.4 Story 2
(`02-the-claim-of-an-initiative-drops-the-lease`), and the objective review path is authored as
EPIC 053.2.

- **`judged-checkpoint-unaccepted` is dropped, and the epic carries five new codes.** EPIC 052 Story 5
  (`05-the-seams-the-acceptance-needs`) settled that every checkpoint row is an accepted checkpoint —
  `.agents/plan/stories/052-the-graph-patch-and-its-policies/05-the-seams-the-acceptance-needs.md:138`
  — `accepted` — and migration `14` has no column the predicate could read. The code would be
  unreachable. See `03-an-oversized-reason-reaches-no-seam.md`.
- **The second seam is `newestExecutionCheckpoint`.** A name promising an acceptance predicate the
  schema cannot express sends a reader looking for a column that will never exist. See
  `01-the-three-read-seams.md`.
- **The contract dispatches at position 9 and the route at position 10.** Story 10's route cases need
  the member and the codes, and Story 10 must be last because it appends `shippedEpics`. See
  `09-the-contract-the-cli-and-the-proposal.md`.
- **Four contract-side edits the epic's story list omits are carried by Story 9.**
  `src/http/contract/error-details.ts`, the `operationAdditions` allowlist at
  `src/http/contract/coverage.test.ts:19` — `operationAdditions`, the error-code matrix of
  `docs/proposal/api/README.md` that `test/helpers/proposal.ts:89` — `readErrorCodeMatrix` reads, and
  the moved `envelopeCodeForStatus(400)` assertion. Each is what makes `pnpm run verify` pass. See
  `09-the-contract-the-cli-and-the-proposal.md`.
- **`acceptReview` owns the terminal tail, and the route owns none of it.** EPIC 051.4 removed every
  terminal write from the report route, and EPIC 052.1 Story 9 (`09-the-accepted-patch`) holds them
  in the nested command. `report-review-gate` is therefore a nine-step prelude plus one nested call
  plus the reap, and the two success diagrams grow to twelve and eleven steps. See
  `07-the-attestation-with-a-reason.md` and `10-the-report-route-carries-a-verdict.md`.
- **The tail order and `plan.readAllNodes` after `objective.aggregate` are copied from EPIC 053's
  `land-settle-aggregate`.** The aggregation returns `void`, so the post-transition `objectiveState`
  is only readable after it. See `07-the-attestation-with-a-reason.md`.
- **`acceptReview` returns `NodeReportResult`, so `CheckpointRecord` does not widen.** EPIC 052.1
  Story 9 (`09-the-accepted-patch`) returns the same type from `acceptStructural`, and nothing
  outside `execution` reads a review column. Only `WriteCheckpointInput` gains a member. See
  `07-the-attestation-with-a-reason.md`.
- **The precedence table holds six pairs and two three-way cases, not ten pairs.**
  `judged-checkpoint-unknown` excludes the other three judged codes, and
  `judged-checkpoint-not-execution` excludes `judged-checkpoint-superseded` because supersession is
  defined over an execution checkpoint. `judged-checkpoint-undeclared` and
  `judged-checkpoint-superseded` **can** both hold, because supersession is a fact about the judged
  node. See `07-the-attestation-with-a-reason.md`.
- **Story 7 writes the blob unconditionally and Story 8 makes it conditional.** That staging is what
  gives Story 8 a production change and makes the reasonless trace a path with an empty prior set.
  See `08-the-attestation-with-no-reason.md`.
- **`accept` stays one object key with three methods.** Three function-valued keys would make step 8
  of `report-review-gate` invisible to the recorder. See
  `10-the-report-route-carries-a-verdict.md`.
- **The refusal mapping is written in `src/http/server/node/refusals.ts`.** The epic names
  `report-node.ts`; the code and EPIC 052.2 both say `refusals.ts`. See
  `10-the-report-route-carries-a-verdict.md`.
- **Story 2 draws the review-task claim, and EPIC 053.2 owns the review-objective claim.** The lift
  admits both `(task, review)` and `(objective, review)` — `src/domain/node-pair.ts:43` — `review`
  makes the second legal with the state owner `attestation-then-human` — and their token sets differ,
  so they are two paths. The epic is at the ten-story cap, and a story count is not a product-scope
  argument, so the second path moves to a sibling epic together with the objective attestation
  lifecycle. See `02-a-review-claim-is-admitted.md`.
- **The attempt gate is repaired upstream, and Story 2 does not repair it.** A review checkpoint needs
  `attempt_id`, which no claim wrote for a non-execution run. The repair — an admitted run opens
  exactly one attempt whatever its kind — is applied to EPIC 050.4 Story 2
  (`02-the-claim-of-an-initiative-drops-the-lease`), which is the story that already redraws the one
  trace the change moves. EPIC 052.1 was unexecutable without it. Story 2 draws the trace the repair
  produces and edits no gate. See `02-a-review-claim-is-admitted.md`.
- **`nodeReportRequest`'s review member carries `runId` and `runFence`, and no `fence`.** See
  `09-the-contract-the-cli-and-the-proposal.md`.
- **`reason-too-large` carries a details schema.** The command raises `{ bytes, limit }`, so a record
  entry of `null` would emit an envelope the daemon's own response fails to parse. See
  `09-the-contract-the-cli-and-the-proposal.md`.
