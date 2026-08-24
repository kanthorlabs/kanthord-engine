# Story 4 — The closed mutation API on `PlanStore`

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: Story 3.

**This story is one member of the atomic unit 04 + 05 + 07 + 08 + 10.** Deleting `upsertNode`, `insertEdge` and `deleteEdge` breaks `src/commands/plan/import-plan.ts:418,452,464` until Story 7 lands, and giving `SqlitePlanStore` a required constructor breaks `src/main.ts:163` until Story 10 lands. Run all five stories before `npm run verify`. No intermediate state of the unit typechecks.

## Change

### `src/services/plan/index.ts`

Delete the three mutation methods at `src/services/plan/index.ts:75-77`:

```ts
  upsertNode(transaction: Transaction, node: NodeWrite): void;
  insertEdge(transaction: Transaction, edge: EdgeWrite): void;
  deleteEdge(transaction: Transaction, id: string): void;
```

Keep `NodeWrite` at `:19-31` and `EdgeWrite` at `:33-37` unchanged. Add two input types and two methods.

```ts
import type { NodeTriggerId } from "../../domain/node-trigger.ts";
import type { ReadinessCause } from "../readiness/index.ts";
import type { ReadinessTransition } from "../../domain/readiness.ts";

export type MutateGraphInput = Readonly<{
  projectId: string;
  nodes: readonly NodeWrite[];
  insertEdges: readonly EdgeWrite[];
  deleteEdgeIds: readonly string[];
  at: number;
  cause: ReadinessCause;
}>;

export type SetNodeStateInput = Readonly<{
  id: string;
  from: NodeState;
  to: NodeState;
  trigger: NodeTriggerId;
  blockReason: string | null;
  at: number;
  cause: ReadinessCause;
}>;
```

`MutateGraphInput` declares **no** `trigger` member. `SetNodeStateInput.trigger` is **required**; do not mark it optional and do not give it a default.

Add both methods to `interface PlanStore`, after `insertRevision` at `:71-74`:

```ts
  mutateGraph(
    transaction: Transaction,
    input: MutateGraphInput,
  ): readonly ReadinessTransition[];
  setNodeState(
    transaction: Transaction,
    input: SetNodeStateInput,
  ): readonly ReadinessTransition[];
```

Import `NodeState` beside the existing `NodeKind` import at `src/services/plan/index.ts:2`.

### `src/services/plan/sqlite.ts`

`SqlitePlanStore` has no constructor today (`src/services/plan/sqlite.ts:115`). Give it one:

```ts
export type SqlitePlanStoreDependencies = Readonly<{ readiness: Readiness }>;

export class SqlitePlanStore implements PlanStore {
  constructor(private readonly dependencies: SqlitePlanStoreDependencies) {}
```

Add one SQL constant beside `INSERT_NODE` at `src/services/plan/sqlite.ts:25`:

```ts
const UPDATE_NODE_STATE =
  "UPDATE node SET state = ?, updated_at = ? WHERE id = ? AND state = ?";
```

Add a second constant for the state write that carries a block reason:

```ts
const UPDATE_NODE_STATE_AND_REASON =
  "UPDATE node SET state = ?, block_reason = ?, updated_at = ? WHERE id = ? AND state = ?";
```

Rename the three write methods into two, and keep the deleted bodies as private helpers.

- Turn `upsertNode` at `:303-317` into `private insertNode(transaction, node)`, body unchanged.
- Turn `insertEdge` at `:319-324` into `private addEdge(transaction, edge)`, body unchanged.
- Turn `deleteEdge` at `:326-328` into `private removeEdge(transaction, id)`, body unchanged.

Add `mutateGraph`. It runs in exactly this order:

1. Call `this.insertNode` once per member of `input.nodes`, in the given order.
2. Call `this.removeEdge` once per member of `input.deleteEdgeIds`, in the given order.
3. Call `this.addEdge` once per member of `input.insertEdges`, in the given order.
4. Call `this.readGraph(transaction, input.projectId)`.
5. Call `this.dependencies.readiness.apply(transaction, { projectId: input.projectId, nodes: graph.nodes.map(({ id, state }) => ({ id, state })), edges: graph.edges, at: input.at, cause: input.cause })`.
6. For each returned transition, in the returned order, call `transaction.run(UPDATE_NODE_STATE, [transition.to, input.at, transition.nodeId, transition.from])`.
7. Return the transitions.

Node insertion precedes edge insertion, because the `edge` table holds a foreign key to `node`.

Add `setNodeState`. It runs in exactly this order, and the order is normative. Story 5 owns the three guards; this list owns their position.

1. `const before = this.readNode(transaction, input.id)`. When it is `null`, return `[]` and write nothing.
2. The **matrix check** over `before.kind`, `input.from` and `input.to`.
3. The **declaration check** over `input.trigger`, `input.from` and `input.to`.
4. The **level check** over `before.kind`.
5. When `before.state !== input.from`, return `[]` and write nothing.
6. When `input.blockReason === null`, call `transaction.run(UPDATE_NODE_STATE, [input.to, input.at, input.id, input.from])`. Otherwise call `transaction.run(UPDATE_NODE_STATE_AND_REASON, [input.to, input.blockReason, input.at, input.id, input.from])`. The `AND state = ?` guard stays as defence in depth.
7. Call `this.readGraph(transaction, before.projectId)` and then `this.dependencies.readiness.apply(...)` with the same input shape as `mutateGraph` step 5, using `before.projectId` as `projectId`.
8. Write each returned transition with `UPDATE_NODE_STATE`, exactly as `mutateGraph` step 6.
9. Return the transitions.

**The matrix check runs before the declaration check.** That order makes `canTransition` load-bearing and observable: `pending → running` throws the matrix message, which is what `.agents/plan/epics/016-readiness-applied.md:98` requires. The reverse order makes the matrix branch unreachable, because `src/domain/node-trigger.test.ts` asserts every row of both tables names a legal cell.

One statement serves both readiness directions. The guard binds `transition.from`, never a literal.

A guard failure throws. A state disagreement returns `[]` and writes nothing. Those two outcomes never swap.

**A readiness transition can never no-op its own update.** `deriveReadiness` reads the graph `readGraph` returned inside this same transaction, so each `transition.from` equals the state on disk at that moment. `Storage.transact` serializes transactions in one process (`src/services/storage/sqlite.ts:36`, `assertIdle()`), so no second writer exists between the read and the write. The event `Readiness.apply` appended therefore always has a matching row change.

### `test/helpers/plan.ts`

`createPlanStore()` at `test/helpers/plan.ts:13-15` has twenty call sites. Keep it callable with no argument.

```ts
export function createPlanStore(
  readiness: Readiness = discardingReadiness(),
): PlanStore {
  return new SqlitePlanStore({ readiness });
}
```

`discardingReadiness()` is a local factory in the same file. It returns `new DependencyReadiness({ events: <a discarding EventLog>, instanceId: "daemon_test" })`, where the discarding `EventLog` has an `append` that records nothing and returns a fixed `RecordedEvent`, and a `list` that returns `[]`. The real derivation therefore still runs at every call site; only the event append is dropped. A test that asserts an event passes its own readiness.

Add `export function createReadiness(events: EventLog, instanceId = "daemon_test"): Readiness` to the same file, returning `new DependencyReadiness({ events, instanceId })`. Story 7 and Story 8 use it.

## Constraints

- Leave the seventeen read-only `createPlanStore()` call sites untouched. Only `src/commands/plan/import-plan.test.ts:340` and the four sites in `src/http/server/plan/import-plan.test.ts` (`:145`, `:291`, `:361`, `:523`) pass an argument, and Story 7 owns those edits.
- `src/services/plan/sqlite.test.ts:25` constructs the store directly. Change it to `new SqlitePlanStore({ readiness })` where `readiness` comes from a recording `EventLog` built in that file.
- `INSERT_NODE` at `src/services/plan/sqlite.ts:25-28` keeps its `'pending'` literal, its `NULL, NULL` block and discard reasons, and its `ON CONFLICT(id) DO UPDATE SET` list byte for byte. An insert must place a node in the table before its edges exist, and an upsert must never rewrite `state`.
- `src/services/plan/sqlite.test.ts:537-554` scans the module source from the first `ON CONFLICT` to the next quote and asserts the slice names none of `state`, `block_reason` or `discard_reason`. Declare `UPDATE_NODE_STATE` and `UPDATE_NODE_STATE_AND_REASON` **above** `INSERT_NODE`, so the first `ON CONFLICT` in the file still belongs to `INSERT_NODE`. Do not weaken that test.
- `SqlitePlanStore` reads no clock. `at` is an input at every call.
- `mutateGraph` and `setNodeState` open no transaction. Both take the caller's.
- Add no third mutation method. No public write other than `insertRevision`, `mutateGraph` and `setNodeState` may exist on `PlanStore`.
- Do not edit `src/commands/`, `src/queries/`, `src/http/` or `src/main.ts`. Stories 7, 8 and 10 own those.

## Verify

- `src/services/plan/sqlite.test.ts` — rename the three write tests and add the new ones.
  - `mutateGraph inserts a fresh node as pending, then promotes it to ready` — one node, no edge; assert the stored `state` is `ready` and the returned transition is `{ nodeId, from: "pending", to: "ready", trigger: "readiness-promoted" }`.
  - `mutateGraph never rewrites state, block_reason or discard_reason through the upsert` — keep the coverage of the tests at `:466-500` and `:502-535` by driving them through `mutateGraph` on a `discarded` node and a `blocked` node, and assert every field of the row before and after with `assert.deepEqual`.
  - `mutateGraph inserts every node before any edge` — a plan whose edge references a node created in the same call succeeds.
  - `mutateGraph writes and removes an edge` — keep the coverage of `:556-592`, driving `insertEdges` and `deleteEdgeIds` instead.
  - `mutateGraph returns both readiness directions from one call` — seed one `pending` node with a satisfied dependency and one `ready` node, add an unsatisfied dependency to the `ready` node in the same call, and assert both transitions and both stored states.
  - `mutateGraph declares no trigger member` — prove it at the **type** level, not by source text. Add a module-scope fixture to `src/services/plan/sqlite.test.ts`:

    ```ts
    // @ts-expect-error MutateGraphInput declares no trigger member
    const graphInputWithTrigger: MutateGraphInput = {
      projectId: "project_a",
      nodes: [],
      insertEdges: [],
      deleteEdgeIds: [],
      at: 1,
      cause: { revision: "revision_a", importId: null },
      trigger: "readiness-promoted",
    };
    ```

    The excess-property check fails the assignment today, so `@ts-expect-error` is satisfied. Adding a `trigger` member later turns the directive into an unused-directive error and `npm run typecheck` fails. Add one runtime assertion (`assert.ok(graphInputWithTrigger)`) so the binding is used.

  - `setNodeState writes the pair and returns the readiness transitions` — a `running` task moves to `ready`; assert the stored state and the returned list.
  - `setNodeState writes a block reason when one is given` — a `running` task moves to `blocked` with `blockReason: "dirty-recovery"`; assert both columns.
  - `setNodeState writes no row and appends no event when the from state does not match` — call with `from: "ready"` on a `running` node; assert the row is byte-identical before and after, the return is `[]`, and the recording event log recorded nothing.
  - `setNodeState applies readiness after the write` — a `pending` dependent of the node moved to `done` becomes `ready` in the same call, and the returned list names it.
  - `a waived edge satisfies its dependency through the store` — seed a `pending` dependent whose only edge has `waived_at` set and whose dependency stays `pending`, call `mutateGraph` with no node and no edge change, and assert the dependent became `ready` while the dependency stayed `pending`. This is the store-level half of `.agents/plan/epics/016-readiness-applied.md:90`; the domain half is Story 2. No route writes `edge.waived_at` in phase 1, so seed the column with raw SQL in the test.
- `node --test src/services/plan/sqlite.test.ts src/services/readiness/dependency.test.ts src/domain/readiness.test.ts` exits 0.
- `npm run typecheck` exits 0. Every former `upsertNode`, `insertEdge` and `deleteEdge` caller is gone or converted.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/services/plan/sqlite.test.ts`. Hermetic coverage: `.agents/plan/epics/016-readiness-applied.md:101` and `:103`.
