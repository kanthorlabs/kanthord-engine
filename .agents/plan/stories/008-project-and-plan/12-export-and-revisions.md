# Story 12 — export and the revision lineage

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 02.5 (`PlanStore`), Story 07 (the renderer).

Export renders from the rows, never from `accepted_blob` (`docs/proposal/database/plan_revision.md:30`). Export writes no status.

## Change

### 1. The stored graph read is `PlanStore.readGraph`

Story 02.5 owns it, with `StoredNode` and `StoredEdge` in `src/domain/plan-graph.ts`. This story adds no read of its own beyond the project existence check.

### 2. `src/queries/plan/export-plan.ts` (new)

```ts
export type ExportPlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
}>;

export type ExportPlanResult = Readonly<{
  revision: string | null;
  documents: readonly RenderedDocument[];
}>;

export type ExportPlanRefusal = "project-not-found";

export function exportPlan(
  dependencies: ExportPlanDependencies,
  input: Readonly<{ projectId: string }>,
): ExportPlanResult;
```

Inside one `storage.transact`: the project read, `plan.readGraph`, `blobs.get` per `instruction_blob` and `acceptance_blob`, `canonicalPaths`, `renderDocumentSet`. `revision` is `plan.newestRevision`, `null` on a project with no revision, and `documents` is `[]` in that case.

A blob the node cites and the store does not hold throws. `docs/proposal/database/blob.md:20` — a blob is never deleted while any row references it — so an absent blob is corruption, not an empty document.

The rendered body is `blobs.get(instruction_blob).content` decoded as UTF-8, plus the acceptance content when present. No re-normalization runs: the stored bytes are already normalized, which is what makes export reproduce the import byte for byte (`plan-format.md:49`).

**No status field is emitted.** `RenderInput` has no state member, so a status cannot reach a document by accident. A test asserts that no rendered document contains `state`, `block_reason`, `blockReason`, `discard_reason` or `discardReason`.

### 3. `src/queries/plan/list-revision.ts` (new)

```ts
export type RevisionEntry = Readonly<{
  id: string;
  parentId: string | null;
  importId: string;
  submittedBlob: string;
  choicesBlob: string;
  acceptedBlob: string;
}>;

export function listRevisions(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<{ projectId: string }>,
): readonly RevisionEntry[];
```

The project read, then `plan.listRevisions`, both inside one `storage.transact`. `RevisionEntry` is `PlanStore`'s `RevisionRecord`, re-exported rather than redeclared.

Descending, so the head of the list is the revision an import must name in `fromRevision` (`docs/proposal/api/graph.md:94`). The three columns are hashes, not content: `blob.show` serves the content, and it is a `stubbed` route in this phase.

An unknown project throws `project-not-found`. An existing project with no revision returns `[]`.

### 4. `src/http/contract/graph.ts` — two response schemas

```ts
export const planExportResponse = z.object({
  revision: z.string().nullable(),
  documents: z.array(planDocument),
});

export const planRevisionEntry = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  importId: z.string(),
  submittedBlob: blobHash,
  choicesBlob: blobHash,
  acceptedBlob: blobHash,
});

export const planRevisionsResponse = z.object({
  revisions: z.array(planRevisionEntry),
});
```

`blobHash` is imported from `src/domain/blob.ts:5`, so the `sha256:` spelling has one definition (`docs/proposal/database/blob.md:16`).

Attach them to `plan.export` at `src/http/contract/graph.ts:30-40` and `plan.revisions` at `:42-52`.

### 5. `src/http/server/plan/export-plan.ts` and `list-revision.ts` (new)

Each reads `context.parameters["id"]`, calls one query, and returns `{ status: 200, body }`. `export` returns the result directly; `revisions` wraps as `{ revisions }`. `project-not-found` maps to `not-found`.

### 6. `src/main.ts` — bind `plan.export` and `plan.revisions`

### 7. Contract test counts after this story

This story is dispatched after Story 01 and before Story 08, so the counts step from Story 01's values.

- `registry.test.ts:78-99` — requests 5 (unchanged from Story 01). Responses 15: Story 01's thirteen plus `plan.export` and `plan.revisions`, bytewise sorted.
- `openapi.test.ts:205-224` — 21 schema keys.
- `system.test.ts:173-196` — `withResponse.length` is 15.
- `system.test.ts:212-214` (`plan.import carries no request schema today`) stays green. Story 11 removes it.

## Constraints

- Export renders from the rows through `plan.readGraph`. It never reads `accepted_blob`, and it holds one statement of its own, the project existence check.
- No status, no block reason and no discard reason reaches a document.
- A waived edge is exported as a `depends_on` entry.
- `docs/proposal/database/README.md:73` records that `node` is the one table where `ORDER BY id` is not creation order, which is accepted: the render order is the canonical path order, not the row order.
- `listRevisions` is descending by id.
- An absent blob throws.

## Verify

```
node --test src/queries/plan/export-plan.test.ts \
  src/queries/plan/list-revision.test.ts \
  src/http/server/plan/export-plan.test.ts \
  src/http/server/plan/list-revision.test.ts \
  src/http/contract/registry.test.ts src/http/contract/openapi.test.ts \
  src/http/contract/system.test.ts
```

Real SQLite through `createMigratedStorage()` with `seedRegistry` and `seedGraph`, plus direct writes for the multi-node cases. `seedGraph` writes one initiative, one objective and one task, all `pending`, all citing `fixtureIds.instructionBlob`, and `seedRegistry` writes that blob with the content `new Uint8Array([0])` — so the export cases that assert body bytes overwrite the blob rows with real markdown through `blobs.put` first.

### `export-plan.test.ts`

- **A seeded graph exports three documents at canonical paths**, asserted as an exact `(path, content)` table with the content written out in full as a template literal.
- The task document holds `## Acceptance criteria`; the objective and the initiative do not.
- The objective document holds `repo: "repo_a"`; the task does not.
- **No status.** For every document, assert the content contains none of `state`, `block_reason`, `blockReason`, `discard_reason`, `discardReason`. Then move the task to `blocked` with `block_reason = 'attempt-limit'` and `discard_reason` set, re-export, and assert the documents are `deepEqual` to the earlier ones. State moved and the bytes did not. That is the whole reason a plan document carries no state (`plan-format.md:35`).
- **Export is stable across a state change and across two calls.** Two calls `deepEqual`.
- `revision` equals the newest `plan_revision.id`, proved with a second revision row whose id sorts above the first.
- A project with no revision and no node returns `{ revision: null, documents: [] }`.
- A node citing a blob that is not in the store throws.
- A task whose stored body ends with two trailing spaces on its last line exports those spaces, byte for byte.
- An unknown project throws `project-not-found`.

### `list-revision.test.ts`

- Two revisions return newest first, asserted with ids inserted in ascending order.
- `parentId` chains: the second row's `parentId` is the first row's `id`.
- Every hash member matches `/^sha256:[0-9a-f]{64}$/`.
- No member carries content: `JSON.stringify(entry)` does not contain the blob's bytes.
- A project with no revision returns `[]`; an unknown project throws.

### The two handler tests

- `GET /v1/project/:id/plan/export` answers `200`, and `planExportResponse` parses the body.
- `GET /v1/project/:id/plan/revision` answers `200` with `{ revisions: [...] }`, and `planRevisionsResponse` parses it.
- An unknown project answers `404` on both.
- Both routes leave every row count unchanged.
- No response body names a daemon path.

`npm run verify` exits 0.

Proof: contributes `src/queries/plan/export-plan.test.ts` and `list-revision.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
