# Story 8 — The range gate

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: Story 6 (the parser).
Kind: story-foundation

This story enforces `.agents/plan/authoring.md` over the plan tree. It draws no path.

## Change

**Create `scripts/verify-epic-sequence.ts`**, and add it to the `verify` script of `package.json`.

The epic set is the file-name grammar `^(05[0-7])(\.[0-9]+)?-[a-z0-9-]+\.md$` under
`.agents/plan/epics/`, and the eight base numbers 050 to 057 are each required to be present. The
story set is `.agents/plan/stories/<epic-id>/` for each.

It refuses when:

- an epic file holds a mermaid block. An epic states decisions and a verification gate, and it draws nothing;
- a diagram fails the parser of Story 6;
- a diagram id repeats across live diagrams;
- a `Supersedes` line names an id no story in the set declares;
- an unpinned tail names an epic inside the set that declares no such diagram id;
- a live diagram is named by no `Diagrams:` line or by two;
- a story owns more than one live diagram. One story, one path;
- a story naming a diagram does not hold the exact path `test/sequence/scenarios/<id>.ts`;
- a baseline id holds a scenario file, or carries no `Superseded by:` line;
- a `Baselines:` pair names an id that is not a baseline diagram, or maps a diagram the story does not own;
- a `Seams:` line names no diagram, or names a diagram the story does not own;
- a `Seams:` token carries no sign, or two signs for one diagram;
- a `+` or `~` token appears in no diagram that line names;
- a `+` token appears in that diagram's baseline;
- a `-` token appears in that diagram, or appears neither in that diagram's baseline nor in a `@<file>:<line>` citation;
- a token of a live diagram that is no context token of its baseline is `+` or `~` in no story or in two.

**Add a row to the `AGENTS.md` enforcement table**: a sequence diagram per changed path, and code
conformance to it, enforced by `scripts/verify-epic-sequence.ts` and `test/sequence/conformance.test.ts`.

**Rollout.** The gate goes red the moment it lands unless every story of the range carries its
diagrams. The script and its test land in this epic. The `verify` wiring lands in the change that
completes the last story of the range, and this epic does not merge a red gate.

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
tree, one case each, and assert the real tree passes. The two cases that carry the most weight:

1. `"an epic holding a mermaid block fails"` — Rule A is enforced, not requested.
2. `"a story owning two live diagrams fails"` — Rule B is enforced, not requested.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `scripts/verify-epic-sequence.test.ts` in `PASS EPIC-050.1`.
