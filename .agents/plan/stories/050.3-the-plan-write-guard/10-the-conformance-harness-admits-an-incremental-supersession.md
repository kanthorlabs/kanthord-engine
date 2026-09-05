# Story 10 — The conformance harness admits an incremental supersession

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: nothing. No story of this epic depends on it either, and it may run at any position.
Kind: story-foundation

This story draws nothing. It changes how a diagram is discovered, and it owns none. **It is inert on
the tree this epic leaves**, and case 8 asserts that.

**It is here because EPIC 050.4 is red without it and cannot hold it.** EPIC 050.4 is the first epic to
supersede a **shipped, replayed** diagram: six of its stories replace a live diagram of EPIC 050.1 or
EPIC 050.2, and both rules that decide dueness read `shippedEpics` alone —
`test/sequence/conformance.test.ts:85` — `has` calls a diagram due when its own epic is shipped and no
**shipped** epic supersedes it. `"050.4"` reaches `shippedEpics` in that epic's last story, so through
every story before it each predecessor stays due while the production change moves its trace.
**Keeping the predecessor's scenario replays a trace the command no longer takes; deleting it fails
`due live diagram … lacks …`.** Neither state is green.

`.agents/plan/authoring.md:46` — `A change and the repairs it forces are one epic` puts the repair with
EPIC 050.4, and `scripts/verify-epic-sequence.ts:466` — `holds more than ten stories` refuses it there:
that epic holds ten story files. The repair therefore lands in the **last epic before the first
consumer**, which is this one, and both epics state it.

## Change

Two implementations of one rule live in the tree, and both decide it from `shippedEpics`. Both change
here, identically. A predicate that differs between the two files is the defect this story exists to
remove.

### 1 — `test/sequence/conformance.test.ts` — dueness and supersession per diagram

`test/sequence/conformance.test.ts:72` — `Superseded` captures the epic id alone, and
`test/sequence/conformance.test.ts:85` — `has` decides both facts from `shippedEpics`. Three edits.

**Capture the superseding diagram id.** The regex at `:72` becomes
`/^Superseded by:\s+EPIC\s+(\S+)\s+(\S+)/gm`, and each match yields a pair. The real plan tree already
writes both tokens: `scripts/verify-epic-sequence.ts:121` — `Superseded by:` requires them and errors on the
one-token form. The fixture at `test/sequence/conformance.test.ts:205` — `Superseded` writes the
one-token form and must gain a diagram id.

**Decide supersession on the superseding scenario file, or on the predecessor's own absence.**
`superseded` becomes true when a `Superseded by:` pair names an epic in **`authoredEpics`** and
**either** `test/sequence/scenarios/<the superseding diagram id>.ts` exists **or** the diagram's own
scenario file is already gone. Not `shippedEpics`, and not the epic id alone.

**The first clause is what EPIC 050.4 consumes.** Each of its Stories 1 to 6 adds its replacement
scenario and deletes its predecessor's in the same commit, so the predecessor is superseded at the
moment its replacement lands. **The second clause lands with it**, because one rule in two files may
not be split across two epics: EPIC 051.5 Story 6 (`06-the-branch-base-claim-reaps`) is its first
consumer, where one statement changes two traces and one replacement arrives two stories later.

**Decide dueness on the diagram's own epic or its own scenario file.** The filter at `:85` becomes: a
diagram is due when its own epic is in `shippedEpics` **or** its own scenario file exists, and it is
not superseded. Without the second half, a replacement EPIC 050.4 adds is not replayed until its last story appends
`shippedEpics`, so a story could add a scenario that never runs.

Both predicates need the scenario listing, which `test/sequence/conformance.test.ts:89` —
`scenarioFilesById` already provides and which `validateScenarioFiles` at
`test/sequence/conformance.test.ts:104` — `validateScenarioFiles` already takes as an injectable
parameter. Thread the same root into `authoredLiveDiagrams` and `liveDiagrams` so every case can drive
the pair over a fixture tree; the existing default arguments keep every real-tree call unchanged.

**What the change guarantees, unchanged.** A scenario naming a superseded diagram is still refused, and
a due diagram still needs exactly one scenario. It widens no epic's authority, because `authoredEpics`
still gates every supersession: a `Superseded by:` naming an unauthored epic supersedes nothing.

### 2 — `scripts/verify-epic-sequence.ts` — the same rule, in the range gate

The gate carries an independent copy of both predicates and runs on the real tree through
`scripts/verify-epic-sequence.test.ts:895` — `doesNotThrow` under `pnpm test`. Left alone, it refuses
at exactly the boundaries step 1 unblocks: at EPIC 050.4 Story 1
(`01-the-claim-of-a-task-drops-the-lease`), `claim-success-task`'s owner epic `050.1` is shipped and
`"050.4"` is not, so `scripts/verify-epic-sequence.ts:746` — `due` still calls it due and
`scripts/verify-epic-sequence.ts:757` — `lacks` refuses the scenario that story deleted.

Three edits, matching step 1:

- `scripts/verify-epic-sequence.ts:736` — `supersededBy` becomes: superseded when a `Superseded by:`
  reference names an epic in `authoredEpics` **and** either the scenario file of its `diagramId`
  exists **or** the superseded diagram's own scenario file is absent. The reference already carries
  `diagramId`, from `scripts/verify-epic-sequence.ts:120` — `supersededByMatch`, so no parser change is
  needed here.
- `scripts/verify-epic-sequence.ts:738` — `superseded` keeps its message and its refusal; only the
  predicate above it changes.
- `scripts/verify-epic-sequence.ts:746` — `due` becomes: due when the owner's epic is in
  `shippedEpics` **or** the diagram's own scenario file exists, and it is not superseded.

`scenarioIds` at `scripts/verify-epic-sequence.ts:724` — `scenarioIds` is already in scope at all three
sites.

### 3 — the fixture facility both test files need

`scripts/verify-epic-sequence.test.ts:16` — `createFixtureTree` already builds an `epics/`, `stories/`
and `scenarios/` tree per `authoredEpics` entry and already takes a `scenarioIds` second parameter,
which is exactly the "does the superseding scenario file exist" lever. Its story builder
`storyDocument` and its diagram builder `diagram(id, steps, ending, reference)` already inject a
`Superseded by:` line through the `reference` parameter. Use them; add no new fixture facility.

`test/sequence/conformance.test.ts` builds the same tree open-coded in the fixture cases that begin at `test/sequence/conformance.test.ts:189` — `mkdtempSync` and `:224` — `mkdtempSync`. Extract those
two loops into one local `createFixtureTree(stories, scenarioIds)` in that file, shaped like the
`scripts/` one. **Do not import across the two**:
`.agents/plan/stories/050.1-the-claim/07-the-conformance-runner.md:12` — `script` rules that a script
never imports from `test/`, and the reverse direction is already used at
`test/sequence/conformance.test.ts:17` — `epic-sequence-range` for the range lists alone.

## Constraints

- Change the predicate, never the refusal. Every existing error message and every existing `it` name of `test/sequence/conformance.test.ts` and `scripts/verify-epic-sequence.test.ts` stays.
- Gate supersession on `authoredEpics`, never widen it to any epic id found in the tree. An unauthored epic supersedes nothing, and that is what stops a draft from retiring shipped code.
- Require the authored epic **and** one of the two scenario conditions. The authored epic alone would let a draft retire shipped code.
- Land both clauses of the supersession rule, even though this epic consumes the first alone. Splitting one predicate across two epics leaves two files to edit twice and two chances to diverge.
- Change both files. One rule in two implementations is what makes this story's two halves inseparable; shipping one leaves `pnpm test` red.
- Touch neither `authoredEpics` nor `shippedEpics`. Both ranges are already applied, and each epic appends its own shipped entry in its own last story.
- Do not add a diagram, a scenario file or a `Diagrams:` line. This story changes how diagrams are discovered and owns none.
- Do not change `test/helpers/sequence-conformance.ts`. The recorder, the parser and the terminal are EPIC 050.1's, and this story touches discovery alone.
- Delete no scenario file and add none. Each of EPIC 050.4's Stories 1 to 6 deletes its own predecessor's.
- Change no rule this epic's own stories depend on. This story is inert here: no scenario of an unshipped epic exists, and no predecessor's scenario is gone.

## Verify

```
node --test test/sequence/conformance.test.ts scripts/verify-epic-sequence.test.ts
```

Extend `test/sequence/conformance.test.ts` for cases 1 to 6 and
`scripts/verify-epic-sequence.test.ts` for case 7, each over a fixture plan tree in its own `mkdtemp`
directory.

Add, each as a separate `it`:

1. `"a diagram superseded by an authored epic is due while the superseding scenario is absent"` — a
   fixture story in a shipped epic declaring `superseded-live` with
   `Superseded by: EPIC 050.4 replacement-live`, a fixture story in `050.4` declaring
   `replacement-live`, and a scenarios root holding `superseded-live.ts` alone. Assert
   `validateScenarioFiles` does not throw, and that the due set includes `superseded-live` and excludes
   `replacement-live`.

2. `"a diagram is superseded once the superseding scenario file exists"` — the same tree with
   `replacement-live.ts` added and `superseded-live.ts` removed. Assert `validateScenarioFiles` does not
   throw, the due set includes `replacement-live` and excludes `superseded-live`. **This is the state
   every story of this epic passes through**, and case 6 walks the six of them in order.

2a. `"a diagram whose own scenario is gone is superseded with no replacement on disk"` — the same tree
with **both** files absent. Assert `validateScenarioFiles` does not throw and the due set holds
neither id. This is the second clause, which EPIC 051.5 Story 6 (`06-the-branch-base-claim-reaps`) is
the first to need; it is asserted here because it lands here.

3. `"a diagram of an unshipped epic is due once its own scenario file exists"` — a fixture story in an
   authored, unshipped epic declaring `unshipped-live`, and `unshipped-live.ts` present. Assert the due
   set includes it. Then remove the file and assert the due set excludes it, in the same case, so the
   `or` is asserted in both directions.

4. `"a Superseded by naming an unauthored epic supersedes nothing"` — the same tree with
   `Superseded by: EPIC 099 replacement-live`, no story declaring `replacement-live`, and
   `replacement-live.ts` present. Assert `superseded-live` is still due and that
   `validateScenarioFiles` throws `scenario … names no live diagram` for `replacement-live.ts`. This is
   what keeps `authoredEpics` the gate on supersession. **This case belongs to
   `test/sequence/conformance.test.ts` alone and is not mirrored into case 7**: the range gate refuses
   an unauthored supersession outright at `scripts/verify-epic-sequence.ts:528` — `knownEpicIds`,
   before it ever reaches its dueness predicate, so the same fixture there asserts that refusal
   instead.

5. `"a diagram with no Superseded by line keeps the shipped behaviour"` — the control for cases 1 to 4.
   A fixture story in a shipped epic declaring `plain-live` with no supersession. Assert it is due, and
   that `validateScenarioFiles` throws when its scenario file is absent and does not throw when it is
   present. Two assertions, one case; without them the four cases above pass for a rule that made
   everything due.

6. `"the scenario swap is green at every boundary EPIC 050.4 passes through"` — over one fixture tree
   modelling that epic: six shipped-epic diagrams `pred-1` to `pred-6`, each carrying
   `Superseded by: EPIC 050.4 rep-<n>`, six `050.4` diagrams `rep-1` to `rep-6`, and the six states of
   the scenarios root in that epic's dispatch order. At state `n`, `pred-1` to `pred-n` are deleted and `rep-1` to
   `rep-n` are present. Assert no throw at each state, and at state `6` assert every one of the twelve
   ids resolves to exactly one file or to none. Then the control: a seventh diagram `plain-7` in a
   shipped epic carrying **no** `Superseded by:` line, its scenario deleted — assert
   `validateScenarioFiles` **throws**. Assert the state count is `6`, so a boundary dropped from the
   case fails rather than passing.

7. `"the range gate treats supersession and dueness per diagram"` — through
   `scripts/verify-epic-sequence.test.ts:16` — `createFixtureTree` and `verifyEpicSequence`, using
   `assertFixtureRefusal` for the throwing arms. Five states, each named and asserted by its exact
   outcome rather than by reference to another case:

   - a diagram of a shipped epic with `Superseded by: EPIC 050.4 rep-a` and **no** `rep-a.ts`, its own
     scenario present — no refusal.
   - the same tree with `rep-a.ts` present and its own scenario deleted — no refusal.
   - the same tree with **both** deleted — no refusal, which is the second clause.
   - a diagram of an authored, unshipped epic whose own scenario exists — no refusal, and it is
     replayed as due.
   - the control: a diagram of a shipped epic with no `Superseded by:` line and no scenario — refused
     with `due live diagram plain-d lacks test/sequence/scenarios/plain-d.ts`.

   The unauthored-epic fixture of case 4 is asserted here as a **refusal** —
   `supersession names an epic outside the authored set: EPIC 099` from
   `scripts/verify-epic-sequence.ts:528` — `knownEpicIds` — and not as a dueness outcome, because this
   gate rejects it before the predicate runs.

8. **the real plan tree passes both gates** — a build-only check, and not an `it`. Run
   `node --test test/sequence/conformance.test.ts scripts/verify-epic-sequence.test.ts` and require
   exit 0, then `pnpm run verify` and require exit 0. **Do not write this as a test that shells out to
   `node --test` over the files it lives in** — such a case re-enters the runner and spawns itself.
   This is the check that proves the change is inert on the tree as it stands, which it must be: no
   scenario of an unshipped epic exists yet, and no predecessor's scenario is gone. **It is why this
   story can land an epic before its first consumer.**

`pnpm run verify` exits 0.

Proof: PASS line delivered — `test/sequence/conformance.test.ts` and
`scripts/verify-epic-sequence.test.ts` in `PASS EPIC-050.3`.
