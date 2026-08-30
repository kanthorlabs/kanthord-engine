# EPIC 052 — The structural checkpoint

Status: **draft**. It follows EPIC 051 by sequence order.

## Goal

An accepted graph patch is the checkpoint of a structural run:

- a mutation set is a closed algebra, canonically serialised and pinned by content address before acceptance;
- one command validates the patch against the pinned graph and lands it, under the four conditions of `worker.md` section 7, in one storage transaction;
- an expansion of a childless node creates at least one surviving child of that node, which bounds the completeness exemption;
- the completeness check does not gate a node that declares `expansion` and holds no child.

## Non-goals

- **No plan import change.** `plan import` writes a whole document set against a project. A structural patch writes a mutation set against a claimed subtree. This epic touches neither `src/commands/plan/import-plan.ts` nor the document parser.
- **No author worker, and no routable expansion node.** Nothing produces a patch here. A human deferred every internal worker to phase 2, so no registry entry of EPIC 048 declares `expansion`, and an expansion claim answers `unroutable` in production. `worker.md` section 10 states an external client submits no graph patch and creates no node, so an external worker could not fill the gap. Every test of this epic supplies its own registry fixture holding one expansion-capable worker, and the phase-2 worker is then a registry edit rather than a rebuild.
- **No node deletion restriction beyond scope.** `worker.md` section 2 permits deleting a child in any state. This epic adds no state-based or checkpoint-based refusal.
- **No new revision model.** The patch reuses `plan_revision`. This epic adds no counter and no second version space.

## Decisions

- **The mutation algebra is closed, and every case is decided here.** `src/domain/graph-patch.ts` defines three operations and nothing else.

  | `op`     | fields                                                                                                                          | meaning                                                 |
  | -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
  | `create` | `id`, `kind`, `deliverable`, `title`, `parentId`, `repositoryId`, `verify`, `instruction`, `acceptance`, `dependsOn`            | Insert one node with the full field set.                |
  | `update` | `id`, and one or more of `title`, `deliverable`, `verify`, `instruction`, `acceptance`, `parentId`, `repositoryId`, `dependsOn` | Replace each named field. An absent field is unchanged. |
  | `delete` | `id`                                                                                                                            | Remove one node and every edge that names it.           |

  `update` is a partial replacement of named fields, never a merge of a value. `dependsOn` is the whole dependency list of that node, replaced wholesale, so an edge is never addressed on its own. Reparenting is one `update` naming `parentId`. A `delete` cascades to edges only; a delete of a node that still holds a child refuses `patch-hierarchy-invalid`, so a subtree is removed leaf-first and the patch says so explicitly.

- **One id appears at most once in a patch.** A second mutation naming an id refuses `patch-id-duplicate`. A create-then-update or a create-then-delete of one id is therefore impossible, and the list order carries no hidden state. The list stays ordered because a create must precede any reference to it, and the daemon applies it in that order.

- **Validation runs against the staged final graph, and the application order is separate.** `validatePatch` builds the graph as the patch would leave it, then checks ids, hierarchy, dependencies and scope in that fixed order. The mutations are then applied in list order inside the transaction. Judging a transient intermediate state would refuse a patch that removes one edge and adds another.

- **Scope has three rules, because a created node is not in the pinned subtree.** `patchScopeVerdict` refuses `patch-scope-invalid` when: an `update` or `delete` names an id outside the subtree of the claimed node in the **pinned** graph; a `create` gives a node whose final parent is outside the subtree of the claimed node in the **staged** graph; or a `dependsOn` entry names a node outside the claimed subtree in the staged graph. A single "targets" set cannot express these, and a checker that skips created nodes checks nothing about the mutation that matters most.

- **A patch never leaves its project, and the check is explicit.** An objective binds one repository, and a subtree may hold objectives of several repositories, so a repository rule proves nothing about a project. `patchProjectVerdict` refuses `patch-project-invalid` when a mutation names an existing node of another project, or when a `create` names a `parentId` or a `dependsOn` entry outside the claimed node's project. The rule is enforced and tested, not asserted.

- **`graph_revision` is a `plan_revision` id, and this epic states the mapping.** `worker.md` section 5 shows `graph_revision: 41` and defines no representation. The engine already versions a project's graph through `plan_revision`, whose id is a `revision_` ULID. The run pins that id at claim, per EPIC 050. Introducing a second counter would give one graph two version spaces.

- **The compare and swap is on the project's current revision pointer.** The land reads the project's current `plan_revision` id inside the transaction, refuses `graph-contended` when it is not the pinned one, inserts a new `plan_revision` whose `parent_id` is the pinned one, writes every mutated node and edge against that new revision, and moves the project pointer to it. `src/domain/revision-guard.ts:12` already classifies a structural write as `project` scope, which is the guard this land uses.

- **The whole land is one storage transaction, in one command.** Staging, validation against the pinned graph, the revision compare and swap, the mutations, the checkpoint row, the node transition, the event and the pointer move all sit in the single `storage.transact` block of `src/commands/checkpoint/accept-structural.ts`. `AGENTS.md` states a command imports `domain/` and service interfaces, never another command, so there is no second command to compose and no window in which validation and landing see different state.

- **`accept-structural` asserts all four conditions of `worker.md` section 7 itself.** Active run, matching fence, target inside the claimed subtree, matching graph revision. It calls `assertRunAuthority` of EPIC 050 for the first two, and derives the claimed node, the subtree and the pinned revision from the run row and the plan store. A caller-supplied subtree would let the caller define its own scope.

- **The refusal order is fixed and complete.**

  1. `run-not-found`, `run-ended`, `run-expired`, `run-caller-mismatch`, `fence-stale` — from `assertRunAuthority`.
  2. `patch-unparsable`, `patch-id-duplicate`, `patch-id-invalid`.
  3. `patch-hierarchy-invalid`.
  4. `patch-dependency-invalid`.
  5. `patch-scope-invalid`, `patch-project-invalid`.
  6. `pair-illegal`, `pair-fixed`.
  7. `expansion-empty`.
  8. `graph-contended`.

  Authority precedes content, content precedes scope, scope precedes semantics, and contention is last because it is the only refusal that depends on another writer.

- **The at-least-one-child rule applies to a claimed node that holds no child, and it is evaluated on the staged final graph.** `worker.md` section 7 states that an accepted expansion checkpoint creates at least one child, and that this bounds the completeness exemption. The exemption exists only for a childless node, so the rule binds exactly there. `expansionVerdict` refuses `expansion-empty` when the claimed node held no child in the pinned graph and holds none in the staged graph. A node that already holds children is free to shed them, which is what makes the parent-to-atomic conversion of `worker.md` section 2 reachable at all. Counting `create` mutations would pass a patch that creates a child and then reparents it away.

- **A child created by an expansion inherits nothing implicitly.** Each created node carries its own `kind`, `deliverable`, `verify` and, for an objective, its `repositoryId`. The pair table of EPIC 047 validates each created node, and an illegal pair refuses `pair-illegal`. An inherited field would make a patch unreadable against the document the human later exports.

- **A pair change is legal only before the first child and the first accepted checkpoint.** `pairChangeVerdict({ nodeId, hasChild, hasAcceptedCheckpoint })` refuses `pair-fixed`, reading both facts from storage in the pinned graph. `worker.md` section 2 states the rule, and states that a parent objective becomes atomic only after a structural patch deletes every child, in any state. The two-patch sequence is therefore: patch one deletes every child; patch two changes the pair.

- **A delete carries no state condition and no checkpoint condition.** `worker.md` section 2 states a parent objective becomes atomic after a patch deletes every child, in any state. A checkpoint row is immutable evidence bound to a `plan_revision` that still exists, so removing a node from the current graph rewrites nothing. `checkpoint.node_id` therefore has no foreign-key delete cascade, and a test asserts the checkpoint row survives the deletion of the node it names.

- **The mutation set is canonically serialised and pinned before acceptance.** `renderGraphPatch(patch)` emits canonical JSON: keys sorted bytewise at every level, mutations in list order, two-space indentation, one trailing newline. `services/blob` stores those bytes and returns the hash, and `checkpoint.patch_blob` holds it. `worker.md` section 11 requires structural evidence to be the mutation set, and evidence that is not pinned by content is not evidence.

- **A structural checkpoint holds no commit and runs no command.** `worker.md` section 11 states it. The CHECK clauses of EPIC 051 already refuse `accepted_oid` on a structural row, and a test asserts no verify call is made during a structural acceptance.

- **The completeness exemption is one parameter, and only the claimed node is ever passed.** `completenessFindings` at `src/domain/plan-completeness.ts:22` gains `exempt: readonly string[]` on `CompletenessInput`. A parent whose key is in `exempt` raises no finding. The claim passes the claimed node's key when its deliverable is `expansion`. `worker.md` section 7 states the exemption covers that node's own missing children, and nothing else.

## Stories

1. **The patch shape.** Add `src/domain/graph-patch.ts` with `graphPatch` and the three mutation shapes of the Decisions table. Add `src/domain/graph-patch.test.ts` asserting each shape parses with its full field set, asserting an unknown `op` is refused by value, asserting an `update` with no field beyond `id` is refused, asserting the list order survives a parse, and asserting a duplicate id refuses `patch-id-duplicate`.

2. **Canonical serialisation.** Add `renderGraphPatch` to `src/domain/graph-patch.ts`. Add cases asserting byte-exact output against a literal, asserting key order is bytewise at every level, asserting mutation order is preserved, and asserting two structurally equal patches with different key insertion orders render identically.

3. **The staged graph.** Add `src/domain/graph-patch-stage.ts` with `stagePatch(pinnedGraph, patch)` returning the graph as the patch would leave it. Add its test asserting a create, an update, a reparent and a delete each produce the expected staged node set and edge set, and asserting a delete removes every edge naming the node.

4. **Patch validation.** Add `src/domain/graph-patch-validate.ts` with `validatePatch` running ids, hierarchy, dependencies and scope against the staged graph in the fixed order. Add its test asserting each refusal in isolation, asserting a patch failing two checks returns only the earlier code, and asserting a delete of a node that still holds a child refuses `patch-hierarchy-invalid`.

5. **Scope and project.** Add `patchScopeVerdict` and `patchProjectVerdict`. Add cases asserting: an `update` outside the pinned subtree refuses and names the id; a `create` whose final parent is inside the staged subtree passes; a `create` whose final parent is outside refuses; a `dependsOn` entry outside the claimed subtree refuses; a mutation naming a node of another project refuses `patch-project-invalid`; and a `create` whose `dependsOn` names a node of another project refuses.

6. **The cycle check.** Extend `validatePatch` to compute the dependency closure over the staged graph with `src/domain/plan-ancestry.ts`. Add cases stating the exact initial edges, the exact mutations and the exact expected closure: a patch removing edge `A→B` and adding edge `B→A` passes, because the final graph holds one edge; the same addition without the removal refuses `patch-dependency-invalid`; and a self-dependency refuses.

7. **The at-least-one-child rule.** Add `expansionVerdict({ claimedNodeId, pinnedGraph, stagedGraph })`. Add cases asserting: a childless claimed node whose staged graph holds one direct child passes; a childless claimed node whose staged graph holds none refuses `expansion-empty`; a patch that creates a child and reparents it away refuses; a claimed node that already holds children and whose patch deletes them all passes; and a claimed node whose staged child belongs to another parent refuses.

8. **The pair is fixed by a child or a checkpoint.** Add `pairChangeVerdict` to `src/domain/node-pair.ts`. Add cases asserting a change with neither passes, a change with a child refuses `pair-fixed`, a change with an accepted checkpoint refuses `pair-fixed`, and a single patch deleting every child and changing the pair refuses `pair-fixed`. Add a companion case proving the two-patch sequence succeeds.

9. **A delete carries no state or checkpoint condition.** Add cases asserting a child in each of the eight `nodeStates` values deletes, and asserting a `checkpoint` row whose `node_id` names a deleted node still exists after the land, read by id.

10. **The completeness exemption.** Add `exempt` to `CompletenessInput` at `src/domain/plan-completeness.ts:16` and honour it at line 26. Add cases asserting an exempt parent raises no finding while a second, non-exempt parent in the same input raises one, and asserting the exemption never suppresses a finding for a different parent.

11. **Accept structural.** Add `src/commands/checkpoint/accept-structural.ts` as one command, tested against a registry fixture holding one internal expansion-capable worker: `assertRunAuthority`, derive the claimed node, subtree and pinned revision from the run row and the plan store, parse and pin the patch through `services/blob`, validate, apply the mutations in list order, insert the new `plan_revision`, move the project pointer, write the checkpoint, the transition and the event — all in one `storage.transact`. Add its test asserting the full refusal order across all fifteen codes, asserting the command imports no other command, asserting a successful acceptance leaves the claimed node with at least one child and the project on a new revision whose `parent_id` is the pinned one, and asserting `checkpoint.patch_blob` resolves to bytes identical to `renderGraphPatch` of the submitted patch.

12. **Nothing is written on a refusal.** Add a case comparing a full snapshot of `node`, `edge`, `plan_revision`, the project revision pointer, `checkpoint`, `run`, `attempt` and `event` before and after each of the fifteen refusals.

13. **No command runs during a structural acceptance.** Add a case asserting the verify service double records zero calls, and asserting `checkpoint.accepted_oid` is null.

14. **The claim exempts an expansion node.** Extend `src/commands/node/claim-node.ts` to pass the claimed node's key in `exempt` when its deliverable is `expansion`. Add cases asserting a claim on a childless expansion node succeeds, and asserting a claim on a childless objective whose deliverable is `implementation` still refuses `plan-incomplete`.

15. **The route enforces the gate.** Wire the structural report path in `src/http/server/` to `accept-structural`, mapping each refusal to its contract error, and add the codes to `src/http/contract/errors.ts`. Add an integration case asserting a stale fence is refused before the patch is parsed.

16. **The proposal records the structural checkpoint.** Amend `docs/proposal/phase-2/checkpoints.md` with the mutation algebra, the staged-graph rule, the three scope rules, the project rule, the fixed refusal order, the revision compare and swap, the at-least-one-child rule and its childless-node condition, the pair-fixing rule and its two-patch sequence, the delete rule, and the canonical patch serialisation.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/graph-patch.test.ts \
  src/domain/graph-patch-stage.test.ts \
  src/domain/graph-patch-validate.test.ts \
  src/domain/node-pair.test.ts \
  src/domain/plan-completeness.test.ts \
  src/commands/checkpoint/accept-structural.test.ts \
  src/commands/node/claim-node.test.ts \
  src/http/server/outcome/report-outcome.test.ts \
  && echo "PASS EPIC-052"
```

Hermetic coverage required beyond the Proof:

- A duplicate id in one patch refuses `patch-id-duplicate`, so no create-then-update sequence exists to reason about.
- `renderGraphPatch` is byte-exact against a literal, and two patches with different key insertion orders render identically.
- A patch removing edge `A→B` and adding edge `B→A` passes, and the same addition without the removal refuses `patch-dependency-invalid`. The case states the exact initial edges and the exact final closure.
- A `create` whose final parent is inside the staged subtree passes, and one whose final parent is outside refuses `patch-scope-invalid`. Both are asserted, so the created-node rule is not vacuous.
- A mutation naming a node of another project refuses `patch-project-invalid`, and a `create` whose `dependsOn` crosses a project refuses the same. The cross-project invariant is proven, not asserted.
- A childless claimed node whose patch creates a child and then reparents it away refuses `expansion-empty`. Counting `create` mutations would pass this case.
- A claimed node that already holds children and whose patch deletes every one of them passes. This is the case that makes the parent-to-atomic conversion reachable, and it is the direct consequence of the childless-node condition.
- The two-patch conversion sequence succeeds: patch one deletes every child, patch two changes the pair. A single combined patch refuses `pair-fixed`.
- A child is deleted in each of the eight `nodeStates` values, iterated from the tuple.
- A `checkpoint` row survives the deletion of the node it names, read by id after the land.
- An exempt parent raises no completeness finding while a second, non-exempt parent in the same input raises one. Both assertions are in one case, so a blanket exemption fails.
- The fifteen refusal codes are each reachable, and a patch failing two returns the earlier one by the stated order. Authority refusals precede every content refusal, asserted by a stale fence against a syntactically invalid patch.
- Each of the fifteen refusals leaves a full snapshot of eight tables unchanged.
- A structural acceptance makes zero verify calls and leaves `checkpoint.accepted_oid` null.
- `checkpoint.patch_blob` resolves through `services/blob` to bytes identical to `renderGraphPatch` of the submitted patch.
- `accept-structural` imports no other command. The assertion is the `eslint-plugin-boundaries` rule of `AGENTS.md`, run by `pnpm run lint`.
- A claim on a childless node whose deliverable is `expansion` succeeds against the registry fixture, and a claim on a childless objective whose deliverable is `implementation` refuses `plan-incomplete`. Both are asserted, so the exemption is bounded.
- Against the **production** registry, a claim on any expansion node refuses `unroutable` with `failedSet: "capable"`. The assertion records that the structural path has no worker until phase 2, so nobody reads the fixture as production behaviour.
