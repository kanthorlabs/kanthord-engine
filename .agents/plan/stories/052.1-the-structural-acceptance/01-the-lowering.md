# Story 1 — The lowering

Epic: `.agents/plan/epics/052.1-the-structural-acceptance.md`
Depends on: EPIC 052 Story 1 (`01-the-patch-shape-and-its-canonical-form`) for `GraphPatch`, EPIC 052
Story 2 (`02-the-staged-graph-and-target-legality`) for `stagePatch`, and EPIC 052 Story 5
(`05-the-seams-the-acceptance-needs`) for the `deliverable` and `verifyJson` fields of `NodeWrite`.
Kind: story-foundation

## Change

**`scripts/epic-sequence-range.ts` — append `"052.1"` to `authoredEpics`.** The list is at
`scripts/epic-sequence-range.ts:1` — `authoredEpics`. Insert the one element after `"052"`, in
sequence order. `.agents/plan/epics/053-node-state-ownership.md:5` — `authoredEpics` records that
EPIC 052 and EPIC 052.1 each own their own insert and that EPIC 053 adds neither.

This edit is first in the epic because `validateScenarioFiles` at
`test/sequence/conformance.test.ts:104` — `validateScenarioFiles` refuses a scenario file whose id
names no live diagram, and Story 2 adds the epic's first scenario file. Without the insert,
`readEpics` at `scripts/verify-epic-sequence.ts:410` — `readEpics` never reads this epic's stories, so
every scenario id of it resolves to nothing.

`test/sequence/conformance.test.ts:255` — `assert.deepEqual` pins the matching literal. Add `"052.1"`
to that array in the same position. Do **not** touch `shippedEpics`: Story 8
(`08-the-report-route-carries-a-patch`) appends `"052.1"` to it, and the two lists are separate
because `shippedEpics` is what makes a scenario due.

**`src/domain/graph-patch-lower.ts` — add `lowerPatch`, a pure function that turns one patch into the
field sets `plan.mutateGraph` takes, in an order SQLite accepts.**

`src/services/storage/connection.ts:8` — `foreign_keys` sets `PRAGMA foreign_keys = ON` at every open,
`src/services/storage/migration-0002-graph-and-plan.ts:21` — `parent_id` references `node(id)` with no
`DEFERRABLE` and no `ON DELETE CASCADE`, and `src/services/storage/migration-0002-graph-and-plan.ts:45`
— `from_node` and `:46` — `to_node` do the same. `src/services/plan/sqlite.ts:467` — `mutateGraph`
iterates each array in caller order, in the phase order nodes, edge deletes, node deletes, edge
inserts. The phase order settles edges against nodes. The order **inside** each array is this
function's obligation.

### 1 — the signature

```ts
export type LowerPatchDependencies = Readonly<{ mintEdgeId: () => string }>;

export type ResolvedProse = Readonly<{
  instructionBlob: string;
  acceptanceBlob: string | null;
}>;

export type LowerPatchInput = Readonly<{
  pinnedNodes: readonly StoredNode[];
  pinnedEdges: readonly StoredEdge[];
  staged: StagedGraph;
  patch: GraphPatch;
  prose: ReadonlyMap<string, ResolvedProse>;
  revision: string;
  updatedAt: number;
}>;

export type LoweredPatch = Readonly<{
  nodes: readonly NodeWrite[];
  insertEdges: readonly EdgeWrite[];
  deleteEdgeIds: readonly string[];
  nodeDeletes: readonly string[];
}>;

export function lowerPatch(
  dependencies: LowerPatchDependencies,
  input: LowerPatchInput,
): LoweredPatch;
```

**The edge id arrives through an injected function, and never through `ids`.** `eslint.config.js:312`
— `src/domain/**/*.ts` forbids `domain/` every vendor package and every `node:` builtin, and
`AGENTS.md` states a ULID is minted by a service and passed in.
`src/domain/plan-candidate.ts:304` — `validateCandidateStructural` is the shape precedent in this same
directory: a `dependencies` object first, the input second. `acceptStructural` passes
`() => dependencies.ids.mint("edge")`.

`StagedGraph` is EPIC 052 Story 2's output. `lowerPatch` reads two things from it and nothing else:
the final `parentId` of every surviving node, and the final dependency list of every surviving node.
**EPIC 052 Story 2 must expose both.** A staged value that carries only ids cannot order a create
parent-first.

### 2 — created and updated nodes, parent-first

Emit one `NodeWrite` per `create` and per `update`, ordered so that a node's final parent precedes it.

- Build the map from node id to final `parentId` over the staged nodes.
- Walk the written ids, and emit a node only after every ancestor of it that is itself written has
  been emitted. A written node whose final parent is not written is emitted immediately, because that
  parent already sits in the pinned graph.
- Break a tie between two writable nodes by `Buffer.compare` over the utf-8 bytes of their ids, as
  `src/commands/node/create-node.ts:157` — `Buffer.compare` does for a dependency list. Determinism
  needs the tie broken, and the epic's Proof asserts an exact array.

### 3 — an `update` submits a complete row

`src/services/plan/sqlite.ts:43` — `INSERT_NODE` is `ON CONFLICT(id) DO UPDATE SET` over
`kind`, `parent_id`, `title`, `instruction_blob`, `acceptance_blob`, `worker`, `repository_id`,
`revision` and `updated_at`, each unconditionally from `excluded`. An absent field is therefore not
preserved by the statement: it is overwritten with whatever the write carries. `lowerPatch` overlays
the named patch fields onto the pinned row and resubmits every other field from that row.

`state`, `block_reason`, `discard_reason` and `assignment` are in the `VALUES` list and in no `SET`
clause, so the upsert never moves them. That is what keeps a structural acceptance from touching node
state.

`deliverable` and `verify_json` are the exception. `src/services/plan/sqlite.ts:435` —
`hasDeliverable` reads own-property presence with `Object.hasOwn`, and `:451` — `hasDeliverable`
binds the two has-flags of `INSERT_NODE`. So:

- a mutation that names `deliverable` emits the key with its value;
- a mutation that does not name `deliverable` emits **no `deliverable` key at all**, so the stored
  value survives. `deliverable: undefined` is an own property and would clear the column.

The same rule governs `verifyJson`.

**The blob fields arrive through `prose`, and never through the patch.** `GraphPatch` carries
`instruction` and `acceptance` as prose, so it holds no hash and cannot be the carrier. `prose` maps a
mutation id to the two hashes the caller already resolved. A `create` reads its entry; an `update`
reads its entry when the mutation names `instruction` or `acceptance`, and the pinned row otherwise;
a node the patch does not touch keeps the pinned hashes. **A missing entry is a programming error, not
a refusal**: throw a plain `Error` naming the id, because every legality check ran before the lowering.
`lowerPatch` never encodes bytes and never hashes them.

### 4 — every obsolete edge id

Emit into `deleteEdgeIds` the id of every pinned edge that the staged graph does not hold, ordered by
`Buffer.compare` over the utf-8 bytes of the edge id. A `dependsOn` replacement therefore deletes
every existing edge whose `fromNode` is the mutated node, and a `delete` mutation deletes every edge
naming the deleted node in either column.

### 5 — deleted node ids, child-first

Emit into `nodeDeletes` the id of every `delete` mutation, ordered so that a node precedes its own
pinned parent. Break a tie by `Buffer.compare` over the utf-8 bytes of the id.

### 6 — every final edge, with a fresh id

Emit one `EdgeWrite` per dependency of the staged graph that the pinned graph does not already hold,
`{ id: dependencies.mintEdgeId(), fromNode, toNode }`, ordered by `fromNode` then `toNode`, each
compared with `Buffer.compare` over utf-8 bytes. The order fixes the mint order, so a mock generator
yields the same id for the same edge on every run.

## Constraints

- The function is pure. It reads no clock, opens no transaction and touches no store.
- It imports from `src/domain/` and `zod` only. `eslint.config.js:315` — `no-restricted-imports`
  enforces it.
- It decides no legality. Every refusal of this epic is decided before the lowering runs, so
  `lowerPatch` may assume the patch is legal against the pinned graph.
- It never emits a `deliverable` or a `verifyJson` own property for a mutation that names neither.
- Every emitted array is ordered by an explicit rule. No array is left in patch order.

## Verify

```
node --test src/domain/graph-patch-lower.test.ts src/services/plan/sqlite.test.ts test/sequence/conformance.test.ts
```

Add `src/domain/graph-patch-lower.test.ts`. Follow `src/domain/node-pair.test.ts:8` — `describe` for
the suite name and the exhaustive-value style. Cases 1, 2, 3 and 5 apply the lowering against real
SQLite through `createMigratedStorage` at `test/helpers/database.ts:32` — `createMigratedStorage` and
`createPlanStore` at `test/helpers/plan.ts:50` — `createPlanStore`, seeded by `seedPlanFixture` at
`test/helpers/plan.ts:172` — `seedPlanFixture`, because the constraint under test is a database
constraint. Put those four in `src/services/plan/sqlite.test.ts`, which already builds that fixture at
`src/services/plan/sqlite.test.ts:50` — `build`.

Add, each as a separate `it`:

1. `"a patch creating a parent and its child lowers parent-first, and applies"` — a patch creating
   objective `O2` under the pinned initiative and task `T2` under `O2`. Assert
   `lowered.nodes.map((node) => node.id)` deep-equals `["O2", "T2"]` by value, then call
   `plan.mutateGraph` with it and assert both rows exist by reading them back. This is the epic's
   gate row 1.

2. `"the control: the same two nodes child-first raise FOREIGN KEY constraint failed"` — pass
   `{ ...lowered, nodes: [...lowered.nodes].reverse() }` to `plan.mutateGraph` and assert the thrown
   error message contains `FOREIGN KEY constraint failed`. This is the control the epic's gate row 2
   names: without it, the ordering assertion of case 1 proves nothing.

3. `"a patch deleting a parent and its child lowers child-first, and applies"` — the pinned fixture
   holds objective `O` and its task `T`; the patch deletes both. Assert
   `lowered.nodeDeletes` deep-equals `["T", "O"]`, apply it, and assert both rows are gone. Then apply
   the reversed array against a fresh fixture and assert `FOREIGN KEY constraint failed`. This is
   the epic's gate row 3.

4. `"an update naming only title resubmits every other field from the pinned row"` — assert the one
   emitted `NodeWrite` field by field: `id`, `projectId`, `kind`, `parentId`, `title` (the new value),
   `instructionBlob`, `acceptanceBlob`, `worker`, `repositoryId`, `revision` (the new revision id) and
   `updatedAt`. Assert `Object.hasOwn(node, "deliverable")` is `false` and
   `Object.hasOwn(node, "verifyJson")` is `false`, which is the has-flag path. This is the epic's
   gate row 4.

5. `"an update naming no deliverable leaves the stored deliverable unchanged"` — seed a node whose
   `deliverable` is `expansion`, lower an `update` naming only `title`, apply it, read the row back
   and assert `deliverable` is still `expansion` and `verify_json` is still its seeded value.
   This is the epic's gate row 5.

6. `"a dependsOn replacement deletes every existing edge of the node and inserts one per final entry"`
   — the pinned node depends on `A` and `B`; the patch replaces its `dependsOn` with `B` and `C`.
   Assert `deleteEdgeIds` holds exactly the two pinned edge ids, sorted bytewise; assert
   `insertEdges.length` is `1`; assert that one edge's `fromNode` and `toNode` by value; and assert
   its `id` equals the id the injected `mintEdgeId` returned first. This is the epic's gate row 6.

7. `"the mint order is fixed by fromNode then toNode"` — a patch adding three dependencies whose
   endpoints sort in an order the patch does not use. Assert `insertEdges` endpoints in the exact
   expected order, and assert the three ids in the exact order the stub generator yields them.

8. `"a create takes both blob hashes from prose and never from the patch"` — a `create` whose
   `prose` entry names two hashes. Assert the emitted `NodeWrite.instructionBlob` and
   `acceptanceBlob` equal those two by value, and assert a `create` whose id is absent from `prose`
   throws an `Error` naming the id.

9. `"an update naming deliverable emits the key, so the has-flag is set"` — assert
   `Object.hasOwn(node, "deliverable")` is `true` and the value equals the named one. This is the
   control for case 4: without it, case 4 passes for a function that emits no field at all.

`pnpm run verify` exits 0, and `pnpm run lint` exits 0 over the new `src/domain/` file.

Proof: PASS line delivered — `src/domain/graph-patch-lower.test.ts` in `PASS EPIC-052.1`.
