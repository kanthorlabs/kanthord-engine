# Story 02 — the graph service on graphology

Epic: `.agents/plan/epics/008-project-and-plan.md`

`src/services/graph/index.ts` declares three members and holds no implementation. This story writes the implementation and pins the order of every one of them.

## Change

### 1. `src/services/graph/index.ts` — add one member

The interface at `:21-25` is three members. Add a fourth, because the candidate validation of Story 09 needs the undirected components of Story 09's reset loop and the container of the reset rule is the graph service, not a command:

```ts
export interface Graph {
  topologicalOrder(input: GraphInput): readonly string[];
  cycles(input: GraphInput): readonly (readonly string[])[];
  children(input: GraphInput, parentId: string | null): readonly string[];
  components(input: GraphInput): readonly (readonly string[])[];
}
```

Nothing else in `index.ts` changes. `GraphInput`, `GraphNodeInput`, `GraphEdgeInput`, `GraphErrorCode` and `GraphError` stay as declared at `:1-19`.

### 2. `src/services/graph/graphology.ts` (new)

```ts
export class GraphologyGraph implements Graph { … }
```

`graphology` is imported here and nowhere else. It is already a dependency (`package.json:52`) and is not imported anywhere in the tree today. `eslint.config.js:9-18` lists `graphology` in `vendorPackages`, which bans it from `domain/`, `commands/`, `queries/` and `cli/` — a service implementation is the only legal site.

Every member builds one `DirectedGraph` from `input` and throws nothing else:

- Add every `input.nodes[].id` with `addNode`. A repeated id throws `GraphError("graph-duplicate-node", `${id} appears twice`)`. Extend `GraphErrorCode` at `index.ts:10` to `"graph-cycle" | "graph-unknown-node" | "graph-duplicate-node"`.
- Add every edge with `addDirectedEdge(edge.from, edge.to)`. An endpoint that is not a declared node throws `GraphError("graph-unknown-node", `${id} is not a node of this graph`)`. A repeated `(from, to)` pair is accepted and counted once, because `edge` carries `UNIQUE (from_node, to_node)` (`migration-0002-graph-and-plan.ts:43`) and a document set is de-duplicated by Story 05 before it reaches here.
- `parentId` on a node is used by `children` only. A `parentId` that names no declared node throws `GraphError("graph-unknown-node", …)`.

**`topologicalOrder`.** Kahn, with the tie broken by the bytewise-smallest id. This is the same rule and the same insertion helper as `src/domain/task-order.ts:81-124`: seed `available` with every in-degree-zero id in `input.nodes` order then `sort()`, `shift()` the smallest, and re-insert a freed dependent with a binary `insertSorted`. `from` depends on `to`, so an edge `from → to` contributes to the in-degree of `from` and `to` is emitted first — identical to `task-order.ts:76-79`. A result shorter than `input.nodes.length` throws `GraphError("graph-cycle", "the graph holds a cycle")`.

**`cycles`.** Tarjan's strongly connected components, with every neighbour list visited in bytewise id order and roots entered in bytewise id order of `input.nodes`. Return only the components that hold a cycle: size greater than one, or size one with a self edge. Each component's ids are returned bytewise ascending, and the components are ordered by their first id, bytewise ascending. `cycles` never throws for a cycle — it reports.

**`children`.** Every `input.nodes[].id` whose `parentId === parentId`, bytewise ascending. `null` returns the roots.

**`components`.** The connected components of the graph read as **undirected**, over the union of the dependency edges and, for every node with a non-null `parentId`, the pair `(id, parentId)`. Each component's ids bytewise ascending; components ordered by their first id, bytewise ascending. Every declared node appears in exactly one component, so a node with no edge is a component of one.

Bytewise comparison everywhere is `<` on the identity strings. Every identity is ASCII by construction — `src/domain/identity.ts:45` fixes the ULID alphabet and `:25-43` the prefixes — so `<` and `Buffer.compare` agree, and no locale-sensitive `localeCompare` appears in the module.

### 3. `src/main.ts` — construct it once

Add `import { GraphologyGraph } from "./services/graph/graphology.ts";` and `const graph = new GraphologyGraph();` beside `const ids = new UlidIdGenerator();` at `:136`. It is passed to the plan handlers of Stories 08, 11 and 12.

### 4. `test/helpers/plan.ts` — `createPlanGraph()`

One line, returning a real `GraphologyGraph`. Story 02.5 creates the file. A domain test, a command test and a query test may not import an implementation directly (`AGENTS.md`'s test rule), and Stories 05 and 09 need the real cycle and component finders — a hand-written fake would re-implement Tarjan and prove nothing.

### 5. `src/domain/layout.test.ts` — no edit

`:101-123` pins thirteen service directories and `graph` is already one of them. `:157-173` asserts no `src/services/*/index.ts` contains `implements ` — `graphology.ts` is not an `index.ts`, so it is unaffected.

## Constraints

- `graphology` is imported in `src/services/graph/graphology.ts` and in no other production file. A test asserts it.
- No member reads a clock, a random source or the file system. The service is pure over its input.
- Every returned order is bytewise. No `localeCompare`, no `Intl`, no `sort()` on a non-ASCII value.
- `cycles` reports and never throws on a cycle. `topologicalOrder` throws on a cycle and never reports one.
- `components` is undirected and includes containment pairs. `topologicalOrder` and `cycles` ignore `parentId`.

## Verify

`node --test src/services/graph/graphology.test.ts`

The suite name is `src/services/graph/graphology.ts`. Every fixture uses literal identities so every assertion is an exact array.

- **The tie-break is the ULID.** Nodes `task_01A`, `task_01B`, `task_01C` with no edge return exactly `["task_01A","task_01B","task_01C"]`, and the same set declared in the reverse input order returns the same array.
- **A freed dependent re-enters at its sorted position.** `task_01D → task_01A` and `task_01B`, `task_01C` free: assert the exact emitted array, and assert it differs from a naive queue order by naming both.
- A diamond `A → B`, `A → C`, `B → D`, `C → D` (`from` depends on `to`) returns `["task_01D","task_01B","task_01C","task_01A"]`.
- **A cycle throws.** `A → B`, `B → A` throws `GraphError` with `code === "graph-cycle"`.
- **`cycles` finds it and reports it sorted.** The same input returns `[["task_01A","task_01B"]]`. A graph with two disjoint cycles returns both, ordered by their first id. An acyclic graph returns `[]`. A three-node cycle plus one acyclic node returns one component of three.
- A self edge `A → A` is reported as `[["task_01A"]]`.
- **An unknown endpoint throws.** An edge naming an undeclared node throws `code === "graph-unknown-node"`, from `topologicalOrder`, from `cycles` and from `components`.
- A duplicate node id throws `code === "graph-duplicate-node"`.
- A duplicate `(from, to)` pair does not throw, and the order equals the order without the duplicate.
- **`children`.** Three tasks under `objective_01A` and one under `objective_01B` return the right two arrays, both bytewise ascending; `children(input, null)` returns the nodes whose `parentId` is `null`.
- **`components` unions dependency and containment.** Two tasks with no dependency edge but the same parent are one component of three (the two tasks and the parent). Two tasks under different parents with no edge are two components. A dependency edge across two parents merges the two into one component.
- `components` on a graph with no edge and no parent returns one component per node, ordered bytewise.
- **Determinism.** Every one of the four members is called twice on the same input and the two results `deepEqual`.
- **Non-ASCII is impossible and asserted as such.** A node id `task_01A` and a node id `tásk` — the second is rejected by no rule in this service, so the assertion is instead that the module source contains neither `localeCompare` nor `Intl`.
- `graphology` is imported once: read every non-test file under `src/` and assert exactly one contains `"graphology"`, and that its path is `src/services/graph/graphology.ts`.

`npm run verify` exits 0.

Proof: delivers `src/services/graph/graphology.test.ts`, which the EPIC Proof glob `src/services/graph/**/*.test.ts` already names. `PASS EPIC-008`.
