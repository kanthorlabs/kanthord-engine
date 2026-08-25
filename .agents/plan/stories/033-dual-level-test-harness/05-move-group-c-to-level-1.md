# Story 5 — Move group C to level 1

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: Story 4.

## Change

- Re-run both inventory commands immediately before editing:

```bash
grep -rlE 'loopback(Agent|Server)' --include='*.test.ts' src test
grep -rl createTestApp --include='*.test.ts' src test
```

- Define group C as files present in both command results, after the level-2 exclusions.
- Apply the edit to each resulting group-C file.
- The pre-EPIC-032 group is `src/http/server/authorize.test.ts`,
  `src/http/server/dispatch.test.ts`, and `src/http/server/route.test.ts`.
- At each helper import, replace `loopbackAgent` with `fetchAgent`.
- At each direct call, remove only the await that resolved `loopbackAgent`.
- Keep the await that resolves the request response.
- Pass a direct `Hono` application to `fetchAgent` when the file constructs one.
- If the file calls `createApp`, pass that result's `hono` field to `fetchAgent`.
- Keep each `createTestApp` call unchanged; Story 3 already makes that path level 1.
- Keep every suite name, case name, request, status, header assertion, and body assertion unchanged.

## Constraints

- Add exactly zero cases and remove exactly zero cases.
- Apply the same five level-2 exclusions that Story 4 names.
- Do not edit group A, the completed group B, a direct handler test, production code, or a manifest.
- Both paths in each group-C file must use level 1 after this story.
- Do not add or change an assertion during migration.

## Verify

- Run the group-C suite:

```bash
node --test \
  src/http/server/authorize.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/route.test.ts
```

- Every file passes with its pre-story case count.
- Re-run the inventory commands. No recomputed group-C file names `loopbackAgent`.
- Run `npm run verify`; it exits 0 with no pass-count change from Story 4.
- Proof: delivers the `authorize`, `dispatch`, and `route` lines when those files remain in group C.
- Proof: preserves every EPIC 030 parity assertion in those files.
