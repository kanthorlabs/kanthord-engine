# Story 7 — `plan.import` writes through the mutation API

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: Story 4 and Story 5.

**Member of the atomic unit 04 + 05 + 07 + 08 + 10.** Run every member before `npm run verify`; no intermediate state of the unit typechecks. See `index.md` for why.

## Change

### `src/commands/plan/import-plan.ts`

Replace three loops with one call. The edge reconciliation that computes the sets stays exactly as it is.

1. Delete the `dependencies.plan.upsertNode(transaction, {...})` call at `src/commands/plan/import-plan.ts:418-430`. Keep the surrounding `for (const node of candidate.nodes)` loop at `:406-431` and its `repositoryId` resolution at `:407-417`, and collect the node writes into a local array instead:

```ts
    const nodeWrites: NodeWrite[] = [];
    ...
      nodeWrites.push({
        id: node.id,
        projectId: input.projectId,
        kind: node.kind,
        parentId: node.parentId,
        title: node.title,
        instructionBlob: node.instructionBlob,
        acceptanceBlob: node.acceptanceBlob,
        worker: node.worker,
        repositoryId,
        revision,
        updatedAt,
      });
```

2. Delete the `dependencies.plan.deleteEdge(transaction, edge.id)` call at `:452`. Collect `edge.id` into `deleteEdgeIds` inside the same loop at `:450-454`.
3. Delete the `dependencies.plan.insertEdge(transaction, {...})` call at `:464-468`. Collect the same object into `insertEdges` inside the same loop at `:463-469`. Keep the `toInsert.sort` at `:458-462` byte for byte; it is the determinism of edge identity minting.
4. Insert one call at the position of the current line 469, after the edge reconciliation and before the `node.imported` loop at `:471`:

```ts
dependencies.plan.mutateGraph(transaction, {
  projectId: input.projectId,
  nodes: nodeWrites,
  insertEdges,
  deleteEdgeIds,
  at: updatedAt,
  cause: { revision, importId: input.importId },
});
```

Discard the return value. The command asserts nothing about the transitions; the events the store appended are the record.

`revision` comes from `src/commands/plan/import-plan.ts:355` and `updatedAt` from `:356`. Both already exist.

The readiness events therefore precede the `node.imported` appends at `:471` and the `plan.imported` append at `:481`. Do not reorder those two appends.

### Import `NodeWrite`

Add `NodeWrite` and `EdgeWrite` to the existing type-only import of `../../services/plan/index.ts` in `src/commands/plan/import-plan.ts`.

### The retry path

`src/commands/plan/import-plan.ts:151-153` returns `retryResult(...)` before any write. Add no call there. A retry changes no row, so it derives no readiness and appends no readiness event.

### `ImportPlanDependencies`

Add no member. Readiness reaches the command through `dependencies.plan`.

## Constraints

- Change no validation, no blob write, no `insertRevision` call and no refusal.
- Change no line of `renderCandidate`, `renderResolved`, `retryResult` or `staleConflicts`.
- The command imports no vendor package and no service implementation. `eslint.config.js:248-274` enforces it.
- Do not change the `actorKind: "human"` or `actorId: input.actor` of `node.imported` at `:476-477` or of `plan.imported` at `:485-486`. Story 9 attributes the readiness events only.
- `plan.export` must stay byte-identical. A state write touches no column `exportPlan` reads.

## Verify

### `src/commands/plan/import-plan.test.ts`

- `src/commands/plan/import-plan.test.ts:340` becomes `const plan = createPlanStore(createReadiness(log.events, "daemon_test"))`, using the recording event log built at `:345`. Move the `createRecordingEventLog()` call above the `createPlanStore` call so the same log serves both. The readiness events then land in `fixture.recorded` beside the import events.
- Add `it("an import leaves a ready frontier", ...)`. Import the round-trip fixture and assert the stored state of every node by identity through `plan.readGraph`. The fixture is `test/helpers/plan.ts:29-34`: `initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV`, `objective_01BQZ3NDEKTSV4RRFFQ69G5FAV`, `task_01DRZ3NDEKTSV4RRFFQ69G5FAV` and `task_01ERZ3NDEKTSV4RRFFQ69G5FAV`. Assert each identity with its state. Assert no count.
- Add `it("a task with a sibling dependency stays pending and its dependency is ready", ...)` using `withTaskDependsOn` at `src/commands/plan/import-plan.test.ts:635-649`. Assert the dependent is `pending` and the dependency is `ready`.
- Add `it("a re-import that adds an unsatisfied dependency demotes a ready node", ...)`. Import once, assert the node is `ready`, then import a second revision that adds a `depends_on` to that node, and assert:
  - the node is `pending`;
  - exactly one `node.pending` event exists for it, with `payload.reason === "dependency-unsatisfied"`;
  - every dependent of that node keeps the state it held before the second import, asserted field by field. No cascade occurs.
- Add `it("a retry of a committed importId writes no transition and appends no readiness event", ...)`. Use the existing `snapshot(storage)` helper at `src/commands/plan/import-plan.test.ts:419`. Compare the whole snapshot before and after the retry with `assert.deepEqual`, and assert `fixture.recorded` gained no entry whose `type` is `node.ready` or `node.pending`.
- Add `it("an import that satisfies a dependency leaves a running, blocked, awaiting_approval, done, partial or discarded node untouched", ...)`. Seed one node in each of the six states, import a revision that satisfies each one's dependencies, and compare each row field by field before and after. Then add the mirror case: import a revision that adds an unsatisfied dependency to each of the six, and compare each row field by field again. Twelve comparisons.
- Add `it("the readiness event order of one import is bytewise by node identity", ...)`. Read the `node.ready` entries out of `fixture.recorded` in order and assert their `subjectId` sequence equals the same list sorted through `Buffer.compare`.
- Add `it("the readiness events precede the node.imported events", ...)`. Assert the index of the last `node.ready` entry in `fixture.recorded` is lower than the index of the first `node.imported` entry.
- Every existing `it` in the file keeps passing. The `node.imported` count assertion at `src/commands/plan/import-plan.test.ts:862-872` filters by `entry.input.type === "node.imported"` and therefore ignores the new events. Do not change it.
- Add `it("plan.export is byte-identical after readiness lands", ...)` — or extend the existing round-trip test. Assert the exported documents deep-equal `expectedDocuments` after an import that promoted nodes.

### `src/http/server/plan/import-plan.test.ts`

- The four `createPlanStore()` sites at `:145`, `:291`, `:361` and `:523` pass `createReadiness(...)` over a recording event log, or keep the zero-argument form where the test asserts no event. Update every node-state assertion in the file to the derived frontier.

### Commands

- `node --test src/commands/plan/import-plan.test.ts src/http/server/plan/import-plan.test.ts src/http/server/plan/export-plan.test.ts src/queries/plan/export-plan.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/commands/plan/import-plan.test.ts` and `src/http/server/plan/*.test.ts`. Hermetic coverage: `.agents/plan/epics/016-readiness-applied.md:92`, `:95`, `:96`, `:97`, `:109` and `:110`.
