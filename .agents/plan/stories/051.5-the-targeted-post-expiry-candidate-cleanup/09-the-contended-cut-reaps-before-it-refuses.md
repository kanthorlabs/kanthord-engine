# Story 9 — The contended cut reaps before it refuses

Epic: `.agents/plan/epics/051.5-the-targeted-post-expiry-candidate-cleanup.md`
Depends on: Story 7 (`07-the-first-execution-claim-reaps`), for the reap statement above the raise;
Story 8 (`08-the-initiative-claim-reaps`), for the third scenario swap, which must be on disk before
`"051.5"` joins `shippedEpics`.
Kind: story-foundation

It is **last in dispatch order**, because it appends `"051.5"` to `shippedEpics` and that append is
what makes the six diagrams of this epic due.

## Change

**This story writes no production statement.** The reap already sits between the settle and the raise,
from Story 7 (`07-the-first-execution-claim-reaps`). This story proves the contended arm reaches it,
proves the open-journal arm does not, and closes the range.

### 1 — no diagram, and the reason is the placement

The contended arm reaches the **same nineteen steps in the same order** as
`claim-first-execution-reap`, so under `.agents/plan/authoring.md` it is not a second diagram. Three
facts make that true and each is checkable:

- `claim.settle` raises nothing; it returns `{ disposition: "contended" }`, per
  `.agents/plan/stories/051-the-workspace-branch/07-the-loser-of-two-first-claims-refuses.md:50` —
  `claimSettle`. So step 17 is one step on both arms.
- `test/helpers/sequence-conformance.ts:132` — `tokens` pushes the token before `Reflect.apply`, so a
  call is recorded whether it returns or throws.
- The raise sits **below** the reap statement, so step 19 is reached on both arms before the terminal
  diverges.

This extends the ruling
`.agents/plan/stories/051-the-workspace-branch/06-the-first-execution-claim.md:22` — `same` by one
step. Case 2 stands in for the diagram.

### 2 — `scripts/epic-sequence-range.ts` — append `"051.5"` to `shippedEpics`

The list is at `scripts/epic-sequence-range.ts:12` — `shippedEpics`. Append the one element after the
last one, reordering nothing.

`test/sequence/conformance.test.ts:267` — `slice` requires `shippedEpics` to stay a prefix of
`authoredEpics`, so this edit is legal only once every epic before this one in `authoredEpics` has
shipped. That is the sequence order, and this story is where it is asserted rather than assumed. If a
predecessor is unshipped when this story runs, raise `OPEN:` naming it rather than reordering either
list.

Update the pinned literals at `test/sequence/conformance.test.ts:255` — `authoredEpics` and
`test/sequence/conformance.test.ts:266` — `shippedEpics` to match. `authoredEpics` already holds
`"051.5"` from Story 10 (`10-the-conformance-harness-admits-an-incremental-supersession`); this story
touches only the shipped half and the two pins.

### 3 — what the append turns on

Before it, every diagram of this epic is due only because its own scenario file exists, which is
Story 10's rule. After it, the owning epic is shipped and the shipped rule and the per-diagram rule
agree — which is the epic-level state the shipped harness would have produced. Nothing about the three
superseded diagrams changes: their `Superseded by:` lines name `"051.5"`, which is now shipped, so both
rules call them superseded and both refuse a scenario for them.

## Constraints

- Append to `shippedEpics` only. `authoredEpics` is Story 10's, and reordering either list is a defect
  of the epic that inserted the out-of-order element, reported rather than repaired here.
- Write no production code, and add no scenario file. Every diagram of this epic is owned by another
  story.
- Do not add a diagram for the contended arm. Its token list is asserted for equality against
  `claim-first-execution-reap`'s instead, which is a stronger claim than a second diagram: a second
  diagram would let the two lists drift.
- Do not change the `objective-busy` refusal, its code or its `details` helper. This story asserts they
  are unchanged; a story that edited them could not.
- Do not touch the three superseded story files in `.agents/plan/`.

## Verify

```
node --test src/commands/node/claim-node.test.ts test/sequence/conformance.test.ts scripts/verify-epic-sequence.test.ts
```

Extend `src/commands/node/claim-node.test.ts` for cases 1 to 3, and
`test/sequence/conformance.test.ts` for cases 4 to 6. The contended fixture is EPIC 051 Story 7's
(`07-the-loser-of-two-first-claims-refuses`): two first claims on the same objective, the second
losing the `workspace_branch` insert. Catch the refusal with
`src/commands/node/claim-node.test.ts:280` — `refused`.

Add, each as a separate `it`:

1. `"a contended cut deletes the candidate ref of the run its begin expired and still refuses objective-busy"` —
   over the contended fixture with one due run carrying a candidate ref, assert in **one** case that
   `error.refusal` equals `"objective-busy"`, that the due run's ref was present before and is absent
   after, and that `error.details` deep-equals
   `{ objectiveId: "objective_a", siblingNodeId: null, siblingRunId: null, expiresAt: null }` — the
   whole four-key value `contendedObjectiveDetails` produces at
   `.agents/plan/stories/051-the-workspace-branch/07-the-loser-of-two-first-claims-refuses.md:144` —
   `contendedObjectiveDetails`. **Assert the literal, not a comparison against a second refusal.** All
   four members are required and nullable at `:130` — `nullable`, so the value is fixed and a whole-object
   equality is the strongest available oracle; a run-to-run comparison would also pass if the reap
   changed the same field on both arms. The control for the deletion is case 3 below, which leaves the
   ref in place.

2. `"the contended arm reaches the same nineteen recorded steps, in the same order, as claim-first-execution-reap"` —
   record both arms over the same fixture shape, one settling and one contending, and assert the two
   token lists deep-equal each other and have length `19`. Assert the length as well as the equality,
   so a step dropped from both lists fails rather than passing. This stands in for the diagram the
   reap-before-raise placement makes unnecessary, and it extends
   `.agents/plan/stories/051-the-workspace-branch/06-the-first-execution-claim.md:338` — `pid` by one
   step.

3. `"a claim whose git.refUpdate fails leaves the cut row open, reaps nothing and leaves the ref"` —
   the control for case 1. A `git` double whose `refUpdate` rejects. Assert `claimNode` rejects, the
   `cut` journal row is `open`, the `candidate.reap` Mock recorded zero calls, and the due run's
   candidate ref still resolves. Three assertions, one case.

4. `"the conformance runner replays the six diagrams of EPIC 051.5"` — assert the due-diagram set
   includes exactly `reap-candidates-no-expired-run`, `reap-candidates-no-ref`,
   `reap-candidates-one-ref`, `claim-branch-base-reap`, `claim-first-execution-reap` and
   `claim-initiative-reap`, that each has exactly one scenario file, and that
   `test/sequence/conformance.test.ts:270` — `conforms` passes for all six. Assert the count is `6`,
   so a diagram dropped from the epic fails rather than passing silently.

5. `"removing candidate.reap from a claim path fails the comparison"` — the mutation control for
   case 4. For each of the three claim scenarios, replay it against a token list with
   `"candidate.reap"` removed and assert `assertConformance` throws. Three assertions, one case;
   without them case 4 passes for a comparison that ignores the last step.

6. `"the three superseded diagrams carry Superseded by, the three superseding diagrams carry Supersedes, and no scenario remains for the superseded ids"` —
   read the three story files of EPIC 051 and EPIC 050.4 and the three of this epic, and assert
   `claim-branch-base-task`, `claim-first-execution` and `claim-lease-free-initiative` each carry
   `Superseded by: EPIC 051.5 <the replacing id>`, that each replacing diagram carries the matching
   `Supersedes:`, and that `test/sequence/scenarios/` holds no file for the three superseded ids. Then
   write a fixture scenario file for one of them into a temp scenarios root and assert
   `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` throws. The restored file is the
   control.

7. `"shippedEpics holds this epic and stays a prefix of authoredEpics"` — assert
   `shippedEpics.at(-1)` equals `"051.5"`, `authoredEpics.includes("051.5")` is `true`, and
   `authoredEpics.slice(0, shippedEpics.length)` deep-equals `shippedEpics`. Three assertions, so this
   story cannot append to the wrong list and cannot break the prefix.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/node/claim-node.test.ts` and
`test/sequence/conformance.test.ts` in `PASS EPIC-051.5`.
