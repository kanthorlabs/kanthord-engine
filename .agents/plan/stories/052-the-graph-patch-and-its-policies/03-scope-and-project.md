# Story 3 — Scope and project

Epic: `.agents/plan/epics/052-the-graph-patch-and-its-policies.md`
Depends on: Story 1 (`01-the-patch-shape-and-its-canonical-form`) for `GraphPatch`; Story 2 (`02-the-staged-graph-and-target-legality`) for `PatchGraph`, `StagedGraph` and `stagePatch`.
Kind: story-foundation

This story adds the second and third verdicts of the ordered chain. It has no caller: EPIC 052.1
Story 4 (`04-an-illegal-target-scope-or-project`) is where both first
run. It changes no drawn path, so it draws nothing.

## Change

**Create `src/domain/graph-patch-scope.ts`.** Two verdicts and one private downward walk. Both
verdicts take a single `Readonly<{…}>` input bag, matching
`src/domain/run-exclusion.ts:8` — `SubtreeExclusionInput`.

### 1 — the descendant walk

`src/domain/` holds no downward walk. The three subtree reads are SQL — the recursive CTE at
`src/services/plan/sqlite.ts:330` — `readSubtree` is the closest — and the only domain hierarchy walk
is upward, at `src/domain/plan-ancestry.ts:10` — `terminalAncestor`.

Write a private `subtreeIds(nodes, rootId): ReadonlySet<string>` over
`Readonly<{ id: string; parentId: string | null }>[]`. It returns the root and every descendant. It
carries a `seen` set, copying the cycle guard at `src/domain/plan-ancestry.ts:17` — `seen`, because a
staged graph may hold a parent cycle that
`src/domain/plan-candidate.ts:294` — `dependency-cycle` has not yet judged, and an unguarded walk
would not terminate.

It is used three times, against two different node sets. Do not export it.

### 2 — `patchScopeVerdict`

```ts
export type PatchScopeVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: "patch-scope-invalid"; id: string }>;

export function patchScopeVerdict(
  input: Readonly<{
    claimedNodeId: string;
    pinnedGraph: PatchGraph;
    stagedGraph: StagedGraph;
    patch: GraphPatch;
  }>,
): PatchScopeVerdict;
```

Three rules, evaluated in this order, each reporting the first offending id in submitted mutation
order:

1. **An `update` or a `delete` naming an id outside the claimed subtree of the _pinned_ graph
   refuses.** The pinned subtree is what the run claimed, so a mutation may not reach a node the
   claim never covered. This is the rule EPIC 050's exclusion depends on:
   `worker.md:377` states a run covers the claimed node and every descendant.
2. **A `create` whose final parent is outside the claimed subtree of the _staged_ graph refuses.** A
   created node is in no pinned subtree, so the pinned graph cannot answer this. The final parent is
   read from the staged graph, so a `create` whose parent is another node the same patch creates is
   in scope when that chain reaches the claimed node.
3. **A `dependsOn` entry naming a node outside the claimed subtree of the _staged_ graph refuses.**
   It is read over every staged node the patch touches — every `create` and every `update` naming
   `dependsOn` — and the offending id reported is the **dependency**, not the mutation.

**A single "targets" set cannot express these.** Rule 1 reads the pinned graph and rules 2 and 3 read
the staged graph, and a checker that skipped created nodes would check nothing about the mutation
that matters most.

**The claimed node itself is in scope.** `subtreeIds` returns the root, so an `update` of the claimed
node passes rule 1 and a `create` parented directly on it passes rule 2.

### 3 — `patchProjectVerdict`

```ts
export type NodeProject = Readonly<{ id: string; projectId: string }>;

export type PatchProjectVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: "patch-project-invalid"; id: string }>;

export function patchProjectVerdict(
  input: Readonly<{
    projectId: string;
    nodeProjects: readonly NodeProject[];
    patch: GraphPatch;
  }>,
): PatchProjectVerdict;
```

It refuses when a mutation names an existing node whose `projectId` is not `input.projectId`, or when
a `create` names a `parentId` or a `dependsOn` entry that resolves to an existing node of another
project. `projectId` is the claimed node's project.

**`nodeProjects` spans every project, and that is the whole point of the parameter.**
`src/services/plan/sqlite.ts:154` — `project_id` scopes `readGraph` to one project, so a node of
another project is simply absent from a `PatchGraph`, and "absent" is indistinguishable from
"unknown id". Fed a project-scoped set, this verdict can never fire and gate row 12 is unreachable.
The pure function therefore takes the cross-project projection explicitly, and EPIC 052.1 supplies
it. `src/services/plan/index.ts:79` — `readAllNodes` is the one shipped seam that returns it in one
call, and `src/services/plan/index.ts:78` — `readNode` is the per-id alternative. **Choosing between
them is EPIC 052.1's, not this story's**, and it is raised as a blocker against that epic's seam
list.

**An id `nodeProjects` does not hold is not this verdict's refusal.** A `create` naming an unknown
`parentId` is `src/domain/plan-candidate.ts:107` — `parent-missing`, and an unknown `dependsOn` entry
is `src/domain/plan-candidate.ts:248` — `reference-unresolved`. This verdict answers one question:
does a named id belong to another project.

**The order is load-bearing, and it is the reason this verdict exists as its own step.** A
cross-project `dependsOn` entry is simultaneously an unresolved reference, out of scope and
cross-project. `src/domain/plan-candidate.ts:304` — `validateCandidateStructural` would report it as
`reference-unresolved` and the caller would raise the shipped `plan-invalid`
(`src/commands/node/create-node.ts:226` — `plan-invalid`), so a project check placed after the graph
validator is a refusal no input can reach. Case 9 below asserts the whole chain and is the row that
proves the ruling.

**A repository rule proves nothing about a project.** An objective binds one repository
(`src/domain/plan-candidate.ts:181` — `repo-missing`), and a subtree holds objectives of several, so
`repositoryId` is not a project discriminator.

## Constraints

- `src/domain/` is pure. This module reads no clock, no file system, no randomness and no
  transaction, and it imports no vendor package.
- Neither verdict throws. Both return a value, matching
  `src/domain/node-write-legality.ts:30` — `NodeWriteLegality`.
- `subtreeIds` is private, and it carries the `seen` guard. A staged graph is not yet validated, so
  a parent cycle can reach it.
- Rule 1 reads the **pinned** graph, and rules 2 and 3 read the **staged** graph. Do not collapse
  them onto one node set.
- `patchProjectVerdict` never reads `repositoryId`, and it never reads the pinned graph. Its only
  node source is `nodeProjects`.
- Register `patch-scope-invalid` and `patch-project-invalid` nowhere. EPIC 052.1 Story 9
  (`09-the-contract-and-the-proposal`) owns `src/http/contract/errors.ts:7` — `errorStatuses` and
  `src/cli/exit-code.ts:13` — `exitCodes`.
- Do not add a chain runner here. The nine-step refusal order is EPIC 052.1's, at
  `.agents/plan/epics/052.1-the-structural-acceptance.md:44` — `patch-target-invalid`. Case 9 below
  composes the three verdicts inside the test, not in production.

## Verify

```
node --test src/domain/graph-patch-scope.test.ts
```

Create `src/domain/graph-patch-scope.test.ts`, suite name `"src/domain/graph-patch-scope.test"`, on
`node:test` with `node:assert/strict`, matching `src/domain/run-exclusion.test.ts:52` — `describe`.
Build a local `storedNode(id, kind, overrides)` literal builder on the pattern of
`src/domain/plan-candidate.test.ts:82` — `storedNode`. The fixture is one project holding
`objective_a` with children `task_a` and `task_b`, plus `objective_out` with child `task_out`
outside the claimed subtree, and a second project holding `task_far`. The claimed node is
`objective_a`.

Add, each as a separate `it`:

1. `"an update outside the pinned subtree refuses patch-scope-invalid and names the id"` — assert
   `patchScopeVerdict` deep-equals
   `{ ok: false, refusal: "patch-scope-invalid", id: "task_out" }`. Gate row 9.

2. `"an update inside the pinned subtree passes, and so does an update of the claimed node"` — the
   control for case 1. Assert `{ ok: true }` for an `update` of `task_a`, and again for an `update`
   of `objective_a`.

3. `"a create whose final parent is inside the staged subtree passes and one whose parent is outside refuses"`
   — in one case, assert `{ ok: true }` for a `create` parented on `task_a`, and
   `{ ok: false, refusal: "patch-scope-invalid", id: "task_new" }` for a `create` parented on
   `objective_out`. Both directions together, so the created-node rule is not vacuous. Gate row 10.

4. `"a create parented on another node the same patch creates is in scope"` — a patch holding a
   `create` of `task_p` parented on `objective_a` and a `create` of `task_c` parented on `task_p`.
   Assert `{ ok: true }`. This is what makes rule 2 read the staged graph and not the pinned one.

5. `"a dependsOn entry outside the claimed subtree refuses patch-scope-invalid and names the dependency"`
   — assert `{ ok: false, refusal: "patch-scope-invalid", id: "task_out" }` for an `update` of
   `task_a` whose `dependsOn` names `task_out`. Gate row 11.

6. `"a dependsOn entry naming a sibling inside the subtree passes"` — the control for case 5. Assert
   `{ ok: true }` for an `update` of `task_a` whose `dependsOn` names `task_b`.

7. `"a mutation naming an existing node of another project refuses patch-project-invalid, and so does a create whose dependsOn names one"`
   — in one case, assert `patchProjectVerdict` deep-equals
   `{ ok: false, refusal: "patch-project-invalid", id: "task_far" }` for a `delete` of `task_far`,
   and the same value for a `create` whose `dependsOn` names `task_far`. Gate row 12.

8. `"a create whose parentId names a node of another project refuses patch-project-invalid"` —
   assert the same shape with `id: "task_far"`. With case 7 this covers all three ways a mutation
   reaches a foreign id.

9. `"a cross-project dependsOn entry reaches patch-project-invalid and not plan-invalid"` — run one
   input through the ordered chain inside the test: `patchTargetVerdict`, then `patchScopeVerdict`,
   then `patchProjectVerdict`, then `validateCandidateStructural` over the staged graph expressed as
   a `Candidate` with `graph.cycles` from `test/helpers/plan.ts:136` — `createPlanGraph`. Assert the
   chain stops at `patchProjectVerdict` with
   `{ ok: false, refusal: "patch-project-invalid", id: "task_far" }`. Assert additionally, in the
   same case, that running `validateCandidateStructural` alone over that staged graph returns a
   `reference-unresolved` finding — which is the code the input would have reached had the project
   check run later, and the reason the order is load-bearing. Gate row 13.

10. `"a patch naming only nodes of the claimed project passes the project verdict"` — the control for
    cases 7 to 9. Assert `patchProjectVerdict` deep-equals `{ ok: true }` for a patch that updates
    `task_a` and creates a child of it.

11. `"a create naming an id no node holds is not the project refusal"` — assert
    `patchProjectVerdict` deep-equals `{ ok: true }` for a `create` whose `dependsOn` names
    `task_absent`. Without it, a verdict that refused every unresolved id would pass cases 7 and 8.

12. `"the subtree walk terminates on a parent cycle"` — build a staged graph where two nodes name
    each other as parent, call `patchScopeVerdict`, and assert it returns a value rather than
    hanging. Give the case an explicit `{ timeout: 1000 }` option so an unguarded walk fails rather
    than stalls the run.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/graph-patch-scope.test.ts` in `PASS EPIC-052`.
