# Story 15 — `node.list` filters

Epic: `.agent/plan/epics/018-claim-and-lease.md`

`docs/proposal/api/graph.md:104` records the filter set: `project`, `kind`, `state`, `blockReason` and `repository`. That is the exact set, and this story adds no sixth.

## Change

### `src/http/contract/graph.ts`

`node.list` at `src/http/contract/graph.ts:332-340` declares no `query`. Add one. `src/http/contract/operation.ts:41` already carries `query?: ZodType`, so no transport work is needed.

```ts
export const nodeListQuery = z.strictObject({
  project: identity("project").optional(),
  kind: z.enum(nodeKinds).optional(),
  state: z.enum(nodeStates).optional(),
  blockReason: z.enum(blockReasons).optional(),
  repository: identity("repository").optional(),
});
```

`nodeKinds`, `nodeStates` and `blockReasons` come from `src/domain/state.ts`. `project` and `repository` are identity strings through the existing `identity` helper. **Each key is optional and single-valued.** Add the schema to the `node.list` entry as `query: nodeListQuery`, and add a `query` member to `nodeListExamples`.

`registryFaults` at `src/http/contract/registry.ts:234-239` faults a `query` on a `stubbed` operation. `node.list` is `routed`, so it passes.

### `src/http/server/node/list-node.ts`

The handler at `src/http/server/node/list-node.ts:10-17` takes no input today. It becomes:

```ts
return async (context) => {
  const parsed = nodeListQuery.safeParse(singleValued(context.query));
  if (!parsed.success) {
    throw httpError("invalid-request", "the node filters are not valid");
  }
  const nodes = dependencies.listNodes(parsed.data);
  return { status: 200, body: { nodes } };
};
```

`singleValued` from `src/http/server/single.ts` is what makes a repeated key a refusal: it throws on a two-value entry, exactly as `src/http/server/event/list-event.ts:18` already does. `strictObject` is what makes an unknown key a refusal. Catch the `singleValued` throw and turn it into the same `400 invalid-request`, following the `list-event.ts` pattern.

`ListNodeHandlerDependencies` at `:4-8` changes its `listNodes` signature from `Readonly<Record<string, never>>` to `NodeListFilter`.

### `src/queries/node/list-node.ts`

`listNodes` at `src/queries/node/list-node.ts:23-30` takes `Readonly<Record<string, never>>`. It becomes:

```ts
export type NodeListFilter = Readonly<{
  project?: string;
  kind?: NodeKind;
  state?: NodeState;
  blockReason?: string;
  repository?: string;
}>;

export function listNodes(
  dependencies: ListNodeDependencies,
  input: NodeListFilter,
): readonly NodeListItem[];
```

**The filtering happens in the query, over the rows `PlanStore.readAllNodes` returns.** `services/plan` gains no method and no SQL changes.

- `project` matches `node.projectId`.
- `kind` matches `node.kind`.
- `state` matches `node.state`.
- `blockReason` matches `node.blockReason`.
- `repository` matches the repository of the node's objective. `src/domain/node.ts:29-31` refines `nodeRow` so `repositoryId` is non-null on an **objective** and null at the other two levels. An objective therefore matches on its own `repositoryId`; a task matches on the `repositoryId` of the node its `parentId` names; an **initiative never matches** a `repository` filter. Resolve the parent from the same `readAllNodes` result. Do not query the database twice.

**Filters combine with `AND`.** An absent key filters nothing. An **empty** query returns exactly what it returns today. The order stays by identity, unchanged.

## Constraints

- Exactly five filter keys. Add no sixth, and add no `limit`, `after` or `order` key.
- Each key is single-valued. Do not accept a repeated key, and do not accept a comma-separated list.
- `services/plan` gains no method. Do not push the filter into SQL.
- The order is by identity and does not depend on the filter.
- Change no member of `NodeListItem`, and add no lease member to any read route. `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:14` gives the node lease field to EPIC 111.
- Do not change `node.show` or `edge.list`.

## Verify

`src/queries/node/list-node.test.ts` — extend. Fixture: two projects, each with one initiative, one objective bound to a distinct repository, and two tasks; states spread over `pending`, `ready`, `running` and `blocked`; one `blocked` node carrying `dirty-recovery`.

- `an empty filter returns every node ordered by identity` — the existing assertion, unchanged.
- `each filter alone selects its rows` — five `it` blocks, one per key, each asserting the exact identity list in identity order.
- `two filters combine with AND` — `state` and `kind` together; assert the exact identity list, and assert it is a strict subset of each filter alone.
- `repository matches an objective and its tasks, and never an initiative` — assert the objective and its two tasks are returned, the other objective's tasks are not, and no initiative appears in the result.
- `a filter that matches nothing returns an empty list`.
- `the order does not depend on the filter` — assert the filtered list is the identity-ordered subsequence of the unfiltered list.

`src/http/server/node/list-node.test.ts` — extend.

- `a repeated filter key is 400 invalid-request` — `?state=ready&state=running`.
- `an unknown key is 400 invalid-request` — `?owner=me`.
- `a filter value outside its enum is 400 invalid-request` — `?kind=epic`.
- `no query returns exactly what it returned before this epic` — drive the fixture of `.agent/plan/epics/008-project-and-plan.md:61` and assert the body is byte-identical to the recorded pre-epic body.
- `state=ready&kind=task returns only the ready tasks, ordered by identity` — assert the exact identity list.
- `the handler passes the parsed filter to the query exactly once` — a counting stub asserting the received object.

Run:

- `node --test src/queries/node/list-node.test.ts src/http/server/node/list-node.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts` exits 0.
- `npm run verify` exits 0. The generated OpenAPI master validates with the new query schema.
- Proof: `PASS EPIC-018`, through `src/queries/node/list-node.test.ts` and `src/http/server/node/list-node.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:210-211`.
