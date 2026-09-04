# Story 10 — The conformance harness admits an incremental supersession

Epic: `.agents/plan/epics/051.5-the-targeted-post-expiry-candidate-cleanup.md`
Depends on: nothing of this epic — it is **first in dispatch order**.
Kind: story-foundation

Every other story of this epic depends on it. Stories 6, 7 and 8 each swap one scenario, and no
ordering of them is green under the shipped rule. Story 3 depends on it for the `authoredEpics` entry,
without which `scripts/verify-epic-sequence.ts` refuses this epic's first scenario file.

## Change

**Amended: the rule is landed, and this story verifies it rather than applying it.**
`.agents/plan/stories/050.3-the-plan-write-guard/10-the-conformance-harness-admits-an-incremental-supersession.md`
lands both predicates, in both files, together with the fixture-tree extraction — because EPIC 050.4 is
the first epic to supersede a shipped, replayed diagram and is red without them. **Read every section
below as the specification of what must already be true.** Verify each and raise `OPEN:` naming the
divergence rather than re-applying it; a second application of one predicate is what makes the two
implementations diverge. What remains this story's own is case 6 and case 8 of `## Verify`, which
assert the rule over **this** epic's three supersessions and over the real tree at this range
boundary.

Two implementations of one rule live in the tree, and both applied it keyed on `shippedEpics`. Both
changed identically.

### 1 — `scripts/epic-sequence-range.ts` — `"051.5"` is already in `authoredEpics`

The list is at `scripts/epic-sequence-range.ts:1` — `authoredEpics`, and it already holds `"051.5"` in
sequence order. **Amended: the whole authored range is already applied.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` holds every id of the family, and `test/sequence/conformance.test.ts:255` — `assert.deepEqual` pins the matching literal. A human applied the range whole rather than one id per epic, and `scripts/verify-epic-sequence.test.ts:880` — `the real plan tree passes the range gate` is green over it. **This story edits neither file: verify the entry and report a
divergence rather than re-applying it.**

**This edit is in this story and not in Story 3, and the reason is that the tree is red without it.**
A human already applied the three `Superseded by: EPIC 051.5 …` lines, at
`.agents/plan/stories/051-the-workspace-branch/03-the-claim-reads-the-workspace-head.md:26` —
`Superseded`,
`.agents/plan/stories/051-the-workspace-branch/06-the-first-execution-claim.md:31` — `Superseded` and
`.agents/plan/stories/050.4-the-node-lease-removal/02-the-claim-of-an-initiative-drops-the-lease.md:25` —
`Superseded`. `scripts/verify-epic-sequence.ts:505` — `knownEpicIds` refuses a supersession naming an
epic outside `authoredEpics`, so `scripts/verify-epic-sequence.test.ts:882` — `doesNotThrow` fails
until the entry lands. The epic assigns the insert to Story 3; every story of this epic promises
`pnpm run verify` exits 0, and only the first story in dispatch order can keep that promise. **The
amendment is recorded in `index.md`.**

Do **not** touch `scripts/epic-sequence-range.ts:17` — `shippedEpics` here. Story 9
(`09-the-contended-cut-reaps-before-it-refuses`) appends to it, because a diagram is due a scenario
only once the code it describes exists. Update the pinned literal at
`test/sequence/conformance.test.ts:255` — `authoredEpics` to match.

If a predecessor of `"051.5"` is absent from `authoredEpics` when this story runs, that is a
dependency violation: raise `OPEN:` naming it rather than adding it here, because
`test/sequence/conformance.test.ts:41` — `authoredEpics` throws for a listed epic whose story
directory is absent.

### 2 — `test/sequence/conformance.test.ts` — dueness and supersession per diagram

`test/sequence/conformance.test.ts:72` — `Superseded` captures the epic id alone, and
`test/sequence/conformance.test.ts:85` — `has` decides both facts from `shippedEpics`. Three edits.

**Capture the superseding diagram id.** The regex at `:72` becomes
`/^Superseded by:\s+EPIC\s+(\S+)\s+(\S+)/gm`, and each match yields a pair. The real plan tree already
writes both tokens: `scripts/verify-epic-sequence.ts:81` — `Superseded` requires them and errors on the
one-token form. The fixture at `test/sequence/conformance.test.ts:205` — `Superseded` writes the
one-token form and must gain a diagram id.

**Decide supersession on the superseding scenario file, or on the predecessor's own absence.**
`superseded` becomes true when a `Superseded by:` pair names an epic in **`authoredEpics`** and
**either** `test/sequence/scenarios/<the superseding diagram id>.ts` exists **or** the diagram's own
scenario file is already gone. Not `shippedEpics`, and not the epic id alone.

**The second clause is what lets one story retire a predecessor whose replacement a later story
writes, and Story 6 needs it.** One `claimNode` statement serves both `claim-branch-base-task` and
`claim-lease-free-initiative`, so Story 6 (`06-the-branch-base-claim-reaps`) changes both traces and
must retire both scenarios — while `claim-initiative-reap.ts` does not arrive until Story 8
(`08-the-initiative-claim-reaps`). Without the clause `claim-lease-free-initiative` stays due at
Story 6, because `"050.4"` is shipped, and the runner replays a thirteen-step trace against a
fourteen-step claim.

**The clause weakens nothing.** A retirement still requires an authored `Superseded by:` naming a
diagram some story declares; `scripts/verify-epic-sequence.ts` still refuses a `Supersedes:` that
resolves to nothing and still refuses a live diagram with no story owner; and Story 9
(`09-the-contended-cut-reaps-before-it-refuses`) case 4 asserts all six diagrams of this epic replay
once `shippedEpics` holds `"051.5"`. A declared replacement that never ships is therefore caught at
the epic boundary rather than never.

**Decide dueness on the diagram's own epic or its own scenario file.** The filter at `:85` becomes:
a diagram is due when its own epic is in `shippedEpics` **or** its own scenario file exists, and it
is not superseded.

Both predicates need the scenario listing, which `test/sequence/conformance.test.ts:89` —
`scenarioFilesById` already provides and which `validateScenarioFiles` at
`test/sequence/conformance.test.ts:104` — `validateScenarioFiles` already takes as an injectable
parameter. Thread the same root into `authoredLiveDiagrams` and `liveDiagrams` so every case can drive
the pair over a fixture tree; the existing default arguments keep every real-tree call unchanged.

**What the change guarantees, unchanged.** A scenario naming a superseded diagram is still refused, and
a due diagram still needs exactly one scenario. It widens no epic's authority, because `authoredEpics`
still gates every supersession: a `Superseded by:` naming an unauthored epic supersedes nothing.

**Why each of the three stories is then green.** While `claim-first-execution-reap.ts` exists and
`"051.5"` is authored, `claim-first-execution` is superseded and needs no scenario, while
`claim-lease-free-initiative` is still due and keeps its own. And `claim-first-execution-reap` is due
because its own scenario file exists, even though `"051.5"` is unshipped — so the runner replays it at
the story boundary that added it.

### 3 — `scripts/verify-epic-sequence.ts` — the same rule, in the range gate

The gate carries an independent copy of both predicates and runs on the real tree through
`scripts/verify-epic-sequence.test.ts:882` — `doesNotThrow` under `pnpm test`. Left alone, it fails at
exactly the story boundaries step 2 unblocks: at Story 7, `claim-first-execution`'s owner epic `051`
is shipped and `"051.5"` is not, so
`scripts/verify-epic-sequence.ts:723` — `due` still calls it due and
`scripts/verify-epic-sequence.ts:734` — `lacks` refuses the scenario Story 7 deleted.

Three edits, matching step 2:

- `scripts/verify-epic-sequence.ts:713` — `supersededBy` becomes: superseded when a `Superseded by:`
  reference names an epic in `authoredEpics` **and** either the scenario file of its `diagramId`
  exists **or** the superseded diagram's own scenario file is absent. The reference already carries
  `diagramId`, from `scripts/verify-epic-sequence.ts:114` — `supersededByMatch`, so no parser change
  is needed here. Both clauses must match `test/sequence/conformance.test.ts` exactly; a predicate
  that differs between the two files is the defect this story exists to remove.
- `scripts/verify-epic-sequence.ts:715` — `superseded` keeps its message and its refusal; only the
  predicate above it changes.
- `scripts/verify-epic-sequence.ts:723` — `due` becomes: due when the owner's epic is in
  `shippedEpics` **or** the diagram's own scenario file exists, and it is not superseded.

`scenarioIds` at `scripts/verify-epic-sequence.ts:701` — `scenarioIds` is already in scope at all
three sites.

### 4 — `scripts/verify-epic-sequence.test.ts` — the fixture cases

`scripts/verify-epic-sequence.test.ts:16` — `createFixtureTree` already builds an `epics/`, `stories/`
and `scenarios/` tree per `authoredEpics` entry and already takes a `scenarioIds` second parameter,
which is exactly the "does the superseding scenario file exist" lever. Its story builder
`storyDocument` and its diagram builder `diagram(id, steps, ending, reference)` already inject a
`Superseded by:` line through the `reference` parameter. Use them; add no new fixture facility.

`test/sequence/conformance.test.ts` builds the same tree open-coded at `:197` and `:232`. Extract those
two loops into one local `createFixtureTree(stories, scenarioIds)` in that file, shaped like the
`scripts/` one. **Do not import across the two**:
`.agents/plan/stories/050.1-the-claim/07-the-conformance-runner.md:12` — `script` rules that a script
never imports from `test/`, and the reverse direction is already used at
`test/sequence/conformance.test.ts:17` — `epic-sequence-range` for the range lists alone.

## Constraints

- Change the predicate, never the refusal. Every existing error message and every existing `it` name
  of `test/sequence/conformance.test.ts` and `scripts/verify-epic-sequence.test.ts` stays.
- Gate supersession on `authoredEpics`, never widen it to any epic id found in the tree. An
  unauthored epic supersedes nothing, and that is what stops a draft from retiring shipped code.
- Require the authored epic **and** one of the two scenario conditions for supersession. The authored
  epic alone would let a draft retire shipped code; dropping the retired clause reintroduces the
  boundary where Story 6 has two changed traces and one replacement.
- Change both files. One rule in two implementations is what makes this story's two halves
  inseparable; shipping one leaves `pnpm test` red.
- Append `"051.5"` to `authoredEpics` only. `shippedEpics` is Story 9's.
- Do not add a diagram, a scenario file or a `Diagrams:` line. This story changes how diagrams are
  discovered and owns none.
- Do not change `test/helpers/sequence-conformance.ts`. The recorder, the parser and the terminal are
  EPIC 050.1's, and this story touches discovery alone.

## Verify

```
node --test test/sequence/conformance.test.ts scripts/verify-epic-sequence.test.ts
```

**Cases 1 to 5 and case 7 are EPIC 050.3 Story 10's, and they are already in the tree.** Verify each
by name and report a divergence rather than writing it again. This story adds **case 6 and case 8**,
which are the only two keyed to this epic's own supersessions and to this range boundary.

Extend `test/sequence/conformance.test.ts` for case 6, over a fixture plan tree in its own `mkdtemp`
directory.

The cases, each a separate `it`:

1. `"a diagram superseded by an authored epic is due while the superseding scenario is absent"` — a
   fixture story in a shipped epic declaring `superseded-live` with
   `Superseded by: EPIC 051.5 replacement-live`, a fixture story in `051.5` declaring
   `replacement-live`, and a scenarios root holding `superseded-live.ts` alone. Assert
   `validateScenarioFiles` does not throw, and that the due set includes `superseded-live` and
   excludes `replacement-live`.

2. `"a diagram is superseded once the superseding scenario file exists"` — the same tree with
   `replacement-live.ts` added and `superseded-live.ts` removed. Assert `validateScenarioFiles` does
   not throw, the due set includes `replacement-live` and excludes `superseded-live`.

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
   an unauthored supersession outright at
   `scripts/verify-epic-sequence.ts:505` — `knownEpicIds`, before it ever reaches its dueness
   predicate, so the same fixture there asserts that refusal instead.

5. `"a diagram with no Superseded by line keeps the shipped behaviour"` — the control for cases 1 to 4.
   A fixture story in a shipped epic declaring `plain-live` with no supersession. Assert it is due, and
   that `validateScenarioFiles` throws when its scenario file is absent and does not throw when it is
   present. Two assertions, one case; without them the four cases above pass for a rule that made
   everything due.

6. `"the scenario swap is green at every boundary this epic passes through"` — over one fixture tree
   modelling this epic: three shipped-epic diagrams `pred-a`, `pred-b` and `pred-c`, each carrying
   `Superseded by: EPIC 051.5 <its replacement>`, three `051.5` diagrams `rep-a`, `rep-b` and `rep-c`,
   and these four states of the scenarios root, asserted in this order:

   - **Story 6's state** — `pred-a.ts` and `pred-c.ts` deleted, `rep-a.ts` added, `pred-b.ts` still
     present. `pred-c` is retired by the second supersession clause with no replacement on disk, which
     is the state the shipped rule could not express. Assert no throw.
   - **Story 7's state** — `pred-b.ts` deleted, `rep-b.ts` added. Assert no throw.
   - **Story 8's state** — `rep-c.ts` added. Assert no throw, and assert all six ids resolve to
     exactly one file or to none, with `rep-a`, `rep-b` and `rep-c` present.
   - **the control** — a fourth diagram `plain-d` in a shipped epic carrying **no** `Superseded by:`
     line, its scenario deleted. Assert `validateScenarioFiles` **throws**. Without it the three
     passes prove only that the rule accepts everything.

   Assert the state count is `4`, so a boundary dropped from the case fails rather than passing.

7. `"the range gate treats supersession and dueness per diagram"` — through
   `scripts/verify-epic-sequence.test.ts:16` — `createFixtureTree` and `verifyEpicSequence`, using
   `assertFixtureRefusal` for the throwing arms. Five states, each named and asserted by its exact
   outcome rather than by reference to another case:

   - a diagram of a shipped epic with `Superseded by: EPIC 051.5 rep-a` and **no** `rep-a.ts`, its own
     scenario present — no refusal.
   - the same tree with `rep-a.ts` present and its own scenario deleted — no refusal.
   - the same tree with **both** deleted — no refusal, which is the retired clause.
   - a diagram of an authored, unshipped epic whose own scenario exists — no refusal, and it is
     replayed as due.
   - the control: a diagram of a shipped epic with no `Superseded by:` line and no scenario — refused
     with `due live diagram plain-d lacks test/sequence/scenarios/plain-d.ts`.

   The unauthored-epic fixture of case 4 is asserted here as a **refusal** —
   `supersession names an epic outside the authored set: EPIC 099` from
   `scripts/verify-epic-sequence.ts:505` — `knownEpicIds` — and not as a dueness outcome, because this
   gate rejects it before the predicate runs.

8. **the real plan tree passes both gates** — a build-only check, and not an `it`. Run
   `node --test test/sequence/conformance.test.ts scripts/verify-epic-sequence.test.ts` and require
   exit 0, then `pnpm run verify` and require exit 0. **Do not write this as a test that shells out to
   `node --test` over the files it lives in** — such a case re-enters the runner and spawns itself.
   This is the check that clears the failure the applied `Superseded by: EPIC 051.5` lines opened at
   `scripts/verify-epic-sequence.test.ts:882` — `doesNotThrow`, and it is why this story is first in
   dispatch order.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `test/sequence/conformance.test.ts` in `PASS EPIC-051.5`.
