# EPIC 048 — The worker registry and routing

Status: **draft**. It follows EPIC 047 by sequence order, and it supersedes EPIC 041.

## Goal

A worker is a design-time record, and routing is a computation over three sets:

- `src/domain/worker-registry.ts` holds one ordered entry per worker, with `driver`, `agents`, `claims`, `deliverables`, `harness` and `metadata.composition`;
- an agent holds one role contract that declares a tool whitelist, and one generator renders that contract per harness;
- `routeWorker` computes the intersection of `capable`, `authorized` and `available`, takes the first worker by registry order, and answers `unroutable` on an empty intersection, naming the set that failed. It is a pure function, and EPIC 050 is the first caller inside a claim;
- `worker.list` and `agent.list` move from `stubbed` to `routed`.

## Non-goals

- **No internal worker at all.** A human ruled that `general@1`, `tdd@1`, `poc@1`, `research@1` and `git@1` are phase-2 work. The registry holds two entries, and neither has an executor here either: `claude@1` and `opencode@1` are external, so the harness implements them. EPIC 110 adds `general@1`, and the other four follow it.
- **No claim change.** `src/commands/node/claim-node.ts` does not read the registry here. EPIC 050.1 wires routing into the claim, so the routing function ships one epic before its production caller.

- **No additive schema.** `worker.md` section 13 step 1 pairs the registry with the additive nullable schema. EPIC 047 shipped that half. This epic ships the registry half, and no column is added here.

- **No path ownership.** `worker.md` section 3 states `swe@1` and `te@1` differ by the paths they own, and it defines no schema for a path set. This epic ships the tool capability record only, and it names the gap rather than inventing a schema. The `verify.paths` of EPIC 047 is a node declaration, not a role declaration, and the two must not be conflated.
- **No grant.** `authorized` reads a caller record that EPIC 055 defines. This epic takes the authorized set as an input to the pure function and supplies it from a fixed test value.
- **No harness adapter.** The role-contract generator emits a document per harness format. It starts no process. EPIC 106 owns the `pi-coding-agent` adapter.
- **No removal of `workerKinds`.** `src/domain/worker.ts:3` stays until EPIC 057, because a plan row still holds a value from it.
- **No health probe implementation.** `available` reads a health result the caller supplies. The self health check of a real worker ships with that worker.

## Decisions

- **A worker id is `<name>@<version>`, and this epic decides the alphabet.** `worker.md` section 4 gives the shape and no alphabet. The grammar is `^[a-z][a-z0-9-]*@[1-9][0-9]*$`, and it is a decision taken here, not a transcription. It forbids a dot so that a harness cannot be smuggled into a name, which is the point of the next decision. `parseWorkerId` returns `{ name: string; version: number; id: string }`, where `id` reproduces the input verbatim. The version is a number, and a version above `Number.MAX_SAFE_INTEGER` is refused at parse rather than rounded.

- **`claude.swe@1` is a legacy `node.worker` value, and it is never a worker id.** The dual-read window of `worker.md` section 13 covers the plan document, not the registry. A legacy plan row keeps `worker: claude.swe@1` under `workerKinds`, which EPIC 049 still parses and EPIC 057 removes. The registry never holds that value, `routeWorker` never sees it, and no conversion maps it to a worker id. The two vocabularies do not meet.

- **The harness is a registry field, not a name prefix.** An external entry carries `harness: "claude-code"`. `worker.md` section 4 states the registry shape, and the prefix convention of EPIC 041 encoded the same fact in a string. One representation survives, and it is the field. `docs/proposal/phase-2/agents-and-workers.md:9` is amended, and its harness-qualified paragraph is deleted.

- **The registry is code, and its declaration order is the routing order.** `src/domain/worker-registry.ts` exports `workerRegistry` as a `readonly` tuple. The order is observable, because routing takes the first element of the intersection, and a test asserts the tuple of ids by deep equality.

- **The registry holds the two external workers, and every internal worker is deferred to phase 2.** `worker.md` section 4 lists seven workers and gives complete fields for three. A human ruled that only the external pair ships in this block.

  | `worker`     | `driver` | `agents` | `claims`            | `deliverables`                     | `harness`     | `composition`  |
  | ------------ | -------- | -------- | ------------------- | ---------------------------------- | ------------- | -------------- |
  | `claude@1`   | external | `[]`     | `objective`, `task` | `test`, `implementation`, `review` | `claude-code` | `self-managed` |
  | `opencode@1` | external | `[]`     | `objective`, `task` | `test`, `implementation`, `review` | `opencode`    | `self-managed` |

  **The `claude@1` row is `worker.md` section 4 verbatim.** Its registry entry appears in full in that section, and every field is copied.

  **The `opencode@1` row is derived, and a human confirmed it.** Section 4 gives `opencode@1` a table row only: external, self-managed, "opencode drives its own sub-agents." Its `driver`, `composition` and `harness` follow from that row. Its `claims` and `deliverables` are copied from `claude@1`, and a human confirmed the copy: both are self-managed harnesses dispatching the same personas, and a narrower set would leave one harness unable to take work the other can. `docs/workflow/worker.md` section 4 now carries the `opencode@1` registry entry in full, so the copy is recorded in the design document and not only here.

- **No worker claims `initiative`, and no worker declares `expansion`.** `research@1` held both, and it is deferred. A claim on an initiative, and a claim on any node whose deliverable is `expansion`, therefore answers `unroutable` with `failedSet: "capable"` in production. That is correct rather than a gap: `worker.md` section 10 states an external client submits no graph patch and creates no node, so expansion is internal-only work and no internal worker exists yet. EPIC 052 ships the structural mechanism against a fixture registry, so the phase-2 worker is a registry edit.

- **The agent role contracts stay, and they are not gated on a worker.** `worker.md` section 3 defines four agents, and none of them is a worker. No registry entry references one, because both external entries carry `agents: []`. The contracts and the generator ship here because they are the input phase 2 consumes, and `agent.list` publishes them, which is the route this epic closes on.

- **The `composition` set stays closed at three, and two of its values are unused today.** `single` and `composed` describe internal workers, and every internal worker is deferred. Both stay in the tuple, because the phase-2 workers take them and a tuple that shrinks and regrows is a contract that churns. `worker.md` section 4 now defines `single` as one execution path driving at most one agent, so the phase-2 `git@1` row is `single` with no agent and contradicts nothing.

- **`composition` is metadata, and one lint refuses a direct read outside three files. It does not prove the absence of a branch.** `worker.md` section 4 states no integration branches on `composition`. A lint cannot prove that: an alias, a destructure, a bracket access or a helper evades a member-expression selector. The mechanism this epic ships is narrower and honest — an `eslint` `no-restricted-syntax` rule refusing `.metadata.composition` and `["composition"]` outside `src/domain/worker-registry.ts`, its test and `src/queries/worker/list-workers.ts`. `AGENTS.md` requires a rule to carry a mechanism, and this is the strongest mechanism available; the epic states its limit rather than claiming a proof.

- **The lint is proven by a RuleTester case, not by a fixture in the linted tree.** A committed fixture that lint rejects makes `pnpm run lint` fail. `eslint.config.js`'s rule is asserted in `src/domain/worker-registry-lint.test.ts` through the ESLint `RuleTester` over an in-memory source string, which passes and refuses without writing a file.

- **`capable` reads the registry alone.** `capableWorkers(registry, { kind, deliverable })` returns every entry whose `claims` holds the node kind and whose `deliverables` holds the node deliverable. It reads no runtime state, so it is pure and it lives in `src/domain/worker-routing.ts`.

- **Routing is one pure function over three inputs, and the three sets are worker id sets.** `routeWorker({ registry, kind, deliverable, authorized, available })` takes `authorized` and `available` as `readonly string[]` of worker ids. It returns `{ routed: true; worker }` or `{ routed: false; refusal: "unroutable"; failedSet: "capable" | "authorized" | "available" }`. `failedSet` names the first set, in that order, whose intersection with the previous ones is empty. The order is fixed, because a caller that reads `authorized` when `capable` is already empty reports the wrong cause.

- **The function validates its inputs and refuses rather than filtering.** `worker.md` section 4 defines `authorized` as a subset of `capable` and `available` as a subset of `authorized`. An id absent from the registry, a duplicate id, an `authorized` id outside `capable`, or an `available` id outside `authorized` throws `WorkerRoutingError` with the codes `worker-unknown-id`, `worker-duplicate-id`, `authorized-not-capable` and `available-not-authorized`. Silently filtering an invalid input would let a caller's bug read as an `unroutable` node.

- **Availability is per instance, so the health interface takes an instance, not a worker id.** `worker.md` section 4 states capability is design-time and code-derived while availability is runtime and per instance, and that a worker runs a self health check before it claims. `src/services/worker-health/index.ts` declares `check(instance: WorkerInstance): Promise<{ available: boolean; reason: string | null }>`, where `WorkerInstance` is `{ worker: string; instanceId: string }`. `src/services/worker-health/not-implemented.ts` throws, mirroring `src/services/agent/not-implemented.ts`. The **caller** owns this check, never the daemon: a supervisor calls it for the worker it spawned, and a client calls it for itself. EPIC 050 carries the result into the claim as an assertion. The epic closes on a route that reads the registry, not on a probe.

- **An agent role contract is data, and the tool set is a whitelist.** `src/domain/agent-contract.ts` exports `tools` as the tuple `["read", "bash", "edit", "write", "grep", "find", "ls"]` and `agentContracts` as one record per agent of `src/domain/agent.ts:3`. `general@1`, `swe@1` and `te@1` hold every tool. `re@1` holds `read`, `bash`, `grep`, `find` and `ls`. `worker.md` section 3 states this table.

- **`swe@1` and `te@1` hold the same tools, and that is correct.** `worker.md` section 3 states their contracts differ by the paths they own. This epic adds no path field, because no worker enforces one yet. The equality is asserted by a test, so a later divergence is deliberate.

- **The harness set is closed and lives in code, so `denyByDefault` is a fact and not a caller's assertion.** `src/domain/harness.ts` exports `harnesses` as a `readonly` tuple of descriptors: `claude-code` and `opencode`, each `denyByDefault: true`, and `pi` with `denyByDefault: false`. A caller names a harness by id; it supplies no descriptor. A caller-supplied boolean would let any caller claim the property the check exists to test.

- **The generator emits one document per harness, and it fails closed.** `src/domain/agent-contract-render.ts` exports `renderAgentContract(contract, harnessId)`. It throws `AgentContractError` with code `harness-unknown` for an id outside the tuple, and `harness-cannot-deny` when the descriptor's `denyByDefault` is false. `worker.md` section 3 states that generation fails when a harness cannot deny by default. `pi` is in the tuple precisely so that the failing path has a real subject.

- **Each harness output format is pinned, and the bytes are golden fixtures.** `claude-code` emits a markdown file with YAML frontmatter holding `name`, `description` and `tools`. `opencode` emits the same shape under its own directory convention. The exact bytes live in `test/fixtures/agent-contract/<harness>/<agent>.md`, committed, and the renderer is asserted byte-identical against them. Rendering a document is not starting a session: EPIC 106 owns the adapter that runs one.

- **`worker.list` publishes the registry, and `agent.list` publishes the contracts.** Both are queries and both write nothing. The two operations already exist as `stubbed` entries, so no operation id is added.

- **The response field names follow the design document's own spelling.** A `worker.list` entry is `{ worker, driver, agents, claims, deliverables, harness, metadata: { composition } }`, with `worker` holding the id — not `id` — because `worker.md` section 4 writes `worker: tdd@1`. An `agent.list` entry is `{ agent, purpose, capabilities: { tools } }`, which is the shape of the `re@1` contract in `worker.md` section 3. `harness` is null for an internal worker.

- **Moving a route from `stubbed` to `routed` is handler work, not schema work.** `AGENTS.md` states a `stubbed` entry binds to the one shared `501` handler and a `routed` entry binds to exactly one command or query. Each route therefore needs a handler under `src/http/server/`, a binding in `src/main.ts`, and an integration test asserting the route no longer answers `501`. A query test alone cannot prove the route moved.

- **`agent.list` publishing the allow list satisfies the closing rule of row 106.** `100-phase-2-overview.md` states that 106 closes on `agent.list`. That route closes here instead, and 106 keeps the adapter, the exclusion computation and the fail-closed session assertion.

## Stories

1. **The worker id grammar.** Add `src/domain/worker-id.ts` with `workerId` and `parseWorkerId` returning `{ name, version, id }`. Add `src/domain/worker-id.test.ts` asserting `general@1`, `tdd@1` and `opencode@1` parse to the exact object with `id` equal to the input, asserting `claude.swe@1`, `general`, `general@`, `general@0`, `General@1` and `general@9007199254740993` are each refused by value, and asserting `workerKinds` of `src/domain/worker.ts:3` and `workerRegistry` share no member.

2. **The registry.** Add `src/domain/worker-registry.ts` with the two entries in the order of the Decisions table, each field taken from that table, and the `compositions` tuple. Add `src/domain/worker-registry.test.ts` asserting the whole tuple by deep equality against a literal — every field of both entries — asserting both ids parse under `workerId`, asserting both carry `driver: "external"`, an empty `agents` list, a non-null `harness` and `composition: "self-managed"`, asserting no entry declares `expansion`, asserting no entry claims `initiative`, and asserting `compositions` deep-equals `["single", "composed", "self-managed"]`.

3. **Routing.** Add `src/domain/worker-routing.ts` with `capableWorkers`, `routeWorker` and `WorkerRoutingError`. Add `src/domain/worker-routing.test.ts` asserting: `capableWorkers` for `(task, implementation)` deep-equals `["claude@1", "opencode@1"]`; `capableWorkers` for `(initiative, expansion)` deep-equals `[]` and routing it returns `failedSet: "capable"`; `capableWorkers` for `(objective, expansion)` deep-equals `[]`; `(task, research)` returns `failedSet: "capable"`, because no registry entry declares `research`; a non-empty capable set with an empty authorized set returns `failedSet: "authorized"`; a non-empty authorized set with an empty available set returns `failedSet: "available"`; two capable workers resolve to the earlier registry entry, asserted by id; and the four input-validation errors are each thrown by code.

4. **The composition lint.** Add the `no-restricted-syntax` rule to `eslint.config.js` refusing `.metadata.composition` and `["composition"]` outside the three permitted files. Add `src/domain/worker-registry-lint.test.ts` asserting the rule through the ESLint `RuleTester` over in-memory sources: a permitted file passes, a member read outside them is reported, and a bracket read outside them is reported. No fixture file is committed into the linted tree.

5. **The health interface.** Add `src/services/worker-health/index.ts` with `WorkerInstance` and `check(instance)`, and `src/services/worker-health/not-implemented.ts`, mirroring `src/services/agent/not-implemented.ts`. Add `src/services/worker-health/not-implemented.test.ts` asserting the throw by error code.

6. **The agent role contracts.** Add `src/domain/agent-contract.ts` with the `tools` tuple and the four contracts, each `{ agent, purpose, capabilities: { tools } }`. Add `src/domain/agent-contract.test.ts` asserting the tool tuple by deep equality, asserting `re@1` omits `edit` and `write`, asserting the `swe@1` and `te@1` tool sets are deep-equal to each other and to the `general@1` set, asserting no contract carries a path field, which is the gap the Non-goals name, and asserting no `workerRegistry` entry references an agent, so the contracts stand on their own.

7. **The harness set and the contract generator.** Add `src/domain/harness.ts` with the three descriptors, and `src/domain/agent-contract-render.ts` with `renderAgentContract(contract, harnessId)`. Commit eight golden fixtures under `test/fixtures/agent-contract/`, one per agent per deny-by-default harness. Add `src/domain/agent-contract-render.test.ts` asserting each rendered document is byte-identical to its fixture, asserting `pi` throws `harness-cannot-deny`, and asserting an unknown id throws `harness-unknown`. Both throws are asserted by error code.

8. **`worker.list` is routed.** Move the `worker.list` entry of `src/http/contract/` from `stubbed` to `routed`, add the response schema with `worker` as the id field, add `src/queries/worker/list-workers.ts`, add the handler under `src/http/server/worker/list-workers.ts`, and bind it in `src/main.ts`. Add `src/queries/worker/list-workers.test.ts` asserting the response holds two entries in registry order and validates against the contract schema, and add an integration case asserting the route answers `200` and no longer `501`.

9. **`agent.list` is routed.** Move the `agent.list` entry from `stubbed` to `routed` with the `{ agent, purpose, capabilities: { tools } }` shape, add `src/queries/agent/list-agents.ts`, add the handler and the `src/main.ts` binding. Add `src/queries/agent/list-agents.test.ts` asserting the four agents and their exact tool whitelists, and add an integration case asserting the route answers `200` and no longer `501`.

10. **The proposal records the registry.** Amend `docs/proposal/phase-2/agents-and-workers.md`. Delete the harness-qualified paragraph at line 9. State the worker id grammar and that it forbids a dot, the three `composition` definitions with `single` counting execution paths, the two-row registry table, that every internal worker is phase-2 work, that `expansion` and `initiative` are unroutable until an internal worker exists, the three eligible sets and their subset rule, the registry-order rule, the `unroutable` refusal with its `failedSet`, the four role contracts, the closed harness set, and that generation fails when a harness cannot deny by default. State that role path ownership is not represented and remains open.

11. **The dependency plan records the moved route.** Amend `.agents/plan/epics/100-phase-2-overview.md` row 106 so that `agent.list` closes here and EPIC 106 closes on its adapter assertions. `100-phase-2-overview.md` states 106 closes on `agent.list`, and moving a closing route without amending the plan leaves two epics claiming one route.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
pnpm run lint \
  && node --test \
  src/domain/worker-id.test.ts \
  src/domain/worker-registry.test.ts \
  src/domain/worker-routing.test.ts \
  src/domain/worker-registry-lint.test.ts \
  src/domain/agent-contract.test.ts \
  src/domain/agent-contract-render.test.ts \
  src/services/worker-health/not-implemented.test.ts \
  src/queries/worker/list-workers.test.ts \
  src/queries/agent/list-agents.test.ts \
  && echo "PASS EPIC-048"
```

Hermetic coverage required beyond the Proof:

- `workerId` refuses `claude.swe@1`, asserted by value. This is the assertion that proves EPIC 041 is superseded.
- The whole registry deep-equals a literal holding every field of both entries, in the fixed order. An id-only assertion is not sufficient, because registry order is the routing tie-break.
- Both registry entries carry `driver: "external"`, `agents: []` and `composition: "self-managed"`, asserted per entry.
- `compositions` deep-equals `["single", "composed", "self-managed"]`, so the two values the deferred internal workers need survive the shrink.
- No registry entry declares `expansion`, and none claims `initiative`, each asserted by filtering the registry. Both are the state a phase-2 registry edit changes.
- `capableWorkers` for `(task, implementation)` deep-equals `["claude@1", "opencode@1"]`, and for `(initiative, expansion)` and `(objective, expansion)` each deep-equals the empty array.
- Routing an expansion node returns `failedSet: "capable"`. The refusal names the set that failed, so an operator reads "no worker declares this" rather than an authorization error.
- `routeWorker` throws `authorized-not-capable` for an authorized id outside the capable set, and `available-not-authorized` for an available id outside the authorized set. Both are asserted by error code, so an invalid input never reads as `unroutable`.
- `routeWorker` returns `failedSet: "capable"`, `"authorized"` and `"available"` in three separate cases, each asserted by the full result object.
- Two capable workers resolve to the earlier registry entry, asserted by worker id, not by index.
- The `RuleTester` reports a member read and a bracket read of `composition` outside the three permitted files, and reports nothing inside them. No fixture is committed into the linted tree, so `pnpm run lint` stays green.
- The `re@1` tool list deep-equals `["read", "bash", "grep", "find", "ls"]`, and `edit` and `write` are absent, each asserted by membership.
- The `swe@1` and `te@1` tool lists are deep-equal to each other.
- Each of the eight rendered contracts is byte-identical to its committed golden fixture.
- `renderAgentContract` throws `harness-cannot-deny` for `pi` and `harness-unknown` for an id outside the tuple, each asserted by error code. The harness descriptor comes from the closed tuple, never from the caller.
- No agent contract carries a path field. The assertion is the record of the stated gap.
- `worker.list` returns two entries, in registry order, asserted by the `worker` field sequence, and the response parses under the contract schema.
- `worker.list` and `agent.list` each answer `200` over the real server, and neither answers `501`. A query-level test alone does not prove a route moved off the shared stub handler.
