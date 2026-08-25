# EPIC 033 — Dual-level test harness — stories

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Prereq: EPIC 032 (sequence order).

The transport suite uses Hono Fetch by default and retains five named real-socket test files.

## Dispatch order

1. `01-pin-the-level-2-primitive.md` adds the ephemeral-port assertion.
2. `02-add-the-level-1-fetch-agent.md` adds the Fetch request builder and its contract tests.
3. `03-move-create-test-app-to-level-1.md` moves the shared factory and preserves one socket-backed twin.
4. `04-move-group-b-to-level-1.md` migrates direct socket callers without shared-factory calls.
5. `05-move-group-c-to-level-1.md` migrates direct socket callers that also use the shared factory.
6. `06-add-level-2-wire-cases.md` adds shutdown and duplicate `set-cookie` wire coverage.
7. `07-assert-the-socket-budget.md` freezes the five-file socket allow list and runs the full Proof.

Stories 1 and 2 are a coupled pair over `test/helpers/agent.test.ts`. Stories 2 and 3 are ordered by
the new `Agent` contract. Stories 4 and 5 depend on Story 3's level-1 factory. Story 7 runs last.

## Stories

- 1 — Pin the level-2 primitive with one ephemeral-port case -> `01-pin-the-level-2-primitive.md`
- 2 — Add `fetchAgent` and fourteen contract cases -> `02-add-the-level-1-fetch-agent.md`
- 3 — Move `createTestApp` to Fetch and add its socket twin -> `03-move-create-test-app-to-level-1.md`
- 4 — Move the recomputed group-B files to Fetch -> `04-move-group-b-to-level-1.md`
- 5 — Move the recomputed group-C files to Fetch -> `05-move-group-c-to-level-1.md`
- 6 — Add four real-wire cases -> `06-add-level-2-wire-cases.md`
- 7 — Assert the exact five-file socket budget -> `07-assert-the-socket-budget.md`

## Facts (needed for implementation)

- EPIC 032 must first make `createApp` return `{ app, hono, cancelWaits }` at
  `src/http/server/app.ts:App`.
- `test/helpers/agent.ts:loopbackServer` caches one unref'd server per Koa application in a `WeakMap`.
- `test/helpers/agent.ts:loopbackAgent` returns a Supertest agent over that cached server.
- `test/helpers/app.ts:createTestApp` currently routes every caller through `loopbackAgent(app)`.
- `src/http/server/blob/show-blob.test.ts:handlerApp` is the only socket-backed shared-factory caller.
- EPIC 032 can change groups B and C. Stories 4 and 5 recompute both groups before any edit.
- The closed level-2 set is `agent.test.ts`, `host.test.ts`, `idempotency.test.ts`,
  `show-blob.test.ts`, and `shutdown-socket.test.ts`.
- `src/main.claim.test.ts:599` names `createTestApp` inside a string. It reaches neither harness helper.
- The EPIC adds exactly 21 cases: 1, 14, 0, 0, 0, 4, and 2 by story order.
- No story edits a production file or a package manifest.
