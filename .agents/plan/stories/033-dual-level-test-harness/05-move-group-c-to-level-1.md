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

### `src/http/server/dispatch.test.ts` — the authorized rawHeaders exception

The file holds three cases served by its local `rawResponse` helper over `loopbackServer`, which
read node `rawHeaders` or raw body bytes. Human amendment of this cycle authorizes their migration;
every expected value survives unchanged, only the access path moves onto the `AgentResponse`
contract.

- Migrate all three `rawResponse(koaFromHono(hono), "GET", "/v1/status")` call sites to
  `fetchAgent(hono).get("/v1/status")`.
- Delete the local `rawResponse` helper and every import only that helper needed.
- The 204 case keeps its name and asserts the same values through level 1: status `204`,
  zero body bytes as `response.text === ""`, and neither `"content-type"` nor `"content-length"`
  present in the joined lower-case `headers` object.
- The 304 case makes the same three assertions at status `304`.
- The bytes-result case keeps its status and body assertions verbatim; `AgentResponse.body` is
  already the parsed envelope object, so the assertion compares it directly with the same
  deep-equal value.
- The `content-length` half of the 204 case and the 304 case cannot fail at level 1. No production
  module sets a response `content-length`, so the header reaches a client only when the node adapter
  writes it. Keep the assertion here; the `content-type` half keeps its teeth at level 1. The wire
  property has its own owner: the EPIC review addendum adds a 204 case and a 304 case to
  `src/http/server/app.handler-result.test.ts`, which asserts the absence over a real socket.

## Constraints

- Add exactly zero cases and remove exactly zero cases.
- Apply the same six level-2 exclusions that Story 4 names, plus `src/http/server/app.test.ts`,
  which this cycle's amendment adds as level-2 row 7.
- Do not edit group A, the completed group B, a direct handler test, production code, or a manifest.
- Both paths in each group-C file must use level 1 after this story.
- Do not add or change an assertion during migration, outside the authorized rawHeaders exception
  of `src/http/server/dispatch.test.ts` above, whose rewrite names the same expected values.

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
