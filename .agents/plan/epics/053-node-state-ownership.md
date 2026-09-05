# EPIC 053 — Node state ownership

Status: **draft**. It follows EPIC 052.1 by sequence order, and it runs before EPIC 053.1. It consumes EPIC 051.3's `land-settle-accepted` diagram, EPIC 051.4's acceptance gate, and EPIC 047's pair table.

**Dispatch prerequisite.** EPIC 052 and EPIC 052.1 own their own `authoredEpics` inserts, and this epic adds neither. Story 1 inserts `"053"` into `scripts/epic-sequence-range.ts:1` — `authoredEpics` after the entry EPIC 052.1 adds, and Story 8 appends it to `shippedEpics`, which `test/sequence/conformance.test.ts:254` — `shippedEpics` requires to stay a prefix of `authoredEpics`. Story 8 is the last drawing story, and it appends the entry in the same turn as it deletes the superseded scenario file, because a due diagram with no scenario file fails `test/sequence/conformance.test.ts:126` — `has ${matches.length} scenario files` in between. Story 9 is last in dispatch order and edits no range.

## Goal

A parent state derives from its children, and a run never writes a parent terminal state:

- a parent objective moves when its last task becomes terminal, and never before;
- every task terminal with at least one `done` gives `awaiting_approval`, and a human closes it;
- every task `discarded` gives `discarded`, and the initiative aggregates from it in the same transaction;
- an atomic objective reaches `awaiting_approval` from its own accepted checkpoint, whatever the projection;
- a terminal objective and a closed objective are never moved by a later aggregation;
- the reported result names the objective state the transaction leaves behind.

## Non-goals

- **No review checkpoint.** EPIC 053.1 owns the review attestation, its refusals and the review member of `node.report`.
- **No close.** A human closing an objective is EPIC 056. This epic moves a parent objective to `awaiting_approval` and stops there.
- **No `closed_at` column, and no migration.** No epic builds `node.closed_at` or `node.closed_actor`. The precedence this epic needs comes from the state guard: `aggregateObjective` writes only from `running`, and `src/services/plan/index.ts:119` — `setNodeState` validates the declared `from`, so a closed objective is unreachable by a later aggregation. `.agents/plan/epics/056.1-the-close-and-the-human-boundary.md` records the same ruling for the close, and the event row carries the actor a provenance column would have held.
- **No new initiative aggregation.** `src/commands/outcome/aggregate-initiative.ts:20` — `aggregateInitiative` ships, and this epic changes no line of it. It gains one caller.
- **No initiative end-to-end result.** `initiativeOutcome` at `src/domain/outcome.ts:25` — `initiativeOutcome` keeps its `e2e` parameter and its `not-applicable` default.
- **No initiative report.** `src/commands/outcome/report-outcome.ts:116` — `initiative-not-reportable` refuses every report on an initiative. The structural member and that guard belong to EPIC 052.1, which lifts the guard for that member and asserts the initiative state is unchanged.
- **No approval evidence bundle.** `node.approvalEvidence` stays `stubbed`. EPIC 112 owns it.

## Decisions

- **The parent-objective aggregation is a nested command in the caller's transaction, and it copies the shipped initiative aggregation.** `src/commands/outcome/aggregate-objective.ts` exports `aggregateObjective(dependencies, transaction, input)` with `input` of `{ objectiveId: string | null; at: number }`. A nested command does not open a second transaction: `src/commands/outcome/close-objective.ts:157` — `aggregateInitiative` already calls one inside the close transaction. The shipped idiom is therefore the decision, and no domain walk and no new mechanism join it.

- **The caller is `landSettle`'s accepted arm, and it is not `reportOutcome`.** A task reaches a terminal state on one path only, and after EPIC 051.4 that path does not run in `reportOutcome`: `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/08-the-report-route-enforces-the-gate.md:13` — `Seams` removes `plan.setNodeState:T:outcome-accepted`, `events.append:outcome.reported:T:null` and `plan.readAllNodes` from the report route, and `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:9` — `Seams` holds all three. `land-settle-accepted` opens its own transaction at its step 2, so a caller further out would put the task's terminal write and the parent's aggregation in **two** transactions, which `AGENTS.md` refuses. `src/main.ts` binds `aggregateObjective` into `LandSettleDependencies`, and `reportOutcome` gains no key. The same settle runs at startup reconciliation through `.agents/plan/stories/051.3-the-checkpoint-and-the-land/06-startup-reconciles-an-open-merge-row.md:11` — `land.settle:accepted`, so a crash between the git write and the settle still aggregates on recovery.

- **Both roll-up injections are object capabilities, and neither is a bare callable.** `landSettle` receives `objective: { aggregate(transaction, input): void }` and `aggregateObjective` receives `initiative: { aggregate(transaction, input): void }`. `test/helpers/sequence-conformance.ts:113` — `typeof capability` returns a function dependency unwrapped, so a bare callable records no token and the gate row that requires the comparison to fail when the aggregation is removed could not hold. `src/commands/node/claim-node.ts`'s `Expiry`, bound at `test/sequence/scenarios/claim-success-task.ts:81` — `expiry`, is the shipped drawable idiom. `reportObjective` and `closeObjective` stay bare callables, because no diagram draws either.

- **The command reads, decides and returns nothing, exactly as `aggregateInitiative` does.** It returns early when `objectiveId` is null, when the node is absent, and when the node state is not `running`, which is the guard at `src/commands/outcome/aggregate-initiative.ts:30` — `running`. It reads the children through `plan.readAllNodes` and sorts them by ULID with `Buffer.compare`, which is the order at `src/commands/outcome/aggregate-initiative.ts:35` — `readAllNodes`. It throws when a `running` parent holds no child, which is the shipped behaviour of the same file.

- **The parent-objective mapping is three rows, and the transition table already fixes it.** `parentObjectiveOutcome(projected)` in `src/domain/outcome.ts`:

  | `aggregate` gives | node state          | trigger                                  |
  | ----------------- | ------------------- | ---------------------------------------- |
  | `done`            | `awaiting_approval` | `objective-aggregated-awaiting-approval` |
  | `partial`         | `awaiting_approval` | `objective-aggregated-awaiting-approval` |
  | `discarded`       | `discarded`         | `objective-aggregated-discarded`         |

  `src/domain/transition.ts:152` — `awaiting_approval` admits `running -> awaiting_approval` for an objective at `:154` — `objective`, and its note states "every task is terminal, and at least one task is `done`". `src/domain/transition.ts:176` — `discarded` admits `running -> discarded` for an objective at `:178` — `objective`, and its note states "every child is `discarded`". `src/domain/transition.ts:162` — `objective` and `:170` — `objective` both refuse a `running` objective reaching `done` or `partial`, with the note "an objective always passes the human gate". `worker.md:371` states the same three rules in prose. A mixture is `done` and `discarded`, because `aggregate` at `src/domain/aggregation.ts:17` — `aggregate` refuses a `partial` task, so `partial` always carries at least one `done` and the note's condition holds.

- **An all-`discarded` parent objective is terminal without a human, and this is the one exception to the close rule.** `worker.md:371` states an objective reaches a terminal state when a human closes it, and `src/domain/transition.ts:176` — `discarded` admits the transition anyway. The human ruling of 2026-09-03 settles it: every child `discarded` aggregates the parent to `discarded`. Nothing remains to approve, `src/commands/outcome/close-objective.ts:123` — `discarded` already refuses a `discarded` projection at the gate, and an objective that could reach neither the gate nor a terminal state would be unreachable state.

- **A terminal parent objective rolls the initiative up in the same transaction, and the aggregation is the only caller this epic adds.** `aggregateObjective` calls `aggregateInitiative` with the objective's `parentId` after it writes `discarded`, which is the ordering of `src/commands/outcome/close-objective.ts:157` — `aggregateInitiative`. It never calls it after `awaiting_approval`, because `awaiting_approval` is not in `src/domain/state.ts:20` — `terminalStates` and `aggregateInitiative` requires every objective terminal.

- **`parentObjectiveOutcome` is the one new rule, and no dispatcher over `stateOwner` joins it.** Two files already hold the other two rules: `taskReportEffect` at `src/domain/outcome-report.ts:27` — `TaskReportEffect` owns the task rule, and `objectiveOutcome` at `src/domain/outcome.ts:17` — `objectiveOutcome` owns the atomic-objective rule. A table over the `stateOwner` value of EPIC 047 would be a third expression of all three, and `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md:38` states of its own rule that "two expressions are the minimum; three would drift". The new function lives beside the two it joins, and `src/domain/outcome.ts` keeps its name.

- **`objectiveOutcome` loses its `discarded` branch, and this supersedes the shipped value.** `src/domain/outcome.ts:18` — `discarded` returns `discarded` for a `discarded` projection, which lets a worker report put an atomic objective in a terminal state directly. That branch is removed, so an atomic objective reaches `awaiting_approval` for every projection. `worker.md:371` states an atomic objective reaches `awaiting_approval` from its own accepted checkpoint. The projection is carried on the checkpoint and in the `node.awaitingApproval` payload, and the human reads it before closing. An atomic objective holds no child, so `src/domain/transition.ts:176` — `discarded`'s "every child is `discarded`" condition can never hold for it.

- **Two internal triggers join the table, named after their target state.** `src/domain/node-trigger.ts:8` — `internalTriggerIds` gains `objective-aggregated-awaiting-approval` with `levels: ["objective"]`, `from: "running"`, `to: "awaiting_approval"`, and `objective-aggregated-discarded` with `levels: ["objective"]`, `from: "running"`, `to: "discarded"`. The naming copies `src/domain/node-trigger.ts:21` — `initiative-aggregated-done`. Both are internal, because the daemon derives the transition from committed child state and no external report names it.

- **The event contract is settled here, and it reuses both shipped types.** A transition appends one event, in the report transaction, with `subjectKind: "node"`, `subjectId` the objective id, `actorKind: "daemon"` and `actorId` the `instanceId`, which is the shape of `src/commands/outcome/aggregate-initiative.ts:82` — `objectives-terminal`. The type is `node.awaitingApproval` for the first two rows and `node.discarded` for the third, and `src/domain/event-type.ts:7` — `node.awaitingApproval` and `:10` — `node.discarded` both exist, so no type joins the registry. One payload variant joins `src/http/contract/event-payload.ts`:

  ```ts
  const taskRollUpPayload = z.strictObject({
    from: nodeState,
    to: nodeState,
    reason: z.literal("tasks-terminal"),
    taskStates: z.array(terminalState),
    projection: terminalState,
  });
  ```

  `src/http/contract/event-payload.ts:106` — `node.awaitingApproval` becomes a union of its shipped `object-attested` object and this variant, and `:124` — `node.discarded` becomes a union of `rollUpPayload` and this variant. The shipped `node.awaitingApproval` object requires `objectId` and `objectiveRunId`, and a parent objective holds neither, so a union is the only shape that admits both writers. `reason` is `tasks-terminal`, which mirrors `objectives-terminal` at `src/http/contract/event-payload.ts:46` — `rollUpPayload` one level down.

- **The precedence of a human decision needs no column, because the state guard carries it.** `worker.md:367` states human input overrides aggregation and aggregation overrides attestation. `aggregateObjective` writes only from `running`, and `src/services/plan/index.ts:119` — `setNodeState` validates the declared `from` against the stored state. A closed objective is `done` or `partial`, an attested atomic objective is `awaiting_approval`, and neither is `running`, so no later aggregation can overwrite either. The precedence is therefore a property of the transition table plus one guard, and no function reads a provenance column to enforce it.

- **The walk is two deep at most on the report path, and the stop is by construction.** A task report aggregates its parent objective. That objective moves the initiative only when it reaches `discarded`, and an initiative has no parent. `worker.md:365` states a run never sets an initiative or a parent objective terminal state, and the `awaiting_approval` row satisfies it because `awaiting_approval` is not terminal. No ordered transition list and no generic ancestor walk exist.

- **The reported result names the state the transaction leaves behind, and ordering is what delivers it.** `.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md` draws `plan.readAllNodes` at step 13 and builds the `NodeReportResult` from it. The aggregation is inserted **before** that read, so the read is already post-transition and `objectiveState` names the state the settle leaves behind. **No re-read is added, and none may be**: `plan.readNode` is already step 3 of that diagram, `test/helpers/sequence-conformance.ts:50` — `projections` declares no entry for it, and `.agents/plan/stories/050.2-the-run-renew-release-and-report/02-the-authority-seams.md:164` — `plan.readNode` forbids adding one, so a second read draws a duplicate token that `test/helpers/sequence-conformance.ts:284` — `duplicate token in diagram` refuses. `objectiveProjection` keeps its aggregate value, because `docs/proposal/phase-2/gates-and-approval.md:74` — `projected` requires the projection beside the state for the human gate.

- **`aggregate` does not change, and neither refusal is reclassified.** `src/domain/aggregation.ts:17` — `aggregate` keeps `empty-parent` and `invalid-child-state`. Both are invariant failures raised by `AggregationError`, they are reachable from no legal request, and they map to no error code in `src/http/contract/errors.ts`. A `running` parent with no child and a `partial` task are each impossible by construction, and a thrown `AggregationError` is a defect report rather than a refusal a client reads.

## Stories

Each entry is a name and the output it contributes. The story file holds the change, the tasks and the diagrams, and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **The parent-objective outcome.** Add `parentObjectiveOutcome` to `src/domain/outcome.ts` with the three rows of the Decisions, and remove the `discarded` branch of `objectiveOutcome`. Insert `"053"` into `authoredEpics`. `story-foundation`.

2. **The triggers and the payload variant.** Add the two internal triggers to `src/domain/node-trigger.ts` with their levels and their declared transitions, and add `taskRollUpPayload` to the `node.awaitingApproval` and `node.discarded` unions in `src/http/contract/event-payload.ts`. `story-foundation`.

3. **The aggregation declines a null objective id.** Add `src/commands/outcome/aggregate-objective.ts` and draw `aggregate-objective-null-id`, a diagram with **no step**. Its prior set is empty. `story-implement`.

4. **The aggregation declines a parent that is not running.** Draws `aggregate-objective-not-running`, whose only step is `plan.readNode`. Its prior set is empty. `story-implement`.

5. **The aggregation declines while a task is not terminal.** Draws `aggregate-objective-not-terminal`, adding `plan.readAllNodes` and reaching no write. Its prior set is empty. `story-implement`.

6. **The aggregation reaches the human gate.** Draws `aggregate-objective-awaiting-approval`: `plan.readNode`, `plan.readAllNodes`, `plan.setNodeState` and `events.append`, and no roll-up. Its prior set is empty. `story-implement`.

7. **The aggregation discards and rolls the initiative up.** Draws `aggregate-objective-discarded`, adding `initiative.aggregate` as the one step after the event. Its prior set is empty. `story-implement`.

8. **The accepted settle aggregates the parent.** Draws `land-settle-aggregate`, superseding EPIC 051.3 Story 4 (`04-the-accepted-settle`) `land-settle-accepted`, and adding `objective.aggregate` as one step **before** `plan.readAllNodes`. It adds the `main.ts` binding, deletes `test/sequence/scenarios/land-settle-accepted.ts` and appends `"053"` to `shippedEpics` in the same turn. `story-implement`.

9. **The proposal records state ownership.** Add `docs/proposal/phase-2/node-state-ownership.md` stating the state owner per pair, the three parent-objective rows with the transition-table evidence, the all-`discarded` exception, the aggregation rules, the terminal-state tuple, the two-deep roll-up and its stop condition, the precedence carried by the state guard, and the event contract. Add its row to `docs/proposal/phase-2/README.md`. It is last in dispatch order and edits no range. `story-foundation`.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 051.3 Story 4 (`04-the-accepted-settle`)** — its `` ### `land-settle-accepted` `` section gains one `Superseded by: EPIC 053 land-settle-aggregate` line. The line must land after Story 1 has put `"053"` in `authoredEpics`, or `scripts/verify-epic-sequence.ts:530` — `outside the authored set` refuses the supersession. The ``Add `test/sequence/scenarios/land-settle-accepted.ts`.`` line of that story stays: deleting it would leave EPIC 051.3 owning a live diagram with no scenario. The scenario-file deletion belongs to Story 8, because `test/sequence/scenarios/` is in the test-engineer lane. **The default if no ruling arrives: `land-settle-accepted` stays live with no scenario file**, and `test/sequence/conformance.test.ts` reports it as unsuperseded.

- **EPIC 051.6 Story 3 (`03-the-report-reaps-on-every-settled-terminal`)** — no amendment. An earlier draft of this epic asked it for a `Superseded by:` line naming a `report-checkpoint-aggregate` diagram. This epic changes no step of `report-checkpoint-reap`, so that ask is withdrawn and the diagram stays live and unsuperseded.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/outcome.test.ts \
  src/domain/aggregation.test.ts \
  src/domain/node-trigger.test.ts \
  src/commands/outcome/aggregate-objective.test.ts \
  src/commands/outcome/aggregate-initiative.test.ts \
  src/commands/checkpoint/land-execution.test.ts \
  src/domain/external-transition.test.ts \
  src/http/contract/event-payload.test.ts \
  src/main.test.ts \
  test/sequence/conformance.test.ts \
  && echo "PASS EPIC-053"
```

Hermetic coverage required beyond the Proof. **Every row names exactly one proof owner.**

| #   | assertion                                                                                                                                                                                                                                                                                                             | story |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `parentObjectiveOutcome` is asserted for all three `terminalStates` values by iterating the tuple, so a fourth terminal state fails the test. Each result is asserted by value, state and trigger together.                                                                                                           | 1     |
| 2   | `objectiveOutcome` returns `awaiting_approval` for every `terminalStates` value, iterated from the tuple. The `discarded` case is the one that supersedes the shipped branch, and it is asserted by value.                                                                                                            | 1     |
| 3   | `aggregate` still throws `empty-parent` for a childless parent and `invalid-child-state` for a `partial` task, each asserted by error code, and `src/http/contract/errors.ts` holds no code for either. The negative is controlled by asserting one shipped code of that file is found by the same lookup.            | 1     |
| 4   | Each new trigger resolves through `triggerTransition` to its declared `levels`, `from` and `to`, asserted by value; and each is refused for a `task` and for an `initiative`, so the level restriction is proven in both directions.                                                                                  | 2     |
| 5   | The shipped `object-attested` payload still parses against `node.awaitingApproval`, and a `tasks-terminal` payload parses against `node.awaitingApproval` and against `node.discarded`. A `tasks-terminal` payload carrying `objectId` is refused, which is the control that the union stays strict.                  | 2     |
| 6   | `aggregateObjective` returns and reaches **no seam at all** for a null `objectiveId`, asserted by an ordered recorder holding zero tokens. Row 6a is the control that the recorder observes a call when one is made.                                                                                                  | 3     |
| 6a  | `aggregateObjective` returns and reaches `plan.readNode` and nothing beyond it for an absent node, and for a node in each `nodeStates` value other than `running`, iterated from the tuple. The `running` case of row 8 is the control that the assertion detects a reached write.                                    | 4     |
| 7   | `aggregateObjective` over a parent whose three tasks hold one `running` child writes nothing and appends no event, asserted by `databaseBytes` byte-identical before and after. Row 8 is the control.                                                                                                                 | 5     |
| 8   | A parent objective whose three tasks are all `done` reaches `awaiting_approval` with the trigger `objective-aggregated-awaiting-approval`, appends exactly one `node.awaitingApproval` event whose payload deep-equals the `tasks-terminal` value with `taskStates` in ULID order and `projection` of `done`.         | 6     |
| 9   | A parent objective whose tasks are two `done` and one `discarded` reaches `awaiting_approval` with `projection` of `partial`, and `aggregateInitiative` is reached zero times. Row 10 is the control for the zero call count.                                                                                         | 6     |
| 10  | A parent objective whose three tasks are all `discarded` reaches `discarded` with the trigger `objective-aggregated-discarded`, appends exactly one `node.discarded` event with `projection` of `discarded`, and reaches `aggregateInitiative` exactly once with the objective's `parentId` asserted by value.        | 7     |
| 11  | A `running` parent objective holding no task throws, asserted by message, which is the shipped behaviour of `aggregate-initiative.ts` at one level down.                                                                                                                                                              | 7     |
| 12  | An initiative holding one objective whose three tasks all end `discarded` reaches `discarded` through the two-deep roll-up in one settle transaction, asserted by both node rows and by exactly three events — the task's `outcome.reported`, the objective's `node.discarded` and the initiative's `node.discarded`. | 8     |
| 13  | The same fixture with all three tasks `done` leaves the initiative state unchanged, asserted by value, with exactly two events. `awaiting_approval` is not terminal, so the roll-up stops.                                                                                                                            | 8     |
| 14  | A task report whose parent objective is already `done` leaves that objective `done` and appends no objective event, asserted after a close-shaped fixture writes `awaiting_approval` then `done`. This is the precedence with no column, and row 8 is the control.                                                    | 8     |
| 15  | A failure injected at the objective's `events.append` leaves the task state, the objective state and every event absent, proving the settle and the aggregation are one transaction.                                                                                                                                  | 8     |
| 16  | `objectiveState` of the returned `NodeReportResult` equals `awaiting_approval` on the last `done` task and `discarded` on the last `discarded` task, over the real route through the daemon `src/main.ts` builds, and `objectiveProjection` equals the aggregate value in both. The route proves the binding.         | 8     |
| 17  | The conformance runner replays all six diagrams of this epic by equality, and the comparison fails when `objective.aggregate` is removed from `landSettle`'s accepted arm and again when it is moved after `plan.readAllNodes`.                                                                                       | 8     |
| 18  | `land-settle-accepted` carries `Superseded by:` naming `land-settle-aggregate`, that diagram carries the matching `Supersedes:`, and no scenario file remains for the superseded id. A scenario file restored for it fails the assertion, which is the control.                                                       | 8     |
