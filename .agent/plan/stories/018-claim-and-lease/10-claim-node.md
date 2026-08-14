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

**3. Completeness.** Run `completenessFindings` of `src/domain/plan-completeness.ts` over the **claimed node and its containment ancestors only** — never over the whole project. A non-empty finding list raises `ClaimNodeError("plan-incomplete")` with `details` `{ findings }`. For a task claim the check is nearly tautological: the task proves its objective holds a task, and that objective proves its initiative holds an objective. The one meaningful public case is a claim on an objective that holds no task.

**Pin the input exactly.** `completenessFindings` takes explicitly ordered `parents` and `children` arrays; the story must fix their membership and order, not leave "build the input" to build time.

- `parents` holds the claimed node and every containment ancestor of it, **ordered from the initiative down to the claimed node**. Build it by walking `parentId` upward from the claimed node and reversing. For a task claim it holds three members; for an objective claim, two.
- `children` holds, for **every** member of `parents`, each node whose `parentId` names that member, ordered by the `parents` order first and by child identity under `Buffer.compare` second.
- A `discarded` child is excluded from `children`, because a discarded task does not make its objective complete. Every other state is included.
- Both arrays are built from the one node set of step 2. Read the graph no second time.

The read costs one full-graph read, O(nodes + edges) per claim, under the 2000-node bound. **Add no index on `node.parent_id` and write no containment query.**

**3a. The read-only hierarchy pre-check, before any acquisition.** Call `liveLeaseRefusal` on the **claimed node** as target, built from the node set of step 2 and the live lease rows, and raise `ClaimNodeError("lease-held")` on a non-null refusal with `details` from that refusal.

**This step exists because acquisition order destroys the refusal vocabulary.** Step 4 acquires the **objective** lease first, so a second actor's claim on a sibling task would be refused by `lease.acquire` with the objective as target and `relation: "self"` — never `sibling` and never `ancestor`. The EPIC requires `sibling` and `descendant` in the refusal a human reads, and its own Decision at `.agent/plan/epics/018-claim-and-lease.md:73` states the purpose plainly: the `sibling` relation "is computed so the refusal message names the sibling a human sees". A read-only check on the claimed node is what computes it. Acquisition still happens objective-first, so the one-harness-per-objective rule is unchanged.

A `lease-held` raised later by `lease.acquire` is a **race**, not the ordinary refusal path: two actors reached the acquisition between one another's pre-check and write. It maps to the same code and carries whatever relation `acquire` reports.

**3b. The idempotent-replay branch, decided before any write.** Read the live lease of the **claimed node** through `lease.read`. When the node's state is `running` **and** that lease names `input.actorId` **and** its `expiresAt` is after `now`, this is a replay: read the active run of the node, read the active objective run, read the **one open attempt** of the task run through `attemptsOfRun` filtered to `outcome IS NULL`, and **return immediately**. Write nothing, append no event, and move no fence.

**This branch must precede steps 4 to 7, and the ordering is the whole point.** Steps 4 to 7 renew leases, adopt runs and call `openAttempt` unconditionally. Reached first, they mint a **second** attempt on a replayed claim and then the state branch reports "writes nothing", which is false. Deciding the replay before any mutation is what makes the promise true.

The open attempt is exactly one by construction: `openAttempt` is called once per claim and the release, the report and the sweep each close it. When `attemptsOfRun` yields more than one open attempt, throw a plain `Error` naming the run — that is a corrupted invariant, not a claim outcome.

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

**7. The state branch.** Branch on the claimed node's state. Step 3b already returned every replay, and step 1 already swept every expired external lease, so **two** cases remain here.

- `ready` — `plan.setNodeState(transaction, { id: node.id, from: "ready", to: "running", trigger: "claim-taken", blockReason: null, at: now, cause })`, then the ancestor cascade of Story 11.
- every other state, `running` included — raise `ClaimNodeError("illegal-transition")` with `details` `{ state: node.state, admitted: ["ready", "running"] }`. `admitted` names both states because `running` **is** admitted, by step 3b, and reaching this arm in `running` means the node is `running` under a different owner or an expired lease that the sweep did not free.

**Do not branch on the post-acquisition lease owner.** After step 4 the objective lease names `input.actorId` in **both** the replay case and a genuinely new acquisition over a freed row, so "the lease names me" cannot distinguish them. An expired or released objective stays `running`, so a new actor acquiring that free row would be misread as a pre-existing same-owner claim, and the claim would return someone else's run and append no acquisition event. `AcquireLeaseResult.acquired` is the discriminator: `false` is a same-owner reuse and `true` is a new acquisition, and step 3b decides the replay from the pre-write state rather than from either.

**A `running` node held by another actor at an expired fence is not a case here**: the sweep of step 1 already returned it to `ready`, so it reaches the first case with a freed lease row and a new fence.

**8. The events.** On the `ready` path, in this exact order: one `lease.claimed`, then the `node.running` events of the cascade, then the `node.running` of the claimed node. Story 11 fixes the cascade order. `lease.claimed` carries `subjectKind: "node"`, `subjectId` of the claimed node, the calling actor as `actorKind` and `actorId`, and payload `{ subjectId, objectiveId, fence, objectiveFence, expiresAt, runId, objectiveRunId, attemptId, attemptNo }`. The claimed node's own `node.running` keeps the calling actor, because it is the decision.

**9. The response.** `heartbeatIntervalMs` is `Math.floor(leaseTtlMs / 3)`, `100000` under the default `300000`. The claim response carries it so the harness never guesses.

### `cause`, pinned once for every `setNodeState` call of this epic

`ReadinessCause` of EPIC 016 carries `revision` and `importId`. Every `setNodeState` call of Stories 9, 10, 11 and 12 passes:

```ts
{ revision: <the written node's own revision>, importId: null }
```

`revision` is the `revision` column of the node **being written**, read from the node set already in hand, and never the project's newest revision. `importId` is `null` at every call site of this epic, because no write of this epic comes from an import. A cascade write therefore carries the ancestor's own revision, not the claimed node's. There is no other `cause` shape in this epic.

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

New test file `src/commands/node/claim-node.test.ts`, on real SQLite through `createMigratedStorage`, with a `MockClock` and `leaseTtlMs: 300000`. Fixed identities.

**A command test reaches no service implementation.** `AGENTS.md` admits a test importing its module under test, `domain/`, service interfaces, `test/helpers/` and `node:` builtins, and it reaches an implementation "only in the capability it covers" — which for this file is `commands/node/`, not `services/lease/` or `services/execution/`. So:

- `Lease` and `Execution` arrive as **hand-written fakes implementing the interface**, kept in `test/helpers/lease.ts` and `test/helpers/execution.ts`. Both record their calls, so the adoption, trigger and `openAttempt` assertions read the recording rather than the database.
- Both fakes are backed by the real `storage` transaction and write the real `lease`, `run` and `attempt` rows with plain SQL, so every row assertion in this file stays a real-SQLite assertion. A fake here means "a small hand-written object implementing the interface", per `AGENTS.md`, not an in-memory substitute.
- `PlanStore` is the recording fake EPIC 016 introduced, for the trigger assertions.
- `SqliteLease` and `SqliteExecution` are covered by their own suites, `src/services/lease/sqlite.test.ts` and `src/services/execution/sqlite.test.ts`. **Import neither here.** The end-to-end pairing of command and implementation is proved once, by `src/main.claim.test.ts` over HTTP.

- `a claim on a ready task returns a lease and moves the task, the objective and the initiative to running` — the three states asserted **by identity**, not by count.
- `a claim on a ready task opens an external objective run and an external task run` — assert the task run's `parent_run_id` names the objective run, both `driver` columns are `external`, and both `workspace_id`, `worker` and `base_oid` are null.
- `a claim on a ready task opens attempt number 1` — assert `attemptNo` is `1` and the row's `driver` is `external`.
- `a claim on an objective opens no attempt` — assert `attemptId` and `attemptNo` are both null and the `attempt` table holds no row.
- `heartbeatIntervalMs is one third of leaseTtlMs` — assert `100000`.
- `a claim on an initiative is refused initiative-not-claimable and writes nothing` — assert the refusal, `details.refusal`, and that every table is deep-equal before and after.
- `an unknown node is refused node-not-found`.
- `a claim under an objective that holds no task is refused plan-incomplete with exactly objective-without-task` — assert `details.findings` holds exactly that one code, and the database is deep-equal before and after. In the same fixture assert an unrelated complete objective in the same project is still claimable with a successful claim.
- `a claim on the claimed node in any of six states is refused illegal-transition` — loop the **claimed node** through `pending`, `blocked`, `awaiting_approval`, `done`, `partial`, `discarded`; assert all six carry `details` `{ state, admitted }` with **no** `ancestorId`, and assert the database is deep-equal before and after each. The **objective** in a bad state is a different refusal, `ancestor-not-startable`, and **Story 11 owns it** — do not assert it here.
- `a claim on a task whose objective is already running writes no objective state change and still succeeds` — assert the recording `PlanStore` fake recorded no call for the objective.
- `the state branch holds two cases only` — drive a `ready` node and each of the six non-`running` states, and assert the `running` case never reaches the branch because step 3b returns first. Assert no fixture reaches a third case.
- `a replayed claim writes nothing at all` — claim, then claim again as the **same** actor while the lease is live. Assert the returned `fence`, `objectiveFence`, `runId`, `objectiveRunId`, `attemptId` and `attemptNo` are **identical** to the first response; assert the `attempt` table holds exactly **one** row for that run; assert the event log grew by **zero** rows; and assert the whole database is deep-equal before and after the second call, `expires_at` included. **`expires_at` does not move on a replay**: step 3b returns before any renewal, so a replay is a pure read. A harness extends its lease through `node.heartbeat`, not by re-claiming.
- `a replayed claim opens no second attempt` — the assertion the ordering exists for. Drive the replay against a recording `Execution` fake and assert `openAttempt` was **never** called.
- `a new acquisition over a freed row is not mistaken for a replay` — actor A claims and releases the task; actor B then claims it. Assert B's claim appends `lease.claimed`, opens a new run and a new attempt, and returns B as the owner, and assert it did **not** return A's run id. This is the case a post-acquisition owner check gets wrong.
- `the same actor claims two ready sibling tasks in turn` — both succeed; the objective lease fence is **identical** after both; two task runs exist and both name the one objective run as `parent_run_id`.
- `an actor claims an objective and then a task under it with no self-deadlock` — the task claim succeeds, the objective lease fence is unchanged, and the objective run is reused rather than reopened (assert the `run` row count).
- `a second actor's claim on a sibling task is refused lease-held with relation sibling` — and assert the refusal names the **sibling task** as `subject`, not the objective. The pre-check of step 3a is what makes this relation reachable; without it the objective-first acquisition reports `self` and this assertion fails.
- `a second actor's claim on the objective is refused lease-held with relation descendant` — and assert `subject` names the held **task**.
- `a second actor's claim on the same task is refused lease-held with relation self`.
- `the refusal is raised before any write` — for all three refusals above, assert the whole database is deep-equal before and after, so the pre-check precedes every acquisition.
- `a claim over an expired lease goes through the sweep and never through a takeover branch` — a second actor claims a task **both of whose leases expired**, task and objective, because a claim writes both on one `now` with one `leaseTtlMs`. Inside that one transaction assert: the old task run ended with outcome `expired`, its attempt closed `cancelled`, the old objective run ended with outcome `expired`, the new task lease fence is the old fence plus one, a new task run is `active`, a new objective run is `active`, **attempt number `1` is open in the new run**, and the task is `running`.
  **Attempt number `1` and not `2`.** Numbering is per run by `UNIQUE (run_id, attempt_no)` and by `accountAttempts` over `attemptsOfRun`; the sweep ended the old run and the claim opened a new one, so the new run's first attempt is `1`. Assert additionally that the **old** run still holds exactly one attempt numbered `1`, so the two runs are distinguishable and no number was reused inside one run.
  **The events of that transaction are exactly `recovery.leaseRecovered`, `recovery.leaseRecovered`, `lease.claimed`, `node.running`, asserted in that order**, with the two recovery events ordered bytewise by subject identity. Two recovery events, because the sweep frees the objective lease and the task lease and both were expired.
- `a re-claim on the same run numbers the next attempt 2` — claim, release the task, then claim again **before** any expiry so the sweep does not fire. The release ended the run, so assert this too opens a new run with attempt `1`. Then, for the same-run case, open a second attempt directly on one run through `Execution` and assert `2`. This separates "per-run numbering" from "per-task numbering" and pins the former.
- `no event of type lease.takenOver exists in the repository` — a scan of every `.ts` file under `src/` asserting the literal `lease.takenOver` appears nowhere.
- `the drive-mode pin refuses a harness claim on an objective whose history holds an internal run` — the fixture writes the internal run directly, because no route of this block opens one. Assert the refusal, `details` naming both drivers, and that the database is deep-equal before and after.
- `a claim over an active internal run under that objective is the same refusal and never adopts` — assert through the recording `Execution` fake that `adoptRun` was **never** called.
- `a claim whose run history is empty succeeds, and a claim whose history holds external runs only succeeds`.
- `the claimed task write names trigger claim-taken` — assert through the recording `PlanStore` fake, and assert no other trigger appears on that path.
- `a setNodeState call whose trigger disagrees with the pair throws and commits nothing` — drive the claim path with `claim-taken` over a `running → ready` pair and assert it throws and the database is deep-equal before and after.
- `no path of the claim writes awaiting_approval` — read the state of every node after the claim and assert none is `awaiting_approval`. This covers the **claim** only. The full bullet at `.agent/plan/epics/018-claim-and-lease.md:205` requires one assertion spanning a claim, a heartbeat, a release, a sweep and a re-claim, which needs all three commands; **Story 12 owns that journey**, because it is the first story in which all three exist. Story 12 asserts it and cites line 205; this story cites it no longer.
- `the sibling race commits exactly one claim` — two different actors claim two different `ready` sibling tasks of one objective, each in its own `storage.transact`, serialized by `BEGIN IMMEDIATE`. Exactly one succeeds and the other is refused `lease-held`. Afterwards assert the database holds exactly one objective lease row with an owner, exactly one task lease row with an owner, and exactly one open attempt.
- `one claim reads the clock once` — a counting `Clock` fake asserts exactly one `now()` call.
- **`the abandoned objective is freed by expiry and by nothing else`** — one actor claims a task, reports nothing and heartbeats no more. Advance the `MockClock` past `leaseTtlMs`, and a **second** actor claims an unrelated task. Afterwards assert: the objective lease holds a **null owner**; the objective run ended with outcome `expired`; the objective state is **still `running`**; and the task is `ready`. Then assert the second actor claims that task and that objective successfully. The objective is therefore never held for ever, and `leaseTtlMs` is the whole bound.
- **`the claim-driven sweep needs no restart and no timer`** — one actor claims a task, advance the `MockClock` past `leaseTtlMs`, and a **second** actor claims an unrelated task **in another project**. Assert the first task is `ready`, its run ended `expired`, its attempt closed `cancelled`, and its lease holds a null owner with an **unchanged** fence. Assert no daemon restarted: the whole test runs in one process with no `launchDaemon` call. Then assert `listNodes({ state: "ready" })` returns the first task.

Run:

- `node --test src/commands/node/claim-node.test.ts src/domain/lease-hierarchy.test.ts src/services/lease/sqlite.test.ts src/services/execution/sqlite.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/commands/node/claim-node.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:171-173`, `:184`, `:189-190`, `:194`, `:197`, `:202-204`, `:209`. Lines `:186-188` belong to Story 11, line `:205` to Story 12, and line `:206` to Story 8.
