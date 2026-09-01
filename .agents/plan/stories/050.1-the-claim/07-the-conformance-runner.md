# Story 7 — The conformance runner

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: Story 6 (the harness).
Kind: story-foundation

This story runs every scenario the range declares. It draws no path, and it adds no scenario file: a
scenario is owned by the story that owns its diagram.

## Change

**Create `test/sequence/conformance.test.ts`.** It reads every diagram of every story of EPIC 050 to
EPIC 057, lists `test/sequence/scenarios/`, and refuses:

- a live diagram id with no scenario file;
- a scenario file with no live diagram id;
- a baseline id holding a scenario file;
- a superseded id holding a scenario file.

It then imports every scenario and runs it through `assertConformance`. Each scenario default-exports
a function that builds the fixture its diagram names, runs the real command over real SQLite behind
`recordSeams`, binds a nested command to unrecorded dependencies, and returns the recorder and the
result.

Discovery is by directory listing and the run is by import, so a scenario cannot be satisfied by
unreached source text.

## Constraints

- Add no scenario file. Stories 2 to 5 add theirs, and EPIC 050.2 adds its own.
- Discover by listing the directory. Never hold a hard-coded scenario list.
- Import each scenario. A file that parses and never runs proves nothing.
- Use real SQLite through the shipped `createMigratedStorage()` helper. A fake would assert the fake.

## Verify

```
node --test test/sequence/conformance.test.ts
```

Assert, each as a separate `it`:

1. `"every live diagram has exactly one scenario file"`.
2. `"every scenario file names a live diagram"`.
3. `"a baseline id holding a scenario file fails"` — against a fixture tree in its own `mktemp` directory.
4. `"a superseded id holding a scenario file fails"` — same fixture form.
5. `"every scenario conforms"` — the real run over the real tree.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `test/sequence/conformance.test.ts` in `PASS EPIC-050.1`.
