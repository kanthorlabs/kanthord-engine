# Story 10 — `claimNode`, the command

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 5, Story 6, Story 7, Story 8, Story 9. **Coupled with Story 11**, the ancestor cascade. Implement 10 then 11 with no verify gate between them.

## Change

One new file `src/commands/node/claim-node.ts`.

```ts
export type ClaimNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  ids: IdGenerator;
  sweepExpiredExternalLeases: (
    transaction: Transaction,
    input: Readonly<{ actor: string; now: number }>,
  ) => void;
  attemptLimit: number;
  leaseTtlMs: number;
  instanceId: string;
}>;

export type ClaimNodeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type ClaimNodeResult = Readonly<{
  lease: ClaimedLease;
  objectiveLease: ClaimedLease;
  runId: string;
  objectiveRunId: string;
  attemptId: string | null;
  attemptNo: number | null;
  heartbeatIntervalMs: number;
  node: NodeView;
}>;

export class ClaimNodeError extends Error {
  readonly refusal: ClaimRefusal;
  readonly details: Readonly<Record<string, unknown>> | undefined;
}
```

`ClaimedLease` is `Readonly<{ subjectId: string; owner: string; ownerKind: "actor"; fence: number; expiresAt: number }>`. `ClaimRefusal` is the closed union `"node-not-found" | "initiative-not-claimable" | "plan-incomplete" | "drive-mode-pinned" | "lease-held" | "illegal-transition" | "ancestor-not-startable"`. `sweepExpiredExternalLeases` arrives as a bound callable, because `commands/` imports no command.

**One transaction. One `now` from `clock.now()`, read once and passed everywhere**, so one claim writes one instant. The steps run in this exact order.

**1. Sweep.** Call `dependencies.sweepExpiredExternalLeases(transaction, { actor: dependencies.instanceId, now })`. `instanceId` is the daemon instance identity EPIC 016 hoisted in `src/main.ts`; the sweep attributes its events to the daemon, not to the claiming actor. Every dead harness's task is back in the pool before any decision is taken. Nothing later in this command observes a `running` node that holds an expired lease.

**2. Load the node.** Read the whole node set once through `plan.readAllNodes(transaction)` and find the claimed node in it. Step 3 needs the same set, so read it once and reuse it; `PlanStore` gains no single-node method. An unknown node raises `ClaimNodeError("node-not-found")`. A node of kind `initiative` raises `ClaimNodeError("initiative-not-claimable")` with `details` `{ refusal: "initiative-not-claimable" }`, which follows `invalidRequestDetails` at `src/http/contract/error-details.ts:75-79`. An initiative is never executed; it reaches `running` through the ancestor cascade.

**3. Completeness.** Build the input `completenessFindings` of `src/domain/plan-completeness.ts` takes from the node set of step 2, and run it over the **claimed node and its containment ancestors only** — never over the whole project. A non-empty finding list raises `ClaimNodeError("plan-incomplete")` with `details` `{ findings }`. For a task claim the check is nearly tautological: the task proves its objective holds a task, and that objective proves its initiative holds an objective. The one meaningful public case is a claim on an objective that holds no task.

The read costs one full-graph read, O(nodes + edges) per claim, under the 2000-node bound. **Add no index on `node.parent_id` and write no containment query.**

**4. The objective scope.** For a `task` the objective is `node.parentId`; for an `objective` it is the node itself.

- Call `execution.runDriversUnderObjective(transaction, objectiveId)` and pass the result to `objectiveDrivePin({ runDrivers, claimDriver: "external" })` of `src/domain/external-transition.ts`. A non-null refusal raises `ClaimNodeError("drive-mode-pinned")` with `details` `{ pinnedDriver, claimDriver }`.
- Call `lease.acquire(transaction, { subjectKind: "node", subjectId: objectiveId, owner: input.actorId, ownerKind: "actor", ttlMs: leaseTtlMs, now })`. A `LeaseError` of code `lease-held` raises `ClaimNodeError("lease-held")` with `details` built from the error's `refusal` property: `{ subject, holder, holderKind, fence, expiresAt, relation }`. A same-owner live objective lease returns `acquired: false` and moves no fence.

**5. The objective run.** Call `execution.activeRunOfNode(transaction, objectiveId)`.

- `null` — open the objective run through `execution.openRun` with `kind: "objective"`, `parentRunId: null`, `leaseFence` of the objective lease and `attemptLimit`.
- an active run of driver `external` — adopt it through `execution.adoptRun` with the new fence.
- an active run of driver `internal` — raise `ClaimNodeError("drive-mode-pinned")` with `details` `{ pinnedDriver: "internal", claimDriver: "external" }`. **It is never adopted**, because an external attempt under an internal run breaks the composite driver foreign key of migration 0007. A blind adoption is a database failure, not a refusal.

The objective moves `ready → running` through the ancestor cascade of Story 11.

**6. The task lease, run and attempt.** For a **task** claim only:

- `lease.acquire` on the task, same shape as step 4.
- `execution.activeRunOfNode` on the task, under the same three-case driver rule as step 5. On `null`, `execution.openRun` with `kind: "task"` and `parentRunId` of the objective run id.
- `execution.openAttempt` on the task run.

For an **objective** claim, `runId` is the objective run id, and `attemptId` and `attemptNo` are both null. **An objective claim opens no attempt**: `docs/proposal/database/attempt.md` makes an attempt one try at one task.

**7. The state branch.** Branch on the claimed node's state. It holds exactly **three** cases, because step 1 already swept every expired external lease.

- `ready` — `plan.setNodeState(transaction, { id: node.id, from: "ready", to: "running", trigger: "claim-taken", blockReason: null, at: now, cause })`, then the ancestor cascade of Story 11.
- `running`, when the live lease of the claimed node names `input.actorId` — return the current leases, run and attempt with no write at all. Append no event.
- every other state — raise `ClaimNodeError("illegal-transition")` with `details` `{ state: node.state, admitted: ["ready", "running"] }`.

**A `running` node held by another actor at an expired fence is not a case here**: the sweep of step 1 already returned it to `ready`, so it reaches the first case with a freed lease row and a new fence.

**8. The events.** On the `ready` path, in this exact order: one `lease.claimed`, then the `node.running` events of the cascade, then the `node.running` of the claimed node. Story 11 fixes the cascade order. `lease.claimed` carries `subjectKind: "node"`, `subjectId` of the claimed node, the calling actor as `actorKind` and `actorId`, and payload `{ subjectId, objectiveId, fence, objectiveFence, expiresAt, runId, objectiveRunId, attemptId, attemptNo }`. The claimed node's own `node.running` keeps the calling actor, because it is the decision.

**9. The response.** `heartbeatIntervalMs` is `Math.floor(leaseTtlMs / 3)`, `100000` under the default `300000`. The claim response carries it so the harness never guesses.

## Constraints

- One `storage.transact`. A state transition, its event append, the lease write, the run write and the attempt write never sit in two transactions.
- One `clock.now()`. Do not call it twice, and do not let a service read a clock.
- `claimNode` runs no SQL. Every read is a `PlanStore`, `Lease` or `Execution` method.
- `claimNode` imports no other command and no vendor package.
- The step order above is normative. Do not move the sweep, and do not evaluate the hierarchy before it.
- No path of this command writes `awaiting_approval` at any level, and no path infers an objective result.
- No path of this command calls `services/git`.
- Do not add a `ttlMs` request member. The TTL is configuration.
- Do not add a takeover branch. `lease.takenOver` is not an event type of this repository.

## Verify

New test file `src/commands/node/claim-node.test.ts`, on real SQLite through `createMigratedStorage`, with a `MockClock`, a recording `PlanStore` fake for the trigger assertions, a recording `Execution` fake for the adoption assertions, and the real `SqliteLease` and `SqliteExecution` for the row assertions. Fixed identities and `leaseTtlMs: 300000`.

- `a claim on a ready task returns a lease and moves the task, the objective and the initiative to running` — the three states asserted **by identity**, not by count.
- `a claim on a ready task opens an external objective run and an external task run` — assert the task run's `parent_run_id` names the objective run, both `driver` columns are `external`, and both `workspace_id`, `worker` and `base_oid` are null.
- `a claim on a ready task opens attempt number 1` — assert `attemptNo` is `1` and the row's `driver` is `external`.
- `a claim on an objective opens no attempt` — assert `attemptId` and `attemptNo` are both null and the `attempt` table holds no row.
- `heartbeatIntervalMs is one third of leaseTtlMs` — assert `100000`.
- `a claim on an initiative is refused initiative-not-claimable and writes nothing` — assert the refusal, `details.refusal`, and that every table is deep-equal before and after.
- `an unknown node is refused node-not-found`.
- `a claim under an objective that holds no task is refused plan-incomplete with exactly objective-without-task` — assert `details.findings` holds exactly that one code, and the database is deep-equal before and after. In the same fixture assert an unrelated complete objective in the same project is still claimable with a successful claim.
- `a claim on a task whose objective is in any of six states is refused illegal-transition` — loop `pending`, `blocked`, `awaiting_approval`, `done`, `partial`, `discarded`; assert all six, and assert the database is deep-equal before and after each.
- `a claim on a task whose objective is already running writes no objective state change and still succeeds` — assert the recording `PlanStore` fake recorded no call for the objective.
- `the state branch holds three cases only` — drive a `ready` node, a `running` node held live by the same actor, and each of the six other states. Assert no fixture reaches a fourth case.
- `a same-owner claim of a live lease returns the same fence, the same run id and the same attempt id, extends expires_at, and appends no second event` — assert all five.
- `the same actor claims two ready sibling tasks in turn` — both succeed; the objective lease fence is **identical** after both; two task runs exist and both name the one objective run as `parent_run_id`.
- `an actor claims an objective and then a task under it with no self-deadlock` — the task claim succeeds, the objective lease fence is unchanged, and the objective run is reused rather than reopened (assert the `run` row count).
- `a second actor's claim on a sibling task is refused lease-held with relation sibling`.
- `a second actor's claim on the objective is refused lease-held with relation descendant`.
- `a claim over an expired lease goes through the sweep and never through a takeover branch` — a second actor claims a task whose lease expired. Inside that one transaction assert: the run of the old owner ended with outcome `expired`, its attempt closed `cancelled`, the new lease fence is the old fence plus one, a new run is `active`, attempt number `2` is open, and the task is `running`. **The events of that transaction are exactly `recovery.leaseRecovered`, `lease.claimed`, `node.running`, asserted in that order.**
- `no event of type lease.takenOver exists in the repository` — a scan of every `.ts` file under `src/` asserting the literal `lease.takenOver` appears nowhere.
- `the drive-mode pin refuses a harness claim on an objective whose history holds an internal run` — the fixture writes the internal run directly, because no route of this block opens one. Assert the refusal, `details` naming both drivers, and that the database is deep-equal before and after.
- `a claim over an active internal run under that objective is the same refusal and never adopts` — assert through the recording `Execution` fake that `adoptRun` was **never** called.
- `a claim whose run history is empty succeeds, and a claim whose history holds external runs only succeeds`.
- `the claimed task write names trigger claim-taken` — assert through the recording `PlanStore` fake, and assert no other trigger appears on that path.
- `a setNodeState call whose trigger disagrees with the pair throws and commits nothing` — drive the claim path with `claim-taken` over a `running → ready` pair and assert it throws and the database is deep-equal before and after.
- `no path of the claim writes awaiting_approval` — read the state of every node after the claim and assert none is `awaiting_approval`.
- `the sibling race commits exactly one claim` — two different actors claim two different `ready` sibling tasks of one objective, each in its own `storage.transact`, serialized by `BEGIN IMMEDIATE`. Exactly one succeeds and the other is refused `lease-held`. Afterwards assert the database holds exactly one objective lease row with an owner, exactly one task lease row with an owner, and exactly one open attempt.
- `one claim reads the clock once` — a counting `Clock` fake asserts exactly one `now()` call.
- **`the abandoned objective is freed by expiry and by nothing else`** — one actor claims a task, reports nothing and heartbeats no more. Advance the `MockClock` past `leaseTtlMs`, and a **second** actor claims an unrelated task. Afterwards assert: the objective lease holds a **null owner**; the objective run ended with outcome `expired`; the objective state is **still `running`**; and the task is `ready`. Then assert the second actor claims that task and that objective successfully. The objective is therefore never held for ever, and `leaseTtlMs` is the whole bound.
- **`the claim-driven sweep needs no restart and no timer`** — one actor claims a task, advance the `MockClock` past `leaseTtlMs`, and a **second** actor claims an unrelated task **in another project**. Assert the first task is `ready`, its run ended `expired`, its attempt closed `cancelled`, and its lease holds a null owner with an **unchanged** fence. Assert no daemon restarted: the whole test runs in one process with no `launchDaemon` call. Then assert `listNodes({ state: "ready" })` returns the first task.

Run:

- `node --test src/commands/node/claim-node.test.ts src/domain/lease-hierarchy.test.ts src/services/lease/sqlite.test.ts src/services/execution/sqlite.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/commands/node/claim-node.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:171-173`, `:184`, `:186-190`, `:194`, `:197`, `:202-205`, `:209`.
