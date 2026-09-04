# Story 2 — The staged graph and target legality

Epic: `.agents/plan/epics/052-the-graph-patch-and-its-policies.md`
Depends on: Story 1 (`01-the-patch-shape-and-its-canonical-form`) for `GraphPatch` and `GraphMutation`.
Kind: story-foundation

This story adds the staging function and the first verdict of the ordered chain. It declares the two
graph types Stories 3 and 4 read. It has no caller: EPIC 052.1 Story 4
(`04-an-illegal-target-scope-or-project`) is where `patchTargetVerdict`
first runs. It changes no drawn path, so it draws nothing.

## Change

**Create `src/domain/graph-patch-stage.ts`.** Two types, one pure staging function and one verdict.
Story 4 (`04-the-two-structural-policies`) appends `expansionVerdict` to this same file.

### 1 — the two graph types

`src/domain/plan-graph.ts` declares `StoredNode` at `src/domain/plan-graph.ts:3` — `StoredNode` and
`StoredEdge` at `src/domain/plan-graph.ts:24` — `StoredEdge`, and **it declares no graph type**. The
node-set-plus-edge-set pair is written inline at
`src/services/plan/index.ts:71` — `readGraph`. Declare the two shapes here rather than editing
`plan-graph.ts`, because `src/domain/plan-graph.test.ts:12` — `StoredNode` pins that module's member
sets and this epic's staged shapes are not stored shapes.

```ts
export type PatchGraph = Readonly<{
  nodes: readonly StoredNode[];
  edges: readonly StoredEdge[];
}>;

export type StagedNode = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  parentId: string | null;
  worker: string | null;
  repositoryId: string | null;
  deliverable: string | null;
  verifyJson: string | null;
  dependencies: readonly string[];
}>;

export type StagedEdge = Readonly<{ fromNode: string; toNode: string }>;

export type StagedGraph = Readonly<{
  nodes: readonly StagedNode[];
  edges: readonly StagedEdge[];
}>;
```

`PatchGraph` is structurally the return type of
`src/services/plan/index.ts:71` — `readGraph`, so EPIC 052.1 passes that value with no adapter.

**`StagedNode` is the structural projection of a node, and it is not a `StoredNode`.** A `create`
mutation carries no `instructionBlob`, no `assignment`, no `state`, no `revision` and no
`updatedAt`, so a staged node cannot be a `StoredNode`. The nine fields above are exactly the fields
this epic's legality questions read, and they are exactly the fields
`src/domain/plan-candidate.ts:96` — `validateCandidate` reads on a structural finding:
`src/domain/plan-candidate.ts:107` — `parent-missing`,
`src/domain/plan-candidate.ts:165` — `worker-unknown`,
`src/domain/plan-candidate.ts:205` — `nodePairLegality`,
`src/domain/plan-candidate.ts:216` — `verify-invalid`,
`src/domain/plan-candidate.ts:248` — `reference-unresolved`,
`src/domain/plan-candidate.ts:257` — `dependency-cross-parent` and
`src/domain/plan-candidate.ts:294` — `dependency-cycle`. Nothing structural reads `title`,
`instructionBlob` or `acceptanceBlob`, so the staged graph carries none of them and **this epic
therefore builds no `Candidate`**. EPIC 052.1 Story 5
(`05-an-invalid-staged-graph-refuses`) expresses the staged graph as a
`Candidate`, and it owns the blob fields the validator ignores.

`StoredNode` is assignable to `StagedNode` field by field, so a pinned node stages by projection and
never by a rebuild.

**`StagedEdge` carries no `id` and no `waivedAt`.** `StoredEdge` carries both, and a pure function
cannot mint an id. Every legality question of this epic reads only the two endpoints, and EPIC 052.1
Story 1 (`01-the-lowering`) mints the real edge ids in `lowerPatch`.

### 2 — `stagePatch`

```ts
export function stagePatch(graph: PatchGraph, patch: GraphPatch): StagedGraph;
```

It returns the node set and the edge set the patch would leave. It is declarative: one id appears at
most once, so no order is expressible and none is applied.

- **A pinned node** projects to a `StagedNode` unchanged.
- **A `create`** adds one `StagedNode` carrying the mutation's `kind`, `parentId`, `repositoryId`,
  `deliverable` and `dependsOn`, with `projectId` copied from **the pinned graph**, and
  `verifyJson` set to `renderVerifyBlock(mutation.verify)`
  (`src/domain/verify-block.ts:57` — `renderVerifyBlock`).
- **`worker` on a created node is `null`.** The patch carries no `worker` field, and
  `src/domain/plan-candidate.ts:163` — `node.worker` only fires `worker-unknown` for a non-null
  value, so `null` reaches no refusal. Routing assigns a worker; a patch does not.
- **`projectId` comes from the pinned graph, not the mutation.** The patch has no project field.
  `src/services/plan/sqlite.ts:154` — `project_id` scopes `readGraph` to one project, so every
  pinned node of a `PatchGraph` carries the same `projectId` and a created node inherits it. When
  `graph.nodes` is empty, `stagePatch` cannot supply one; this is unreachable in production, because
  the claimed node is always in the pinned graph, and the story states it rather than inventing a
  fallback: **`stagePatch` requires a non-empty `graph.nodes` and the caller of EPIC 052.1 has one**.
- **An `update`** overlays each named field onto the pinned node's projection. An absent field is
  unchanged. `dependsOn` replaces the whole list. `verify` becomes `verifyJson` the same way a
  `create` does.
- **A `delete`** removes the node, removes it from every other node's `dependencies`, and removes
  every edge naming it on either side.
- **`stagePatch` never validates.** An `update` of an absent id and a `create` of an existing id both
  reach it; both are `patchTargetVerdict`'s refusals, and the order of the chain runs the verdict
  first. When `stagePatch` is nevertheless given such a patch, an `update` of an absent id stages
  nothing for that mutation and a `create` of an existing id replaces the pinned projection.

**The edge set is derived from the staged `dependencies` lists and never carried alongside them.**
`StoredNode.dependencies` at `src/domain/plan-graph.ts:21` — `dependencies` is already derived from
the edge rows at `src/services/plan/sqlite.ts:162` — `buildNodes`, so two independent staged
representations of one fact would be a source of disagreement. Emit one `StagedEdge`
`{ fromNode: node.id, toNode: dependency }` per entry of every staged node's `dependencies`, in the
node order of `stagedGraph.nodes` and the entry order of each list.

**A dangling `dependsOn` entry stays.** Staging removes only the entries a `delete` names. An entry
naming an id no mutation created and no pinned node holds survives, so
`src/domain/plan-candidate.ts:248` — `reference-unresolved` still fires in EPIC 052.1. Stripping it
would make an unresolved reference unrefusable.

### 3 — `patchTargetVerdict`

```ts
export type PatchTargetVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: "patch-target-invalid"; id: string }>;

export function patchTargetVerdict(
  input: Readonly<{ graph: PatchGraph; patch: GraphPatch }>,
): PatchTargetVerdict;
```

It refuses when a `create` names an id `graph.nodes` already holds, or when an `update` or a
`delete` names an id `graph.nodes` does not hold. It reports the **first** offending id in submitted
mutation order.

The verdict shape is the epic-wide one, matching `src/domain/execution-acceptance.ts` of EPIC 051.1
Story 6 (`06-the-acceptance-verdicts`) and
`src/domain/node-write-legality.ts:30` — `NodeWriteLegality`.

**No shipped check can see either condition.** `src/domain/plan-candidate.ts:304` —
`validateCandidateStructural` judges the graph a candidate node set describes. A `create` of an
existing id stages one node with that id, not two, so
`src/domain/plan-finding.ts:54` — `identity-duplicate` cannot fire, and the staged graph is
well formed. An `update` of an absent id stages nothing, and the remaining graph is also well
formed. Case 3 below is the control that proves it.

## Constraints

- `src/domain/` is pure. This module reads no clock, no file system, no randomness and no
  transaction, and it imports no vendor package.
- `stagePatch` never throws. `renderVerifyBlock` throws on a duplicate path
  (`src/domain/verify-block.ts:61` — `VerifyBlockError`), and it cannot here: the patch is already
  parsed, and `src/domain/verify-block.ts:31` — `superRefine` refuses a duplicate at parse.
- Do not add `PatchGraph`, `StagedNode` or `StagedGraph` to `src/domain/plan-graph.ts`. That module
  holds the stored shapes, and `src/domain/plan-graph.test.ts:12` — `StoredNode` pins them.
- Do not give `StagedNode` a `state`, an `assignment`, a `revision`, an `updatedAt`, a `title` or a
  blob field. Every one of them is either absent from the patch or unread by a structural rule.
- Do not mint an edge id. `src/domain/` is pure and EPIC 052.1 Story 1 (`01-the-lowering`) owns the
  minting.
- `patchTargetVerdict` reads only the pinned graph. Judging it against the staged graph is vacuous,
  because staging is what makes both conditions well formed.
- Register `patch-target-invalid` nowhere. EPIC 052.1 Story 9 (`09-the-contract-and-the-proposal`)
  owns `src/http/contract/errors.ts:7` — `errorStatuses` and
  `src/cli/exit-code.ts:13` — `exitCodes`.

## Verify

```
node --test src/domain/graph-patch-stage.test.ts
```

Create `src/domain/graph-patch-stage.test.ts`, suite name
`"src/domain/graph-patch-stage.test"`, on `node:test` with `node:assert/strict`, matching
`src/domain/run-exclusion.test.ts:52` — `describe`. Build a local
`storedNode(id, kind, overrides: Partial<StoredNode> = {})` literal builder on the pattern of
`src/domain/plan-candidate.test.ts:82` — `storedNode`. Take the real cycle finder only where a case
needs one; cases 1 to 4 need none.

Add, each as a separate `it`:

1. `"a create adds one staged node carrying its own kind, deliverable and verify"` — stage a patch
   holding one `create` against a two-node pinned graph, and assert the staged node set deep-equals
   the expected three `StagedNode` values by value, including `worker: null`,
   `projectId: "project_a"` and `verifyJson` equal to `renderVerifyBlock` of the mutation's verify
   block. Gate row 6, first quarter.

2. `"an update replaces each named field and leaves every other field unchanged"` — stage an
   `update` naming `title` and `dependsOn` only, and assert the staged node's `kind`, `parentId`,
   `repositoryId`, `deliverable` and `verifyJson` equal the pinned node's, while `dependencies`
   equals the replacement list. Gate row 6, second quarter.

3. `"a reparent moves the node and no other node"` — stage an `update` naming `parentId` alone and
   assert the whole staged node set by value. Gate row 6, third quarter.

4. `"a delete removes the node, its outgoing edges and every edge naming it"` — pin a graph where
   `task_b` depends on `task_a` and `task_a` depends on `task_c`, delete `task_a`, and assert in one
   case that the staged node set holds `task_b` and `task_c` only, that `task_b.dependencies` is
   empty, and that `stagedGraph.edges` deep-equals `[]`. Gate row 6, fourth quarter. This is the case
   that proves the incoming direction, which a delete that only dropped the node would fail.

5. `"the staged edge set agrees with the staged dependencies field"` — for a patch holding a
   `create`, an `update` replacing a `dependsOn` list and a `delete`, assert
   `stagedGraph.edges` deep-equals the exact expected `{ fromNode, toNode }` array. This is the
   control for the one-representation rule: without it, a staging that updated `dependencies` and
   not `edges` passes cases 1 to 4.

6. `"a dependsOn entry naming an absent id survives staging"` — stage an `update` whose `dependsOn`
   names `task_absent`, and assert the staged node's `dependencies` holds it and that
   `stagedGraph.edges` holds the matching pair. Stripping it would make
   `src/domain/plan-candidate.ts:248` — `reference-unresolved` unreachable.

7. `"a create naming an existing id refuses patch-target-invalid"` — assert
   `patchTargetVerdict` deep-equals `{ ok: false, refusal: "patch-target-invalid", id: "task_a" }`.
   Gate row 7, first third.

8. `"an update naming an absent id refuses patch-target-invalid"` — assert the same shape with
   `id: "task_absent"`. Gate row 7, second third.

9. `"a delete naming an absent id refuses patch-target-invalid"` — assert the same shape with
   `id: "task_absent"`. Gate row 7, final third.

10. `"a create of a new id and an update and a delete of pinned ids pass"` — the control for cases 7
    to 9. Assert `patchTargetVerdict` deep-equals `{ ok: true }`.

11. `"validateCandidateStructural finds nothing in the create-existing patch"` — take the exact patch
    and pinned graph of case 7, stage it, express the staged nodes as a `Candidate` by adding
    `instructionBlob`, `acceptanceBlob`, `title` and `source: "database"`, and assert
    `validateCandidateStructural({ findCycles: graph.cycles }, { candidate, context })` returns `[]`,
    with `graph` from `test/helpers/plan.ts:136` — `createPlanGraph`. The shipped validator therefore
    cannot see the condition, and `patchTargetVerdict` is not redundant. Gate row 8.

12. `"the same candidate with a real structural fault is refused"` — the control for case 11. Repeat
    case 11 with one node's `parentId` pointing at an id the candidate does not hold, and assert the
    returned findings hold one `parent-missing`. Without it, case 11 passes for a call that validates
    nothing.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/graph-patch-stage.test.ts` in `PASS EPIC-052`.
