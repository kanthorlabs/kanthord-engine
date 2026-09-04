# Story 4 — The two structural policies

Epic: `.agents/plan/epics/052-the-graph-patch-and-its-policies.md`
Depends on: Story 2 (`02-the-staged-graph-and-target-legality`) for `PatchGraph`, `StagedGraph` and the file `expansionVerdict` is appended to.
Kind: story-foundation

This story adds the last two verdicts of the ordered chain. Neither has a caller: EPIC 052.1 Story 6
(`06-a-fixed-pair-or-an-empty-expansion`) is where both first run. It changes no drawn
path, so it draws nothing.

It leaves the checkpoint read to Story 5 (`05-the-seams-the-acceptance-needs`), which declares
`execution.hasAcceptedCheckpoint`. `pairChangeVerdict` takes the boolean; it never reads a store.

## Change

### 1 — `pairChangeVerdict`, in `src/domain/node-pair.ts`

Append below `nodePairLegality` at `src/domain/node-pair.ts:58` — `nodePairLegality`:

```ts
export type PairChangeVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: "pair-fixed"; nodeId: string }>;

export function pairChangeVerdict(
  input: Readonly<{
    nodeId: string;
    hasChild: boolean;
    hasAcceptedCheckpoint: boolean;
  }>,
): PairChangeVerdict;
```

It refuses when `hasChild` or `hasAcceptedCheckpoint` is true. The condition is **disjunctive**:
`worker.md:94` states the pair is fixed once the node holds an accepted checkpoint **or** a child.

`nodeId` is carried on the refusal and read nowhere else, so an unused parameter cannot reach
`pnpm run lint`.

**It reads no pair.** It takes no `kind` and no `deliverable`, and it never calls `nodePairLegality`.
Fixity is about children and checkpoints, not about which pair the patch moves to. The two functions
share a file because they share a subject.

**The verdict shape is the epic-wide one, and it is deliberately not the file's local shape.**
`src/domain/node-pair.ts:6` — `NodePairLegal` and
`src/domain/node-pair.ts:12` — `NodePairIllegal` discriminate on `legal` and are the only
un-`Readonly` verdict types in `src/domain/`. This epic's five verdicts —
`patchTargetVerdict`, `patchScopeVerdict`, `patchProjectVerdict`, `pairChangeVerdict` and
`expansionVerdict` — are one ordered chain in EPIC 052.1, and a chain that alternates `legal` and
`ok` discriminants is a defect the type checker cannot catch, because both are booleans. All five
use `{ ok: true } | { ok: false; refusal; <evidence> }`, matching
`src/domain/node-write-legality.ts:30` — `NodeWriteLegality` and
`src/domain/execution-acceptance.ts` of EPIC 051.1 Story 6 (`06-the-acceptance-verdicts`).

**Do not change `nodePairLegality`, `NodePairLegal`, `NodePairIllegal` or `nodePairTable`.**
`src/domain/node.ts:56` — `refine` calls `nodePairLegality` from inside `nodeRow`, and
`src/commands/node/claim-node.ts:164` — `nodePairLegality` calls it in the claim. Neither moves here.

**Add no import.** `src/domain/node-pair.ts:1` — `deliverables` and
`src/domain/node-pair.ts:3` — `nodeKinds` stay its only imports; `pairChangeVerdict` reads neither.

### 2 — `expansionVerdict`, in `src/domain/graph-patch-stage.ts`

Append to the file Story 2 (`02-the-staged-graph-and-target-legality`) creates:

```ts
export type ExpansionVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: "expansion-empty"; nodeId: string }>;

export function expansionVerdict(
  input: Readonly<{
    claimedNodeId: string;
    pinnedGraph: PatchGraph;
    stagedGraph: StagedGraph;
  }>,
): ExpansionVerdict;
```

It refuses when the claimed node held **no direct child** in the pinned graph **and** holds none in
the staged graph. The condition is conjunctive, and both halves are direct-child tests:
`node.parentId === input.claimedNodeId`, on the pattern of
`src/commands/outcome/aggregate-initiative.ts:36` — `parentId` and
`src/commands/node/claim-node.ts:656` — `parentId`. `src/domain/` holds no children helper and
`src/services/graph/index.ts:67` — `children` is a service this module may not import, so the filter
is inline.

**A node that already holds children never refuses**, whatever the patch does. `worker.md:94` states
a parent objective becomes atomic only after a patch deletes every child, in any state, so a node
free to shed its children is what makes that conversion reachable. The rule bounds the completeness
exemption of `worker.md:383`, which covers a **childless** node's own missing children and nothing
else.

**It counts staged children, never `create` mutations.** `worker.md:385` reads "rejects an expansion
patch that creates none", and the epic overrides that reading: a patch that creates a child and then
reparents it away creates one and leaves none. Case 6 below is that patch.

**It takes no deliverable.** Whether the claim is an expansion is EPIC 052.1's precondition, not this
function's. `src/domain/plan-graph.ts:19` — `deliverable` is `string | null` and not
`Deliverable | null`, so reading it here would need the cast at
`src/commands/node/claim-node.ts:163` — `deliverable` for no gain.

## Constraints

- `src/domain/` is pure. Neither function reads a clock, a file system, randomness or a transaction,
  and neither imports a vendor package.
- Neither function throws. Both return a value.
- `pairChangeVerdict` reads `hasChild` and `hasAcceptedCheckpoint` and nothing else. Do not give it a
  graph, and do not make it derive `hasChild` itself: the pinned graph is the caller's, and Story 5
  (`05-the-seams-the-acceptance-needs`) owns the checkpoint read.
- `expansionVerdict`'s first half reads the **pinned** graph and its second half reads the **staged**
  graph. Collapsing them onto one graph makes gate row 17 fail.
- Both tests use direct children. Do not use a subtree walk: a grandchild is not a child, and
  `worker.md:385` says child.
- Add `pair-fixed` and `expansion-empty` to no registry. They are refusals, not findings, so
  `src/domain/plan-finding.ts:6` — `findingCodes` and
  `src/domain/plan-finding.ts:44` — `findingScope` are untouched, and EPIC 052.1 Story 9
  (`09-the-contract-and-the-proposal`) owns `src/http/contract/errors.ts:7` — `errorStatuses` and
  `src/cli/exit-code.ts:13` — `exitCodes`.
- This story does not own gate row 25. The eight-`nodeStates` delete belongs to Story 5
  (`05-the-seams-the-acceptance-needs`).

## Verify

```
node --test src/domain/node-pair.test.ts src/domain/graph-patch-stage.test.ts
```

Extend `src/domain/node-pair.test.ts`, inside the existing suite at
`src/domain/node-pair.test.ts:8` — `describe`. That file uses no helper and asserts a refusal as a
whole literal with `assert.deepStrictEqual`, at
`src/domain/node-pair.test.ts:83` — `refusal`; match it.

Extend `src/domain/graph-patch-stage.test.ts`, created by Story 2
(`02-the-staged-graph-and-target-legality`), reusing its local `storedNode` builder.

Add, each as a separate `it`:

1. `"a pair change with neither a child nor an accepted checkpoint passes"` — assert
   `pairChangeVerdict({ nodeId: "objective_a", hasChild: false, hasAcceptedCheckpoint: false })`
   deep-equals `{ ok: true }`. Gate row 14, first third.

2. `"a pair change on a node holding a child refuses pair-fixed"` — assert
   `pairChangeVerdict({ nodeId: "objective_a", hasChild: true, hasAcceptedCheckpoint: false })`
   deep-equals `{ ok: false, refusal: "pair-fixed", nodeId: "objective_a" }`. Gate row 14, second
   third.

3. `"a pair change on a node holding an accepted checkpoint refuses pair-fixed"` — assert
   `pairChangeVerdict({ nodeId: "objective_a", hasChild: false, hasAcceptedCheckpoint: true })`
   deep-equals the same value. With case 2 this proves the condition is a disjunction and not a
   conjunction. Gate row 14, final third.

4. `"a childless claimed node whose staged graph holds one direct child passes"` — pin a graph where
   `objective_a` has no child, stage a `create` of `task_new` parented on `objective_a`, and assert
   `expansionVerdict` deep-equals `{ ok: true }`. Gate row 15, first half.

5. `"a childless claimed node whose staged graph holds no child refuses expansion-empty"` — the same
   pinned graph with a patch that creates no child of `objective_a`, and assert
   `{ ok: false, refusal: "expansion-empty", nodeId: "objective_a" }`. Gate row 15, second half.

6. `"a patch that creates a child of the claimed node and then reparents it away refuses expansion-empty"`
   — pin `objective_a` childless plus a sibling `objective_b`. Stage a `create` of `task_new`
   parented on `objective_a` together with a `create` of `objective_c` parented on `objective_b`, and
   an arrangement that leaves `task_new` under `objective_c`. Assert
   `{ ok: false, refusal: "expansion-empty", nodeId: "objective_a" }`. Counting `create` mutations
   would pass this. Gate row 16.

7. `"a claimed node that already holds children and whose patch deletes every one of them passes"` —
   pin `objective_a` with children `task_a` and `task_b`, stage a patch deleting both, and assert
   `{ ok: true }`. This is what makes the parent-to-atomic conversion of `worker.md:94` reachable, and
   it is the direct consequence of the childless-node condition. Gate row 17.

8. `"a claimed node whose only staged child belongs to another parent refuses expansion-empty"` — pin
   `objective_a` childless plus `objective_b`, stage a `create` of `task_new` parented on
   `objective_b`, and assert
   `{ ok: false, refusal: "expansion-empty", nodeId: "objective_a" }`. Gate row 18. With case 4 this
   is the pair that proves the filter reads `parentId` and not the staged node count.

9. `"a grandchild is not a child"` — pin `objective_a` childless, stage a `create` of `task_deep`
   parented on a created `objective_mid` that is itself parented on `objective_a`, and assert
   `{ ok: true }` — `objective_mid` is the direct child. Then stage only `task_deep` parented on a
   **pinned** node outside `objective_a`, and assert the refusal. The control for the direct-child
   rule.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/node-pair.test.ts` and
`src/domain/graph-patch-stage.test.ts` in `PASS EPIC-052`.
