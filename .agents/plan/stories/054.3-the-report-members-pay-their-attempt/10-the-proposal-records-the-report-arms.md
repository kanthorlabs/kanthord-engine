# Story 10 — The proposal records the report arms

Epic: `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md`
Depends on: Stories 1 to 9, all of them — it records the behaviour their edits produce and it ships
the range that makes their diagrams replay.
Kind: story-foundation

**It is last in dispatch order.** It appends `"054.3"` to `scripts/epic-sequence-range.ts:20` —
`shippedEpics` and to the pinned literal at `test/sequence/conformance.test.ts:274` —
`["050", "050.1"]`, which `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` requires to
stay a prefix of `authoredEpics`. **Verify that `"054.2"` is the last entry of `shippedEpics` before
appending.**

**Append the entry and delete the three superseded scenario files in the same turn.**
`test/sequence/conformance.test.ts:72` — `Superseded` marks a diagram superseded only when the naming
epic sits in `shippedEpics`, so a deletion that lands first leaves a due diagram with no scenario,
which `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` refuses.

**Dispatch prerequisite, and it is a human edit.** Each of the three superseded diagram sections must
already carry its `Superseded by: EPIC 054.3 <ship-id>` line:
`.agents/plan/stories/052.1-the-structural-acceptance/09-the-accepted-patch.md:33` —
`accept-structural-success`,
`.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:20` —
`accept-review-success-with-reason` and
`.agents/plan/stories/053.1-the-review-checkpoint/08-the-attestation-with-no-reason.md:18` —
`accept-review-success-no-reason`. `scripts/lane-check.sh` denies `.agents/plan/**` to the
`test-engineer`, the `software-engineer` and the `groundwork-engineer` alike, so no role of `/work`
may write them and no `Paths:` line may carry them. A human applies the three after Story 2
(`02-the-worker-failure-pays-its-attempt`) puts `"054.3"` in `authoredEpics` —
`scripts/verify-epic-sequence.ts` refuses a supersession naming an epic outside the authored set.
Without them the deletions below cannot land, because a diagram nothing supersedes stays due.

## Change

**Add the report arms to `docs/proposal/phase-2/attempts-and-classification.md`.** The document is
EPIC 054 Story 10 (`10-the-proposal-records-classification`)'s, amended by EPIC 054.1 Story 4
(`04-the-proposal-records-the-command`) and EPIC 054.2 Story 8
(`08-the-ceiling-the-order-and-the-proposal`). It gains one section stating five facts and nothing
else:

1. **The arm table.** A worker's own `rejected`, `failed` or `cancelled` report charges
   `worker-reported-failure`, which is semantic. A structural rejection and a review rejection each
   charge `daemon-rejected`, which is semantic. The accepted structural patch and both accepted
   review attestations charge nothing and store a null `termination`. All seven close through
   `end-attempt`, so every close appends one `attempt.ended`.
2. **The returned-disposition rule.** `acceptStructural` and `acceptReview` return a rejection rather
   than throwing it, so the settlement commits before `reportOutcome` raises the refusal. The refusal
   codes, their statuses and their details are unchanged, and the prelude — the expiry pass included
   — now commits on a refused report where it used to roll back.
3. **The discard ownership, per arm.** A worker failure report discards
   `refs/kanthord/candidate/<runId>/<attemptNo>` after the report transaction commits and before the
   reap. A structural rejection discards nothing, because a structural report carries a patch and no
   object id. A review rejection discards nothing, because a review claim writes no candidate ref.
   The accepted execution member discards inside `acceptExecution`, which is EPIC 051.4's.
4. **The trust boundary.** A worker's claim of quota exhaustion is not `provider-quota`: only a
   response the daemon's own transport received carries a `responseHash`, so a worker-reported failure
   is semantic whatever the worker says caused it.
5. **The checkpoint derivation.** Every checkpoint writer records `caller` — the authenticated
   principal — and `subject` — the run's worker. Nothing is backfilled, so a row written before this
   epic keeps both null.

**It states no path this epic does not ship.** The execution arm is EPIC 054.2's and the run lifecycle
is EPIC 054.4's, and each amends this document with the paths it wires.

**A review verdict of `reject` is an accepted attestation and charges no attempt**, and the section
says so in one sentence, because the opposite reading is the default a reader takes. This is the
ruling `.agents/plan/epics/053.1-the-review-checkpoint.md:48` — `The verdict is evidence` carries and
that EPIC 053.1 Story 10 (`10-the-report-route-carries-a-verdict`) is asked to state.

**Append `"054.3"` to `scripts/epic-sequence-range.ts`.** One entry on `shippedEpics` at
`scripts/epic-sequence-range.ts:20` — `shippedEpics`.

**Edit `test/sequence/conformance.test.ts` to pin the new `shippedEpics` literal.** Append `"054.3"`
to `test/sequence/conformance.test.ts:274` — `["050", "050.1"]` and leave
`test/sequence/conformance.test.ts:275` — `authoredEpics.slice` untouched. That line is the prefix
proof, and it is what fails if an epic between `"050.1"` and `"054.3"` has not shipped.

**Delete the three superseded scenario files**, in the same turn as the append:
`test/sequence/scenarios/accept-structural-success.ts`,
`test/sequence/scenarios/accept-review-success-with-reason.ts` and
`test/sequence/scenarios/accept-review-success-no-reason.ts`.

**Delete no baseline scenario file, because none exists.** The four `baseline-` diagrams of Stories 2
to 5 hold no scenario file at all — `test/sequence/conformance.test.ts:104` —
`validateScenarioFiles` refuses one whose id starts with `baseline-` — so the deletions here are the
three superseded **live** diagrams and no fourth.

**The ``Add `test/sequence/scenarios/<id>.ts`.`` line of each superseded story stays.** Deleting it
would leave EPIC 052.1 or EPIC 053.1 owning a live diagram with no scenario, and each of those
diagrams is live while its own epic is the head.

## Constraints

- Append to `shippedEpics` only when `"054.2"` is already its last entry.
- Delete the three scenario files in the same turn as the append, never before it and never after.
- Delete three files, not seven. The four baselines hold none.
- Add no diagram, no `Diagrams:` line, no `Baselines:` line and no `Seams:` line. This story draws
  nothing.
- The proposal amendment states no path of EPIC 054.2 and no path of EPIC 054.4.
- Do not edit any file under `.agents/plan/`. The three `Superseded by:` lines are a human edit and a
  dispatch prerequisite.

## Verify

```
node --test src/commands/checkpoint/discard-run-candidate.test.ts src/commands/outcome/report-outcome.test.ts src/commands/checkpoint/accept-structural.test.ts src/commands/checkpoint/accept-review.test.ts src/commands/checkpoint/land-execution.test.ts src/services/execution/sqlite.test.ts src/http/server/node/report-node.test.ts test/sequence/conformance.test.ts
```

Add, each as a separate case:

1. `"shippedEpics ends with 054.3 and is still a prefix of authoredEpics"` — append `"054.3"` to the
   pinned literal at `test/sequence/conformance.test.ts:274` — `["050", "050.1"]` and leave
   `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` untouched, then run
   `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics` and assert
   it passes.

2. `"the conformance runner replays all eight ship diagrams of this epic by equality"` — after the
   `shippedEpics` entry lands, run `test/sequence/conformance.test.ts:278` —
   `every due scenario conforms` and assert every scenario file this epic added replays:
   `discard-run-candidate`, `report-worker-failure-paid`,
   `report-worker-failure-exhausted-paid`, `report-structural-rejection`,
   `report-review-rejection`, `accept-structural-success-paid`,
   `accept-review-success-with-reason-paid` and `accept-review-success-no-reason-paid`. Then assert
   the comparison **fails** when `attempt.end:A` is removed from each of the seven that hold it,
   seven mutations, and when `candidate.discard:candidate` is removed from `discard-run-candidate`,
   an eighth. This is the epic's gate row 13.

3. `"each superseded diagram is superseded and holds no scenario file"` — for each of the three,
   assert the owning story holds `Superseded by: EPIC 054.3 <ship-id>` inside its own
   `` ### `<id>` `` section, that this epic's story holds the matching `Supersedes:`, and that the
   scenario file does not exist. **The control is the restore direction**: write one of the three
   scenario files into an `mkdtemp` fixture tree and assert `validateScenarioFiles` at
   `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` throws
   `names a superseded live diagram`, in the shape of
   `test/sequence/conformance.test.ts:188` —
   `a live diagram superseded by a shipped epic holding a scenario file fails`.

4. `"no baseline of this epic holds a scenario file"` — for each of
   `baseline-report-worker-failure`, `baseline-report-worker-failure-exhausted`,
   `baseline-report-structural-rejection` and `baseline-report-review-rejection`, assert
   `test/sequence/scenarios/<id>.ts` does not exist, and that each section carries a
   `Superseded by: EPIC 054.3 <ship-id>` line. **The control is the refusal direction**: write
   `test/sequence/scenarios/baseline-report-worker-failure.ts` into an `mkdtemp` fixture tree and
   assert `validateScenarioFiles` throws `is a baseline diagram`. This is the second half of the
   epic's gate row 13.

5. `"the whole Proof block passes"` — a **build-only** check, run from the shell and never from a
   test file: execute the `node --test` block of
   `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md` and assert it exits 0 and
   prints `PASS EPIC-054.3`. **Do not implement it as an `it` inside any file the block names.** The
   block lists `test/sequence/conformance.test.ts`, so a case living there that spawns the block
   would re-enter its own file. EPIC 054.2 Story 8 (`08-the-ceiling-the-order-and-the-proposal`)
   carries no such case for the same reason.

6. `"the proposal states the report arms and no later arm"` — `pnpm run verify` exits 0 with the
   amended `docs/proposal/phase-2/attempts-and-classification.md`, and a reviewer asserts the section
   names the seven charges, the returned disposition, the per-arm discard ownership, the trust
   boundary, the checkpoint derivation and the `reject`-verdict sentence, and names no execution gate
   arm and no run-lifecycle path. This is a build check plus a reviewer check, and it mirrors
   EPIC 054.2 Story 8 (`08-the-ceiling-the-order-and-the-proposal`) case 8.

`pnpm run verify` exits 0.

Proof: PASS line delivered — every file of the Proof block in `PASS EPIC-054.3`.
