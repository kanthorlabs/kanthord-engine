# Story 9 — `createNode`

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: Stories 4, 5, 7 and 8.

## Change

### A new `src/commands/node/create-node.ts`

```ts
export type CreateNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  revision: Revision;
}>;

export type CreateNodeInput = Readonly<{
  projectId: string;
  fromRevision: string | null;
  node: NodeCreateBody;
  actor: ActorRow;
}>;

export type CreateNodeResult = Readonly<{
  revision: string;
  id: string;
  completeness: readonly Finding[];
}>;

export function createNode(
  dependencies: CreateNodeDependencies,
  input: CreateNodeInput,
): CreateNodeResult;
```

`NodeCreateBody` is the discriminated union Story 12 declares in `src/http/contract/graph.ts`; import its inferred type from there is **not** legal under the import matrix, so declare the same shape in this file as a plain type and let Story 12's handler map into it. The three members are:

- `{ kind: "initiative"; title: string; instruction: string; worker: string | null; dependsOn: readonly string[] }`
- `{ kind: "objective"; title: string; parentId: string; repo: string; instruction: string; worker: string | null; dependsOn: readonly string[] }`
- `{ kind: "task"; title: string; parentId: string; instruction: string; acceptance: string; worker: string | null; dependsOn: readonly string[] }`

The whole command runs inside one `dependencies.storage.transact`, in exactly this order. The order is normative, because `node.revision` at `src/services/storage/migration-0002-graph-and-plan.ts:30` is a `NOT NULL` foreign key onto `plan_revision`.

0. `const at = clock.now();` — **read the clock exactly once per command, as the first statement inside the transaction.** Every node stamp, every `mutateGraph` call and every event of this write uses that one value. A second `clock.now()` lets a readiness transition rewrite `updated_at` with a different timestamp inside one logical operation, which makes the write non-deterministic against a mock clock that advances. Stories 10 and 11 take the same rule.
1. `SELECT id FROM project WHERE id = ?`. A miss throws `NodeWriteError("project-not-found", ...)`.
2. `const newest = plan.newestRevision(transaction, input.projectId)`. When `input.fromRevision !== newest`, throw `NodeWriteError("stale-revision", ..., { guard: "project", expected: newest, actual: input.fromRevision })`. The guard class comes from `revisionGuardFor("create")`.
3. `const id = ids.mint(input.node.kind)` and `const revisionId = ids.mint("planRevision")`, in that order.
4. `const instructionBlob = blobs.put(transaction, encoder.encode(input.node.instruction))`. For a task, `const acceptanceBlob = blobs.put(transaction, encoder.encode(input.node.acceptance))`; otherwise `null`.
5. `const { nodes: stored } = plan.readGraph(transaction, input.projectId)`.
6. Resolve `repositoryId`: for an objective, `SELECT id FROM repository WHERE name = ?` on `input.node.repo`. Keep **two** values, and never conflate them: `repositoryId` is the resolved id or `null` on a miss, and `repositoryName` is always the submitted string. Do not put a name into a `StoredNode.repositoryId` field.
7. Build `const after: readonly StoredNode[]` as `stored` concatenated with one new `StoredNode` for the created node, carrying `state: "pending"`, `blockReason: null`, `discardReason: null`, `revision: revisionId`, `updatedAt: at` and `dependencies` equal to `input.node.dependsOn` deduplicated and sorted bytewise through `Buffer.compare`. Its `repositoryId` is the resolved id, or `null` on a miss.
8. Build a `Candidate` over `after` with `source: "database"` on every node. **The candidate is a separate projection, not `after` itself.** Map every stored node's `repositoryId` to its repository name exactly as `src/commands/plan/import-plan.ts:186-198` does, and for the new node use `repositoryName` — the submitted string — whether or not it resolved. A submitted name that names no repository therefore reaches the validator as an unknown name and is reported as `repository-unknown`; it never throws the untyped `ImportPlanError` that `import-plan.ts:191` raises for an unresolvable **stored** id, because that path only walks ids that came out of the database. Call `validateCandidateStructural({ findCycles: (g) => graph.cycles(g) }, { candidate, context })`, where `context` is `plan.readValidationContext(transaction, input.projectId)`. A non-empty result throws `NodeWriteError("plan-invalid", "the write builds an invalid graph", { findings })`, and the transaction commits nothing.
9. `const documents = revision.render(transaction, { nodes: after })`.
10. `revision.record(transaction, { projectId: input.projectId, revisionId, parentRevision: newest, documents })`.
11. `plan.mutateGraph(transaction, { projectId: input.projectId, nodes: [<the new node as a NodeWrite carrying revision: revisionId>], insertEdges: <one edge per dependsOn entry, sorted bytewise by toNode, each id from ids.mint("edge")>, deleteEdgeIds: [], nodeDeletes: [], at, cause: { revision: revisionId, importId: null } })`. Keep the returned transition list; step 14 does not expose it, but the tests observe it through the recording fixture named below.
12. `const completeness = validateCandidateCompleteness(...)` over the same candidate and context of step 8.
13. `events.append(transaction, { subjectKind: "node", subjectId: id, type: "node.created", actorKind: input.actor.kind, actorId: input.actor.id, payload: { kind, parentId, revision: revisionId } })`.
14. Return `{ revision: revisionId, id, completeness }`.

Step 10 precedes step 11, so the `plan_revision` row exists before the `node` row that references it. That is why `Revision.record` renders nothing from the database.

Readiness applies inside `mutateGraph`, per `016-readiness-applied.md:49`. The call names no trigger, because `MutateGraphInput` declares no `trigger` member.

## Constraints

- The command calls `setNodeState` never, and names a trigger never.
- The command opens exactly one transaction and calls `mutateGraph` exactly once.
- `dependsOn` is deduplicated and sorted bytewise before it becomes edges and before it becomes the candidate node's `dependencies`, so the same request always writes the same edge rows in the same order.
- Six structural codes are reachable on a create: `parent-missing`, `worker-unknown`, `repository-unknown`, `repository-unbound`, `reference-unresolved` and `dependency-cross-parent`. `dependency-self` and `dependency-cycle` cannot arise, because the daemon mints the identity and no stored node depends on it, so its in-degree is zero.
- `repo-on-task` and `repo-missing` are not reachable: the discriminated-union request schema answers both with `400`.
- `identity-kind-mismatch` is not reachable **through any request field**, because no request names an identity and `services/ids` mints the new one. State it that way. Do not state it as an absolute invariant of the identity space: `resolveIdentities` preserves a valid identity supplied in an imported document, so a minted ULID payload could in principle collide with an imported node under another prefix. That is a `services/ids` concern, not a concern this command can refuse, and no test of this epic asserts the absolute form.
- **The parent-kind rule of Story 5 is reachable here** and is reported as `parent-missing`. A create of a task under an initiative refuses.
- The command imports no vendor package. `src/commands/` may import `domain/` and service interfaces only.
- No completeness finding refuses anything.

## Verify

Create `src/commands/node/create-node.test.ts`, suite name `src/commands/node/create-node.test`, on real SQLite through `createMigratedStorage`.

- `creates an initiative in an empty project` — `fromRevision: null` succeeds; assert the returned `id` carries the `initiative_` prefix, that `plan_revision` holds one row with `origin: "node-write"`, and that `result.completeness` names `initiative-without-objective`.
- `mints the revision before the node row` — assert the created node's `revision` column equals the returned revision and that the row resolves.
- `takes the project revision as the new parent` — after one import, a create returns a revision whose `parentId` equals the import revision.
- `refuses a stale project revision` — `stale-revision` with `details.guard === "project"`; assert the `node` and `plan_revision` row counts are equal before and after.
- Six named structural refusals, one test each, asserting `plan-invalid` and the code by name in `details.findings`: `parent-missing`, `worker-unknown`, `repository-unknown`, `repository-unbound`, `reference-unresolved`, `dependency-cross-parent`. Each asserts the `node`, `edge` and `plan_revision` row counts are equal before and after.
- `dependency-self and dependency-cycle are unreachable on a create` — a create whose `dependsOn` names every stored node succeeds.
- `sorts dependsOn bytewise` — a create whose `dependsOn` holds three ids in reverse bytewise order writes three `edge` rows, and `readGraph` returns the dependency list in bytewise order.
- `deduplicates dependsOn` — a repeated id writes one edge.
- `export bytes equal the accepted blob` — call `exportPlan` after the create, fetch the blob addressed by the new revision's `acceptedBlob`, and compare through `Buffer.compare`.
- `a stored objective renders its repository name in the accepted blob` — assert the blob content holds the name and not the id.
- `appends one node.created event carrying the resolved actor` — drive with a `harness` `ActorRow` and assert the event row holds `actor_kind = 'harness'` and the actor id.
- `calls mutateGraph exactly once and setNodeState never` — a recording `PlanStore` fake counts every mutation call; assert the mutation call list is exactly `["mutateGraph"]` and that the recorded `MutateGraphInput` holds no `trigger` key.
- `a create with no dependency promotes the node to ready in the same mutation` — the result type exposes **no** transition list, so observe transitions through the recording `PlanStore` fixture named below, and observe the outcome through the stored `node.state`. Assert the recorded transition is `{ nodeId, from: "pending", to: "ready", trigger: "readiness-promoted" }` and that `node.state` is `ready`.
- **The recording fixture.** Add `createRecordingPlanStore()` to `test/helpers/plan.ts`, wrapping a real `SqlitePlanStore` and recording, per call, the method name and the input object, plus the transition list each mutation returned. Every "returned transitions" assertion in Stories 9, 10, 11 and 14 reads that recording. Without it those assertions have nothing to observe.
- `one clock read per command` — drive with a mock clock that advances on every call and assert every `updated_at` written by one `createNode` is the same value.
- `a create with an unsatisfied dependency leaves the node pending` — assert no transition is written for it.
- `a create changes no other node` — assert every other node's `state`, `revision` and `updated_at` are byte-identical before and after.
- `node --test src/commands/node/create-node.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/commands/node/create-node.test.ts`. Hermetic coverage bullets `.agents/plan/epics/017-per-node-graph-write.md:143`, `:144`, `:148`, `:151`, `:155`, `:156` and `:168`.
