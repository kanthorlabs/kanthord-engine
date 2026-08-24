# Story 11 — `deleteNode`

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: Stories 4, 7, 8 and 9.

## Change

### `src/services/plan/index.ts` and `src/services/plan/sqlite.ts` — one new read

`ContainmentFacts` at `src/domain/plan-graph.ts:28` names no run, no attempt, no check result and no git operation, so the delete needs its own read.

```ts
export const executionBlockers = [
  "lease",
  "workspace",
  "run",
  "attempt",
  "commit",
  "check-result",
  "git-operation",
] as const;
export type ExecutionBlocker = (typeof executionBlockers)[number];

export type SubtreeExecutionFact = Readonly<{
  nodeId: string;
  blocker: ExecutionBlocker;
}>;

  readSubtreeExecutionFacts(
    transaction: Transaction,
    nodeId: string,
  ): readonly SubtreeExecutionFact[];
```

Declare `executionBlockers` and `SubtreeExecutionFact` in `src/domain/plan-graph.ts`, and the method on `PlanStore`.

The implementation resolves the subtree with the same recursive CTE as `src/services/plan/sqlite.ts:257-260`, then runs one query per blocker over that id set and emits one fact per `(nodeId, blocker)` pair found. The seven queries are fixed:

| blocker         | query                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `lease`         | `SELECT subject_id AS node_id FROM lease WHERE subject_kind = 'node' AND subject_id IN (...)`       |
| `workspace`     | `SELECT node_id FROM workspace WHERE node_id IN (...)`                                              |
| `run`           | `SELECT node_id FROM run WHERE node_id IN (...)`                                                    |
| `attempt`       | `SELECT r.node_id AS node_id FROM attempt a JOIN run r ON r.id = a.run_id WHERE r.node_id IN (...)` |
| `commit`        | `SELECT node_id FROM candidate WHERE node_id IN (...)`                                              |
| `check-result`  | `SELECT node_id FROM check_result WHERE node_id IN (...)`                                           |
| `git-operation` | `SELECT node_id FROM git_operation WHERE node_id IN (...)`                                          |

**There is no `commit` table.** The `commit` blocker is backed by `candidate`, which carries `candidate.node_id` at `src/services/storage/migration-0003-execution-and-journal.ts:79`.

**The `lease` query matches every row, held or released.** `lease` carries no foreign key onto `node`; it is the polymorphic subject at `:21-22`. `readContainmentFacts` at `src/services/plan/sqlite.ts:330-339` filters on `owner IS NOT NULL`, because it asks whether a node is _currently_ held. This query asks a different question — whether a hard delete would orphan a row — and a released lease row survives with `owner = NULL` precisely to keep its fence. Deleting the node under it would leave a `lease` row naming a node that no longer exists, and no foreign key would catch it. Do **not** copy the `owner IS NOT NULL` filter here. The two queries ask different questions and the difference is deliberate. `attempt` reaches `node` only through `run_id` at `:49`. The other four are direct foreign keys: `workspace.node_id` at `:9`, `run.node_id` at `:33`, `check_result.node_id` at `:106` and `git_operation.node_id` at `:131`.

The result is deduplicated to one entry per `(nodeId, blocker)` pair, sorted by `nodeId` bytewise through `Buffer.compare` and then by the position of the blocker in `executionBlockers`.

### A new `src/commands/node/delete-node.ts`

Dependencies are the same eight members as `CreateNodeDependencies`.

```ts
export type DeleteNodeInput = Readonly<{
  id: string;
  fromRevision: string;
  actor: ActorRow;
}>;

export type DeleteNodeResult = Readonly<{
  revision: string;
  deleted: readonly string[];
  completeness: readonly Finding[];
}>;
```

One transaction, in exactly this order.

1. `const before = plan.readNode(transaction, input.id)`. A `null` throws `NodeWriteError("node-not-found", ...)`.
2. `const newest = plan.newestRevision(transaction, before.projectId)`. When `input.fromRevision !== newest`, throw `NodeWriteError("stale-revision", ..., { guard: "project", expected: newest, actual: input.fromRevision })`. The guard class comes from `revisionGuardFor("delete")`.
3. `const at = clock.now();` — one clock read for the whole command, exactly as Story 9 step 0 requires.
4. Resolve the containment subtree with a recursive CTE that **carries a depth column**. The CTE at `src/services/plan/sqlite.ts:257-260` returns `id` only, ordered by `id ASC`, which is not a containment order: identity order says nothing about depth, so a parent can sort before its child. Add depth and add a new method rather than changing the existing one, which `readSubtreeContainmentFacts` still uses:

```sql
WITH RECURSIVE descendant(id, depth) AS (
  SELECT ?, 0
  UNION ALL
  SELECT n.id, d.depth + 1 FROM node n JOIN descendant d ON n.parent_id = d.id
)
SELECT id, depth FROM descendant ORDER BY depth DESC, id ASC
```

`ORDER BY depth DESC, id ASC` is the child-first order, and it is total: a child always has a greater depth than its parent, and two nodes at one depth break the tie bytewise. That order is what step 11 passes as `nodeDeletes`.

Expose it as `PlanStore.readSubtree(transaction, nodeId): readonly string[]`, returning the ids in that order. The delete set is that array. 4. **Refusal one, state.** A subtree node outside `pending`, `ready` and `blocked` throws `NodeWriteError("illegal-transition", ..., { nodes })`, where `nodes` is one `{ id, state }` entry per offending node, sorted by `id` bytewise. 5. **Refusal two, execution.** `plan.readSubtreeExecutionFacts(transaction, input.id)`. A non-empty result throws `NodeWriteError("binding-in-use", ..., { blockers })`, where `blockers` is that list. 6. **Refusal three, waiver.** Read every edge whose `from_node` or `to_node` is in the delete set and whose `waived_at` is not null. A non-empty result throws `NodeWriteError("binding-in-use", ..., { blockers })`, where each entry is `{ nodeId, blocker: "waived-edge" }` for the subtree node the edge touches, deduplicated and sorted by `nodeId` bytewise. A hard delete of a node touched by a waived edge would erase a human decision, which `docs/proposal/api/outcome.md:37-43` forbids. 7. `const revisionId = ids.mint("planRevision")`. 8. Build `after` in memory: `plan.readGraph(transaction, before.projectId).nodes` with every delete-set node removed. Every surviving node whose dependency set shrank gets its `dependencies` recomputed and `revision: revisionId`, `updatedAt: clock.now()`. A survivor whose dependency set did not change is not restamped. 9. `revision.render(transaction, { nodes: after })`. 10. `revision.record(transaction, { projectId: before.projectId, revisionId, parentRevision: newest, documents })`. 11. One `plan.mutateGraph` call carrying: `nodes` equal to the restamped survivors of step 8 in bytewise id order; `insertEdges: []`; `deleteEdgeIds` equal to every edge id touching the delete set, sorted bytewise; `nodeDeletes` equal to the delete set exactly as `readSubtree` returned it, which is child-first by `depth DESC, id ASC`; `at` equal to the step-0 value; `cause: { revision: revisionId, importId: null }`. 12. `validateCandidateCompleteness` over a candidate built from `after`, as Story 9 step 8 builds it. `validateCandidateStructural` is **not** called: a delete removes a containment subtree and every edge touching it, so it makes no orphan and no unresolved reference, and it reaches no structural code. 13. `events.append` once per deleted node, in bytewise identity order, with `type: "node.deleted"`, `actorKind: input.actor.kind`, `actorId: input.actor.id` and `payload: { kind, parentId, revision: revisionId }`. 14. Return `{ revision: revisionId, deleted: <the delete set in bytewise id order>, completeness }`.

**A delete cascades down the containment tree only, never along a dependency edge**, which is the cascade rule `docs/proposal/api/outcome.md:31` already states for discard.

## Constraints

- This is not `node.discard`. Write no `discard_reason`, move no dependent to `blocked`, and add no `reason` input. `docs/proposal/api/outcome.md:13` keeps discard in phase 3.
- The command calls `setNodeState` never, and names a trigger never.
- Exactly one `mutateGraph` call per successful delete.
- A delete never demotes, because it adds no edge. It can promote a `pending` dependent of a deleted node to `ready`.
- The three refusals run in the declared order — state, execution, waiver — so a node failing two reports the first. A test pins that order.
- An attempt always has a run, so a node blocked by an attempt reports both `run` and `attempt`. The test asserts the pair, not one code.
- The blocker set is closed. Add no eighth blocker.

## Verify

Create `src/commands/node/delete-node.test.ts`, suite name `src/commands/node/delete-node.test`, on real SQLite.

- `deletes an objective and every task under it` — assert the `node` table holds neither, that `result.deleted` lists them in bytewise order, and that `plan_revision` gained one `node-write` row.
- `removes every edge touching the subtree` — after the delete, read the whole `edge` table and assert no row whose `from_node` or `to_node` is absent from `node`.
- `refuses a stale project revision` — `stale-revision` with `details.guard === "project"`; row counts equal before and after.
- `refuses a subtree node in a non-deletable state` — an objective whose task is `done` is `illegal-transition`, and `details.nodes` names the task with its state.
- Seven blocker refusals, one test each, seeding exactly one execution row per blocker: `lease`, `workspace`, `run`, `attempt`, `commit` (a `candidate` row), `check-result`, `git-operation`. Each asserts `binding-in-use`, the blocker name in `details.blockers`, and that the whole database is byte-identical before and after.
- `a run with an attempt reports both blockers` — `details.blockers` deep-equals the two entries for that node, deduplicated, in the declared order `run` then `attempt`.
- `a waived edge refuses the delete` — `binding-in-use` with the blocker `waived-edge`; assert the edge row and its `waived_at` survive.
- `the refusal order is state, then execution, then waiver` — a fixture that trips all three reports `illegal-transition`.
- `restamps only the survivors whose dependency set shrank` — assert the restamped nodes carry the new revision and that every other node's `revision` and `updated_at` are byte-identical before and after.
- `deletes child-first` — over a three-level fixture whose identities sort parent-before-child bytewise, assert the recorded `nodeDeletes` list places every child before its parent. The fixture must defeat identity order, or the assertion passes by accident.
- `readSubtree orders by depth descending then id ascending` — a store-level test in `src/services/plan/sqlite.test.ts` over a three-level tree with two siblings at one depth; assert the exact array.
- `a released lease blocks the delete` — seed a `lease` row with `subject_kind = 'node'` and `owner = NULL`; assert `binding-in-use` with the blocker `lease`. This is the case `readContainmentFacts` deliberately ignores, and a delete must not leave the row orphaned.
- `no orphaned lease row survives a delete` — after every successful delete fixture, assert no `lease` row with `subject_kind = 'node'` names an id absent from `node`.
- `one clock read per command` — a mock clock that advances on every call; assert every `updated_at` written by one `deleteNode` is the same value.
- `promotes a dependent that loses its only dependency` — assert the dependent becomes `ready`, that one `node.ready` event from EPIC 016 was appended in the same transaction, and that the trigger is `readiness-promoted`.
- `never demotes` — assert no `readiness-demoted` transition on any delete fixture.
- `reports completeness and refuses nothing` — delete the last task under an objective; assert success and that `result.completeness` names `objective-without-task`.
- `export bytes equal the accepted blob` — as Story 9.
- `appends one node.deleted event per deleted node in bytewise identity order, carrying the resolved actor` — drive with a `harness` `ActorRow`.
- `calls mutateGraph exactly once and setNodeState never` — the recording fake of Story 9; assert the recorded input holds no `trigger` key.
- Extend `src/services/plan/sqlite.test.ts` with `readSubtreeExecutionFacts` coverage: an empty result on a clean subtree; one fact per blocker; deduplication of a repeated pair; and the sort order over two nodes and two blockers each.
- `node --test src/commands/node/delete-node.test.ts src/services/plan/sqlite.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/commands/node/delete-node.test.ts` and `src/services/plan/sqlite.test.ts`. Hermetic coverage bullets `.agents/plan/epics/017-per-node-graph-write.md:143`, `:152`, `:162`, `:163`, `:164`, `:165`, `:166` and `:168`.
