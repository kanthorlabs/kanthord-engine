# Story 10 — `updateNode`

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: Story 9. The two commands share the write order, and this story mirrors it.

## Change

### A new `src/commands/node/update-node.ts`

Dependencies are the same eight members as `CreateNodeDependencies`.

```ts
export type UpdateNodeInput = Readonly<{
  id: string;
  fromRevision: string;
  node: NodeUpdateBody;
  actor: ActorRow;
}>;

export type UpdateNodeResult = Readonly<{
  revision: string;
  completeness: readonly Finding[];
}>;
```

`NodeUpdateBody` is the same three-member discriminated union on `kind` as Story 9, declared in this file. **An update replaces the whole editable field set.** An omitted field is `400 invalid-request` at the schema, so the command never keeps a stored value silently.

One transaction, in exactly this order.

0. `const at = clock.now();` — one clock read for the whole command, exactly as Story 9 step 0 requires.
1. `const before = plan.readNode(transaction, input.id)`. A `null` throws `NodeWriteError("node-not-found", ...)`.
2. When `input.node.kind !== before.kind`, throw `NodeWriteError("kind-mismatch", ...)` with `details` of `{ expected: before.kind, actual: input.node.kind }`.

   **`kind-mismatch` is a seventh member of `nodeWriteRefusalCodes` in Story 8, and it maps to `400 invalid-request`.** The schema cannot answer this one: a discriminated union proves that a submitted kind carries the right fields, but only the database knows the stored kind. Routing it through `plan-invalid` with an empty `findings` array, as an earlier draft of this story did, both contradicts the EPIC — which calls it `400 invalid-request` at `.agent/plan/epics/017-per-node-graph-write.md:76` — and ships a `422` whose findings array says nothing. The handler maps the refusal; it reads no domain rule, so `AGENTS.md`'s no-branching rule holds.

3. Resolve the submitted `repo` name to a repository id, as Story 9 step 6 does, and load the stored instruction and acceptance blob hashes.
4. `const fields = differingFields(before, <the submitted node as a ResolvedDocument-shaped value>, { instruction, acceptance })` of `src/domain/plan-diff.ts:6`. Compute the two submitted blob hashes through `blobs.hash(...)` **without** writing them, so `body` differs only on a real content change.
5. `const kind = fields.includes("parent") || fields.includes("depends_on") ? "update-topology" : "update-fields"`, then `const guard = revisionGuardFor(kind)`.
6. When `guard === "node"`, compare `input.fromRevision` with `before.revision`. When `guard === "project"`, compare it with `plan.newestRevision(transaction, before.projectId)`. A mismatch throws `NodeWriteError("stale-revision", ..., { guard, expected, actual: input.fromRevision })`.
7. Read the containment facts: `plan.readContainmentFacts(transaction, input.id)` for a task, and `plan.readSubtreeContainmentFacts(transaction, input.id)` for an objective or an initiative (`src/services/plan/sqlite.ts:229,253`). Compute `containmentMovable(before.kind, facts)` of `src/domain/plan-containment.ts:4`.
8. `nodeWriteLegality({ state: before.state, fields, containmentMovable })`. A `state` refusal throws `NodeWriteError("illegal-transition", ..., { nodes: [{ id: input.id, state: before.state }] })`. A `containment` refusal throws `NodeWriteError("binding-in-use", ..., { blockers: <one entry per true fact, see below> })`.
9. `const revisionId = ids.mint("planRevision")` and `const newest = plan.newestRevision(transaction, before.projectId)`.
10. Write the two blobs through `blobs.put`.
11. Build `after` in memory: `plan.readGraph(transaction, before.projectId).nodes` with the edited node replaced, carrying `revision: revisionId`, `updatedAt: clock.now()` and its `dependencies` deduplicated and sorted bytewise. Every other node is unchanged.
12. `validateCandidateStructural` over `after`, exactly as Story 9 step 8. A non-empty result throws `NodeWriteError("plan-invalid", ..., { findings })`.
13. `revision.render(transaction, { nodes: after })`.
14. `revision.record(transaction, { projectId: before.projectId, revisionId, parentRevision: newest, documents })`.
    14a. **The waiver check.** Compute the edge deletes first, then refuse when any of them holds a non-null `waived_at`: throw `NodeWriteError("binding-in-use", ..., { blockers })`, one `{ nodeId: input.id, blocker: "waived-edge" }` entry, deduplicated. A waiver records a human decision that `docs/proposal/api/outcome.md:37-43` says must survive, and a `depends_on` edit that drops a waived edge would erase it exactly as a hard delete would. Story 11 refuses a delete for the same reason; an update must not be the hole in that rule. The check runs after the legality check of step 8 and before any write.

15. One `plan.mutateGraph` call carrying the changed node, the edge inserts and the edge deletes. The edge reconciliation uses the same delete-then-insert order as `src/commands/plan/import-plan.ts:450-469`: compute the stored pair set and the wanted pair set keyed on `(fromNode, toNode)`, delete every stored pair absent from the wanted set in stored order, and insert every wanted pair absent from the stored set sorted by `fromNode` then `toNode` through `comparePaths`. `nodeDeletes` is empty. `at` is the step-0 value. `cause` is `{ revision: revisionId, importId: null }`.
16. `validateCandidateCompleteness` over the candidate of step 12.
17. `events.append(transaction, { subjectKind: "node", subjectId: input.id, type: "node.updated", actorKind: input.actor.kind, actorId: input.actor.id, payload: { fields, revision: revisionId } })`. `fields` is the differing-field list of step 4, already sorted by `differingFields`.
18. Return `{ revision: revisionId, completeness }`.

**An update whose differing-field set is empty still mints a revision**, so a client cannot tell a no-op from a lost response.

The `binding-in-use` blocker list of step 8 is derived from `ContainmentFacts` at `src/domain/plan-graph.ts:28`, one entry per true member, in this declared order: `lease`, `workspace`, `attempt-commit`, `retained-commit`. Each entry is `{ nodeId: input.id, blocker }`.

## Constraints

- The command calls `setNodeState` never, and names a trigger never.
- Exactly one `mutateGraph` call per successful update.
- No kind change, no identity change and no project move. A kind change moves the identity prefix and the containment legality at once, so it stays an import.
- Eight structural codes are reachable on an update: the six of Story 9 plus `dependency-self` and `dependency-cycle`.
- `repo-on-task`, `repo-missing` and `identity-kind-mismatch` are not reachable.
- A structural edit is legal at `pending`, `ready` and `blocked` and refused at the other five states. `nodeWriteLegality` is the one rule; do not restate its state set in this file.
- No completeness finding refuses anything.

## Verify

Create `src/commands/node/update-node.test.ts`, suite name `src/commands/node/update-node.test`, on real SQLite.

- `a title edit succeeds at every state` — drive a title-only update over all eight `nodeStates` and assert `200`-shaped success each time.
- `a structural edit succeeds at pending, ready and blocked and is illegal-transition at the other five` — drive a `depends_on` edit over all eight states and assert the outcome per state. Assert `details.nodes` names the node with its state on each refusal.
- The guard assertions listed in Story 8 for `update-node.test.ts`, verbatim: node-revision success, project-revision refusal with `details.guard === "node"`, `depends_on` at the node revision refused with `details.guard === "project"`, and the classification of `parent`, `worker` and `repo`.
- **The concurrency proof** of Story 8: two field-only updates on two different nodes at their own node revisions both succeed; assert `R2.parentId === R1`, that `acceptedBlob(R2)` holds both edits, that `exportPlan` reports `R2`, that the export bytes equal the `acceptedBlob(R2)` bytes through `Buffer.compare`, and that each node's `revision` column holds `R1` and `R2` respectively.
- Eight named structural refusals, one test each, asserting `plan-invalid` and the code in `details.findings`: the six of Story 9 plus `dependency-self` and `dependency-cycle`. Each asserts the `node`, `edge` and `plan_revision` row counts are equal before and after.
- `a parent move of a task holding a workspace is binding-in-use` — assert `details.blockers` deep-equals `[{ nodeId, blocker: "workspace" }]`.
- `an objective move uses the subtree facts` — seed a lease on a descendant task and assert the objective move is `binding-in-use` with the blocker `lease`.
- `an empty differing-field set still mints a revision` — resubmit the stored values unchanged; assert a new `plan_revision` row and that `node.revision` moved to it.
- `an update that empties an objective succeeds and reports the finding` — move the last task out of an objective; assert success, that `result.completeness` names `objective-without-task`, that `showNode` returns the objective unchanged in state, and that a following `exportPlan` re-imports.
- `an update that adds an unsatisfied dependency to a ready node demotes it` — assert `node.state` becomes `pending`, that one `node.pending` event with `actor_kind = 'daemon'` was appended in the same transaction, and that the transition trigger is `readiness-demoted`.
- `an update that removes the same dependency promotes it back` — assert `ready`, one `node.ready` event, and the trigger `readiness-promoted`.
- `export bytes equal the accepted blob` — as Story 9.
- `appends one node.updated event whose payload lists the differing fields` — assert the payload `fields` array exactly.
- `calls mutateGraph exactly once and setNodeState never` — the recording fake of Story 9; assert the recorded input holds no `trigger` key.
- `edge reconciliation deletes before it inserts` — an update that swaps one dependency for another passes exactly one id in `deleteEdgeIds` and one entry in `insertEdges`. Assert the **contents** of the one recorded `mutateGraph` input; the execution order inside the store belongs to the Story 4 store test, and one command-level call cannot establish it.
- `an update that drops a waived edge is refused` — seed a dependency edge with `waived_at` set through raw SQL, submit a `depends_on` set that omits it, and assert `binding-in-use` with the blocker `waived-edge`, that the edge row and its `waived_at` survive, and that no `plan_revision` row was added.
- `an update that keeps a waived edge succeeds` — the same fixture with the dependency retained commits normally.
- `a kind change is 400` — assert refusal `kind-mismatch` with `details` of `{ expected, actual }`, and that nothing is written.
- `one clock read per command` — a mock clock that advances on every call; assert every `updated_at` written by one `updateNode` is the same value.
- `node --test src/commands/node/update-node.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/commands/node/update-node.test.ts`. Hermetic coverage bullets `.agent/plan/epics/017-per-node-graph-write.md:143`, `:145`, `:147`, `:149`, `:151`, `:153`, `:154`, `:155`, `:156`, `:161` and `:168`.
