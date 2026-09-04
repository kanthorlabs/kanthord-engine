# Story 8 — The ceiling, the order and the proposal

Epic: `.agents/plan/epics/054.2-the-execution-accept-pays-its-attempt.md`
Depends on: Stories 1 to 7, all of them — it asserts the properties their edits produce and it ships
the range that makes their diagrams replay.
Kind: story-foundation

**It is last in dispatch order.** It appends `"054.2"` to `scripts/epic-sequence-range.ts:20` —
`shippedEpics` and to the pinned literal at `test/sequence/conformance.test.ts:274` —
`["050", "050.1"]`, which `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` requires to
stay a prefix of `authoredEpics`. **Verify that `"054.1"` is the last entry of `shippedEpics` before
appending.**

**Append the entry and delete the seven superseded scenario files in the same turn.**
`test/sequence/conformance.test.ts:72` — `Superseded` marks a diagram superseded only when the naming
epic sits in `shippedEpics`, so a deletion that lands first leaves a due diagram with no scenario,
which `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` refuses.

**Dispatch prerequisite, and it is a human edit.** Each of the seven superseded diagram sections must
already carry its `Superseded by: EPIC 054.2 <ship-id>` line. `scripts/lane-check.sh` denies
`.agents/plan/**` to the `test-engineer`, the `software-engineer` and the `groundwork-engineer` alike,
so no role of `/work` may write them and no `Paths:` line may carry them. The seven edits are listed
in `index.md`, and a human applies them after Story 1
(`01-the-unreachable-candidate-pays-its-attempt`) puts `"054.2"` in `authoredEpics` —
`scripts/verify-epic-sequence.ts:530` — `outside the authored set` refuses the line before that.
Without them the deletions below cannot land, because a diagram nothing supersedes stays due.

## Change

**Add the execution arm to `docs/proposal/phase-2/attempts-and-classification.md`.** The document is
EPIC 054 Story 10's, amended by EPIC 054.1 Story 4 (`04-the-proposal-records-the-command`). It gains
one section stating four facts and nothing else:

1. **The arm table.** A rejection of the execution gate charges `daemon-rejected`, which is semantic.
   A contended land charges `contended`, which is infrastructure. An accepted land charges nothing and
   stores a null termination. All three close through `end-attempt`.
2. **The returned-disposition rule.** `acceptExecution` returns a rejection at the five gate refusals
   rather than throwing it, so the settlement commits before `reportOutcome` raises the refusal. The
   refusal codes, their statuses and their details are unchanged.
3. **The discard order.** The order is settle, discard, refuse. A refusal that holds a candidate ref
   discards it after the settlement transaction commits, and the unreachable-candidate refusal
   discards nothing because the ref never existed.
4. **The transaction ceiling.** The execution arm opens one transaction on a rejection and two on an
   acceptance, and never three.

**It states no path this epic does not ship.** The report members are EPIC 054.3 and the run lifecycle
is EPIC 054.4, and each amends this document with the paths it wires.

**Append `"054.2"` to `scripts/epic-sequence-range.ts`.** One entry on `shippedEpics` at
`scripts/epic-sequence-range.ts:20` — `shippedEpics`.

**Edit `test/sequence/conformance.test.ts` to pin the new `shippedEpics` literal.** Append `"054.2"`
to `test/sequence/conformance.test.ts:274` — `["050", "050.1"]` and leave
`test/sequence/conformance.test.ts:275` — `authoredEpics.slice` untouched. That line is the prefix
proof, and it is what fails if an epic between `"050.1"` and `"054.2"` has not shipped.

**Delete the seven superseded scenario files**, in the same turn as the append:
`test/sequence/scenarios/report-refusal-candidate-unreachable.ts`,
`test/sequence/scenarios/report-refusal-multi-repository.ts`,
`test/sequence/scenarios/report-refusal-ancestry-broken.ts`,
`test/sequence/scenarios/report-refusal-path-undeclared.ts`,
`test/sequence/scenarios/report-refusal-command-failed.ts`,
`test/sequence/scenarios/land-settle-contended.ts` and
`test/sequence/scenarios/land-settle-aggregate.ts`.

**The ``Add `test/sequence/scenarios/<id>.ts`.`` line of each superseded story stays.** Deleting it
would leave EPIC 051.3, EPIC 051.4 or EPIC 053 owning a live diagram with no scenario, and each of
those diagrams is live while its own epic is the head.

## Constraints

- Append to `shippedEpics` only when `"054.1"` is already its last entry.
- Delete the seven scenario files in the same turn as the append, never before it and never after.
- Add no diagram, no `Diagrams:` line, no `Baselines:` line and no `Seams:` line. This story draws
  nothing.
- The proposal amendment states no path of EPIC 054.3 and no path of EPIC 054.4.
- Do not edit any file under `.agents/plan/`. The seven `Superseded by:` lines are a human edit and a
  dispatch prerequisite.

## Verify

```
node --test src/commands/checkpoint/accept-execution.test.ts src/commands/checkpoint/land-execution.test.ts src/commands/outcome/report-outcome.test.ts src/http/server/node/report-node.test.ts test/sequence/conformance.test.ts
```

Add, each as a separate case:

1. `"an execution gate rejection opens exactly one transaction span"` — substitute a `Storage` double
   recording every span, drive the real `acceptExecution` once per gate refusal over the five
   fixtures, and assert the count is exactly `1` in each. **The boundary is `acceptExecution`, not
   `node.report`.** `reportOutcome` opens its own prelude span and commits it before the accept runs —
   `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:40` — `reportOutcome` — so
   the whole wire operation opens two on a rejection and three on an acceptance, and the ceiling this
   epic states is the nested one. Assert the outer counts too, in the same case, so the two boundaries
   cannot be confused later. This is the first half of the epic's gate row 10.

2. `"an execution acceptance opens exactly two transaction spans"` — the same double over the accepted
   fixture, asserting exactly `2` at the `acceptExecution` boundary — `land.begin`'s and
   `land.settle`'s. **The span count is not the journaled-write proof.** That the `open` journal row
   lies between the two spans and the git write lies outside both is EPIC 051.3's property, proven by
   its own cases; this epic inherits it unchanged and asserts only that it added no span. Run
   `src/commands/checkpoint/land-execution.test.ts` whole as the sibling regression proof. **Case 1 is its control**: the
   two counts are asserted in one case set, so a third span anywhere fails one of them. This is the
   second half of the epic's gate row 10, and it is the ceiling
   `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:36` — `acceptExecution`
   pinned.

3. `"each of the five refusals leaves every table but attempt and event byte-identical"` — snapshot
   every table before the report and after it, once per refusal, and assert equality on all of them
   except `attempt` and the event log. Take the snapshot in the shape of
   `src/commands/outcome/report-outcome.test.ts:485` — `baseline` and compare it as
   `src/commands/outcome/report-outcome.test.ts:494` — `assertNoWrite` does. **The control is the
   `attempt` table itself**, which must differ in exactly one row; without it the assertion passes
   for a command that wrote nothing at all. This is the epic's gate row 11, and it is what proves the
   settlement writes nothing else.

4. `"the settle-discard-refuse order holds on all four discarding refusals"` — over the four refusals
   that hold a candidate ref, assert the storage span closes before the `Candidate` double's `discard`
   call and that the returned rejection is produced after both. Story 2
   (`02-the-foreign-repository-pays-its-attempt`) case 2 proves one; this case proves the set. **The
   control is the unreachable-candidate path**, which discards zero times.

5. `"the conformance runner replays all seven diagrams of this epic by equality"` — after the
   `shippedEpics` entry lands, run `test/sequence/conformance.test.ts:278` — `every due scenario conforms`
   and assert every scenario file this epic added replays. Then assert the comparison **fails** when
   `attempt.end` is removed from each one in turn, seven mutations. This is the epic's gate row 12.
   **The epic's row says six; there are seven ship diagrams**, and `index.md` records the count as a
   defect for the epic to fix.

6. `"each superseded diagram is superseded and holds no scenario file"` — for each of the seven, assert
   the owning story holds `Superseded by: EPIC 054.2 <ship-id>` inside its own
   `` ### `<baseline-id>` `` section, that this epic's story holds the matching `Supersedes:`, and that
   the scenario file does not exist. **The control is the restore direction**: write one of the seven
   scenario files into an `mkdtemp` fixture tree and assert `validateScenarioFiles` at
   `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` throws
   `names a superseded live diagram`, in the shape of
   `test/sequence/conformance.test.ts:188` — `a live diagram superseded by a shipped epic holding a scenario file fails`.
   This is the epic's gate row 13.

7. `"shippedEpics ends with 054.2 and is still a prefix of authoredEpics"` — append `"054.2"` to the
   pinned literal at `test/sequence/conformance.test.ts:274` — `["050", "050.1"]` and leave
   `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` untouched, then run
   `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics` and assert it
   passes.

8. `"the proposal states the execution arm and no later arm"` — `pnpm run verify` exits 0 with the
   amended `docs/proposal/phase-2/attempts-and-classification.md`, and a reviewer asserts the section
   names the three charges, the returned disposition, the discard order and the two span counts, and
   names no report member and no run-lifecycle path. This is a build check plus a reviewer check, and
   it mirrors EPIC 054 gate row 22.

`pnpm run verify` exits 0.

Proof: PASS line delivered — every file of the Proof block in `PASS EPIC-054.2`.
