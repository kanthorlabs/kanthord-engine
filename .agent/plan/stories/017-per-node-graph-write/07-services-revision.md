# Story 7 — `services/revision`, the one projection and the one mint

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: Story 4 (`RevisionRecord` carries `origin`).

## Change

### A new `src/services/revision/index.ts`

The interface file. It imports `domain/` and service interfaces only, and it holds no `implements`. `src/domain/layout.test.ts:159-175` forbids the string `implements ` in every `src/services/*/index.ts`.

```ts
export type RevisionRenderInput = Readonly<{
  nodes: readonly StoredNode[];
}>;

export type RevisionRecordInput = Readonly<{
  projectId: string;
  revisionId: string;
  parentRevision: string | null;
  documents: readonly RenderedDocument[];
}>;

export type RevisionRefusal = "repository-unknown";

export class RevisionError extends Error {
  readonly refusal: RevisionRefusal;
  constructor(refusal: RevisionRefusal, message: string) {
    super(message);
    this.name = "RevisionError";
    this.refusal = refusal;
  }
}

export interface Revision {
  render(
    transaction: Transaction,
    input: RevisionRenderInput,
  ): readonly RenderedDocument[];
  record(transaction: Transaction, input: RevisionRecordInput): void;
}
```

### A new `src/services/revision/node-write.ts`

Export `class NodeWriteRevision implements Revision`, with dependencies `{ blobs: BlobStore; plan: PlanStore }` taken through a constructor object.

`render` is the complete shared projection. It runs in exactly this order:

1. Read `SELECT id, name FROM repository` from the transaction into a `Map<string, string>`.
2. For each node of `input.nodes`, in the given order:
   - `blobs.get(node.instructionBlob, transaction)`; a `null` throws `new Error(\`blob ${node.instructionBlob} is missing from the store\`)`.
   - When `node.acceptanceBlob` is not null, `blobs.get(...)` the same way; a `null` throws the same message shape.
   - Decode both through one module-level `new TextDecoder()`.
   - When `node.repositoryId` is not null, translate it through the map. A miss throws `new RevisionError("repository-unknown", \`repository ${node.repositoryId} is not registered\`)`.
   - Set the bodies entry to `{ instruction, acceptance, worker: node.worker, repo }`.
3. Build the `CanonicalNode` list by mapping each node to `{ identity: node.id, kind: node.kind, title: node.title, parentIdentity: node.parentId, dependencies: node.dependencies }`, in the given order.
4. Return `renderDocumentSet(canonicalNodes, bodies)` of `src/domain/plan-render.ts:72`.

That is the body of `src/queries/plan/export-plan.ts:63-125` moved with no behaviour change. `renderDocumentSet` sorts by canonical path, so the input node order does not reach the output.

`record` runs in exactly this order:

1. `const hash = blobs.put(transaction, encoder.encode(canonicalDocumentsJson(input.documents)))`, using `canonicalDocumentsJson` of `src/domain/plan-hash.ts:5-12` and one module-level `new TextEncoder()`.
2. `plan.insertRevision(transaction, { id: input.revisionId, projectId: input.projectId, parentId: input.parentRevision, origin: "node-write", importId: null, submittedBlob: null, choicesBlob: null, acceptedBlob: hash })`.

`record` reads no graph and mints no id. The caller renders an in-memory node set and passes the result in.

### `src/queries/plan/export-plan.ts`

- `ExportPlanDependencies` gains `revision: Revision` and **drops `blobs`**. After the extraction no expression in the file reads it, and `tsconfig.json` sets no `noUnusedLocals`, so TypeScript will never diagnose a leftover property. Decide it here rather than leaving it to the implementer: remove `blobs` and remove the `BlobStore` import.
- Delete `readRepositoryNamesById` at `:33-40`, the bodies loop at `:65-114` and the `canonicalNodes` map at `:115-121`.
- Replace them with one call:

```ts
try {
  return {
    revision,
    documents: dependencies.revision.render(transaction, { nodes }),
  };
} catch (error) {
  if (error instanceof RevisionError) {
    throw new ExportPlanError(error.refusal, error.message);
  }
  throw error;
}
```

`RevisionRefusal` is exactly `"repository-unknown"`, which is already a member of `ExportPlanRefusal` at `:19`, so the declared error set of `plan.export` does not change.

### The call-site edits this story owns

Making `revision` a required dependency breaks every `exportPlan` caller at once. This story owns each of those edits, and no later story does. Without them `npm run typecheck` fails on this commit.

- `src/main.ts:320` — `exportPlan: (input) => exportPlan({ storage, plan, revision }, input)`, where `revision` is a `new NodeWriteRevision({ blobs, plan })` constructed once beside the other service implementations. **This is the whole composition edit this story makes.** Story 13 adds the three command bindings and the three handlers; it does not re-wire `exportPlan`.
- `src/http/server/plan/export-plan.test.ts:42` and every `exportPlan(...)` call site in `src/queries/plan/export-plan.test.ts` (thirteen sites, `:92` to `:364`), `src/queries/plan/validate-plan.test.ts` (seven sites, `:332` to `:742`), `src/http/server/plan/import-plan.test.ts:152` and `:529`, and `src/commands/plan/import-plan.test.ts:629` and `:908`.
- Add one shared fixture to `test/helpers/plan.ts`: `export function createRevision(blobs: BlobStore, plan: PlanStore): Revision`, returning `new NodeWriteRevision({ blobs, plan })`. Every call site above uses it, so a later constructor change edits one file.

### `src/domain/layout.test.ts`

- Change the `it` title at `src/domain/layout.test.ts:101` from `src/services/ holds exactly the sixteen capabilities plus home-lock` to `src/services/ holds exactly the seventeen capabilities plus home-lock`. EPIC 015 raises the count to fifteen, EPIC 016 to sixteen, and this story to seventeen.
- Add `"revision"` to the sorted directory array asserted at `:108-124`, between `"readiness"` and `"storage"`.

`renderCandidate` at `src/commands/plan/import-plan.ts:613` stays a separate function. Its bodies come from submitted document text rather than from stored blobs, and `008-project-and-plan.md:61` already pins its output equal to the export bytes.

## Constraints

- `src/services/revision/node-write.ts` may import `domain/`, any service interface, and an implementation in the `revision` capability only. It must not import `../plan/sqlite.ts`, `../blob/sqlite.ts` or any other capability's implementation.
- The capability needs no `not-implemented.ts`. `src/domain/layout.test.ts:144-157` requires one for `agent`, `verify` and `lease` only.
- `render` sorts nothing itself. `renderDocumentSet` is the one ordering rule.
- `record` writes exactly one blob and one row, and it appends no event.
- Do not change `src/commands/plan/import-plan.ts` in this story.
- Add no route, no handler and no contract row. Story 13 owns the transport.

## Verify

Create `src/services/revision/node-write.test.ts`, suite name `src/services/revision/node-write.test`. Use real SQLite through `createMigratedStorage` of `test/helpers/database.ts` and a real `BlobStore`.

- `render translates a repository id to its name` — one objective whose `repositoryId` names a registered repository; assert the rendered document content holds the repository **name** and not the id.
- `render throws repository-unknown for an unregistered repository` — assert `RevisionError` with refusal `repository-unknown` and the exact message shape.
- `render throws on a missing instruction blob` — assert the thrown `Error` message names the hash.
- `render returns documents sorted by canonical path` — pass the node list in reverse canonical order and assert the output order is the canonical one.
- `render reproduces the pre-extraction export bytes` — **a golden-bytes test, not a comparison with `exportPlan`.** After the refactor `exportPlan` calls `render`, so comparing the two compares an implementation with its own wrapper and asserts nothing. Instead: before editing `export-plan.ts`, run the existing `src/queries/plan/export-plan.test.ts` fixture, capture `canonicalDocumentsJson(result.documents)` for each of its graphs, and commit those strings as literal constants in `src/services/revision/node-write.test.ts`. Assert `canonicalDocumentsJson(render(...))` equals each literal through `Buffer.compare`. The fixtures must cover a task with an acceptance body, a node with a `worker`, an objective with a `repo`, a node with dependencies, and the null case of each.
- `record writes one node-write revision and one blob` — call `record`, then assert through `listRevisions` that the row carries `origin: "node-write"`, `importId: null`, `submittedBlob: null`, `choicesBlob: null` and a non-null `acceptedBlob`, and that `blobs.get(acceptedBlob)` decodes to `canonicalDocumentsJson(documents)` byte for byte.
- `record writes the given parent` — call with `parentRevision: null` and with a real parent id, and assert the stored `parentId` in each case.
- `record reads no graph` — pass a `documents` list that names no stored node and assert the row still inserts.
- `src/services/revision/index.ts` contains no occurrence of `implements ` — assert by source read, in the pattern of `src/domain/layout.test.ts:159-175`.
- `node --test src/services/revision/node-write.test.ts src/queries/plan/export-plan.test.ts src/domain/layout.test.ts` exits 0.
- `src/domain/layout.test.ts` asserts the capability list of EPIC 016 plus `revision`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/services/revision/node-write.test.ts`, `src/queries/plan/export-plan.test.ts` and `src/domain/layout.test.ts`. Hermetic coverage bullets `.agent/plan/epics/017-per-node-graph-write.md:144` and `:160`.
