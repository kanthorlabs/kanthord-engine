# Story 8 — The two concurrency classes

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: EPIC 014 Story 11 (`revisionGuardFor` in `src/domain/revision-guard.ts`). Its rule is implemented by Stories 9, 10 and 11; this story owns the shared refusal type and the cross-route guard tests. Dispatch it before the three command stories.

## Change

### A new `src/commands/node/refusal.ts`

The three commands share one error type, in the shape of `ImportPlanError` at `src/commands/plan/import-plan.ts:76`.

```ts
export const nodeWriteRefusalCodes = [
  "project-not-found",
  "node-not-found",
  "kind-mismatch",
  "stale-revision",
  "plan-invalid",
  "illegal-transition",
  "binding-in-use",
] as const;
export type NodeWriteRefusalCode = (typeof nodeWriteRefusalCodes)[number];

export class NodeWriteError extends Error {
  readonly refusal: NodeWriteRefusalCode;
  readonly details: unknown;
  constructor(
    refusal: NodeWriteRefusalCode,
    message: string,
    details?: unknown,
  );
}
```

### The guard rule the three commands implement

Each command calls `revisionGuardFor` of `src/domain/revision-guard.ts` with one of the four `nodeWriteKinds`, and never invents a class.

| command                        | kind passed       | class returned | compared against                                   |
| ------------------------------ | ----------------- | -------------- | -------------------------------------------------- |
| `createNode`                   | `create`          | `project`      | `PlanStore.newestRevision(transaction, projectId)` |
| `updateNode`, topology differs | `update-topology` | `project`      | `PlanStore.newestRevision(transaction, projectId)` |
| `updateNode`, fields only      | `update-fields`   | `node`         | the stored `node.revision` column                  |
| `deleteNode`                   | `delete`          | `project`      | `PlanStore.newestRevision(transaction, projectId)` |

- The topology test is exact: `updateNode` passes `update-topology` when `differingFields` of `src/domain/plan-diff.ts:6` holds `parent` or `depends_on`, and `update-fields` otherwise. `worker` and `repo` are **not** topology for this classification.
- A mismatch throws `NodeWriteError("stale-revision", ...)` with `details` equal to `{ guard, expected, actual }`, where `guard` is the class name, `expected` is the value read inside the transaction and `actual` is `input.fromRevision`.
- A create against an empty project sends `fromRevision: null`, and `newestRevision` returns `null`, so the comparison holds.
- **Whichever class guarded the write, the new revision row takes `parent_id` from `newestRevision` read inside the same transaction.** The node token is a guard and nothing else.
- `src/services/storage/connection.ts:35` opens `BEGIN IMMEDIATE`, which serializes every writer, so two concurrent node-token updates make a linear chain: A from `R0` produces `R1`, and B, still holding `R0`, produces `R2` with `parent_id = R1`.

## Constraints

- Introduce no third guard class. `revisionGuardClasses` is `["node", "project"]` and the commands read it, never a literal of their own.
- The comparison runs inside the write transaction, never before it opens.
- One code answers one condition. Both classes refuse with `stale-revision`; `details.guard` is what distinguishes them, per `docs/proposal/api/README.md:194`.
- Do not add a merge path. A stale token is a hard refusal.

## Verify

`src/commands/node/refusal.ts` gets **no test file of its own.** The Proof block at `.agent/plan/epics/017-per-node-graph-write.md:103-129` names every test file this epic creates, and it names no `refusal.test.ts`. Assert the type in `src/commands/node/create-node.test.ts` instead:

- `nodeWriteRefusalCodes` deep-equals the seven codes above, in that order.
- `NodeWriteError` carries `name === "NodeWriteError"`, the given refusal and the given details, and `details` is `undefined` when omitted.

The cross-route guard assertions live in the three command test files and are listed here so no story omits one. Each is asserted in the test file of its own command.

- `src/commands/node/update-node.test.ts` — a field-only update at the node revision succeeds; the same request at the project revision throws `stale-revision` with `details.guard === "node"`.
- `src/commands/node/update-node.test.ts` — a `depends_on` change at the node revision throws `stale-revision` with `details.guard === "project"`; the same change at the project revision succeeds.
- `src/commands/node/update-node.test.ts` — a `parent` change classifies as `update-topology`, and a `worker` change and a `repo` change classify as `update-fields`. Assert each by driving the request at the node revision and asserting success or refusal.
- `src/commands/node/create-node.test.ts` — a create against an empty project with `fromRevision: null` succeeds; a create with a stale project revision throws `stale-revision` with `details.guard === "project"`.
- `src/commands/node/delete-node.test.ts` — a delete with a stale project revision throws `stale-revision` with `details.guard === "project"`.
- `src/commands/node/update-node.test.ts` — **the concurrency proof.** Two field-only updates on two different nodes, each at its own node revision, both succeed. Assert `R2.parentId === R1`, that the blob addressed by `acceptedBlob(R2)` holds both edits, that `exportPlan` reports `R2`, that the export bytes equal the `acceptedBlob(R2)` bytes through `Buffer.compare`, and that each node's `revision` column holds its own value — `R1` for the first node and `R2` for the second.
- `node --test src/commands/node/refusal.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/commands/node/create-node.test.ts`, `src/commands/node/update-node.test.ts` and `src/commands/node/delete-node.test.ts`. Hermetic coverage bullets `.agent/plan/epics/017-per-node-graph-write.md:145` and `:147`.
