# EPIC 052 — The graph patch and its policies

Status: **draft**. It follows EPIC 051.4 by sequence order, and it runs before EPIC 052.1. It consumes EPIC 047's node pair, EPIC 050's run and fence, EPIC 050.1's claim and its completeness exemption, and EPIC 051.3's `checkpoint` table.

This epic and EPIC 052.1 replace the single EPIC 052 authored before `.agents/plan/authoring.md`. That document held sixteen story entries, declared no story kind, and carried its verification gate as a bullet list; the standard refuses all three. EPIC 052.1 carries a decimal number because EPIC 053 through EPIC 057 are authored and numbered, and renumbering them would break every cross-reference between them.

## Goal

The mutation set is a value with settled legality, and nothing consumes it yet:

- a patch is a closed algebra of three operations, canonically serialised, and one id appears at most once;
- staging a patch onto a graph yields the graph the patch would leave, and every legality question is asked of that staged graph;
- target legality, scope and project are decided before graph validation, so each of their refusals is reachable;
- a pair is fixed once its node holds a child or an accepted checkpoint, and an accepted expansion leaves the claimed node holding at least one child;
- `NodeWrite` carries `deliverable` and `verifyJson`, and the execution store writes and reads a structural checkpoint row.

## Non-goals

- **No acceptance command, no route and no wire contract.** EPIC 052.1 owns `acceptStructural`, the seventh `node.report` member and every contract consumer. Nothing here opens a transaction.
- **No completeness exemption, because it is already shipped.** `src/commands/node/claim-node.ts:179-182` drops every finding whose `id` equals the claimed node when its `deliverable` is `expansion`, and `completenessFindings` sets `id: parent.id` at `src/domain/plan-completeness.ts:45`. It landed with EPIC 050.1 in commit `04376fb`, and `src/commands/node/claim-node.test.ts:1646` covers it. `.agents/plan/epics/050.1-the-claim.md:114` decides it and names that mechanism. The superseded EPIC 052 gave this an `exempt` parameter on `CompletenessInput` and a claim story; both would have re-implemented working code. **The filter belongs in the command and not in the domain**, because `claim-node.ts:641` excludes a discarded child unless it is the claimed node, so a domain-level skip on `expansion` would drop a finding the gate must keep. `.agents/plan/epics/050.1-the-claim.md:114` records that invariant. The two import paths at `src/domain/plan-candidate.ts:147` and `src/domain/plan-validate.ts:257` exempt nothing and never refuse on completeness, and that asymmetry is correct.
- **No new graph validator.** `validateCandidateStructural` at `src/domain/plan-candidate.ts:304` already decides ids, hierarchy, dependencies, cycles and the node pair. This epic reuses it and adds only what it cannot see.
- **No new revision origin and no migration.** A structural revision reuses `origin: "node-write"`. `src/services/storage/migration-0006-revision-origin.ts:13` declares `origin TEXT NOT NULL CHECK (origin IN ('import', 'node-write'))`, so a third value would rebuild `plan_revision`.
- **No plan import change.** `plan import` writes a whole document set against a project; a patch writes a mutation set against a claimed subtree. `src/commands/plan/import-plan.ts` and the document parser are untouched.
- **No worker, and no routable expansion node.** `worker.md:209` states expansion is internal-only work and no internal worker exists, so an expansion claim answers `unroutable` with `failedSet: "capable"` in production. EPIC 052.1 supplies a registry fixture; the phase-2 worker is a registry edit.
- **No node deletion restriction.** `worker.md` section 2 permits deleting a child in any state. This epic adds no state-based and no checkpoint-based refusal.

## Decisions

- **The mutation algebra is closed, and every case is decided here.** `src/domain/graph-patch.ts` defines three operations and nothing else.

  | `op`     | fields                                                                                                                          | meaning                                                 |
  | -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
  | `create` | `id`, `kind`, `deliverable`, `title`, `parentId`, `repositoryId`, `verify`, `instruction`, `acceptance`, `dependsOn`            | Insert one node with the full field set.                |
  | `update` | `id`, and one or more of `title`, `deliverable`, `verify`, `instruction`, `acceptance`, `parentId`, `repositoryId`, `dependsOn` | Replace each named field. An absent field is unchanged. |
  | `delete` | `id`                                                                                                                            | Remove one node and every edge that names it.           |

  `update` is a partial replacement of named fields, never a merge of a value. `dependsOn` is the whole dependency list, replaced wholesale, so an edge is never addressed on its own. Reparenting is one `update` naming `parentId`.

- **The patch is declarative, and no sentence of this epic gives it an application order.** Validation runs against the staged final graph, and one id appears at most once, so there is no intermediate state any rule can describe. The superseded EPIC 052 said "the daemon applies it in that order" while also validating the final graph; the two readings give different rules, and the declarative one wins. `plan.mutateGraph` at `src/services/plan/index.ts:115` takes `nodes`, `insertEdges`, `deleteEdgeIds` and `nodeDeletes` as whole sets, so a list order is not even expressible at the seam. **EPIC 052.1 owns the lowering**, because an order the database requires is not an order the patch language has.

- **One id appears at most once, and that is its own refusal.** A second mutation naming an id refuses `patch-id-duplicate`. It is distinct from `patch-unparsable`: the bytes parse and the shape is legal, and the document is still illegal. A create-then-update or create-then-delete of one id is therefore impossible.

- **Canonical serialisation normalises order, because order carries no meaning.** `renderGraphPatch(patch)` emits JSON with keys sorted bytewise at every level, **mutations sorted bytewise by `id`**, every `dependsOn` list sorted bytewise and de-duplicated, two-space indentation and one trailing newline. Two patches with one meaning therefore hash identically. Preserving the submitted mutation order would make the content address depend on a permutation the semantics ignore, and evidence whose identity moves without its meaning moving is not evidence. `src/commands/node/create-node.ts:156-158` is the precedent for sorting a `dependsOn` list with `Buffer.compare`.

- **Staging is a pure function, and every legality question is asked of the staged graph.** `stagePatch(graph, patch)` returns the node set and edge set the patch would leave. A delete removes every edge naming the node. Judging a transient intermediate state would refuse a patch that removes one edge and adds another.

- **Target legality is its own refusal, because no shipped check can see it.** `patchTargetVerdict` refuses `patch-target-invalid` when a `create` names an id the pinned graph already holds, or an `update` or `delete` names an id it does not. `validateCandidateStructural` receives a candidate node set and judges the graph that set describes; a `create` of an existing id and an `update` of an absent one both produce a well-formed candidate, so the shipped validator passes both. The superseded EPIC 052 had no code for either.

- **Scope has three rules, because a created node is not in the pinned subtree.** `patchScopeVerdict` refuses `patch-scope-invalid` when an `update` or `delete` names an id outside the subtree of the claimed node in the **pinned** graph; when a `create` gives a node whose final parent is outside that subtree in the **staged** graph; or when a `dependsOn` entry names a node outside the claimed subtree in the staged graph. A single "targets" set cannot express these, and a checker that skips created nodes checks nothing about the mutation that matters most.

- **A patch never leaves its project, and the check runs before graph validation so its refusal is reachable.** `patchProjectVerdict` refuses `patch-project-invalid` when a mutation names an existing node of another project, or when a `create` names a `parentId` or a `dependsOn` entry outside the claimed node's project. **The order is load-bearing.** A cross-project `dependsOn` entry is simultaneously an unresolved reference, out of scope and cross-project, so a project check placed after the graph validator is a refusal no input can reach. An objective binds one repository and a subtree may hold objectives of several, so a repository rule proves nothing about a project.

- **Graph validation reuses the shipped validator and the shipped refusal.** After target, scope and project pass, the staged graph is expressed as a `Candidate` and passed to `validateCandidateStructural` with `findCycles` bound to the `graph.cycles` seam, exactly as `src/commands/node/create-node.ts:220-228` does. The refusal is the shipped `plan-invalid` carrying `{ findings }`, as `create-node.ts:226` raises it. **The superseded EPIC 052's `patch-id-invalid`, `patch-hierarchy-invalid` and `patch-dependency-invalid` are deleted**: `findingScope` at `src/domain/plan-finding.ts:44-71` already scopes `identity-duplicate`, `identity-invalid`, `identity-kind-mismatch`, `parent-missing`, `dependency-cycle`, `dependency-self`, `dependency-cross-parent`, `reference-unresolved`, `repo-missing`, `repo-on-task`, `repository-unbound`, `repository-unknown`, `verify-invalid`, `worker-unknown` and `pair-illegal` as structural, and a second code set for one condition would need a mapping nobody can keep total. `pair-illegal` is therefore a finding here and not a separate refusal.

- **A pair change is legal only before the first child and the first accepted checkpoint.** `pairChangeVerdict({ nodeId, hasChild, hasAcceptedCheckpoint })` refuses `pair-fixed`. `worker.md` section 2 states the rule and states that a parent objective becomes atomic only after a patch deletes every child, in any state. The two-patch sequence is therefore: patch one deletes every child, patch two changes the pair. `hasChild` is read from the pinned graph and `hasAcceptedCheckpoint` from the execution store.

- **The at-least-one-child rule binds a childless claimed node, and it is evaluated on the staged graph.** `expansionVerdict({ claimedNodeId, pinnedGraph, stagedGraph })` refuses `expansion-empty` when the claimed node held no child in the pinned graph and holds none in the staged graph. `worker.md:383-385` states the exemption covers a childless node's own missing children and that an accepted expansion checkpoint creates at least one child, which bounds it. A node that already holds children is free to shed them, which is what makes the parent-to-atomic conversion of `worker.md` section 2 reachable. Counting `create` mutations would pass a patch that creates a child and then reparents it away.

- **A child created by an expansion inherits nothing implicitly.** Each created node carries its own `kind`, `deliverable`, `verify` and, for an objective, its `repositoryId`. An inherited field would make a patch unreadable against the document a human later exports.

- **A delete carries no state condition and no checkpoint condition.** `worker.md` section 2 states a parent objective becomes atomic after a patch deletes every child, in any state. A checkpoint row is immutable evidence bound to a `plan_revision` that still exists, so removing a node from the current graph rewrites nothing. `checkpoint.node_id` therefore takes no delete cascade.

- **`NodeWrite` gains `deliverable` and `verifyJson`, and both are optional.** `MutateGraphInput.nodes` is `readonly NodeWrite[]` at `src/services/plan/index.ts:47`, and `NodeWrite` at `:25-37` declares neither field, so the interface cannot express a `create` that sets a pair. Only the private `insertNode` at `src/services/plan/sqlite.ts:431-433` accepts them, as `NodeWrite & Partial<Pick<StoredNode, "deliverable" | "verifyJson">>`, and `INSERT_NODE` at `:43-46` already carries the two has-flags that make each write present-or-absent. A command may depend on the interface and never on an implementation extension, so the interface states what the implementation does. **Both stay optional**, so `create-node`, `update-node`, `delete-node` and `import-plan` construct `NodeWrite` unchanged and this epic forces no repair.

- **The execution store gains the structural checkpoint write and one predicate.** `src/services/execution/index.ts` declares no checkpoint method today. EPIC 051.3 creates the whole `checkpoint` table and states only the `execution` kind has a writer, so the structural writer belongs to the epic that knows the structural evidence. This epic adds a structural write carrying the node, the run, the attempt, the fence, `graph_revision` and `patch_blob` with `accepted_oid` null, and `hasAcceptedCheckpoint(transaction, nodeId): boolean`, which `pairChangeVerdict` reads.

- **`graph_revision` is a `plan_revision` id, and equality is the only comparison.** `worker.md:328` shows `graph_revision: 41` and defines no representation. EPIC 050 already decided the column is a nullable plan revision identity and that EPIC 052 compares by equality alone, never by `<`, `>` or lexical adjacency.

## Stories

Each entry is a name and the output it contributes. The story file holds the change, the tasks and the diagrams, and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **The patch shape and its canonical form.** Add `src/domain/graph-patch.ts` with `graphPatch`, the three mutation shapes of the Decisions table, the duplicate-id refusal and `renderGraphPatch`. `story-foundation`.

2. **The staged graph and target legality.** Add `src/domain/graph-patch-stage.ts` with `stagePatch` and `patchTargetVerdict`. `story-foundation`.

3. **Scope and project.** Add `src/domain/graph-patch-scope.ts` with `patchScopeVerdict` and `patchProjectVerdict`. `story-foundation`.

4. **The two structural policies.** Add `pairChangeVerdict` to `src/domain/node-pair.ts` beside `nodePairLegality`, and add `expansionVerdict` to `src/domain/graph-patch-stage.ts`. `story-foundation`.

5. **The seams the acceptance needs.** Add optional `deliverable` and `verifyJson` to `NodeWrite` at `src/services/plan/index.ts:25`, and add the structural checkpoint write and `hasAcceptedCheckpoint` to `src/services/execution/index.ts` and its SQLite implementation. `story-foundation`.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/graph-patch.test.ts \
  src/domain/graph-patch-stage.test.ts \
  src/domain/graph-patch-scope.test.ts \
  src/domain/node-pair.test.ts \
  src/services/plan/sqlite.test.ts \
  src/services/execution/sqlite.test.ts \
  && echo "PASS EPIC-052"
```

Hermetic coverage required beyond the Proof. **Every row names exactly one proof owner.**

| #   | assertion                                                                                                                                                                                                                                  | story |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1   | Each of the three operations parses with its full field set, and an unknown `op` is refused by value.                                                                                                                                      | 1     |
| 2   | An `update` naming no field beyond `id` is refused.                                                                                                                                                                                        | 1     |
| 3   | A second mutation naming one id refuses `patch-id-duplicate`, and a patch whose bytes do not parse refuses `patch-unparsable`. Both in one case, so the two codes stay distinct.                                                           | 1     |
| 4   | `renderGraphPatch` is byte-exact against a literal, including the two-space indentation and the single trailing newline.                                                                                                                   | 1     |
| 5   | Two patches whose mutations arrive in different orders, whose keys arrive in different insertion orders, and whose `dependsOn` lists arrive in different orders and with a duplicate, render to identical bytes. One case.                 | 1     |
| 6   | A create, an update, a reparent and a delete each produce the expected staged node set and edge set, and a delete removes every edge naming the node.                                                                                      | 2     |
| 7   | A `create` naming an existing id refuses `patch-target-invalid`, and so do an `update` and a `delete` naming an absent id. Three cases.                                                                                                    | 2     |
| 8   | The control for row 7: the same create-existing patch passes `validateCandidateStructural` with no finding, so the shipped validator demonstrably cannot see it and the new verdict is not redundant.                                      | 2     |
| 9   | An `update` outside the pinned subtree refuses `patch-scope-invalid` and names the id.                                                                                                                                                     | 3     |
| 10  | A `create` whose final parent is inside the staged subtree passes, and one whose final parent is outside refuses `patch-scope-invalid`. Both directions in one case, so the created-node rule is not vacuous.                              | 3     |
| 11  | A `dependsOn` entry outside the claimed subtree refuses `patch-scope-invalid`.                                                                                                                                                             | 3     |
| 12  | A mutation naming an existing node of another project refuses `patch-project-invalid`, and a `create` whose `dependsOn` names a node of another project refuses the same.                                                                  | 3     |
| 13  | A cross-project `dependsOn` entry reaches `patch-project-invalid` and not `plan-invalid`, asserted by running the same input through the full ordered verdict chain. This is the row that proves the ordering ruling.                      | 3     |
| 14  | A pair change with neither a child nor an accepted checkpoint passes; one with a child refuses `pair-fixed`; one with an accepted checkpoint refuses `pair-fixed`. Three cases from the one predicate.                                     | 4     |
| 15  | A childless claimed node whose staged graph holds one direct child passes, and one whose staged graph holds none refuses `expansion-empty`.                                                                                                | 4     |
| 16  | A patch that creates a child of the claimed node and then reparents it away refuses `expansion-empty`. Counting `create` mutations would pass this case.                                                                                   | 4     |
| 17  | A claimed node that already holds children and whose patch deletes every one of them passes. This is what makes the parent-to-atomic conversion reachable, and it is the direct consequence of the childless-node condition.               | 4     |
| 18  | A claimed node whose only staged child belongs to another parent refuses `expansion-empty`.                                                                                                                                                | 4     |
| 19  | `mutateGraph` accepts a `NodeWrite` carrying `deliverable` and `verifyJson` and the row holds both, asserted against real SQLite by reading the row back.                                                                                  | 5     |
| 20  | `mutateGraph` accepts a `NodeWrite` carrying neither field, and an existing row's `deliverable` and `verify_json` are unchanged by that write. This is the has-flag behaviour of `INSERT_NODE`, and it is what keeps both fields optional. | 5     |
| 21  | Every shipped `NodeWrite` construction site still type-checks and behaves identically: `create-node`, `update-node`, `delete-node` and `import-plan` each run one existing case unchanged. `pnpm run verify` exits 0.                      | 5     |
| 22  | A structural checkpoint row writes with `graph_revision` and `patch_blob` set and `accepted_oid` null, and the CHECK clauses of EPIC 051.3's migration `14` accept it. Against real SQLite.                                                | 5     |
| 23  | `hasAcceptedCheckpoint` returns true for a node holding an accepted checkpoint of any kind and false for one holding none, and its key predicate is asserted by a second node in the same fixture holding a checkpoint.                    | 5     |
| 24  | A `checkpoint` row survives the deletion of the node it names, read by id after the delete. This is the delete-carries-no-checkpoint-condition ruling.                                                                                     | 5     |
| 25  | A child in each of the eight `nodeStates` values deletes, iterated from the tuple.                                                                                                                                                         | 5     |
