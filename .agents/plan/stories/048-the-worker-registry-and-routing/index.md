# EPIC 048 — The worker registry and routing — stories

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Prereq: EPIC 047 (sequence order).

`worker.list` and `agent.list` move from stubbed to routed, backed by a pure routing function over a design-time registry of two external workers and four agent role contracts.

## Dispatch order

Stories 1–6 are independent of each other and may run in parallel. Story 7 depends on Story 6. Story 8 depends on Stories 2 and 4. Story 9 depends on Story 6. Story 10 depends on Stories 2, 6 and 7. Story 11 depends on Story 9. Stories 10 and 11 may run in parallel once their dependencies are satisfied.

Recommended parallel groups:

- **Group A (parallel):** Stories 1, 5, 6 — fully independent
- **Group B (parallel, after Group A):** Stories 2, 7, 9 — Story 2 depends on Story 1; Story 7 depends on Story 6; Story 9 depends on Story 6
- **Group C (parallel, after Group B):** Stories 3, 4 — both depend on Story 2
- **Group D:** Story 8 — depends on Stories 2 and 4 (after Group C)
- **Group E (parallel, after Group D):** Stories 10, 11 — Story 10 depends on Stories 2, 6, 7; Story 11 depends on Story 9

## Stories

- 1 — Worker id grammar → `01-the-worker-id-grammar.md`
- 2 — Registry (two external entries, compositions tuple) → `02-the-registry.md`
- 3 — Routing (capableWorkers, routeWorker, WorkerRoutingError) → `03-routing.md`
- 4 — Composition lint (no-restricted-syntax + RuleTester) → `04-the-composition-lint.md`
- 5 — Health interface (WorkerHealth, NotImplementedWorkerHealth) → `05-the-health-interface.md`
- 6 — Agent role contracts (tools tuple, four agentContracts entries) → `06-the-agent-role-contracts.md`
- 7 — Harness set and contract generator (harnesses tuple, renderAgentContract, eight golden fixtures) → `07-the-harness-set-and-contract-generator.md`
- 8 — `worker.list` routed (contract change, query, handler, main.ts binding) → `08-worker-list-is-routed.md`
- 9 — `agent.list` routed (contract change, query, handler, main.ts binding, app.test.ts fixup) → `09-agent-list-is-routed.md`
- 10 — Proposal document (agents-and-workers.md amended) → `10-the-proposal-records-the-registry.md`
- 11 — Dependency plan (100-phase-2-overview.md row 106 amended) → `11-the-dependency-plan-records-the-moved-route.md`

## Facts (needed for implementation)

- `src/domain/worker.ts:3-11` — `workerKinds` holds seven legacy strings including `"claude.swe@1"`. These share no member with valid worker ids. Story 1 asserts this.
- `src/domain/agent.ts:3` — `agentKinds = ["general@1", "swe@1", "te@1", "re@1"] as const`. Stories 6 and 9 iterate this tuple for output order.
- `src/services/agent/not-implemented.ts:1-16` — mirror template for `NotImplementedWorkerHealth`. The method discards the argument with `void`, then throws synchronously.
- `src/http/contract/instruction.ts:5-12` — `agent.list` is `"stubbed"` with no request or response schema. Story 9 adds both.
- `src/http/contract/execution.ts:239-245` — `worker.list` is `"stubbed"` with no request or response schema. Story 8 adds both.
- `eslint.config.js:421-436` — existing `no-restricted-syntax` block. Story 4 adds a second block after it; do not modify the existing one.
- `src/main.ts:382-677` — `handlers` object. Stories 8 and 9 each add one keyed entry.
- `src/http/server/app.test.ts:369` — uses `agent.list` as its canonical "stubbed" operationId example. Story 9 updates this line to a different stubbed entry after `agent.list` moves to `"routed"`.
- `test/fixtures/` does not exist. Story 7 creates `test/fixtures/agent-contract/<harness>/<agent>.md` (eight files). This is a greenfield directory.
- Agent purposes (from `docs/workflow/worker.md` section 3): `general@1` — "Does any task end to end."; `swe@1` — "Writes production code. Writes no test."; `te@1` — "Writes tests. Writes no production code."; `re@1` — "Reviews a diff against acceptance criteria."
- Tool capitalization for the harness output: `read→Read`, `bash→Bash`, `edit→Edit`, `write→Write`, `grep→Grep`, `find→Find`, `ls→LS`. Tools are listed comma-separated, in the tuple order of `capabilities.tools`.
- `src/queries/actor/list-actor.ts` — canonical query pattern: named export function, `Dependencies` and `Input` typed as `Readonly<{...}>`, returns a view array. Stories 8 and 9 follow this pattern.
- `src/http/server/node/list-node.ts` — canonical handler pattern: factory `listNodeHandler(deps): Handler`, returns `{ kind: "json", status: 200, body: {...} }`. Stories 8 and 9 follow this pattern.
- `docs/proposal/phase-2/agents-and-workers.md:9` — the harness-qualified paragraph starts "A worker kind executes one objective under a lease." Story 10 deletes it.
- `.agents/plan/epics/100-phase-2-overview.md` row 106 — currently states EPIC 106 closes on `agent.list`. Story 11 corrects it.
