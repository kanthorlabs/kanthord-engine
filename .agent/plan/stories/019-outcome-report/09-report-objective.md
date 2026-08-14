# Story 9 — `reportObjective`, the attestation command

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Stories 4 and 6.

## Change

### A new `src/commands/outcome/report-objective.ts`

```ts
export type ReportObjectiveDependencies = Readonly<{
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  instanceId: string;
}>;

export type ReportObjectiveInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  fence: number;
  objectId: string;
}>;

export function reportObjective(
  dependencies: ReportObjectiveDependencies,
  transaction: Transaction,
  input: ReportObjectiveInput,
): ReportObjectiveResult;
```

It takes the caller's `transaction` as the second argument and opens none of its own. It captures one `now = dependencies.clock.now()`. Declare `ReportObjectiveError` with refusals `actor-forbidden`, `illegal-transition` and `lease-held`, in the shape of `ReportOutcomeError`.

The body runs in this exact order.

1. `input.actorKind === "human"` throws `actor-forbidden`.
2. Read the node. A state other than `running` throws `illegal-transition` with `details: { state }`.
3. Read the objective lease and apply the same three-condition guard as the task branch of Story 7, each throwing `lease-held` with `details: { owner, fence }`: a wrong owner, a wrong fence, and `expiresAt === null || expiresAt <= now`.
4. Read every task of the objective through `plan.readAllNodes(transaction)`, selecting the nodes whose `parentId` equals `node.id`. Any non-terminal task state throws `illegal-transition`.
5. Call `aggregate("objective", states)` of `src/domain/aggregation.ts:17`, with `states` read in bytewise node-id order. A `discarded` projection throws `illegal-transition`, because `awaiting_approval` needs at least one `done` task.
6. Call `objectiveOutcome(projected)` of `src/domain/outcome.ts:17`.
7. `plan.setNodeState(transaction, { id: node.id, from: "running", to: outcome.state, trigger: "object-reported", blockReason: outcome.blockReason, at: now, cause: { revision: node.revision, importId: null } })`.
8. Read the active objective run with `execution.activeRunOfNode` and call `execution.stampRunHead(transaction, { runId: run.id, headOid: input.objectId })`. A null run throws `illegal-transition`.
9. `lease.release(transaction, { subjectKind: "node", subjectId: node.id, fence: input.fence })`.
10. Append one event:

```ts
dependencies.events.append(transaction, {
  subjectKind: "node",
  subjectId: node.id,
  type: "node.awaitingApproval",
  actorKind: "harness",
  actorId: input.actorId,
  payload: {
    from: "running",
    to: "awaiting_approval",
    reason: "object-attested",
    objectId: input.objectId,
    projection: projected,
    objectiveRunId: run.id,
  },
});
```

Return the shared `NodeReportResult` of Story 5: `ReportObjectiveResult = NodeReportResult`. Fill `nodeId`, `kind: "objective"`, `state: outcome.state`, `blockReason: outcome.blockReason`, `objectId: input.objectId`, `objectiveState: outcome.state` and `objectiveProjection: projected`. `attemptId`, `attemptNo` and `attemptsRemaining` are `null`, because an objective report closes no attempt.

## Constraints

- **It ends no run.** The objective run stays active from the claim to the close, so it carries the attested object id while the human reads it.
- It releases the objective lease and no other lease.
- The payload holds exactly six keys, in the order above.
- Write one event only. `setNodeState` and the readiness service append their own.
- Import no vendor package and no other command.
- Read no state pair literal into the call. The trigger is the literal `"object-reported"`.
- The task states of step 4 are ordered bytewise by node id through `Buffer.compare`. Never rely on query order.
- **Every refusal case asserts a byte-identical database, zero recorded `EventLog.append` calls and zero recorded `Lease.release` and `setNodeState` calls.**

## Verify

Create `src/commands/outcome/report-objective.test.ts`, suite name `"src/commands/outcome/report-objective.test"`, in the fixture style of Story 7.

- `it("an attestation moves the objective to awaiting_approval and stamps the object id", ...)` — the objective is `awaiting_approval`, the active run carries the attested `head_oid`, the run is still active (`ended_at IS NULL`), and the objective lease has a null owner.
- `it("the attested object id is not the object id of any task report", ...)` — the fixture reports a task with one object id and attests with a different one; assert `run.head_oid` equals the attested one.
- `it("an attestation over a live objective lease answers rather than refusing", ...)` — the fixture reports the last task first, then attests with the same owner and the fence the claim minted, and asserts no throw. This is the regression guard for the objective-lease rule of `018-claim-and-lease.md:30`.
- `it("an attestation while one task is non-terminal is illegal-transition", ...)` — byte-identical database before and after.
- `it("an attestation on an objective that is not running is illegal-transition", ...)` — drive `pending`, `ready`, `awaiting_approval`, `blocked`, `done`, `partial` and `discarded`; each writes nothing.
- `it("a stale fence, a wrong owner and an expired lease are each lease-held", ...)` — three cases, each byte-identical before and after.
- `it("a projection of discarded is illegal-transition", ...)` — the fixture writes every task `discarded` directly in the database, because no route discards one in this block. Byte-identical before and after.
- `it("a human actor is actor-forbidden", ...)` — byte-identical before and after.
- `it("the event names the attesting harness", ...)` — `actorKind === "harness"`, `actorId` equal to the input actor id, and `Object.keys(payload)` deep-equal to `["from", "to", "reason", "objectId", "projection", "objectiveRunId"]`.
- `it("the awaitingApproval event differs from the ready event of the same transaction", ...)` — assert one recorded `node.awaitingApproval` with `actorKind: "harness"` and one recorded `node.ready` with `actorKind: "daemon"`, when a dependent node exists.
- `it("the trigger is object-reported and no other", ...)` — over the recording `PlanStore` fake.
- `node --test src/commands/outcome/report-objective.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/commands/outcome/report-objective.test.ts`. Hermetic coverage: `019-outcome-report.md:154`, `:155`, `:156`, `:157`, the attestation clause of `:153`, and the attestation rows of `:168`.
