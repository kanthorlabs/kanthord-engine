# Story 2 — `deriveReadiness` in `domain/`

Epic: `.agent/plan/epics/016-readiness-applied.md`
Depends on: EPIC 014 Story 13 (`src/domain/node-trigger.ts` declares `readiness-promoted` and `readiness-demoted`).

## Change

Add one pure function and two types to `src/domain/readiness.ts`, below `isReady` at `src/domain/readiness.ts:12` and above `export type Clearance` at `:16`.

Add these imports to the existing type-only import at `src/domain/readiness.ts:1`:

```ts
import type { BlockReason, NodeState } from "./state.ts";
import type { StoredEdge } from "./plan-graph.ts";
import type { NodeTriggerId } from "./node-trigger.ts";
```

### The two types

```ts
export type ReadinessNode = Readonly<{
  id: string;
  state: NodeState;
}>;

export type ReadinessTransition = Readonly<{
  nodeId: string;
  from: NodeState;
  to: NodeState;
  trigger: NodeTriggerId;
}>;
```

### The function

```ts
export function deriveReadiness(
  nodes: readonly ReadinessNode[],
  edges: readonly StoredEdge[],
): readonly ReadinessTransition[];
```

Implement it exactly this way, and in this order.

1. Build `stateById: Map<string, NodeState>` from `nodes`.
2. Build `dependenciesByNode: Map<string, Dependency[]>` from `edges`. An edge contributes to `edge.fromNode`: the dependent is `fromNode` and the dependency is `toNode`. This matches `src/commands/plan/import-plan.ts:444-447`, where `fromNode` is the node and `toNode` is the thing it depends on.
   - For each edge, resolve `stateById.get(edge.toNode)`. When the lookup misses, skip the edge; a node outside the given set contributes nothing.
   - The `Dependency` value is `{ state: <resolved state>, waived: edge.waivedAt !== null }`.
3. Walk `nodes` and collect at most one transition per node:
   - `node.state === "pending"` and `isReady(dependenciesByNode.get(node.id) ?? [])` yields `{ nodeId: node.id, from: "pending", to: "ready", trigger: "readiness-promoted" }`.
   - `node.state === "ready"` and `isReady(...) === false` yields `{ nodeId: node.id, from: "ready", to: "pending", trigger: "readiness-demoted" }`.
   - Every other state yields nothing.
4. Sort the collected transitions by `nodeId` through `Buffer.compare(Buffer.from(left.nodeId, "utf8"), Buffer.from(right.nodeId, "utf8"))` and return them.

Reuse `isReady` at `src/domain/readiness.ts:12` and `Dependency` at `:3`. Do not restate the satisfying-state rule.

## Constraints

- The file stays pure. It reads no clock, mints no identity, and names none of `Date.now(`, `new Date(` or `Math.random(`. `src/domain/layout.test.ts:56-66` scans every non-test file in `src/domain/` for those three literals.
- It imports only relative `./` domain modules. `eslint.config.js:230-247` bans every `node:*` module, `ulid`, `yaml` and every vendor package here. `Buffer` is a global and needs no import.
- `Buffer.compare` is the only ordering. Do not call `localeCompare` and do not call `Array.prototype.sort` with no comparator.
- Do not change `isReady`, `satisfiesDependency`, `Dependency`, `Clearance`, `blockReasonClearance` or `clearedByUnblock`.
- Emit no transition for a node whose state is `running`, `blocked`, `awaiting_approval`, `done`, `partial` or `discarded`, whatever its dependencies hold.
- Add no consumer. Story 3 is the only caller.

## Verify

Add to `src/domain/readiness.test.ts`, inside `describe("src/domain/readiness.test", ...)`, a new nested `describe("deriveReadiness", ...)` after the `isReady` suite that closes at `src/domain/readiness.test.ts:88`. Write a local `edge(id, fromNode, toNode, waivedAt = null)` factory that returns a `StoredEdge`.

Assert each of these.

- `deriveReadiness([], [])` deep-equals `[]`.
- A `pending` node with no edge yields exactly one transition, `{ nodeId, from: "pending", to: "ready", trigger: "readiness-promoted" }`. Assert the whole object with `assert.deepEqual`.
- A `pending` node with no edge yields the promotion at each of the three kinds' identity prefixes in one call: three nodes `initiative_1`, `objective_1`, `task_1`, all `pending`, no edge, yield three promotions in that bytewise order.
- One `pending` node per satisfying dependency state: a dependency in `done` and a dependency in `partial` each yield one promotion.
- One `pending` node per non-satisfying dependency state: a dependency in `pending`, `ready`, `running`, `blocked`, `awaiting_approval` or `discarded` each yields `[]`. Drive the six states from a local array so all eight `nodeStates` are covered across this bullet and the one above.
- A waived edge satisfies its dependency: an edge with `waivedAt: 1` whose `toNode` is `pending` yields one promotion for the dependent, and no transition for the dependency itself.
- A `ready` node with one unsatisfied dependency yields exactly one transition, `{ nodeId, from: "ready", to: "pending", trigger: "readiness-demoted" }`.
- A `ready` node whose dependencies are all satisfied yields `[]`.
- Both directions come from one pass: one fixture holds a `pending` node whose dependencies are satisfied and a `ready` node with an unsatisfied dependency. Assert the result deep-equals the two transitions with the exact `from`, `to` and `trigger` of each, in bytewise `nodeId` order.
- The fixed point holds in both directions. Apply the returned transitions to the node set — replace each subject's state with the transition's `to` — call `deriveReadiness` again over the same edges, and assert `[]`. Run this on the promotion fixture and on the demotion fixture.
- No node yields two transitions: assert `new Set(result.map((t) => t.nodeId)).size === result.length` on the mixed fixture.
- Every other state is untouched: for each of `running`, `blocked`, `awaiting_approval`, `done`, `partial` and `discarded`, a node in that state with all dependencies satisfied yields `[]`, and the same node with one unsatisfied dependency yields `[]`. Twelve assertions.
- An edge whose `toNode` is absent from the node set is skipped: a `pending` node with one edge to an unknown id yields one promotion.
- **Ordering is bytewise, not locale-sensitive.** Use the identities `node_Z`, `node_a` and `node_B`, all `pending`, with no edge. Assert the returned `nodeId` order is `["node_B", "node_Z", "node_a"]`. Assert in the same test that `["node_Z", "node_a", "node_B"].toSorted((l, r) => l.localeCompare(r))` differs from that order, so the test fails a locale-sensitive comparison.
- `deriveReadiness` stamps `readiness-promoted` on every `pending` → `ready` transition and `readiness-demoted` on every `ready` → `pending` transition. On the mixed fixture, assert the trigger of each returned transition and assert no other trigger id appears.
- `node --test src/domain/readiness.test.ts src/domain/node-trigger.test.ts src/domain/layout.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/domain/readiness.test.ts` and `src/domain/layout.test.ts`. Hermetic coverage: `.agent/plan/epics/016-readiness-applied.md:89`, `:90`, `:91`, `:93`, `:94`, `:96` and `:102`.
