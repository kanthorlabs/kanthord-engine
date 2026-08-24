# Story 7 — `reportOutcome`, the command

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Stories 3, 4, 5, 6. **Coupled with Story 8**, which fixes the event payload of this command. Implement 7 then 8 with no verify gate between them.

## Change

### A new `src/commands/outcome/report-outcome.ts`

```ts
export type ReportOutcomeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  reportObjective: (
    transaction: Transaction,
    input: ReportObjectiveInput,
  ) => ReportObjectiveResult;
  closeObjective: (
    transaction: Transaction,
    input: CloseObjectiveInput,
  ) => CloseObjectiveResult;
  instanceId: string;
}>;

export type ReportOutcomeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  body: NodeReportRequest;
}>;
```

`reportObjective` and `closeObjective` arrive **injected**, because `commands/` never imports `commands/`. `018-claim-and-lease.md:104` sets that precedent.

Declare the refusal type and the error class in this file, in the shape of `ImportPlanError` at `src/commands/plan/import-plan.ts:78-88`:

```ts
export type ReportOutcomeRefusal =
  | "node-not-found"
  | "initiative-not-reportable"
  | "body-kind-mismatch"
  | "actor-forbidden"
  | "illegal-transition"
  | "lease-held";

export class ReportOutcomeError extends Error {
  readonly refusal: ReportOutcomeRefusal;
  readonly details: unknown;
  constructor(
    refusal: ReportOutcomeRefusal,
    message: string,
    details?: unknown,
  );
}
```

`export function reportOutcome(dependencies, input): ReportOutcomeResult` opens **one** `storage.transact` and captures **one** `now = dependencies.clock.now()` as the first statement inside it. Every write and every expiry comparison of the call uses that one `now`. The body runs in this exact order.

1. Read the node with `plan.readNode(transaction, input.nodeId)`. `null` throws `node-not-found`.
2. `node.kind === "initiative"` throws `initiative-not-reportable`.
3. Compare the body discriminator to the kind. A task node with a `report` in `objectiveReportKinds`, and an objective node with a `report` in `taskReportOutcomes`, each throw `body-kind-mismatch`.
4. An objective node delegates and returns:
   - `report: "attested"` returns `dependencies.reportObjective(transaction, { nodeId, actorId, actorKind, fence, objectId })`.
   - `report: "closed"` returns `dependencies.closeObjective(transaction, { nodeId, actorId, actorKind, acknowledgePartial })`.

   It passes **the same** `transaction`. It does not open a second one, and it does not catch their errors.

5. The task branch continues. `input.actorKind === "human"` throws `actor-forbidden`.
6. `node.state !== "running"` throws `illegal-transition`, with `details: { state: node.state }`.
7. Read the task lease with the `Lease` read EPIC 018 exposes for the `node` subject kind. Throw `lease-held` on any of three conditions, each with `details: { owner, fence }` read from the row:
   - `record.owner !== input.actorId`;
   - `record.fence !== input.body.fence`;
   - `record.expiresAt === null || record.expiresAt <= now`.
8. Read the active task run with `execution.activeRunOfNode(transaction, node.id)`. A null run throws `illegal-transition`.
9. Close the open attempt of that run through `execution.closeAttempt`, with `outcome` equal to the body `report` value and `headOid` equal to the body `objectId` for `accepted` and `null` for the other three.
10. Read the attempts back with `execution.attemptsOfRun(transaction, run.id)`, map each row to `{ attemptNo, outcome }`, and call `accountAttempts({ attempts, limit: run.attempt_limit })`.
11. Call `taskReportEffect({ outcome: input.body.report, accounting })`.
12. Write the task state with `plan.setNodeState(transaction, { id: node.id, from: "running", to: effect.nodeState, trigger: effect.trigger, blockReason: effect.blockReason, at: now, cause: { revision: node.revision, importId: null } })`.
13. When `effect.runEnd !== null`, call `execution.stampRunHead(transaction, { runId: run.id, headOid })` for an `accepted` report only, then `execution.endRun(transaction, { runId: run.id, outcome: effect.runEnd, at: now })`. When `effect.runEnd === null`, touch the run not at all.
14. Release the **task** lease with `lease.release(transaction, { subjectKind: "node", subjectId: node.id, fence: input.body.fence })`.
15. Append the `outcome.reported` event of Story 8.
16. Read every node with `plan.readAllNodes(transaction)`, select the tasks whose `parentId` equals `node.parentId`, and compute `objectiveProjection`. It is `aggregate("objective", states)` when **every** sibling task state is terminal, and `null` otherwise. `states` is read in bytewise node-id order. It writes no objective state and it touches no objective lease and no objective run.

Return the shared record of Story 5: `export type ReportOutcomeResult = NodeReportResult;`. Declare no second shape. The task branch fills every member; `attemptsRemaining` is `Math.max(0, run.attempt_limit - accounting.counter)`. `objectId` is the accepted object id or `null`. `objectiveState` is the parent objective state read inside the same transaction, **after** step 12.

## Constraints

- **Never touch the objective lease and never end the objective run.** `018-claim-and-lease.md:30` is the rule. A report that released the objective lease answers the following attestation `409 lease-held`.
- One transaction and one `now`. Do not call `clock.now()` twice.
- **Every derived list is ordered explicitly.** The sibling task states of step 16 are read in bytewise node-id order through `Buffer.compare`, and the attempt list of step 10 is ordered by `attempt_no` ascending. Never rely on the order a query returns.
- Import no vendor package. `commands/` imports `domain/` and service interfaces only.
- Branch on no state pair literal. Each write names its trigger, and `setNodeState` validates the pair against the declared row.
- Do not import `report-objective.ts` or `close-objective.ts`. They arrive injected.
- `timed-out` never reaches this command: the request schema of Story 18 refuses it.
- Do not write a second event for the transition. Step 15 writes `outcome.reported`, and `setNodeState` plus the readiness service of EPIC 016 write their own.

## Verify

Create `src/commands/outcome/report-outcome.test.ts`, suite name `"src/commands/outcome/report-outcome.test"`. Use real `node:sqlite` on a temporary file for storage, plan, lease and execution, and hand-written fakes for `clock` (`test/helpers/clock.ts`), `events` (recording) and the two injected objective functions (recording). Each `it` builds one initiative, one objective and its tasks through the plan fixture, then claims through EPIC 018's command or writes the equivalent rows directly.

- `it("an accepted report moves the task to done and records the object id", ...)` — the task is `done`, exactly one attempt row carries `outcome: "accepted"` and the reported `head_oid`, the run is ended with outcome `done` and the same `head_oid`, and the attempt row count is unchanged apart from that close.
- `it("a rejected report under the limit returns the task to ready and keeps the run active", ...)` — the task is `ready`, the run row has `ended_at IS NULL`, the task lease has a null owner, and the objective lease is compared field by field before and after and is equal in `owner`, `owner_kind`, `fence` and `expires_at`.
- `it("a failed report behaves as a rejected report and records failed", ...)`.
- `it("a cancelled report under the limit leaves the run active", ...)` — and in the same `it`, drive the identical fixture through EPIC 018's `releaseNode` and assert that run **is** ended, side by side.
- `it("three rejected reports under a limit of three block the task", ...)` — the task is `blocked` with `block_reason = "attempt-limit"`, the run is ended with outcome `blocked`, the attempt numbers are 1, 2 and 3, the task lease is free, the objective lease is unchanged field by field, the objective run is active, and the objective is `running`.
- `it("three cancelled reports reach the same block", ...)` and `it("three failed reports reach the same block", ...)` — assert the three fixtures side by side in one file.
- `it("attemptsRemaining clamps at zero", ...)` — a run with `attempt_limit` 3 and a counter of 4 returns `0`; under the limit it returns `limit - counter`.
- `it("no task report touches the objective lease", ...)` — compare the objective `lease` row field by field before and after each of the four outcomes and after the report that closes the last task: `owner`, `owner_kind`, `fence` and `expires_at` are equal in all five cases.
- `it("a report on a task in each non-running state is illegal-transition", ...)` — drive `pending`, `ready`, `blocked`, `awaiting_approval`, `done`, `partial` and `discarded`, assert the refusal names the current state in `details.state`, and assert the database is byte-identical before and after through `test/helpers/database.ts`.
- **Every refusal case in this file asserts three things, not one**: a byte-identical database, zero recorded `EventLog.append` calls, and zero recorded `Lease.release` and `setNodeState` calls. A byte-identical file alone does not prove a rolled-back transaction wrote nothing to a service.
- `it("a wrong owner, a stale fence and an expired lease are each lease-held", ...)` — three cases, each byte-identical before and after. The expired case advances the fake clock past `expires_at` with the owner and the fence both matching, and triggers no claim.
- `it("a human actor is actor-forbidden", ...)` — byte-identical before and after.
- `it("an initiative is initiative-not-reportable", ...)` and `it("a task body on an objective and an objective body on a task are body-kind-mismatch", ...)` — all three write nothing.
- `it("an objective with report attested delegates to reportObjective in the same transaction", ...)` — the recording fake receives the same `Transaction` reference the command opened, and the command returns its result unchanged. The same for `closed` and `closeObjective`.
- `it("objectiveProjection is done when every sibling task is terminal", ...)`, `it("... partial when one sibling is discarded", ...)`, `it("... null while one sibling is non-terminal", ...)` — the third case also asserts the objective state is still `running`.
- `it("every write names its trigger", ...)` — over a `PlanStore` fake that records `setNodeState` calls: `outcome-accepted`, `attempt-rejected`, `attempt-failed`, `report-cancelled` and `attempt-limit-reached`, and no other trigger.
- `it("a trigger that disagrees with the pair commits nothing", ...)` — drive `outcome-accepted` over a `running → ready` pair, assert the throw, and assert the database is byte-identical before and after.
- `it("an accepted report makes a dependent task ready in the same transaction", ...)` — one `node.ready` event with `actorKind: "daemon"`.
- `node --test src/commands/outcome/report-outcome.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/commands/outcome/report-outcome.test.ts`. Hermetic coverage: `019-outcome-report.md:136`, `:137`, `:138`, `:139`, `:140` (the report half), `:142`, `:143`, `:144`, `:147`, `:148`, `:149`, `:152`, `:153` (the task half), `:164` (the task half), `:168` and `:169`.
