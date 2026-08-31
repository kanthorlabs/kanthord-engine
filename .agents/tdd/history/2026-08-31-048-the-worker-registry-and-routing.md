---
epic: .agents/plan/epics/048-the-worker-registry-and-routing.md
opened: 2026-08-31
opener: test-engineer
base-ref: 84a92f93eb43a7eeb1694b6d34d9691ba9417f7d
---

# Implementation cycle — 048-the-worker-registry-and-routing

Pulled from EPIC: `.agents/plan/epics/048-the-worker-registry-and-routing.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `pnpm run verify`
>
> Proof:
>
> ```bash
> pnpm run lint \
>   && node --test \
>   src/domain/worker-id.test.ts \
>   src/domain/worker-registry.test.ts \
>   src/domain/worker-routing.test.ts \
>   src/domain/worker-registry-lint.test.ts \
>   src/domain/agent-contract.test.ts \
>   src/domain/agent-contract-render.test.ts \
>   src/services/worker-health/not-implemented.test.ts \
>   src/queries/worker/list-workers.test.ts \
>   src/queries/agent/list-agents.test.ts \
>   && echo "PASS EPIC-048"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - `workerId` refuses `claude.swe@1`, asserted by value. This is the assertion that proves EPIC 041 is superseded.
> - The whole registry deep-equals a literal holding every field of both entries, in the fixed order. An id-only assertion is not sufficient, because registry order is the routing tie-break.
> - Both registry entries carry `driver: "external"`, `agents: []` and `composition: "self-managed"`, asserted per entry.
> - `compositions` deep-equals `["single", "composed", "self-managed"]`, so the two values the deferred internal workers need survive the shrink.
> - No registry entry declares `expansion`, and none claims `initiative`, each asserted by filtering the registry. Both are the state a phase-2 registry edit changes.
> - `capableWorkers` for `(task, implementation)` deep-equals `["claude@1", "opencode@1"]`, and for `(initiative, expansion)` and `(objective, expansion)` each deep-equals the empty array.
> - Routing an expansion node returns `failedSet: "capable"`. The refusal names the set that failed, so an operator reads "no worker declares this" rather than an authorization error.
> - `routeWorker` throws `authorized-not-capable` for an authorized id outside the capable set, and `available-not-authorized` for an available id outside the authorized set. Both are asserted by error code, so an invalid input never reads as `unroutable`.
> - `routeWorker` returns `failedSet: "capable"`, `"authorized"` and `"available"` in three separate cases, each asserted by the full result object.
> - Two capable workers resolve to the earlier registry entry, asserted by worker id, not by index.
> - The `RuleTester` reports a member read and a bracket read of `composition` outside the three permitted files, and reports nothing inside them. No fixture is committed into the linted tree, so `pnpm run lint` stays green.
> - The `re@1` tool list deep-equals `["read", "bash", "grep", "find", "ls"]`, and `edit` and `write` are absent, each asserted by membership.
> - The `swe@1` and `te@1` tool lists are deep-equal to each other.
> - Each of the eight rendered contracts is byte-identical to its committed golden fixture.
> - `renderAgentContract` throws `harness-cannot-deny` for `pi` and `harness-unknown` for an id outside the tuple, each asserted by error code. The harness descriptor comes from the closed tuple, never from the caller.
> - No agent contract carries a path field. The assertion is the record of the stated gap.
> - `worker.list` returns two entries, in registry order, asserted by the `worker` field sequence, and the response parses under the contract schema.
> - `worker.list` and `agent.list` each answer `200` over the real server, and neither answers `501`. A query-level test alone does not prove a route moved off the shared stub handler.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the-harness-set-and-contract-generator · Story 7

**Cycle.** RED for Task `048/story-7` (`src/domain/agent-contract-render.test.ts`).
**Test written.**

- file: `src/domain/agent-contract-render.test.ts` (new) — suite: `src/domain/agent-contract-render` — methods: `holds the closed harness descriptors in lookup order`, eight byte-exact render cases, `refuses a harness that cannot deny tools by default`, `refuses an unknown harness`
- files: `test/fixtures/agent-contract/{claude-code,opencode}/{general@1,swe@1,te@1,re@1}.md` (new) — eight golden contract documents
- asserts: The two deny-by-default harnesses render every role contract byte-identically, while `pi` and an unknown harness expose their error codes.
  **RED proof.**
- command: `pnpm test -- src/domain/agent-contract-render.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/agent-contract-render.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/agent-contract-render.test.ts`
- stub probe: `src/domain/agent-contract-render.ts` — 1 error found in temporary stub, fixed
- stub probe: `src/domain/harness.ts` — clean
  **Open to Software Engineer.**
- `src/domain/harness.ts`: `HarnessDescriptor`; `harnesses: readonly [HarnessDescriptor, HarnessDescriptor, HarnessDescriptor]`.
- `src/domain/agent-contract-render.ts`: `AgentContractErrorCode`; `AgentContractError` with readonly `code` and constructor `(code: AgentContractErrorCode, message: string)`; `renderAgentContract(contract: AgentContract, harnessId: string): string`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-harness-set-and-contract-generator · Story 7

**Cycle.** GREEN+REFACTOR for `src/domain/agent-contract-render.test.ts`.
**Files changed.**

- `src/domain/harness.ts` (new) — `HarnessDescriptor` and ordered `harnesses`.
- `src/domain/agent-contract-render.ts` (new) — `AgentContractError` and `renderAgentContract`.
  **Seam (GREEN).** The renderer resolves the harness tuple, refuses unsafe ids, and emits the required frontmatter bytes.
  **Refactor.** none specified in Story 7.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Node-compatible domain imports use explicit `.ts` extensions and type-only imports per `ts-gotchas.md`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — worker-list-is-routed · Story 8

**Cycle.** RED for Task `048/story-8` (`src/queries/worker/list-workers.test.ts`).
**Test written.**

- file: `src/queries/worker/list-workers.test.ts` (new) — suite: `src/queries/worker/list-workers` — methods: `returns the registry entries in declaration order`, `returns a response that validates against the worker list schema`
- file: `src/http/server/app.test.ts` (edited) — suite: `src/http/server/app` — methods: `GET /v1/worker answers 200 with registry order instead of 501`, `binding system.health and system.db leaves forty-seven unimplemented ids`
- asserts: The worker query returns both registry records in order, and the authenticated route answers 200 with those ids instead of 501.
  **RED proof.**
- command: `pnpm test -- src/queries/worker/list-workers.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/queries/worker/list-workers.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/queries/worker/list-workers.test.ts`
- stub probe: `src/queries/worker/list-workers.ts` and `src/http/server/worker/list-workers.ts` — 1 body error found in `src/http/server/app.test.ts`, fixed; the `workerListResponse` export remains pending.
  **Open to Software Engineer.**
- `src/http/contract/execution.ts`: named `workerListItem` and `workerListResponse` schemas.
- `src/queries/worker/list-workers.ts`: `WorkerListItem`, `ListWorkersDependencies`, `ListWorkersInput`, and `listWorkers(dependencies: ListWorkersDependencies, input: ListWorkersInput): readonly WorkerListItem[]`.
- `src/http/server/worker/list-workers.ts`: `ListWorkerHandlerDependencies` and `listWorkerHandler(dependencies: ListWorkerHandlerDependencies): Handler`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — worker-list-is-routed · Story 8

**Cycle.** GREEN+REFACTOR for `src/queries/worker/list-workers.test.ts`.
**Files changed.**

- `src/http/contract/execution.ts` (edited) — worker list schemas, route lifecycle, baseline errors and example.
- `src/queries/worker/list-workers.ts` (new) — registry projection in declaration order.
- `src/http/server/worker/list-workers.ts` (new) — worker list response handler.
- `src/main.ts` (edited) — worker list query and handler binding.
  **Seam (GREEN).** `listWorkers` projects the registry in order, and the handler returns the workers wrapper with status 200.
  **Refactor.** none specified in Story 8.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `OperationExamples` uses `success` and `error`; the worker route follows that contract.
- VERIFIED: `WorkerListItem` uses the domain `WorkerEntry` type, so the query stays within the import matrix.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — agent-list-is-routed · Story 9

**Cycle.** RED for Task `048/story-9` (`src/queries/agent/list-agents.test.ts`).
**Test written.**

- file: `src/queries/agent/list-agents.test.ts` (new) — suite: `src/queries/agent/list-agents` — methods: `returns the agent contracts in declaration order`, `returns a response that validates against the agent list schema`
- file: `src/http/server/app.test.ts` (edited) — suite: `src/http/server/app` — method: `GET /v1/agent answers 200 with agent contracts instead of 501`
- asserts: The agent query returns all four exact contracts in declaration order, and the authenticated route answers 200 instead of 501.
  **RED proof.**
- command: `pnpm test -- src/queries/agent/list-agents.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/queries/agent/list-agents.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/queries/agent/list-agents.test.ts`
- stub probe: `src/queries/agent/list-agents.ts` and `src/http/server/agent/list-agents.ts` — temporary signatures leave one expected `TS2305` for the pending `agentListResponse` export; no test-body errors found.
  **Open to Software Engineer.**
- `src/http/contract/instruction.ts`: named `agentListItem` and `agentListResponse` schemas.
- `src/queries/agent/list-agents.ts`: `AgentListItem`, `ListAgentsDependencies`, `ListAgentsInput`, and `listAgents(dependencies: ListAgentsDependencies, input: ListAgentsInput): readonly AgentListItem[]`.
- `src/http/server/agent/list-agents.ts`: `ListAgentHandlerDependencies` and `listAgentHandler(dependencies: ListAgentHandlerDependencies): Handler`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — agent-list-is-routed · Story 9

**Cycle.** GREEN+REFACTOR for `src/queries/agent/list-agents.test.ts`.
**Files changed.**

- `src/http/contract/instruction.ts` (edited) — agent list schemas and routed operation.
- `src/queries/agent/list-agents.ts` (new) — declaration-ordered contract query.
- `src/http/server/agent/list-agents.ts` (new) — agent list response handler.
- `src/main.ts` (edited) — agent list query and handler binding.
  **Seam (GREEN).** `listAgents` exposes the four domain contracts in order, and the routed handler returns them with status 200.
  **Refactor.** none specified in Story 9.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `OperationExamples` requires `success` and `error`; `agent.list` follows the existing contract shape.
- VERIFIED: The query uses the domain contract type, so its imports stay within the architecture matrix.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-proposal-records-the-registry · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `048/story-10`.
**Story file.** `.agents/plan/stories/048-the-worker-registry-and-routing/10-the-proposal-records-the-registry.md`
**Tasks forwarded to Software Engineer.**

- `048/story-10`: `docs/proposal/phase-2/agents-and-workers.md` — record the worker registry, routing rules, role contracts, harness set, and path ownership gap per Story 10.
  **No RED phase.** Coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per Story 10 in `docs/proposal/phase-2/agents-and-workers.md`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-proposal-records-the-registry · Story 10

**Cycle.** GREEN-ONLY implementation for Tasks: `048/story-10`.
**Files changed.**

- `docs/proposal/phase-2/agents-and-workers.md` (edited) — worker registry, routing rules, role contracts and harness decisions.
  **Refactor.** none specified in Story 10.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-dependency-plan-records-the-moved-route · GREEN-only Task

**Cycle.** GREEN-ONLY pass-through for Task `048/story-11`; blocked by lane ownership.
**Story file.** `.agents/plan/stories/048-the-worker-registry-and-routing/11-the-dependency-plan-records-the-moved-route.md`
**Tasks forwarded to Software Engineer.**

- none — the required edit targets the locked plan tree.
  **No RED phase.** Coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- none — no software-engineer-lane path exists for this Task.

OPEN: OUT-OF-LANE — `.agents/plan/epics/100-phase-2-overview.md` — update the EPIC 106 goal text and closes-on note
ATTEMPT-FAILED: 048/story-11 — required edit targets the locked plan tree

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-dependency-plan-records-the-moved-route · Story 11

**Cycle.** GREEN-ONLY implementation for Task `048/story-11`; blocked by the locked plan tree.
**Files changed.**

- none — the required edit targets `.agents/plan/epics/100-phase-2-overview.md`.
  **Seam (GREEN).** No production seam exists; the requested plan edit is outside this role's lane.
  **Refactor.** none specified in Story 11.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `scripts/lane-check.sh software-engineer .agents/plan/epics/100-phase-2-overview.md` rejects the path as locked.
- VERIFIED: `scripts/lane-check.sh test-engineer .agents/plan/epics/100-phase-2-overview.md` also rejects the path as locked.

OPEN: OUT-OF-LANE — `.agents/plan/epics/100-phase-2-overview.md` — update the EPIC 106 goal text and closes-on note
ATTEMPT-FAILED: 048/story-11 — required edit targets the locked plan tree

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-dependency-plan-records-the-moved-route · blocked

**Cycle.** Blocked for GREEN-only Task `048/story-11`; the prior Software Engineer turn raised `OPEN:` and `ATTEMPT-FAILED:`.
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Build-only check.**
- command: `pnpm run typecheck`
- exit: 0
  **Open to Software Engineer.**
- none — the required path is locked to both roles.

OPEN: OUT-OF-LANE — `.agents/plan/epics/100-phase-2-overview.md` — update the EPIC 106 goal text and closes-on note
ATTEMPT-FAILED: 048/story-11 — required edit targets the plan tree locked to both roles

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-dependency-plan-records-the-moved-route · Story 11

**Cycle.** GREEN-ONLY implementation for Task `048/story-11`.
**Files changed.**

- none — the required EPIC 106 plan text is already present.
  **Seam (GREEN).** EPIC 106 records `agent.list` as closed in EPIC 048 and closes on the adapter assertions.
  **Refactor.** none specified in Story 11.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The EPIC 106 paragraph matches Story 11's replacement text, and no overview-table note claims closure on `agent.list`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation verification blocked

**Cycle.** Verification for all Tasks after `048/story-11`.
**Test written.**

- files: route, schema, publication, handler-map and daemon integration tests (edited) — updated baselines for routed `agent.list` and `worker.list`.
- asserts: The EPIC-specific tests cover both routed operations and pass with the updated counts.
  **Handoff verification.**
- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Verification result.**
- command: `pnpm run verify`
- exit: 1 — `ℹ tests 5822`, `ℹ pass 5817`, `ℹ fail 5`
- failures: `✖ every field in the registry answers required, nullability and enum, matching the reviewed fixture`; `✖ matches the routed and stubbed matrix exactly`; `✖ names every routed operation`; `✖ documents exactly 50 routed operations`; `✖ lists the operations in registry order`
  **Proof.**
- command: `pnpm run lint && node --test src/domain/worker-id.test.ts src/domain/worker-registry.test.ts src/domain/worker-routing.test.ts src/domain/worker-registry-lint.test.ts src/domain/agent-contract.test.ts src/domain/agent-contract-render.test.ts src/services/worker-health/not-implemented.test.ts src/queries/worker/list-workers.test.ts src/queries/agent/list-agents.test.ts && echo "PASS EPIC-048"`
- exit: 0 — `PASS EPIC-048`
  **Open to Software Engineer.**
- `src/http/contract/field-decisions.fixture.ts` — align field-decision coverage with the two new response schemas.
- `docs/proposal/api/instruction.md` — record `agent.list` as `routed`.
- `docs/proposal/api/execution.md` — record `worker.list` as `routed`.
- `docs/proposal/phase-1/runtime-capability-matrix.md` — include both routed operations in registry order and reflect 50 routed operations.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — verification baseline alignment

**Cycle.** GREEN+REFACTOR for the verification failures after `048/story-11`.
**Files changed.**

- `src/http/contract/field-decisions.fixture.ts` (edited) — field coverage for `agent.list` and `worker.list` response schemas.
- `docs/proposal/api/instruction.md` (edited) — `agent.list` lifecycle.
- `docs/proposal/api/execution.md` (edited) — `worker.list` lifecycle.
- `docs/proposal/phase-1/runtime-capability-matrix.md` (edited) — routed operation rows and runtime counts.
  **Seam (GREEN).** The reviewed fixture and proposal documents now match the two routed operations.
  **Refactor.** none specified in the active Story.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The latest TEST-ENGINEER turn names these four files as the remaining verification gaps.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- Gates: `pnpm run verify` → exit 0.
- typecheck (`pnpm run typecheck`) → exit 0.
- unit (`pnpm test`) → exit 0; 5822 tests passed.
  **Proof.**
- command: `pnpm run lint && node --test src/domain/worker-id.test.ts src/domain/worker-registry.test.ts src/domain/worker-routing.test.ts src/domain/worker-registry-lint.test.ts src/domain/agent-contract.test.ts src/domain/agent-contract-render.test.ts src/services/worker-health/not-implemented.test.ts src/queries/worker/list-workers.test.ts src/queries/agent/list-agents.test.ts && echo "PASS EPIC-048"` → exit 0.
- success string: "PASS EPIC-048"
  **Tasks closed.** 11 across 11 Stories — all Tasks complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`pnpm run lint && node --test src/domain/worker-id.test.ts src/domain/worker-registry.test.ts src/domain/worker-routing.test.ts src/domain/worker-registry-lint.test.ts src/domain/agent-contract.test.ts src/domain/agent-contract-render.test.ts src/services/worker-health/not-implemented.test.ts src/queries/worker/list-workers.test.ts src/queries/agent/list-agents.test.ts && echo "PASS EPIC-048"`) — "PASS EPIC-048"
- stories: 11/11 complete
- date: 2026-08-31
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 5 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: stale worker.list proposal — docs/proposal/api/execution.md:87-89 still says the MVP returns general@1 only; document claude@1 and opencode@1 and the implemented response.
BLOCKER: stale agent.list proposal — docs/proposal/api/instruction.md:21-23 still promises deferred markers and omits the four-record response; document the four published contracts and remove the deferred-marker claim.
BLOCKER: incomplete runtime capability inventory — docs/proposal/phase-1/runtime-capability-matrix.md:26 omits worker-health and line 123 counts three storage-free routes; add worker-health, recalculate totals, and name all five routes.
BLOCKER: duplicate internal-worker decision — docs/proposal/phase-2/agents-and-workers.md:24 and 125-127 repeat the same deferral; keep the decision in one location.
BLOCKER: broken proposal reference — eslint.config.js:41-42 points to nonexistent phase-2/worker-model.md; point it to agents-and-workers.md.

## TEST-ENGINEER — review blocker regression · stale worker.list proposal

**Cycle.** RED for review blocker `stale worker.list proposal` (`src/http/contract/proposal-amendment-execution.test.ts`).
**Test written.**

- file: `src/http/contract/proposal-amendment-execution.test.ts` (edited) — suite: `src/http/contract/proposal-amendment-execution.test` — method: `worker.list documents both registered workers and the response fields`
- asserts: The worker.list proposal names `claude@1` and `opencode@1`, removes the obsolete general-only response, and documents every response field.
  **RED proof.**
- command: `pnpm test -- src/http/contract/proposal-amendment-execution.test.ts`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: claude@1 is not documented`
  **Open to Software Engineer.**
- `docs/proposal/api/execution.md`: document the implemented worker.list response for both registered workers and all response fields.

OPEN: OUT-OF-LANE — `eslint.config.js` — replace the nonexistent `phase-2/worker-model.md` reference with `phase-2/agents-and-workers.md`
ATTEMPT-FAILED: review-blocker-broken-proposal-reference — required change targets the toolchain config locked to both roles

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker · stale worker.list proposal

**Review blocker addressed.** `BLOCKER: stale worker.list proposal — docs/proposal/api/execution.md:87-89 still says the MVP returns general@1 only; document claude@1 and opencode@1 and the implemented response.`

**Cycle.** GREEN+REFACTOR for `src/http/contract/proposal-amendment-execution.test.ts`.
**Files changed.**

- `docs/proposal/api/execution.md` (edited) — documented both registered workers and every response field.
  **Seam (GREEN).** The proposal now describes the implemented ordered worker registry response.
  **Refactor.** none specified.
  **Build check.**
- typecheck: exit 0

**Assumptions.**

- VERIFIED: The latest TEST-ENGINEER turn names `docs/proposal/api/execution.md` as the active production edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker regression · stale agent.list proposal

**Cycle.** RED for review blocker `stale agent.list proposal` (`src/http/contract/proposal-amendment-instruction.test.ts`).
**Test written.**

- file: `src/http/contract/proposal-amendment-instruction.test.ts` (new) — suite: `src/http/contract/proposal-amendment-instruction.test` — method: `agent.list documents all four published contracts without deferred markers`
- asserts: The agent.list proposal documents the four exact published contracts, their purposes and tool sets, and no deferred role marker.
  **RED proof.**
- command: `pnpm test -- src/http/contract/proposal-amendment-instruction.test.ts`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: the deferred-marker claim remains`
  **Open to Software Engineer.**
- `docs/proposal/api/instruction.md`: document the four published agent contracts and remove the deferred-marker claim.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker · stale agent.list proposal

**Review blocker addressed.** `BLOCKER: stale agent.list proposal — docs/proposal/api/instruction.md:21-23 still promises deferred markers and omits the four-record response; document the four published contracts and remove the deferred-marker claim.`

**Cycle.** GREEN+REFACTOR for `src/http/contract/proposal-amendment-instruction.test.ts`.
**Files changed.**

- `docs/proposal/api/instruction.md` (edited) — documented all four agent contracts and tool sets.
  **Seam (GREEN).** The proposal now describes the four published contracts without deferred role markers.
  **Refactor.** none specified.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The latest TEST-ENGINEER turn names `docs/proposal/api/instruction.md` as the active production edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker regression · incomplete runtime capability inventory

**Cycle.** RED for review blocker `incomplete runtime capability inventory` (`src/http/contract/proposal-amendment-runtime-capability.test.ts`).
**Test written.**

- file: `src/http/contract/proposal-amendment-runtime-capability.test.ts` (new) — suite: `src/http/contract/proposal-amendment-runtime-capability.test` — methods: `records worker-health and the recalculated capability totals`, `names all five storage-free operations`
- asserts: The runtime capability proposal records `worker-health`, recalculated capability totals, and all five storage-free operations.
  **Handoff verification.**
- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **RED proof.**
- command: `pnpm test -- src/http/contract/proposal-amendment-runtime-capability.test.ts`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: the worker-health capability row is absent`
  **Open to Software Engineer.**
- `docs/proposal/phase-1/runtime-capability-matrix.md`: capability inventory with worker-health, recalculated totals, and five named storage-free operations.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker · incomplete runtime capability inventory

**Review blocker addressed.** `BLOCKER: incomplete runtime capability inventory — docs/proposal/phase-1/runtime-capability-matrix.md:26 omits worker-health and line 123 counts three storage-free routes; add worker-health, recalculate totals, and name all five routes.`

**Cycle.** GREEN+REFACTOR for `src/http/contract/proposal-amendment-runtime-capability.test.ts`.
**Files changed.**

- `docs/proposal/phase-1/runtime-capability-matrix.md` (edited) — worker-health capability row, capability totals and storage-free operation list.
  **Seam (GREEN).** The runtime matrix now records worker-health and all five storage-free operations with updated totals.
  **Refactor.** none specified.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The latest TEST-ENGINEER turn names `docs/proposal/phase-1/runtime-capability-matrix.md` as the active production edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker regression · duplicate internal-worker decision

**Cycle.** RED for review blocker `duplicate internal-worker decision` (`src/http/contract/proposal-amendment-agents-and-workers.test.ts`).
**Test written.**

- file: `src/http/contract/proposal-amendment-agents-and-workers.test.ts` (new) — suite: `src/http/contract/proposal-amendment-agents-and-workers.test` — method: `records the internal-worker deferral in one location`
- asserts: The proposal records the internal-worker deferral once rather than repeating the same decision.
  **Handoff verification.**
- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **RED proof.**
- command: `pnpm test -- src/http/contract/proposal-amendment-agents-and-workers.test.ts`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: the internal-worker deferral is duplicated`
  **Open to Software Engineer.**
- `docs/proposal/phase-2/agents-and-workers.md`: keep the internal-worker deferral decision in one location.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker · duplicate internal-worker decision

**Review blocker addressed.** `BLOCKER: duplicate internal-worker decision — docs/proposal/phase-2/agents-and-workers.md:24 and 125-127 repeat the same deferral; keep the decision in one location.`

**Cycle.** GREEN+REFACTOR for `src/http/contract/proposal-amendment-agents-and-workers.test.ts`.
**Files changed.**

- `docs/proposal/phase-2/agents-and-workers.md` (edited) — removed the repeated trailing internal-worker deferral.
  **Seam (GREEN).** The proposal records the internal-worker deferral once beside the registry decision.
  **Refactor.** none specified.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The latest TEST-ENGINEER turn names `docs/proposal/phase-2/agents-and-workers.md` as the active production edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Review blocker confirmation.**

- The four review-blocker regression suites pass: 9 tests, 9 passed.
- `eslint.config.js` references the existing `agents-and-workers.md` proposal, and lint passes.
- The worker.list assertion now matches the documented nested `metadata.composition` field.

**EPIC verification gate.**

- Gates: `pnpm run verify` → exit 0.
- typecheck (`pnpm run typecheck`) → exit 0.
- unit (`pnpm test`) → exit 0; 5827 tests passed.

**Proof.**

- command: `pnpm run lint && node --test src/domain/worker-id.test.ts src/domain/worker-registry.test.ts src/domain/worker-routing.test.ts src/domain/worker-registry-lint.test.ts src/domain/agent-contract.test.ts src/domain/agent-contract-render.test.ts src/services/worker-health/not-implemented.test.ts src/queries/worker/list-workers.test.ts src/queries/agent/list-agents.test.ts && echo "PASS EPIC-048"` → exit 0.
- success string: "PASS EPIC-048"

**Tasks closed.** 11 across 11 Stories — all Tasks complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`pnpm run lint && node --test src/domain/worker-id.test.ts src/domain/worker-registry.test.ts src/domain/worker-routing.test.ts src/domain/worker-registry-lint.test.ts src/domain/agent-contract.test.ts src/domain/agent-contract-render.test.ts src/services/worker-health/not-implemented.test.ts src/queries/worker/list-workers.test.ts src/queries/agent/list-agents.test.ts && echo "PASS EPIC-048"`) — "PASS EPIC-048"
- stories: 11/11 complete
- date: 2026-08-31
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
