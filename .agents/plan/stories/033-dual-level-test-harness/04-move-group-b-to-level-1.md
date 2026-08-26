# Story 4 — Move group B to level 1

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: Story 3.

## Change

- Before editing, run both inventory commands from the EPIC gate:

```bash
grep -rlE 'loopback(Agent|Server)' --include='*.test.ts' src test
grep -rl createTestApp --include='*.test.ts' src test
```

- Define group B as direct `loopbackAgent` importers without a `createTestApp` call.
- Exclude the six level-2 paths listed in this story's Constraints.
- Apply the edit to each resulting group-B file. Do not edit an EPIC row absent from the result.
- The pre-EPIC-032 candidates are `auth.test.ts`, `envelope.test.ts`, `idempotency-key.test.ts`,
  `idempotency-response.test.ts`, `origin.test.ts`, and `preflight.test.ts` under `src/http/server/`.
- At each helper import, replace `loopbackAgent` with `fetchAgent`.
- At each direct call, remove only the await that resolved `loopbackAgent`.
- Keep the await that resolves the request response.
- Pass a direct `Hono` application to `fetchAgent` when the file constructs one.
- If the file calls `createApp`, pass that result's `hono` field to `fetchAgent`.
- In `src/http/server/preflight.test.ts:answerOf`, replace a remaining `request.Response` with `AgentResponse`.
- Replace its `supertest` type import with an `AgentResponse` import from `test/helpers/agent.ts`.
- If EPIC 032 already removed that annotation, make no replacement.
- Keep every suite name, case name, request, status, header assertion, and body assertion
  unchanged, outside the authorized probe exception below.

### `src/http/server/idempotency-key.test.ts` — the authorized probe exception

The `raw body preservation` block builds its own `Koa` application around `@koa/bodyparser`, so no
import swap can move it: `fetchAgent` takes a `Hono` application. EPIC 010.6 built the block as a
vendor probe because `@koa/bodyparser` hard-coded `rawBody` and exposed no option. The product now
owns that behaviour in `src/http/server/body.ts`, and koa leaves the tree in EPIC 035, so the probe
follows the behaviour rather than the vendor.

- Rebuild the `probeApp` fixture as a `Hono<AppEnv>` application that sets a `match` variable, then
  runs `bodyMiddleware(handlers)`, then answers with `optional(c, "rawBody") ?? null`.
- Rename the block from `raw body preservation (vendor probe)` to
  `raw body preservation (body middleware probe)`. It probes no vendor after this edit.
- Keep all three case names, all three requests and all three assertions byte for byte.
- Add no case and remove no case. The block stays at 3.

## Constraints

- Add exactly zero cases and remove exactly zero cases.
- The level-2 exclusions are `test/helpers/agent.test.ts`, `src/http/server/host.test.ts`,
  `src/http/server/idempotency.test.ts`, `src/http/server/blob/show-blob.test.ts`,
  `src/http/server/shutdown-socket.test.ts`, and `src/http/server/app.handler-result.test.ts`.
- Do not edit group A, group C, a direct handler test, production code, or a package manifest.
- Do not retain `loopbackAgent` in any recomputed group-B import statement.
- Do not add or change an assertion during migration.

## Verify

- Run the group-B suite:

```bash
node --test \
  src/http/server/auth.test.ts \
  src/http/server/envelope.test.ts \
  src/http/server/idempotency-key.test.ts \
  src/http/server/idempotency-response.test.ts \
  src/http/server/origin.test.ts \
  src/http/server/preflight.test.ts
```

- Every present candidate passes with its pre-story case count.
- Re-run the two inventory commands. No recomputed group-B file names `loopbackAgent`.
- Run `npm run verify`; it exits 0 with no pass-count change from Story 3.
- Proof: delivers the `auth`, `envelope`, `idempotency-key`, `idempotency-response`, `origin`, and
  `preflight` lines when those files remain in group B after EPIC 032.
- Proof: preserves every EPIC 030 parity assertion in those files.
