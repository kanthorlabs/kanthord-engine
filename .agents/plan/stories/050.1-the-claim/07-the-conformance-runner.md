# Story 7 — The conformance runner

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: Story 6 (the harness).
Kind: story-foundation

This story runs every scenario the range declares. It draws no path, and it adds no scenario file: a
scenario is owned by the story that owns its diagram.

## Change

**Create `scripts/epic-sequence-range.ts`.** It holds the range as data, and Story 8 imports the same
file. A script never imports from `test/`, so the constant lives under `scripts/`.

```ts
export const authoredEpics = [
  "050",
  "050.1",
  "050.2",
  "050.3",
  "050.4",
  "050.5",
] as const;
export const shippedEpics = ["050", "050.1"] as const;
```

`authoredEpics` names every epic whose stories exist. `shippedEpics` names every epic whose code
exists, and it is a prefix of `authoredEpics`. The last story of each epic of the range appends that
epic's own id to `shippedEpics`, so the list grows one entry per merge and never by hand.

**Create `test/sequence/conformance.test.ts`.** It reads every diagram of every story of every epic
in `authoredEpics`, lists `test/sequence/scenarios/`, and refuses:

- a **due** live diagram id with no scenario file;
- a scenario file with no live diagram id;
- a baseline id holding a scenario file;
- a live diagram holding a scenario file after a shipped epic superseded it.

**A live diagram is due a scenario when both hold**: its owning epic is in `shippedEpics`, and the
diagram carries no `Superseded by:` line naming an epic in `shippedEpics`. An unshipped epic owes no
scenario, because a scenario runs real code and that code does not exist. A superseded diagram owes
none either, because the path it draws is gone the moment its replacement ships. Both halves are
needed: `claim-success-task` is due today and stops being due when EPIC 050.4 ships
`claim-lease-free-task`.

It then imports every due scenario and runs it through `assertConformance`. Each scenario
default-exports a function that builds the fixture its diagram names, runs the real command over real
SQLite behind `recordSeams`, binds a nested command to unrecorded dependencies, and returns the
recorder and the result.

Discovery is by directory listing and the run is by import, so a scenario cannot be satisfied by
unreached source text.

## Constraints

- Add no scenario file. Stories 2 to 5 add theirs, and EPIC 050.2 adds its own.
- Discover by listing the directory. Never hold a hard-coded scenario list. `authoredEpics` and
  `shippedEpics` are an epic range, not a scenario list, and discovery inside an epic stays a listing.
- Import each scenario. A file that parses and never runs proves nothing.
- Use real SQLite through the shipped `createMigratedStorage()` helper. A fake would assert the fake.
- Never read the range from the file system. An epic directory appears when its stories are authored,
  which is before its code exists, so a directory listing cannot tell shipped from authored.

## Verify

```
node --test test/sequence/conformance.test.ts
```

Assert, each as a separate `it`:

1. `"every due live diagram has exactly one scenario file"`.
2. `"every scenario file names a live diagram"` — over `authoredEpics`, not over the shipped set. A
   scenario naming nothing is a defect at every point of the rollout.
3. `"a baseline id holding a scenario file fails"` — against a fixture tree in its own `mktemp` directory.
4. `"a live diagram superseded by a shipped epic holding a scenario file fails"` — same fixture form.
5. `"a live diagram of an unshipped epic needs no scenario file"` — same fixture form, asserting the
   pass rather than the refusal, so the scoping cannot be a silent skip of everything.
6. `"shippedEpics is a prefix of authoredEpics"` — a list that drifts scopes nothing.
7. `"every due scenario conforms"` — the real run over the real tree.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `test/sequence/conformance.test.ts` in `PASS EPIC-050.1`.
