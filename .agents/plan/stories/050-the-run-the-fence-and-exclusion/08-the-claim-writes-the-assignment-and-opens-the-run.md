# Story 8 — The claim writes the assignment and opens the run

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 1 (`runKindFor`), Story 2 (the run columns and `run_base`), Story 3 (`runRow`), Story 4 (`StoredNode.assignment`), Story 5 (`subtreeExclusion`), Story 6 (`objectiveBusy`), Story 7 (`expireRuns`), Story 13 (`available` on the request), EPIC 047 (`StoredNode.deliverable`, `nodePairLegality`), EPIC 048 (`routeWorker`, `workerRegistry`).

## Change

**`src/commands/node/claim-node.ts` — extend the existing command.** The whole change sits inside the one `storage.transact` block opened at `src/commands/node/claim-node.ts:104`. Two operations would let a crash leave an assignment with no run, and the next claim would then read an assignment nobody holds.

### One path, and three deletions

`node.deliverable` is `NOT NULL` after migration `12`, so there is no legacy node and no branch. The command has one path.

**Delete `openOrAdoptRun` at `src/commands/node/claim-node.ts:449` and its call site at `:459-483`.** A claim opens exactly one run and never adopts one. A task claim opens **no parent objective run**, which is what keeps `run_one_active` free.

**Delete the own-lease replay path at `src/commands/node/claim-node.ts:179-199` and `replayResult` at `:362-418`.** A second claim by the same worker on a node with an active run is `subtree-busy` with `relation: "self"`. Retrying a lost response is the transport's job: `node.claim` declares `idempotency: "memory"` and `replayable: [200]`, asserted at `src/http/contract/registry.test.ts:839-850`.

**Delete `initiative-not-claimable` at `:117-123` and `run-driver-mismatch` at `:472-478`** from the code and from `ClaimRefusal`. An initiative is claimable: `worker.md` section 7 states a worker that claims an initiative serializes that whole initiative, and a structural run claims one, which is why a structural run holds no `run_base` row. `run-driver-mismatch` lives only inside run adoption.

**Move every refusal ahead of the first mutation.** The shipped command fires `illegal-transition` at `:269-275`, after the leases, the run and the attempt are taken. Reorder so that no lease is acquired, no run is opened, no attempt is opened, no node state changes and no event is appended until every refusal has been evaluated.

### The refusal union and its total order

Replace `ClaimRefusal` at `src/commands/node/claim-node.ts:27-35`. Keep every shipped code and add `pair-illegal`, `assignment-held`, `unroutable`, `review-head-unavailable`, `objective-busy` and `subtree-busy`.

The evaluation order is:

1. `node-not-found`
2. `pair-illegal`
3. `plan-incomplete`
4. `assignment-held`
5. `unroutable`
6. `review-head-unavailable`
7. `lease-held`
8. `drive-mode-pinned`
9. `objective-busy`
10. `subtree-busy`
11. `illegal-transition`
12. `ancestor-not-startable`

`lease-held` and `drive-mode-pinned` keep their shipped meaning. EPIC 050.1 removes the first when it removes the node lease.

**Every one of the twelve is evaluated before the first mutation.**

The completeness check at step 3 exempts a node whose `deliverable` is `expansion`, per `worker.md` section 7: that node holds no child yet, because producing its children is the work. The exemption covers that node's own missing children and nothing else — every other finding still raises `plan-incomplete`.

Details per new refusal, asserted exactly by the tests:

| code                      | details                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pair-illegal`            | `{ kind, deliverable }`                                                                                                   |
| `assignment-held`         | `{ assignment, claimant, maySwitch: true }`                                                                               |
| `unroutable`              | `{ failedSet }` where `failedSet` is `"capable" \| "authorized" \| "available"`                                           |
| `review-head-unavailable` | `{ nodeId, runKind: "review" }`                                                                                           |
| `objective-busy`          | the `ObjectiveBusyRefusal` of Story 6, minus its `refusal` key: `{ objectiveId, siblingNodeId, siblingRunId, expiresAt }` |
| `subtree-busy`            | the `SubtreeExclusionRefusal` of Story 5, minus its `refusal` key: `{ relation, nodeId, runId, expiresAt }`               |

`maySwitch: true` is the offer the EPIC states — a human may switch the assignment — and it is a constant, not a computed permission.

### The input and the caller record

Extend `ClaimNodeInput` at `src/commands/node/claim-node.ts:67-71` with one field:

```ts
available: boolean;
```

The daemon never probes a worker. A worker self-checks before it claims and the caller asserts the result. A caller that asserts `true` when it is not available is trusted.

Extend `ClaimNodeDependencies` at `src/commands/node/claim-node.ts:50-65` with the server-owned caller record:

```ts
caller: Readonly<{ worker: string; authorized: readonly string[] }>;
```

`main.ts` binds `{ worker: "claude@1", authorized: ["claude@1"] }`. **The claiming worker is `dependencies.caller.worker`.** It is never derived from `input.actorId`, which is an `actor_<ULID>` authentication identity carrying no worker semantics, and it is never read from the request body. EPIC 055 replaces the fixed record with `{ worker: grant.worker, authorized: [grant.worker] }` and changes no schema.

### The ordered body

Insert into the transaction at `src/commands/node/claim-node.ts:104`, in this order:

**1 — the expiry pass.** Immediately after `const now = dependencies.clock.now();` at line 105, and **before** the existing `sweepExpiredExternalLeases` call at lines 107-110, call:

```ts
dependencies.expireRuns(transaction, { now });
```

Add `expireRuns` to `ClaimNodeDependencies` at `src/commands/node/claim-node.ts:50-65` with the signature `(transaction: Transaction, input: Readonly<{ now: number }>) => void`, mirroring the injected `sweepExpiredExternalLeases` at `:58-61`. `main.ts` binds the real `expireRuns` of Story 7. The pass runs first so an expired run cannot block a claim, and so an expired run cannot renew itself back to life through a later operation.

**2 — the node read and `node-not-found`.** Unchanged, at `src/commands/node/claim-node.ts:112-116`.

**3 — `initiative-not-claimable`.** Unchanged, at `:117-123`.

**4 — `pair-illegal`.** New. After the node read, call `nodePairLegality(node.kind, node.deliverable)`. On `{ legal: false }`, throw `ClaimNodeError("pair-illegal", ..., { kind: node.kind, deliverable: node.deliverable })`. `node.deliverable` is `NOT NULL`, so there is no null branch.

**5 — `plan-incomplete`.** Unchanged, at `:125-137`.

**6 — `assignment-held`.** New. If `node.assignment !== null` and `node.assignment !== dependencies.caller.worker`, throw `ClaimNodeError("assignment-held", ..., { assignment: node.assignment, claimant: dependencies.caller.worker, maySwitch: true })`. An assigned node compares; an unassigned node routes at step 7.

**7 — `unroutable`.** New. Only when `node.assignment === null`.

First intersect, then route. EPIC 048's `routeWorker` **throws** `authorized-not-capable` when `authorized` holds a worker outside the capable set, and `available-not-authorized` likewise, and it checks those before it returns any refusal. Passing the caller record's `authorized` unintersected would therefore raise a `WorkerRoutingError` instead of producing the `unroutable` refusal this epic wants:

```ts
const capable = capableWorkers(workerRegistry, {
  kind: node.kind,
  deliverable: node.deliverable,
});
const authorized = dependencies.caller.authorized.filter((id) =>
  capable.includes(id),
);
const available =
  input.available && authorized.includes(dependencies.caller.worker)
    ? [dependencies.caller.worker]
    : [];

routeWorker({
  registry: workerRegistry,
  kind: node.kind,
  deliverable: node.deliverable,
  authorized,
  available,
});
```

`capableWorkers` returns ids in registry declaration order, and `filter` preserves it, so the intersection is deterministic. `input.available === false` yields `available: []` and therefore `{ routed: false, failedSet: "available" }`, and this command throws `ClaimNodeError("unroutable", ..., { failedSet })`. Take the routed worker, which `routeWorker` returns as `result.worker`.

When `node.assignment !== null`, skip `routeWorker` and take the assigned worker. The assignment is the routing decision, already made.

**7b — `review-head-unavailable`.** New. When `runKindFor(node.deliverable) === "review"`, throw `ClaimNodeError("review-head-unavailable", ..., { nodeId: node.id, runKind: "review" })`. This epic creates no workspace record, so no objective workspace head exists to pin into `judged_oid`, and no checkpoint mechanism exists that would make a review meaningful. Writing `judged_oid = NULL` and filling it in EPIC 051 would record a commit chosen after the claim, which is the retrospective choice the pin exists to prevent. Do not read some other branch or repository head instead. EPIC 051 lifts the gate in the epic that establishes the workspace head inside the same claim.

**8 — `objective-busy`.** New, and only for a node whose run kind is `execution` and whose kind is `task`. Resolve the objective ancestor from the `nodes` array already read at `:112`. Build `siblingRuns` as the active runs on the objective's other task children — every child of that objective except the target — by reading:

```sql
SELECT id AS runId, node_id AS nodeId, state, expires_at AS expiresAt
  FROM run WHERE node_id IN (...) AND state = 'active' ORDER BY id
```

Call `objectiveBusy({ objectiveId, siblingRuns, now })`. On a refusal, throw `ClaimNodeError("objective-busy", ..., <the refusal minus its refusal key>)`.

**9 — `subtree-busy`.** New. Derive `ancestorIds` and `descendantIds` for the target from the `nodes` array read at `:112` — the existing `ancestorChain` helper at `src/commands/node/claim-node.ts:518` gives the ancestors, and the descendants are the transitive closure of `parentId`. Read every active run over `{target} ∪ ancestors ∪ descendants` with the same SQL shape as step 8. Call `subtreeExclusion({ targetId, ancestorIds, descendantIds, runs, now })`. On a refusal, throw `ClaimNodeError("subtree-busy", ..., <the refusal minus its refusal key>)`.

The exclusion sets are read inside the claim transaction. `services/storage` opens `BEGIN IMMEDIATE` at `src/services/storage/connection.ts:35`, so two concurrent sibling claims serialise and the loser sees the winner's run. Without that isolation each would read no active sibling run and each would insert one.

**10 — the write.** After every shipped check that follows (`drive-mode-pinned`, the leases, `illegal-transition`, the cascade), and inside the same transaction:

- `UPDATE node SET assignment = ?, updated_at = ? WHERE id = ?` with the routed worker id. Write it whether or not the node was already assigned; for an assigned node the value is unchanged, which keeps one write path.
- Compute `runKind = runKindFor(node.deliverable)`.
- Read `graphRevision = dependencies.plan.newestRevision(transaction, node.projectId)` (`src/services/plan/index.ts:75`) inside this transaction. **Do not use `node.revision`.** `docs/proposal/database/node.md:44` states `node.revision` is the plan revision that last wrote that node, so a node last written at R1 in a project whose newest revision is R2 would pin R1 and make EPIC 052 refuse a run that raced nothing.
- Insert the run with `kind = runKind`, `fence = 1`, `worker = <routed worker id>`, `agents_json = JSON.stringify(<the registry entry's agents>)`, `graph_revision = graphRevision`, `expires_at = now + runTtlMs`, `max_lifetime_at = now + runMaxLifetimeMs`, `state = 'active'`. There is no `lease_fence` and no `base_oid`; migration `12` dropped both.
- `agents_json` is `"[]"` for an external run. A self-managed harness selects its own agents and the daemon observes none.
- `judged_oid` is always `NULL` here, because step 7b refuses every `review` claim. A command-created review run with a null `judged_oid` is therefore unreachable in this epic. Do not create a workspace row.
- Write **no `run_base` row**. The EPIC's Non-goals state the row belongs to EPIC 051, which writes it inside this same claim.

Return `runId` and `fence` on `ClaimNodeResult` at `src/commands/node/claim-node.ts:73-82`. `runId` is already there; add `fence: number`. `node.claim` returns both and receives neither.

## Constraints

- Every check and every write is inside the transaction opened at `src/commands/node/claim-node.ts:104`. Open no second transaction.
- Do not remove the shipped `sweepExpiredExternalLeases` call, the node-lease acquire, or the `run_one_active` reliance. The node-lease mechanism and the run mechanism run side by side until EPIC 057.
- Do not clear `node.assignment` anywhere. EPIC 056 owns the only writer that changes it.
- Do not write a `run_base` row and do not create a `workspace` row.
- Do not branch on a domain rule in a handler. `src/http/server/node/claim-node.ts` parses, calls and formats only.
- A node whose `deliverable` is null keeps the shipped behaviour and opens no new-model run. The dual-read window of EPIC 049 is still open.

## Verify

```
node --test src/commands/node/claim-node.test.ts
```

Extend `src/commands/node/claim-node.test.ts`. Keep its conventions: `createClaimFixture()` at `:94-117`, `seedReadyFixture` at `:119-127`, the `claim` driver at `:216-255`, the `refused` helper at `:257-273`, and the `databaseBytes` before/after snapshot that every refusal case takes at `:550-562`. Add `available: true` to the `claim` driver's default input, and `expireRuns` to the dependencies it builds.

Add, each as a separate `it`:

1. `"a claim on an unassigned node writes node.assignment and inserts the run with the same worker id"` — after a successful claim, read the `node` row and the `run` row in one transaction and assert `node.assignment === run.worker`, and that both equal the routed worker id. Two rows, one asserted equality, per the EPIC's gate.

2. `"a claim returns the run id and the fence"` — assert `result.runId` matches the inserted run's `id` and `result.fence === 1`.

3. `"a claim opens the run with its provenance"` — assert the run row's `worker` equals the routed worker id and `agents_json` equals `JSON.stringify(<registry agents>)`. Assert an external claim writes `agents_json === "[]"`.

4. `"a claim writes expires_at and max_lifetime_at"` — assert `expires_at === NOW + runTtlMs` and `max_lifetime_at === NOW + runMaxLifetimeMs`, by value.

4b. `"a claim records the project's newest plan revision, not the node's row revision"` — seed a node whose `revision` is `R1` in a project whose newest `plan_revision` row is `R2`, with `R1 !== R2`. Claim it. Assert `run.graph_revision === R2` and `run.graph_revision !== node.revision`. Both are asserted, so the writer cannot drift back to `node.revision`.

4c. `"a claim carrying no worker field still routes"` — assert `nodeClaimRequest` holds exactly the key `available`, and that the routed worker equals `dependencies.caller.worker`. The wire never names a worker.

5. `"the run kind comes from the node deliverable"` — two cases: a node with `deliverable: "expansion"` opens `kind: "structural"`, and `deliverable: "test"` opens `kind: "execution"`. Assert the column value. `deliverable: "review"` is covered by case 6, which refuses.

6. `"a review claim refuses review-head-unavailable and writes nothing"` — a node whose `deliverable` is `"review"`. Assert `error.refusal === "review-head-unavailable"`, `assert.deepEqual(error.details, { nodeId: "<the node id>", runKind: "review" })`, and `databaseBytes` deep-equals the snapshot: no run row, no lease, no attempt, no workspace row and no event.

6b. `"no command-created run carries a null judged_oid"` — after a successful `structural` claim and a successful `execution` claim, assert `SELECT COUNT(*) AS c FROM run WHERE kind = 'review'` equals `0`. A review run is unreachable in this epic.

7. `"a claim writes no run_base row"` — assert `SELECT COUNT(*) AS c FROM run_base` equals `0` after a successful claim.

8. `"a claim on an assigned node by a different worker refuses assignment-held, naming the current assignment"` — seed `node.assignment = 'tdd@1'` and claim as `general@1`. Assert `error.refusal === "assignment-held"` and `assert.deepEqual(error.details, { assignment: "tdd@1", claimant: "general@1", maySwitch: true })`. Assert `databaseBytes` is unchanged.

9. `"a claim on a node assigned to the claiming worker succeeds"` — seed `node.assignment = 'general@1'` and claim as `general@1`. Assert the claim returns a run id.

9b. `"a caller authorized for a worker outside the capable set refuses unroutable rather than throwing"` — bind a caller record whose `authorized` names a worker that cannot take the node's pair. Assert a `ClaimNodeError` with `refusal === "unroutable"` and `failedSet === "capable"`, and assert no `WorkerRoutingError` escapes. This proves the intersection happens before `routeWorker`.

10. `"a claim carrying available false refuses unroutable with failedSet available and writes no run row"` — assert `error.refusal === "unroutable"`, `assert.deepEqual(error.details, { failedSet: "available" })`, and `SELECT COUNT(*) AS c FROM run` is unchanged. Both halves are asserted, per the EPIC's gate.

11. `"an illegal pair refuses pair-illegal"` — a task node with `deliverable: "expansion"`. Assert `error.refusal === "pair-illegal"` and `assert.deepEqual(error.details, { kind: "task", deliverable: "expansion" })`.

12. `"a claim on a task whose sibling task holds an active run refuses objective-busy, naming the sibling, its run and its expires_at"` — seed a second task under the same objective with an active run. Assert `error.refusal === "objective-busy"` and `assert.deepEqual(error.details, { objectiveId, siblingNodeId, siblingRunId, expiresAt })` with all four values pinned literally.

13. `"a claim on a descendant of a node holding an active run refuses subtree-busy, naming the ancestor"` — seed an active run on the objective, claim the task. Assert `error.refusal === "subtree-busy"` and `error.details.relation === "ancestor"` and `error.details.nodeId === <objective id>`.

14. `"a second claim on a node with an active run is refused by subtreeExclusion"` — claim, then claim the same node again. Assert `error.refusal === "subtree-busy"` and `relation === "self"`.

15. `"the run_one_active index refuses a second active run on the same node against real SQLite"` — inside one `storage.transact`, insert an active run row directly, then `assert.throws` on inserting a second active run row with the same `node_id`. This is the same-node case only; the epic claims no index defence for the subtree case.

16. `"an expired run in the exclusion input does not refuse a claim"` — seed an active run on an ancestor with `expires_at: NOW - 1`. Claim the descendant. Assert the claim succeeds, and assert the ancestor's run is now `ended` with its fence raised by one, proving the expiry pass ran first inside the same transaction.

17. `"a claim failing both assignment-held and objective-busy reports assignment-held"` — seed `node.assignment = 'tdd@1'` and a sibling task with an active run. Claim as `general@1`. Assert `error.refusal === "assignment-held"`. This proves the fixed refusal order.

18. `"a claim failing both pair-illegal and assignment-held reports pair-illegal"` — assert `error.refusal === "pair-illegal"`.

19. `"a claim failing both node-not-found and every later condition reports node-not-found"` — claim an id that does not exist. Assert `error.refusal === "node-not-found"`.

20. `"every refusal leaves the database byte-identical"` — for each of `pair-illegal`, `assignment-held`, `unroutable`, `objective-busy` and `subtree-busy`, snapshot `databaseBytes` before and assert it deep-equals the snapshot after, following `src/commands/node/claim-node.test.ts:554-561`.

21. `"a task claim opens exactly one run"` — claim a task whose `deliverable` is `"test"`. Assert `SELECT COUNT(*) AS c FROM run WHERE state = 'active'` equals `1`, and that its `node_id` is the task. No parent objective run is opened, which is what keeps `run_one_active` free.

22. `"a claim on an initiative whose deliverable is expansion succeeds"` — assert the claim returns a run id and the run's `kind` is `"structural"`. An initiative is claimable; `initiative-not-claimable` is gone.

23. `"initiative-not-claimable and run-driver-mismatch are not members of ClaimRefusal"` — assert against the exported refusal list, so the deletion is proven by the type and not by absence of a test.

24. `"every refusal fires before the first mutation"` — for each of the twelve codes, snapshot `databaseBytes`, provoke the refusal, and assert the bytes are unchanged. `illegal-transition` and `ancestor-not-startable` are the two the shipped command failed this for, because it took leases, the run and the attempt first.

25. `"a second claim by the same worker refuses subtree-busy with relation self"` — claim, then claim the same node again as the same worker. Assert `error.refusal === "subtree-busy"` and `error.details.relation === "self"`. This is the defined replacement for the deleted replay path.

26. `"an expired run and a refused claim leave the database unchanged"` — seed an active run on an ancestor with `expires_at: NOW - 1`, and make the claim refuse `assignment-held`. Assert the refusal and assert `databaseBytes` is unchanged: the expiry pass rolled back with the refusal, so the ancestor run is still `active` with its original fence. Case 16 is the successful counterpart, where the expiry commits.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/node/claim-node.test.ts` in `PASS EPIC-050`.
