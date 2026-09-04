# Story 8 — The range gate

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: Story 6 (the parser).
Kind: story-foundation

This story enforces `.agents/plan/authoring.md` over the plan tree. It draws no path.

## Change

**Create `scripts/verify-epic-sequence.ts`.** Story 7 creates
`scripts/epic-sequence-range.ts`; import `authoredEpics` and `shippedEpics` from it rather than
restating either list.

The epic set is `authoredEpics`. Each id names one file under `.agents/plan/epics/` and one directory
`.agents/plan/stories/<epic-id>/`, and the gate refuses when either is absent. EPIC 051 to EPIC 057
are numbered and outside this set: they hold no stories yet, so there is nothing to lint, and the
epic that authors each one adds its id to `authoredEpics` in the same change.

It refuses when:

- an epic file holds a mermaid block. An epic states decisions and a verification gate, and it draws nothing;
- a diagram fails the parser of Story 6;
- a diagram id repeats across live diagrams;
- a `Supersedes` line names an id no story in the set declares;
- an unpinned tail names an epic inside the set that declares no such diagram id;
- a live diagram is named by no `Diagrams:` line or by two;
- a story owns more than one live diagram. One story, one path;
- a story of a **shipped** epic naming a due diagram does not hold the exact path `test/sequence/scenarios/<id>.ts`. Due is what Story 7 defines: the owning epic is in `shippedEpics`, and no epic in `shippedEpics` superseded the diagram. This one refusal narrows to the shipped set, because a scenario is code and an unshipped epic has none. Every other refusal above reads the plan text only, so it applies to the whole authored set;
- a baseline id holds a scenario file, or carries no `Superseded by:` line;
- a `Baselines:` pair names an id that is not a baseline diagram, or names a live diagram the story does not own. The ownership test applies to the live side only. A refusal diagram names the baseline of the path it refuses, and that baseline belongs to another story, which `.agents/plan/authoring.md` permits;
- a `Seams:` line names no diagram, or names a diagram the story does not own;
- a `Seams:` token carries no sign, or two signs for one diagram;
- a `+` or `~` token appears in no diagram that line names;
- a `+` token appears in that diagram's baseline;
- a `-` token appears in that diagram, or appears neither in that diagram's baseline nor in a `@<file>:<line>` citation;
- a token of a live diagram that is no context token of its baseline is `+` or `~` in no story or in two.

**Add a row to the `AGENTS.md` enforcement table**: a sequence diagram per changed path, and code
conformance to it, enforced by `scripts/verify-epic-sequence.ts` and `test/sequence/conformance.test.ts`.

**Rollout.** The gate goes red the moment it lands unless every story of the range carries its
diagrams. The script and its test land in this epic, and `package.json` is not touched. The `verify`
wiring lands in the change that makes every epic of the range satisfy the gate, per
`.agents/plan/authoring.md`, and this epic does not merge a red gate.

## Constraints

- The gate reads the plan tree only. It never imports a production module.
- Every refusal is asserted against a fixture tree in its own `mktemp` directory, and the directory is removed.
- The real tree passes. That assertion is what makes the gate honest.
- That a path is shipped is not machine-decidable. The gate checks every baseline it finds; the epic's story list is where a reviewer checks the set.

## Verify

```
node --test scripts/verify-epic-sequence.test.ts && node scripts/verify-epic-sequence.ts
```

Create `scripts/verify-epic-sequence.test.ts`. Assert each refusal above by value against a fixture
tree, one case each, and assert the real tree passes. The four cases that carry the most weight:

1. `"an epic holding a mermaid block fails"` — Rule A is enforced, not requested.
2. `"a story owning two live diagrams fails"` — Rule B is enforced, not requested.
3. `"a story of an unshipped epic needs no scenario file"` — a pass, not a refusal, so the shipped-set
   narrowing cannot be a silent skip of every scenario check.
4. `"a story of a shipped epic missing its scenario file fails"` — the same rule from the other side.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `scripts/verify-epic-sequence.test.ts` in `PASS EPIC-050.1`.
