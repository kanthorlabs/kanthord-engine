# Story 4 — The store carries the origin and closes the mutation set

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: Story 2 (the column exists). Depends on EPIC 014 Story 9 (`RevisionOrigin` in `src/domain/plan-revision.ts`) and EPIC 016 Story 4 (`mutateGraph` and `MutateGraphInput`).

## Change

### `src/services/plan/index.ts`

`RevisionRecord` at `src/services/plan/index.ts:10-17` becomes:

```ts
export type RevisionRecord = Readonly<{
  id: string;
  parentId: string | null;
  origin: RevisionOrigin;
  importId: string | null;
  submittedBlob: string | null;
  choicesBlob: string | null;
  acceptedBlob: string;
}>;
```

Import `RevisionOrigin` as a type from `../../domain/plan-revision.ts`.

`MutateGraphInput`, which EPIC 016 Story 4 declares, gains exactly one member after `deleteEdgeIds`:

```ts
  nodeDeletes: readonly string[];
```

It gains no `trigger` member. The assertion at EPIC 016 Story 4 that slices `export type MutateGraphInput` to the next `};` and asserts the slice excludes `trigger` must stay green.

Add no fourth mutation method. `insertRevision`, `mutateGraph` and `setNodeState` stay the whole public write set.

### `src/services/plan/sqlite.ts`

- `SELECT_REVISION` at `src/services/plan/sqlite.ts:20-21` gains `origin` between `parent_id` and `import_id`. `RevisionRow` at `:54-61` gains `origin: RevisionOrigin` — **not `string`** — and makes `import_id`, `submitted_blob` and `choices_blob` nullable. Every other `*Row` type in this file declares its enum columns at the domain type, and `tsconfig.json` sets `"strict": true`, so a `string` field cannot be mapped into `RevisionRecord.origin` without a narrowing step. Declaring the row field at `RevisionOrigin` matches the file's existing convention and needs no narrowing. The row-to-record mapper carries the four fields through unchanged.
- `insertRevision` at `:285-301` writes eight columns:

```sql
INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

The bind order matches the column order above.

- `mutateGraph` gains one step. Its order becomes exactly:

  1. `insertNode` once per member of `input.nodes`, in the given order.
  2. `removeEdge` once per member of `input.deleteEdgeIds`, in the given order.
  3. `DELETE FROM node WHERE id = ?` once per member of `input.nodeDeletes`, in the given order. The caller supplies the list child-first; the store does not reorder it.
  4. `addEdge` once per member of `input.insertEdges`, in the given order.
  5. `readGraph`.
  6. `readiness.apply`.
  7. Write each returned transition through `UPDATE_NODE_STATE`.
  8. Return the transitions.

  Add one SQL constant beside `UPDATE_NODE_STATE`:

```ts
const DELETE_NODE = "DELETE FROM node WHERE id = ?";
```

Declare it above `INSERT_NODE`, so the first `ON CONFLICT` in the module source still belongs to `INSERT_NODE` and the source-scan assertion at `src/services/plan/sqlite.test.ts:537-554` stays green.

The delete runs after the edge deletes and before the edge inserts, because `edge.from_node` and `edge.to_node` are foreign keys onto `node(id)`. It runs before the readiness pass, so a deleted node contributes no state and no edge to the derivation.

- `newestRevision` at `:163-169` is unchanged. A ULID sorts by mint time, so a `node-write` revision becomes the newest.
- `findByImportId` at `:189-209` is unchanged. `import_id IS NULL` matches no supplied key, so a `node-write` row is never returned by an idempotency lookup.

### `src/http/contract/graph.ts`

`planRevisionEntry` at `src/http/contract/graph.ts:39-46` becomes:

```ts
export const planRevisionEntry = z.strictObject({
  id: z.string(),
  parentId: z.string().nullable(),
  origin: z.enum(revisionOrigins),
  importId: z.string().nullable(),
  submittedBlob: blobHash.nullable(),
  choicesBlob: blobHash.nullable(),
  acceptedBlob: blobHash,
});
```

Import `revisionOrigins` from `../../domain/plan-revision.ts`. Update `planRevisionsExamples` so the success example carries `origin: "import"`.

### `src/queries/plan/list-revision.ts`

`RevisionEntry` is `RevisionRecord`, so it carries the four fields with no edit. Change nothing in this file unless `npm run typecheck` names it.

### The compatibility edits this story owns

Widening `RevisionRecord` and `MutateGraphInput` breaks every existing caller at once. This story owns each of those edits, and no later story does. Without them `npm run typecheck` fails on this commit.

- `src/commands/plan/import-plan.ts:395` — the one production `insertRevision` call. Add `origin: "import"`. Change nothing else in this file; Story 5 owns its validation branches.
- The `mutateGraph` call EPIC 016 Story 7 puts in `src/commands/plan/import-plan.ts` — add `nodeDeletes: []`.
- Six test `insertRevision` call sites gain `origin: "import"`: `src/queries/plan/export-plan.test.ts:208`, `src/queries/plan/validate-plan.test.ts:552`, `src/queries/plan/list-revision.test.ts:49` and `:104`, `src/services/plan/sqlite.test.ts:600` and `:625`.
- Five fixture files insert `plan_revision` rows through raw SQL against the **current** schema and gain the `origin` column with the value `'import'`: `test/helpers/rows.ts`, `test/helpers/recovery.ts`, `src/commands/startup/recover-expired-leases.test.ts`, `src/queries/project/read-project-status.test.ts`, `src/commands/provider/remove-provider.test.ts`.
- `src/services/storage/migration-0002-graph-and-plan.test.ts` inserts against the **version-2** schema through its own local `insertRevision` helper at `:584-657`, on a database built from `[coreEntities, graphAndPlan]` only. Those rows never see migration 0006. **Leave every one of them unchanged.**

The rule that separates the two groups: a fixture built through `createMigratedStorage` reaches version 6 and needs the column; a fixture built from a truncated migration array stops before 0006 and must not carry it.

## Constraints

- Do not change `INSERT_NODE` at `src/services/plan/sqlite.ts:25-28`. It keeps its `'pending'` literal, its `NULL, NULL` reasons and its `ON CONFLICT(id) DO UPDATE SET` list byte for byte.
- `mutateGraph` opens no transaction and reads no clock.
- The store applies `nodeDeletes` in the given order and sorts nothing. Ordering is the caller's obligation, so the write order is reproducible from the input alone.
- Do not add a `nodeDeletes` member to `SetNodeStateInput`.
- The only edits permitted outside `src/services/plan/`, `src/http/contract/graph.ts` and `src/queries/plan/` are the compatibility edits listed above. Add no behaviour to `src/commands/plan/import-plan.ts` beyond the two added members.

## Verify

Extend `src/services/plan/sqlite.test.ts`.

- `insertRevision writes an import revision with every provenance column` — insert with `origin: "import"` and three non-null fields; read it back through `listRevisions` and assert every field with `assert.deepEqual`.
- `insertRevision writes a node-write revision with three null provenance columns` — insert with `origin: "node-write"`, `importId: null`, `submittedBlob: null`, `choicesBlob: null`; read it back and assert every field.
- `findByImportId never returns a node-write revision` — insert one `node-write` row and one `import` row under one project, look up the import key, and assert the returned record is the import row. Look up a key no row holds and assert `null`.
- `newestRevision returns a node-write revision minted after an import revision` — insert an `import` row, then a `node-write` row with a greater ULID, and assert `newestRevision` returns the second id.
- `mutateGraph deletes a node` — seed a parent and one child, call `mutateGraph` with `nodeDeletes: [childId]` and no other change, and assert the `node` table holds the parent only.
- `mutateGraph deletes edges before it deletes nodes` — seed two nodes and one edge between them, call `mutateGraph` with `deleteEdgeIds: [edgeId]` and `nodeDeletes: [toNodeId]`, and assert the call succeeds and both rows are gone. Without the ordering the foreign key refuses.
- `mutateGraph applies nodeDeletes in the given order` — **two independent fixtures, each on its own database.** On the first, call with `nodeDeletes: [childId, parentId]` and assert both rows are gone. On the second, freshly seeded with the same parent and child, call with `nodeDeletes: [parentId, childId]` and assert the call throws on the `node.parent_id` foreign key. Reusing one database is a defect: after the first call both rows are gone, so the reversed call would delete nothing and throw nothing. The assertion establishes that the store applies the order it is given; it does not by itself establish that no reordering exists anywhere, and the test name must not claim that.
- `mutateGraph applies readiness after the deletes` — seed a `pending` node whose only dependency is a second node, call `mutateGraph` with the edge id in `deleteEdgeIds` and the dependency id in `nodeDeletes`, and assert the returned transitions name the surviving node with `{ from: "pending", to: "ready", trigger: "readiness-promoted" }` and that its stored state is `ready`.
- `MutateGraphInput declares no trigger member` — the EPIC 016 source-scan assertion stays, and it now also asserts the slice includes `nodeDeletes`.
- `node --test src/services/plan/sqlite.test.ts src/queries/plan/list-revision.test.ts src/http/contract/graph.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/services/plan/sqlite.test.ts`, `src/queries/plan/list-revision.test.ts` and `src/http/contract/*.test.ts`.
