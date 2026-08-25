# EPIC 031 - The fetch-native response model - stories

Epic: `.agents/plan/epics/031-fetch-native-response-model.md`
Prereq: EPIC 030 (sequence order).

Handlers declare JSON, byte, or empty results, and Koa receives each result through one explicit adapter.

## Dispatch order

Run Story 1 before Story 2. Story 2 depends on the bytewise helper and completes the EPIC Proof.

After Story 2, Ulrich applies `.agents/plan/pending/031-s1-eslint-node-buffer.md` before the final verification gate.

## Stories

- Story 1 - Replace all server byte comparisons with the Fetch-native helper -> `01-bytewise-helper-with-no-buffer.md`
- Story 2 - Introduce the result union and update every producer and consumer -> `02-result-union-and-all-producers-consumers.md`

## Facts (needed for implementation)

- EPIC 030 creates four parity files before this epic starts. See `.agents/plan/stories/030-transport-inventory-and-parity-contract/index.md:9-17`.
- The current tree has 44 handler factories: 43 JSON handlers and one blob handler. See `src/http/server/app.ts:38-46`.
- `src/http/server/blob/show-blob.ts:14-49` is the only byte-producing handler.
- `src/http/contract/registry.ts:248-252` rejects operations that declare both `response` and `responseMedia`.
- `src/http/contract/system.ts:177-186` declares `blob.show.responseMedia` as `application/octet-stream`.
- `src/http/server/idempotency.ts:131-147` captures the final Koa context, not `HandlerResult`.
- `src/http/server/dispatch.test.ts:415` uses status 201. Story 2 changes that fixture to allowed status 200.
- `src/http/server/project/read-project-status.ts:11-23` has no direct handler test. Typecheck and the inventory test cover its result shape.
- `scripts/lane-check.sh:47-49` blocks agent edits to `eslint.config.js`; Ulrich applies the staged rule.
