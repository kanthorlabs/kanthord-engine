# Story 15 — `node.show` returns what the human closes

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Story 6 (`latestRunOfNode`).

## Change

### `src/queries/node/show-node.ts`

`NodeView` at `:5-21` gains two fields, after `updatedAt` at `:20`:

```ts
attestedObjectId: string | null;
projection: "done" | "partial" | "discarded" | null;
```

`ShowNodeDependencies` at `:23-26` gains `execution: Execution`. A query may name a service interface.

`showNode` at `:28-35` today returns `plan.readNode` directly. Replace the body with one transaction that reads and composes:

```ts
  return dependencies.storage.transact((transaction) => {
    const node = dependencies.plan.readNode(transaction, input.id);
    if (node === null) {
      return null;
    }
    ...
  });
```

- `attestedObjectId` is the `head_oid` of `dependencies.execution.latestRunOfNode(transaction, node.id)` when `node.kind === "objective"`, and `null` for a task and an initiative. A null run gives `null`.
- `projection` is `aggregate("objective", states)` when `node.kind === "objective"` **and** every task of that objective is terminal, and `null` in every other case. The tasks come from `plan.readAllNodes(transaction)`, selected by `parentId`, ordered bytewise by node id. An objective with no task gives `null`, so `aggregate` never sees an empty child list.
- Every other field keeps its present value and its present order.

### `src/http/contract/graph.ts:119-126`

`nodeShowResponse` gains the two fields, after `updatedAt` at `:125`:

```ts
  attestedObjectId: z.string().nullable(),
  projection: z.enum(terminalStates).nullable(),
```

`nodeListItem` at `:103-113` gains nothing, so `node.list` is unchanged. Add the `nodeShowResponse` example fields to the `node.show` example at `graph.ts:232` with `attestedObjectId: null` and `projection: null`.

### `src/http/contract/field-decisions.fixture.ts`

Add two rows, each in its bytewise position inside the `node.show.response` block:

```
  "node.show.response#/properties/attestedObjectId required=true nullable=true enum=-",
```

goes between `acceptanceBlob` at `:33` and `blockReason` at `:34`, and

```
  "node.show.response#/properties/projection required=true nullable=true enum=done,partial,discarded",
```

goes between `projectId` at `:41` and `repositoryId` at `:42`. `src/http/contract/coverage.test.ts:282-284` sorts bytewise, so confirm both positions from the assertion diff rather than from this text.

## Constraints

- `src/http/server/node/show-node.ts` needs no change: it returns the whole view.
- Add no field to `nodeListItem` and no field to `list-node.ts`. `110-scheduler-leases-and-the-general-worker.md:14` gives the lease field to EPIC 111.
- Read through `latestRunOfNode` and not `activeRunOfNode`, because the close ends the run and the object id must survive it.
- Compute the projection; never read it from a stored column. This epic adds no migration.

## Verify

Edit `src/queries/node/show-node.test.ts`, in its existing fixture style, and add an `Execution` fake or the real sqlite implementation as that file already does for `plan`.

- `it("a task returns a null attestedObjectId and a null projection", ...)`.
- `it("an initiative returns a null attestedObjectId and a null projection", ...)`.
- `it("an objective with one non-terminal task returns a null projection", ...)`.
- `it("an objective whose tasks are all done returns projection done", ...)`, and the same for one `discarded` task giving `partial` and every task `discarded` giving `discarded`.
- `it("an objective with no task returns a null projection", ...)`.
- `it("an objective returns the attested object id of its active run", ...)` — stamp `head_oid` through `stampRunHead` and assert the value.
- `it("a closed objective still returns the attested object id", ...)` — end the run and assert `latestRunOfNode` still serves it.
- `it("an objective with two runs returns the head_oid of the newest run", ...)` — the greater run id wins.
- `it("every other field keeps its value", ...)` — compare the whole view against the literal, so a field-order or field-value regression fails.
- `node --test src/queries/node/show-node.test.ts src/http/server/node/show-node.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/queries/node/show-node.test.ts`. Hermetic coverage: `019-outcome-report.md:171` and the `node.show` clauses of `:154` and `:179`.
