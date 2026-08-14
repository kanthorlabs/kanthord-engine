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
3. For a **task** only, renew the objective lease of the **same owner**, in the same transaction on the same `now`: read it through `lease.read`, and when its `owner` equals `input.actorId`, call `lease.renew` with **that row's own fence**. The harness presents one fence, the task's, and the objective fence is read and not presented. An objective lease held by another owner raises `HeartbeatNodeError("lease-held")`.
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
```

One transaction, one `now`. It branches on the node kind, and the two branches are disjoint.

**A task release**, in this exact order:

1. Close the open attempt of the active task run with outcome `cancelled`, through `execution.closeAttempt`.
2. End the task run with outcome `released`, through `execution.endRun`.
3. `plan.setNodeState(transaction, { id, from: "running", to: "ready", trigger: "claim-released", blockReason: null, at: now, cause })`.
4. `lease.release(transaction, { subjectKind: "node", subjectId: input.nodeId, owner: input.actorId, ownerKind: "actor", fence: input.fence, now })`.
5. Append one `lease.released` event with the calling actor.

**A task release frees the task lease only.** It leaves the objective lease held by the same owner, leaves the objective run `active`, and moves the objective state in no case, because `docs/proposal/phase-1/state-machine.md:78` marks `running → ready` invalid at the objective level. A task path that freed the objective lease would hand the objective to a second actor between two sibling tasks, and it would leave no live lease for the attestation of EPIC 019 to present.

**An objective release**, in this exact order:

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
- `no path of a release writes awaiting_approval` — read every node state after a task release and after an objective release.

Run:

- `node --test src/commands/node/heartbeat-node.test.ts src/commands/node/release-node.test.ts src/commands/node/claim-node.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/commands/node/heartbeat-node.test.ts` and `src/commands/node/release-node.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:191-193`, `:196`.
