# Story 11 — `closeObjective`

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Stories 4, 6 and 10 (`aggregateInitiative`).

## Change

### A new `src/commands/outcome/close-objective.ts`

```ts
export type CloseObjectiveDependencies = Readonly<{
  plan: PlanStore;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  aggregateInitiative: (
    transaction: Transaction,
    input: AggregateInitiativeInput,
  ) => void;
  instanceId: string;
}>;

export type CloseObjectiveInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  acknowledgePartial: boolean;
}>;

export function closeObjective(
  dependencies: CloseObjectiveDependencies,
  transaction: Transaction,
  input: CloseObjectiveInput,
): CloseObjectiveResult;
```

It takes the caller's `transaction` and opens none of its own, and it captures one `now`. Declare `CloseObjectiveError` with refusals `actor-forbidden`, `illegal-transition` and `acknowledgement-required`. `aggregateInitiative` arrives injected, because `commands/` never imports `commands/`.

The body runs in this exact order.

1. `input.actorKind === "harness"` throws `actor-forbidden`. `015-actor-identity.md:50` reserves an approval decision for a human.
2. Read the node. A state other than `awaiting_approval` throws `illegal-transition` with `details: { state }`. **No lease guard runs**: the attestation released the objective lease, so the state check is the whole guard.
3. Read the active objective run with `execution.activeRunOfNode`. A null run throws `illegal-transition`. `run.driver === "internal"` throws `illegal-transition`; the drive-mode pin of EPIC 014 makes that case unreachable and this assertion is the cheap defence. `run.head_oid === null` throws `illegal-transition`, because `014-external-drive-contract.md:33` makes the reported object id required on both close rows.
4. Read every task of the objective through `plan.readAllNodes(transaction)`, and call `aggregate("objective", states)` with `states` in bytewise node-id order. The derived value is `done`, `partial` or `discarded`.
5. A derived `partial` with `input.acknowledgePartial === false` throws `acknowledgement-required`. A derived `discarded` throws `illegal-transition`.
6. `plan.setNodeState(transaction, { id: node.id, from: "awaiting_approval", to: derived, trigger: derived === "done" ? "human-close" : "human-close-partial", blockReason: null, at: now, cause: { revision: node.revision, importId: null } })`.
7. Append one event:

```ts
dependencies.events.append(transaction, {
  subjectKind: "node",
  subjectId: node.id,
  type: derived === "done" ? "node.done" : "node.partial",
  actorKind: "human",
  actorId: input.actorId,
  payload: {
    from: "awaiting_approval",
    to: derived,
    reason: "human-close",
    objectId: run.head_oid,
    objectiveRunId: run.id,
    acknowledgePartial: input.acknowledgePartial,
  },
});
```

8. Call `dependencies.aggregateInitiative(transaction, { initiativeId: node.parentId, at: now })`.
9. **Only then** call `execution.endRun(transaction, { runId: run.id, outcome: derived, at: now })`, so the initiative roll-up of step 8 sees an active run.

Return the shared `NodeReportResult` of Story 5: `CloseObjectiveResult = NodeReportResult`. Fill `nodeId`, `kind: "objective"`, `state: derived`, `blockReason: null`, `objectId: run.head_oid`, `objectiveState: derived` and `objectiveProjection: derived`. `attemptId`, `attemptNo` and `attemptsRemaining` are `null`.

## Constraints

- The state is derived and never read from the request. The request carries `acknowledgePartial` and nothing else.
- Step 9 runs after step 8. Reversing them breaks the assertion of `019-outcome-report.md:163`.
- It writes no candidate row, calls no method of `Git`, and writes no `check_result` and no `agent_invocation` row.
- The payload holds exactly six keys, in the order above.
- Import no vendor package and no other command.
- The task states of step 4 are ordered bytewise by node id through `Buffer.compare`.
- **Every refusal case asserts a byte-identical database, zero recorded `EventLog.append` calls, zero recorded `setNodeState` calls and zero recorded `endRun` and `aggregateInitiative` calls.**

## The close decision table

The derived projection alone decides the outcome. This table is total, and no other combination exists.

| Derived projection | `acknowledgePartial` | Result                                   | Trigger               | Event          | Run outcome | Initiative roll-up |
| ------------------ | -------------------- | ---------------------------------------- | --------------------- | -------------- | ----------- | ------------------ |
| `done`             | `false`              | `awaiting_approval → done`               | `human-close`         | `node.done`    | `done`      | runs               |
| `done`             | `true`               | `awaiting_approval → done`               | `human-close`         | `node.done`    | `done`      | runs               |
| `partial`          | `true`               | `awaiting_approval → partial`            | `human-close-partial` | `node.partial` | `partial`   | runs               |
| `partial`          | `false`              | `409 acknowledgement-required`, no write | none                  | none           | none        | no                 |
| `discarded`        | either               | `409 illegal-transition`, no write       | none                  | none           | none        | no                 |

A `discarded` projection is refused at the close for the same reason the attestation refuses it: `awaiting_approval` needs at least one `done` task, so an objective whose every task is `discarded` never reaches this state through a route of this block. `acknowledgePartial` is ignored on a `done` projection; it is not an error.

## Verify

Create `src/commands/outcome/close-objective.test.ts`, suite name `"src/commands/outcome/close-objective.test"`. Inject a `Git` fake that counts every call and an `Execution` fake that records call order where the assertion needs it.

- `it("a close of a done projection writes done and ends the run", ...)` — the objective is `done`, the run is ended with outcome `done`, and the initiative roll-up ran.
- `it("the decision table holds row by row", ...)` — drive all five rows of the table above and assert the result, the trigger, the event type, the run outcome and whether the roll-up ran.
- `it("acknowledgePartial is ignored on a done projection", ...)` — `true` and `false` both write `done`.
- `it("a derived discarded projection is illegal-transition", ...)` — the fixture writes every task `discarded` directly; byte-identical before and after.
- `it("a derived partial with no acknowledgement is acknowledgement-required", ...)` — the fixture builds one `discarded` task directly in the database; the database is byte-identical before and after. The same request with `acknowledgePartial: true` answers and writes `partial`.
- `it("a close of an objective that is not awaiting_approval is illegal-transition", ...)` — drive all seven other states; each writes nothing.
- `it("a close of an objective whose run driver is internal is illegal-transition", ...)` — the fixture writes `driver = 'internal'` on the active run directly; byte-identical before and after.
- `it("a close of an objective whose run head_oid is null is illegal-transition", ...)` — byte-identical before and after.
- `it("a harness actor is actor-forbidden", ...)` — byte-identical before and after.
- `it("the close writes no candidate, calls no git and writes no check or invocation row", ...)` — the `Git` fake call count is `0`, and `SELECT COUNT(*)` over `candidate`, `check_result` and `agent_invocation` is `0` after the close.
- `it("the initiative roll-up runs before the run ends", ...)` — over the recording `Execution` fake, assert the `aggregateInitiative` call precedes the `endRun` call, and assert the run row is active at the moment `aggregateInitiative` runs.
- `it("the trigger is human-close or human-close-partial", ...)` — over the recording `PlanStore` fake, one case each, and no other trigger.
- `it("a trigger that disagrees with the pair commits nothing", ...)` — drive `human-close` on a `task` node and assert the throw plus a byte-identical database.
- `it("the event names the closing human", ...)` — `actorKind === "human"`, `actorId` equal to the input actor id, and `Object.keys(payload)` deep-equal to `["from", "to", "reason", "objectId", "objectiveRunId", "acknowledgePartial"]`.
- `it("the close makes a dependent objective ready in the same transaction", ...)` — one `node.ready` event with `actorKind: "daemon"`.
- `node --test src/commands/outcome/close-objective.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/commands/outcome/close-objective.test.ts`. Hermetic coverage: `019-outcome-report.md:159`, `:160`, `:161`, `:163`, `:164` (the close half), the close clause of `:153`, and the close rows of `:168` and `:169`.
