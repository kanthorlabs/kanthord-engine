# Story 12 — `heartbeatNode`, `releaseNode` and the heartbeat protocol

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 6, Story 7, Story 8, Story 10.

## Change

### `src/commands/node/heartbeat-node.ts`

```ts
export type HeartbeatNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  events: EventLog;
  clock: Clock;
  leaseTtlMs: number;
}>;

export type HeartbeatNodeInput = Readonly<{
  nodeId: string;
  fence: number;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type HeartbeatNodeResult = Readonly<{
  lease: ClaimedLease;
  objectiveLease: ClaimedLease;
  heartbeatIntervalMs: number;
}>;
```

One transaction, one `now`.

1. Read the node from `plan.readAllNodes`. An unknown node raises `HeartbeatNodeError("node-not-found")`.
2. `lease.renew(transaction, { subjectKind: "node", subjectId: input.nodeId, owner: input.actorId, ownerKind: "actor", fence: input.fence, ttlMs: leaseTtlMs, now })`. A `LeaseError` of code `lease-fenced` raises `HeartbeatNodeError("lease-held")`. **A stale fence is `lease-held` and not `stale-revision`**, because `staleRevisionDetails` at `src/http/contract/error-details.ts:9-12` carries revision identities rather than a fence.
3. For a **task** only, renew the objective lease of the **same owner**, in the same transaction on the same `now`. Read it through `lease.read` and branch on exactly these four cases, which are total:

   - `owner` equals `input.actorId` and `expiresAt` is after `now` — call `lease.renew` with **that row's own fence**. The harness presents one fence, the task's; the objective fence is read and never presented.
   - `owner` is a different actor — raise `HeartbeatNodeError("lease-held")`.
   - the row is **absent**, or its `owner` is **null** — raise `HeartbeatNodeError("lease-held")`. A task lease cannot outlive its objective lease: the claim wrote both, and only the sweep, an objective release or an EPIC 019 attestation frees the objective. A live task lease over a free objective is a broken invariant, and the harness must stop rather than keep working under an objective anyone can take.
   - `owner` equals `input.actorId` but `expiresAt` is at or before `now` — raise `HeartbeatNodeError("lease-held")`. The holding is dead and `lease.renew` refuses it anyway; raising here makes the refusal explicit rather than incidental.

   A **heartbeat on an objective** renews that one lease and reads no child. A **heartbeat on an initiative** raises `HeartbeatNodeError("initiative-not-claimable")`, matching the release, because an initiative is never claimed and so never held.

4. Append one `lease.renewed` event, `subjectKind: "node"`, `subjectId` of the named node, the calling actor as `actorKind` and `actorId`, payload `{ subjectId, objectiveId, fence, objectiveFence, expiresAt, objectiveExpiresAt }`.

**It moves no node**, and it moves no fence.

### `src/commands/node/release-node.ts`

```ts
export type ReleaseNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
}>;

export type ReleaseNodeInput = Readonly<{
  nodeId: string;
  fence: number;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type ReleaseNodeResult = Readonly<{ node: NodeView }>;
```

`NodeView` is the shape `src/queries/node/show-node.ts` already returns, and the handler formats it unchanged. `ReleaseNodeError` carries a `refusal` over the closed union `"node-not-found" | "initiative-not-claimable" | "lease-held" | "no-active-run" | "no-open-attempt" | "illegal-transition"`, in the shape of `ClaimNodeError`. `HeartbeatNodeError` carries `"node-not-found" | "initiative-not-claimable" | "lease-held"`.

One transaction, one `now`. It branches on the node kind, and the two branches are disjoint.

**A task release**, in this exact order. **Authority is validated before any write.**

0. `lease.assertHeld(transaction, { subjectKind: "node", subjectId: input.nodeId, owner: input.actorId, fence: input.fence, now })`. A `LeaseError` raises `ReleaseNodeError("lease-held")`.

   **This step is first, and the ordering is the point.** With the writes first, a stale caller gets `attempt-not-open` or `run-not-active` from the execution service instead of the `lease-held` the Decisions require, because the previous owner's attempt is already closed and its run already ended. Rollback keeps the data safe either way, but the **code** the harness reads decides whether it stops or retries, and `409 lease-held` is what tells it the claim is gone.

1. Read the active task run through `execution.activeRunOfNode`. When it is null, raise `ReleaseNodeError("no-active-run")`. Read its attempts through `attemptsOfRun` and select the ones with a null `outcome`: exactly **one** is expected, and it is the attempt this release closes. **Zero** open attempts raises `ReleaseNodeError("no-open-attempt")`; **more than one** throws a plain `Error` naming the run, because that is a corrupted invariant rather than a caller error. Close that one attempt with outcome `cancelled` through `execution.closeAttempt`.
2. End the task run with outcome `released`, through `execution.endRun`.
3. `plan.setNodeState(transaction, { id, from: "running", to: "ready", trigger: "claim-released", blockReason: null, at: now, cause })`.
4. `lease.release(transaction, { subjectKind: "node", subjectId: input.nodeId, owner: input.actorId, ownerKind: "actor", fence: input.fence, now })`.
5. Append one `lease.released` event with the calling actor.

**A task release frees the task lease only.** It leaves the objective lease held by the same owner, leaves the objective run `active`, and moves the objective state in no case, because `docs/proposal/phase-1/state-machine.md:78` marks `running → ready` invalid at the objective level. A task path that freed the objective lease would hand the objective to a second actor between two sibling tasks, and it would leave no live lease for the attestation of EPIC 019 to present.

**An objective release**, in this exact order.

0. `lease.assertHeld` on the objective, exactly as the task release step 0, so a stale caller is refused `lease-held` before the child scan runs.

1. Read the objective's children from `plan.readAllNodes`, sort them bytewise by identity, and call `lease.read` on each. When any row names an owner and its `expires_at` is after `now`, raise `ReleaseNodeError("lease-held")` with `details` naming that task, its holder and `relation: "descendant"`, and write nothing. The first refusing child in bytewise order is the one reported, so the refusal is reproducible. `Lease` gains no eighth method for this: `read` already answers it.
2. End the objective run with outcome `released`.
3. `lease.release` on the objective.
4. Append one `lease.released` event.

It writes no objective node state: `running → ready` is invalid at the objective level.

**An objective release is the only path of this epic that frees a live objective lease.** The expiry sweep of Story 9 clears an expired one, and `reportObjective` of EPIC 019 frees the lease of an attestation. No other path anywhere frees it, and `reportOutcome` of EPIC 019 releases the task lease alone.

An initiative release raises `ReleaseNodeError("initiative-not-claimable")`.

### The protocol, stated and not delegated

Document it in one section of `docs/proposal/api/execution.md`, under `## node.heartbeat`, which Story 1 created.

- `heartbeatIntervalMs` is `Math.floor(leaseTtlMs / 3)`, `100000` under the default. The claim response and every heartbeat response carry it, so the harness never guesses.
- The harness adds uniform jitter of at most ten percent of that interval, so a fleet does not synchronise.
- **Expiry measures from the latest renewal**: a claim and every heartbeat each write `expires_at = now + leaseTtlMs`.
- On a request timeout or a network partition the harness retries at the same interval, and it stops all work once `leaseTtlMs` has passed since its last **successful** heartbeat.
- On `409 lease-held` the harness stops at once, because the claim is gone. It reports nothing.
- A daemon restart is not an expiry: the `lease` row is durable, so a heartbeat with a live fence still succeeds.
- **Every heartbeat carries a fresh `Idempotency-Key`**, minted per request. A repeated key replays the captured body from `src/http/server/idempotency.ts` and would hand the harness an old `expiresAt` while the real lease expires.
- **EPIC 019 must refuse every report that carries an owner or a fence other than the current live pair, with `409 lease-held`.** That refusal is lease safety, and this epic states the requirement. Recovery recovers the CLAIM and never the in-flight work: kanthord cannot inspect, reset or kill a harness process tree, so the old harness may still edit and commit. The protocol rule and that fence check are the whole protection.

## Constraints

- One transaction and one `clock.now()` per command.
- Neither command runs SQL, and neither imports another command.
- The fence never moves in either command.
- No task path frees the objective lease. No path of either command writes `awaiting_approval`.
- Neither command calls `services/git`.
- Do not add a `ttlMs` request member. The TTL is configuration.
- The release presents both the owner and the fence, which `ReleaseLeaseInput` of Story 7 requires.

## Verify

New test file `src/commands/node/heartbeat-node.test.ts`:

- `a heartbeat with the current fence extends expires_at on both the task lease and the objective lease` — assert both `expires_at` values equal `now + leaseTtlMs`.
- `a heartbeat leaves both fences unchanged` — assert both.
- `a heartbeat with any other fence is refused lease-held and writes nothing` — assert the refusal and assert both lease rows are deep-equal before and after.
- `a heartbeat by another owner is refused lease-held and writes nothing`.
- `a heartbeat moves no node` — assert the recording `PlanStore` fake recorded no call and every node state is unchanged.
- `a heartbeat on an objective renews the objective lease only` — assert no task lease moved.
- `a heartbeat appends one lease.renewed event` — assert the type, the actor and the payload.
- `a heartbeat on an unknown node is refused node-not-found`.
- `a heartbeat on an initiative is refused initiative-not-claimable and writes nothing`.
- `a heartbeat whose objective lease is absent or free is refused lease-held and writes nothing` — two fixtures: no objective lease row at all, and a row whose `owner` is null. Assert both refuse and both leave the task lease deep-equal before and after.
- `a heartbeat whose own holding has expired is refused lease-held and writes nothing` — right owner, right fence, `now` past `expiresAt`.
- `heartbeatIntervalMs is one third of leaseTtlMs` — assert `100000`.

New test file `src/commands/node/release-node.test.ts`:

- `a task release with the current fence frees the task lease, moves the task to ready, and leaves the fence unchanged` — assert the lease row deep-equals `{ subjectKind: "node", subjectId, owner: null, ownerKind: null, fence: <the pre-release fence>, acquiredAt: null, renewedAt: null, expiresAt: null }`, and assert the node state. Five columns are cleared, per the Story 7 amendment.
- `a task release leaves the objective lease held and the objective run active` — assert both rows **even when the actor holds no other task lease**, and assert a second actor's claim on that objective is still refused `lease-held` afterwards.
- `a task release closes the attempt cancelled and ends the run released` — assert both outcomes.
- `a task release records trigger claim-released` — assert through the recording `PlanStore` fake, and assert no other trigger appears.
- `a task release with a wrong fence or a wrong owner is refused and writes nothing` — two cases, each with the whole database deep-equal before and after.
- `an objective release while a task lease under it is live is refused lease-held and writes nothing` — assert the refusal, `details` naming the holding task and `relation: "descendant"`, and the whole database deep-equal before and after.
- `an objective release after every task release frees the objective lease and ends the objective run released` — assert both rows, and assert the objective node state is still `running`.
- `an objective release writes no objective node state` — assert the recording `PlanStore` fake recorded no call for the objective.
- `an initiative release is refused initiative-not-claimable and writes nothing`.
- `a stale release is refused lease-held and not no-open-attempt` — actor A claims, actor A releases, then actor A releases again with the same fence. Assert the second call raises **`lease-held`**, not `no-open-attempt` and not `run-not-active`. This is the assertion the step-0 ordering exists for: with the writes first, the already-closed attempt reports the wrong refusal.
- `a release whose run has no open attempt is refused no-open-attempt` — close the attempt directly through `Execution` while the lease stays live, then release, and assert that refusal rather than `lease-held`.
- `a release result carries the node view` — assert the returned `node` matches the row, with `state` equal to `ready` for a task release.
- **`no path of this epic writes awaiting_approval`** — the journey `.agent/plan/epics/018-claim-and-lease.md:205` requires, and this story owns it because it is the first story in which the claim, the heartbeat and the release all exist. Drive, in one fixture and this order: a claim, a heartbeat, a release, a re-claim, an expiry sweep, and a final re-claim. **Read the state of every node after each of the six steps** and assert none is ever `awaiting_approval`. Then assert `externalTransitions` holds no row of this epic whose `to` is `awaiting_approval`.

Run:

- `node --test src/commands/node/heartbeat-node.test.ts src/commands/node/release-node.test.ts src/commands/node/claim-node.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/commands/node/heartbeat-node.test.ts` and `src/commands/node/release-node.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:191-193`, `:196`, `:205`.

Use the same test conventions Story 10 fixes: hand-written `Lease` and `Execution` fakes from `test/helpers/`, the recording `PlanStore` fake, real SQLite for row assertions, and **no import of `SqliteLease` or `SqliteExecution`**.
