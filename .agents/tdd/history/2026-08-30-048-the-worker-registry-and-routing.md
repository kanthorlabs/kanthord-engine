---
epic: .agents/plan/epics/048-the-worker-registry-and-routing.md
opened: 2026-08-30
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

## TEST-ENGINEER — the-worker-id-grammar · Story 1

**Cycle.** RED for Task `048/story-1` (`src/domain/worker-id.test.ts`).
**Test written.**

- file: `src/domain/worker-id.test.ts` (new) — suite: `src/domain/worker-id` — methods: three exact parse cases, six invalid-value cases, and `refuses every legacy worker kind`
- asserts: Valid ids return exact identities, invalid ids expose `worker-id-invalid`, and every legacy worker kind is refused.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/worker-id.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/worker-id.test.ts`
- stub probe: `src/domain/worker-id.ts` — clean
  **Open to Software Engineer.**
- `src/domain/worker-id.ts`: `WORKER_ID_PATTERN: RegExp`; `WorkerId`; `parseWorkerId(raw: string): WorkerId`; `WorkerIdError` with readonly code `"worker-id-invalid"`.

OPEN: OUT-OF-LANE — .agents/plan/stories/048-the-worker-registry-and-routing/01-the-worker-id-grammar.md — reconcile valid `general@1` and `tdd@1` cases with the requirement that every `workerKinds` member throws
ATTEMPT-FAILED: 048/story-1 — Story 1 requires `general@1` and `tdd@1` both to parse and to throw through `workerKinds`.

END: TEST-ENGINEER

## HUMAN — Ulrich · blocker B1 resolved

**Cause.** Story 1 mis-transcribed the EPIC. EPIC 048 line 86 requires `workerKinds` and `workerRegistry` to share no member. Story 1 wrote that every `workerKinds` member fails `parseWorkerId`. The two claims are different, and only the EPIC's claim is true: `workerKinds` holds `general@1` and `tdd@1` (`src/domain/worker.ts:4-5`), which are valid grammar.

**Amendment.** No EPIC change.

- `01-the-worker-id-grammar.md`: deleted the `workerKinds` assertion from `## Verify`. Story 1 keeps the `claude.swe@1` refusal, which is the EPIC-041 proof the Verification Gate names.
- `02-the-registry.md`: added to `## Verify` — import `workerKinds` from `./worker.ts` and assert no registry id appears in it. Story 2 already imports both modules, so each story stays independently green.
- `src/domain/worker-id.test.ts`: removed the `refuses every legacy worker kind` case and the now-unused `workerKinds` import. The rest of the RED test is unchanged.

**Lane restored.** Story 1 RED stands. Software-engineer takes `src/domain/worker-id.ts`.

END: HUMAN

## SOFTWARE-ENGINEER — the-worker-id-grammar · Parse worker identities

**Cycle.** GREEN+REFACTOR for `src/domain/worker-id.test.ts`.
**Files changed.**

- `src/domain/worker-id.ts` (new) — `WORKER_ID_PATTERN`, `WorkerId`, `WorkerIdError`, and `parseWorkerId(raw)`
  **Seam (GREEN).** `parseWorkerId` returns exact identities and rejects malformed or unsafe worker ids with `worker-id-invalid`.
  **Refactor.** No named refactor in Story 1.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 1 requires a split, numeric conversion, and an explicit maximum-safe-integer check.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-registry · Story 2

**Cycle.** Confirmed GREEN for Story 1, then RED for Task `048/story-2` (`src/domain/worker-registry.test.ts`).
**Test written.**

- file: `src/domain/worker-registry.test.ts` (new) — suite: `src/domain/worker-registry` — methods: `holds every worker field in routing order`, `describes both workers as self-managed external harnesses with no agents`, `declares neither expansion deliverables nor initiative claims`, `keeps the closed composition set`, `uses valid worker ids outside the legacy worker kinds`
- asserts: The exact ordered registry exposes valid new identities, external harness metadata, closed compositions, and no deferred capabilities or legacy overlap.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/worker-registry.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/worker-registry.test.ts`
- stub probe: `src/domain/worker-registry.ts` — clean
  **Open to Software Engineer.**
- `src/domain/worker-registry.ts`: `Composition`; `compositions: readonly ["single", "composed", "self-managed"]`; `WorkerEntry`; `workerRegistry: readonly [WorkerEntry, WorkerEntry]`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-registry · Declare routed workers

**Cycle.** GREEN+REFACTOR for `src/domain/worker-registry.test.ts`.
**Files changed.**

- `src/domain/worker-registry.ts` (new) — `Composition`, `compositions`, `WorkerEntry`, and `workerRegistry`
  **Seam (GREEN).** `workerRegistry` exposes both external workers and every field in the required routing order.
  **Refactor.** No named refactor in Story 2.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 2 defines exact registry values and requires no worker-id import.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — routing · Story 3

**Cycle.** Confirmed GREEN for Story 2, then RED for Task `048/story-3` (`src/domain/worker-routing.test.ts`).
**Test written.**

- file: `src/domain/worker-routing.test.ts` (new) — suite: `src/domain/worker-routing` — methods: `finds capable workers in registry order`, `finds no capable worker for deferred expansion work`, `names capable when no worker supports the work`, `names authorized when no capable worker is authorized`, `names available when no authorized worker is available`, `routes to the earliest eligible worker by registry order`, `routes to a later worker when the earlier worker is not authorized`, `routes supported objective work`, and four validation refusal cases
- asserts: Routing preserves registry order, identifies the first failed set, selects an eligible worker, and exposes each validation error code.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/worker-routing.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/worker-routing.test.ts`
- stub probe: `src/domain/worker-routing.ts` — clean
  **Open to Software Engineer.**
- `src/domain/worker-routing.ts`: `WorkerRoutingError` with readonly validation code; `capableWorkers(registry: typeof workerRegistry, input: { kind: string; deliverable: string }): readonly string[]`; `routeWorker(input: { registry: typeof workerRegistry; kind: string; deliverable: string; authorized: readonly string[]; available: readonly string[] }): { routed: true; worker: WorkerEntry } | { routed: false; refusal: "unroutable"; failedSet: "capable" | "authorized" | "available" }`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — routing · Select an eligible worker

**Cycle.** GREEN+REFACTOR for `src/domain/worker-routing.test.ts`.
**Files changed.**

- `src/domain/worker-routing.ts` (new) — `WorkerRoutingError`, `capableWorkers`, and `routeWorker`
  **Seam (GREEN).** Routing validates all worker sets, names the first empty intersection, and preserves registry-order selection.
  **Refactor.** No named refactor in Story 3.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 3 fixes validation precedence and requires registry-order filtering.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-composition-lint · Story 4 blocked RED

**Cycle.** Confirmed GREEN for Story 3, then attempted RED for Task `048/story-4` (`src/domain/worker-registry-lint.test.ts`).
**Test written.**

- file: `src/domain/worker-registry-lint.test.ts` (new) — suite: `src/domain/worker-registry-lint` — methods: `reports a direct composition member read`, `reports a bracket composition member read`, `permits a different metadata member read`, `does not absorb the independent node write restriction`
- asserts: The inline lint rule reports both composition reads and ignores unrelated metadata and node-write source.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `message: 'Parsing error: Unexpected token INTO'`
- typecheck: `pnpm run typecheck` — exit 0
  **Open to Software Engineer.**
- None. The required production path is locked to both engineer lanes.

OPEN: OUT-OF-LANE — .agents/plan/stories/048-the-worker-registry-and-routing/04-the-composition-lint.md — reconcile the required empty result for `INSERT INTO node VALUES (1);` with ESLint parsing that source as invalid JavaScript
OPEN: OUT-OF-LANE — eslint.config.js — add the Story 4 composition restriction block after the existing node-write restriction
ATTEMPT-FAILED: 048/story-4 — the planned assertion fails on ESLint's fatal parse message, and the required config path is locked

END: TEST-ENGINEER

## HUMAN — the-composition-lint · Story 4 unblocked

**Resolved.** Both OUT-OF-LANE items are closed. Story 4 is GREEN.
**Files changed.**

- `eslint.config.js` — three `no-restricted-syntax` blocks replace one; `compositionExemptions`, `compositionSelectors` and `nodeEdgeWriteSelectors` are named constants
- `.agents/plan/stories/048-the-worker-registry-and-routing/04-the-composition-lint.md` — amended: the three-block structure, and a valid JavaScript node write fixture
- `src/domain/worker-registry-lint.test.ts` — the fourth assertion verifies `const q = "INSERT INTO node VALUES (1);";`, built by concatenation
  **Defect found in the original story.** For one rule name the last matching flat-config block wins. The planned single extra block disabled the node/edge write restriction for every non-exempt `src/` file. The three-block structure keeps both restrictions.
  **Proof.**
- `pnpm run lint` — exit 0
- `pnpm run typecheck` — exit 0
- `pnpm test` — 5795 pass, 0 fail
- config probe: a non-exempt file reports `no-restricted-syntax` for a node write and for both composition reads; `src/domain/worker-registry.ts` reports the node write only; `src/services/plan/sqlite.ts` reports the composition read only

END: HUMAN

## SOFTWARE-ENGINEER — the-composition-lint · Await the next RED cycle

**Cycle.** No implementation action follows the latest HUMAN turn, which marks Story 4 GREEN.
**Files changed.**

- None.
  **Seam (GREEN).** The HUMAN turn closed the latest TEST-ENGINEER handoff without an unresolved production seam.
  **Refactor.** Not applicable.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The discussion ends with Story 4 GREEN; no later TEST-ENGINEER turn selects Story 5.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-health-interface · Story 5

**Cycle.** Confirmed GREEN for Story 4, then RED for Task `048/story-5` (`src/services/worker-health/not-implemented.test.ts`).
**Test written.**

- file: `src/services/worker-health/not-implemented.test.ts` (new) — suite: `src/services/worker-health/not-implemented` — methods: `throws the not-implemented worker health error synchronously`
- file: `src/domain/layout.test.ts` (edited) — suite: `src/domain/layout` — methods: `src/services/ holds exactly the twenty-one capabilities plus home-lock`, `agent, verify, lease and worker-health each hold a not-implemented.ts`
- asserts: The health check throws synchronously with the required error type and code, while the capability follows the service layout.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/services/worker-health/index.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/services/worker-health/not-implemented.test.ts`
- stub probe: `src/services/worker-health/index.ts` — clean
- stub probe: `src/services/worker-health/not-implemented.ts` — clean
  **Open to Software Engineer.**
- `src/services/worker-health/index.ts`: `WorkerInstance`; `WorkerHealthErrorCode`; `WorkerHealthError(code: WorkerHealthErrorCode, message: string)` with readonly `code`; `WorkerHealth.check(instance: WorkerInstance): Promise<{ available: boolean; reason: string | null }>`.
- `src/services/worker-health/not-implemented.ts`: `NotImplementedWorkerHealth` implementing `WorkerHealth`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-health-interface · Define worker health capability

**Cycle.** GREEN+REFACTOR for `src/services/worker-health/not-implemented.test.ts`.
**Files changed.**

- `src/services/worker-health/index.ts` (new) — `WorkerInstance`, `WorkerHealthError`, and `WorkerHealth`
- `src/services/worker-health/not-implemented.ts` (new) — `NotImplementedWorkerHealth.check(instance)`
  **Seam (GREEN).** The capability defines per-instance health checks and a synchronous not-implemented refusal with the required code.
  **Refactor.** No named refactor in Story 5.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 5 requires the service interface and implementation to mirror the existing agent capability structure.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-agent-role-contracts · Story 6

**Cycle.** Confirmed GREEN for Story 5, then RED for Task `048/story-6` (`src/domain/agent-contract.test.ts`).
**Test written.**

- file: `src/domain/agent-contract.test.ts` (new) — suite: `src/domain/agent-contract` — methods: `holds the closed tool whitelist in contract order`, `declares all four role contracts with exact tool whitelists`, `omits edit and write from the review role`, `gives general, software and test roles equal tool sets`, `leaves role path ownership unrepresented`, `keeps role contracts independent from the worker registry`
- asserts: The four contracts expose exact purposes and tool whitelists, omit path ownership, and reference no registered worker agent.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/agent-contract.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/agent-contract.test.ts`
- stub probe: `src/domain/agent-contract.ts` — clean
  **Open to Software Engineer.**
- `src/domain/agent-contract.ts`: `tools: readonly ["read", "bash", "edit", "write", "grep", "find", "ls"]`; `AgentContract`; `agentContracts: Readonly<Record<string, AgentContract>>` with entries for `general@1`, `swe@1`, `te@1`, and `re@1`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-agent-role-contracts · Declare tool whitelists

**Cycle.** GREEN+REFACTOR for `src/domain/agent-contract.test.ts`.
**Files changed.**

- `src/domain/agent-contract.ts` (new) — `tools`, `AgentContract`, and `agentContracts`
  **Seam (GREEN).** The registry declares all four role contracts with exact purposes and closed tool whitelists.
  **Refactor.** No named refactor in Story 6.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 6 requires compile-time completeness against `agentKinds` without worker registry coupling.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-harness-set-and-contract-generator · Story 7

**Cycle.** Confirmed GREEN for Story 6, then RED for Task `048/story-7` (`src/domain/agent-contract-render.test.ts`).
**Test written.**

- file: `src/domain/agent-contract-render.test.ts` (new) — suite: `src/domain/agent-contract-render` — methods: `holds the closed harness descriptors in lookup order`, eight `renders <agent> byte-identically for <harness>` cases, `refuses a harness that cannot deny tools by default`, `refuses an unknown harness`
- files: `test/fixtures/agent-contract/{claude-code,opencode}/{general@1,swe@1,te@1,re@1}.md` (new) — eight golden contract documents
- asserts: Each deny-by-default harness renders exact fixture bytes, while `pi` and an unknown harness expose the required error codes.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/agent-contract-render.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/048-the-worker-registry-and-routing/src/domain/agent-contract-render.test.ts`
- stub probe: `src/domain/agent-contract-render.ts` — clean
- stub probe: `src/domain/harness.ts` — clean
  **Open to Software Engineer.**
- `src/domain/harness.ts`: `HarnessDescriptor`; `harnesses: readonly [HarnessDescriptor, HarnessDescriptor, HarnessDescriptor]`.
- `src/domain/agent-contract-render.ts`: `AgentContractErrorCode`; `AgentContractError(code: AgentContractErrorCode, message: string)` with readonly `code`; `renderAgentContract(contract: AgentContract, harnessId: string): string`.

END: TEST-ENGINEER
