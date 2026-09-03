# EPIC 056 — The worker switch

Status: **draft**. It follows EPIC 055.1 by sequence order, and it runs before EPIC 056.1. It consumes `end-attempt` and the `operator-handoff` termination of the **EPIC 054 split family**, EPIC 055.1's per-operation caller admission, and EPIC 048's worker registry.

This epic and EPIC 056.1 replace the single EPIC 056 authored before `.agents/plan/authoring.md`. That document held twelve story entries, declared no story kind, and carried its verification gate as a bullet list; the standard refuses all three. EPIC 056.1 carries a decimal number because EPIC 057 is authored and numbered, and renumbering it would break every cross-reference to it.

**One consumed predecessor is not authorable today, and it must split before this epic dispatches.** `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:5` — `authoring.md` states of itself that it holds thirteen story entries, declares no story kind and carries its coverage as a bullet list, and that "`/author` cannot run on this file until that split lands". This epic therefore names the EPIC 054 family rather than that file, and the `## Amendments` section carries what the family must settle. The EPIC 055 range needs no such note: it split into EPIC 055 and `.agents/plan/epics/055.1-the-grant-governs-the-run.md:1` — `EPIC 055.1`, and both satisfy the standard.

**Citation convention.** `worker.md` is `docs/workflow/worker.md` of the superproject, one level above this repository. Every epic in the tree cites it by bare file name, and this epic keeps that convention.

**Dispatch prerequisite.** Story 1 inserts `"056"` into `scripts/epic-sequence-range.ts:1` — `authoredEpics` after the `"055.1"` entry that epic adds, and Story 7 appends it to `shippedEpics`, which `test/sequence/conformance.test.ts:254` — `shippedEpics` requires to stay a prefix of `authoredEpics`. Story 7 is therefore last in dispatch order.

## Goal

A human is the only actor that changes an existing assignment:

- a switch is one operation that ends the active run as an operator handoff, raises the fence and writes the new assignment;
- a switch is legal with an active run and without one, and the response says which happened;
- a switch keeps the node, its state and every accepted checkpoint, byte for byte, per `worker.md:449`;
- a switch consumes no attempt, and it clears the ambiguous budget of the worker it replaces, per `worker.md:469`;
- `node.switch` admits a human actor and refuses every other caller kind.

## Non-goals

- **No automatic switch.** No timeout, no attempt limit and no unroutable result triggers one. `worker.md:292` states only a human switches a worker.
- **No workspace discard, and no startup cleanup for one.** `worker.md:292` places the discard after the transaction commits, and this range has nothing to discard: `.agents/plan/epics/051-the-workspace-branch.md:26` — `Workspace` and `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:22` — `disposal` both state that no epic through this one creates an attempt workspace, and `src/services/` holds no service that could remove one. Both epics rule that **the epic that creates an attempt workspace owns its disposal**, and this epic repeats that ruling rather than writing a remover for a directory nothing creates. `worker.md:292` supplies the safety argument itself: "The raised fence is what makes the discard safe: a late write from the old worker fails whether the discard has run or not, and an orphaned attempt directory costs nothing because the attempt workspace is not durable evidence."
- **No candidate-ref deletion.** The switch ends an attempt, and an ended attempt may leave a candidate ref. The `## Amendments` section asks the EPIC 054 family to settle the owner, and this epic writes no git deletion.
- **No repair of `sweep-remnants`.** `AGENTS.md:106` records that `src/commands/startup/sweep-remnants.ts` opens two transactions around filesystem I/O with no journal row, and assigns the repair to the next epic that touches startup recovery. This epic touches no startup file, so it takes neither the repair nor the obligation. No gate row asserts the absence, because a source scan proves a non-goal rather than a decision.
- **No close.** EPIC 056.1 owns the human close, its evidence reference and the `node.claim` and `node.report` actor narrowing.
- **No run adoption, and no grant minting.** `worker.md:294` states a new external worker needs its own grant and adopts no run. The switch mints none.
- **No first assignment.** The daemon writes an assignment at the first claim on an unassigned node, per EPIC 050. `.agents/plan/epics/050.1-the-claim.md:65` states that ending a run never clears `node.assignment` and that "EPIC 056 adds the only writer that changes it". This epic owns the change of an existing one.
- **No unblock replacement.** `node.unblock` at `src/commands/node/unblock-node.ts` stays as it is.
- **No provenance columns.** `node.closed_at` and `node.closed_actor` are not built by any epic. The next decision states why the switch needs neither.

## Decisions

- **A switch is one operation, `node.switch`, at `POST /node/{node}/switch`.** `worker.md:292` states "A switch is one operation", and a human performing its effects as separate calls would leave a node assigned to a worker whose run is still active. The request is `{ runId?, fence?, worker }` — `worker` is the new worker id, and the optional pair guards against a switch aimed at a run that already ended. The response is `{ nodeId, assignment, runEnded, runId, fence }`, where `runId` and `fence` name the run the switch ended and are both null when it ended none.

- **`actionSegments` gains `"switch"`, and that is a contract edit this epic owns.** `src/http/contract/path.ts:40` — `actionSegments` is a closed set holding no `switch`, and `AGENTS.md` requires every path segment to come from such a set. The value is added there, in the set's alphabetical position between `rotate` and `unblock`, so the operation declares `action("switch")` and no free-form segment reaches a path.

- **The transactional effects are four, and every one of them is a seam call this epic adds no method for.** `worker.md:292` names three — "It ends the active run as an operator handoff, raises the fence and writes the new assignment, in one transaction" — and `worker.md:469` adds the fourth, "A human switch clears the counter". They map onto shipped seams:

  | effect                                                                      | seam                                                         |
  | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
  | the attempt carries `operator-handoff`                                      | `end-attempt` of the EPIC 054 family, one nested step        |
  | the run ends, and its fence rises                                           | `execution.endRun` at `src/services/execution/index.ts:108`  |
  | the new assignment is written, and `node.ambiguous_used` is cleared with it | `plan.setNodeAssignment` at `src/services/plan/index.ts:123` |
  | the handoff is recorded                                                     | `events.append`                                              |

  **No `execution.raiseFence` exists and none is added.** `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md:32` rules that "The run owns the fence... The daemon raises the fence when it ends a run, and nowhere else", and `.agents/plan/epics/050.1-the-claim.md:79` shows the raise folded into the end as one conditional `UPDATE run SET state = 'ended', fence = fence + 1`. The fence raise is therefore an effect of `execution.endRun` and never a step of its own, and a diagram that draws it separately draws a call the recorder never sees.

  **The counter clear joins `plan.setNodeAssignment` rather than taking a seam of its own.** `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:69` rules that the counter "resets when the assignment changes, and at nothing else". Folding the reset into the one writer of `node.assignment` makes that rule true by construction, and `SetNodeAssignmentInput` at `src/services/plan/index.ts:65` gains no field: the reset is unconditional, because a first assignment on an unassigned node clears a counter that is already null.

  It opens no run and mints no grant, so "admits a new claim from the accepted branch head" is the state the transaction leaves behind, never a write it performs. `worker.md:294` states exactly that postcondition.

- **A switch is legal for an assigned, non-terminal node, with or without an active run.** `worker.md:292` describes the switch against an active run, and a node whose run ended on an accepted report still holds an assignment a human may want to change. `switchVerdict` refuses:

  | refusal                 | condition                                                                                         |
  | ----------------------- | ------------------------------------------------------------------------------------------------- |
  | `switch-unassigned`     | `node.assignment` is null. There is nothing to change, and a first assignment is the claim's job. |
  | `switch-node-terminal`  | The node state is `done`, `partial` or `discarded`.                                               |
  | `switch-unchanged`      | The new worker equals the current assignment. Four destructive effects for no change.             |
  | `switch-worker-unknown` | The registry holds no entry for the new worker id.                                                |
  | `switch-incapable`      | The registry knows the worker, and it is not `capable` for the node's `(kind, deliverable)` pair. |
  | `fence-stale`           | The request named a `runId` and `fence` that are not those of the node's active run.              |

  With no active run the transaction performs the assignment write and the event, and skips the run end and the termination write. `runEnded` in the response says which happened.

- **With no active run the switch raises no fence, and it needs none.** The fence lives on the run row (`RunRecord.fence` at `src/services/execution/index.ts:15`) and rises only when a run ends, per the ruling above. A node with no active run has no fence to raise, and the previous run's fence already rose when that run ended, so a late write from the replaced worker already fails on it. The response and the `node.switched` payload therefore carry `runId` and `fence` as nullable values naming the run the switch ended, and no path reads `execution.latestRunOfNode`.

- **The optional request pair is all-or-nothing, and a supplied pair demands an active run.** A request carrying `runId` without `fence`, or `fence` without `runId`, refuses the shipped `invalid-request` at the schema. A request carrying both refuses `fence-stale` when the node holds no active run or holds one the pair does not name, because the pair asserts a run the human believed was current. A request carrying neither proceeds on either shape. Without the all-or-nothing rule a half-supplied pair would silently skip the guard the pair exists to apply.

- **There is no `switch-node-closed` refusal, and no column records a close.** A closed objective holds one of the three values of `src/domain/state.ts:20` — `terminalStates`, so `switch-node-terminal` already refuses it, and a second refusal over a provenance column would be a second expression of one rule. The close's provenance is in the event log: `src/services/storage/migration-0005-actor.ts:23` — `actor_kind` and `:24` — `actor_id` are `NOT NULL` on every event row, and the event id is a ULID minted by `src/services/ids/ulid.ts:11` — `mintUlid`, whose leading bits carry the mint millisecond. Nothing in the product decides on that time, so no hermetic reader of it is required.

- **The refusal order is fixed:** `actor-forbidden`, `invalid-request`, `node-not-found`, `switch-unassigned`, `switch-node-terminal`, `switch-unchanged`, `switch-worker-unknown`, `switch-incapable`, `fence-stale`. The first is decided by the authorization middleware and the second by the request schema, both before the command runs; the next six stop after the node read; and the last stops after the run read. `switch-worker-unknown` precedes `switch-incapable` because a capability verdict over an absent registry entry states a capability the registry never claimed.

- **`switch-worker-unknown` and `switch-incapable` are two refusals, because a client acts differently on each.** An unknown id is a typo or a decommissioned worker, and the human retypes it. A known incapable worker is a routing mistake, and the human picks another worker. `capableWorkers` folds both into an empty result, so a single refusal would name neither condition.

- **Neither registry refusal reaches a seam of its own.** `registry` is injected data, not a capability: `src/commands/node/claim-node.ts:97` — `registry` declares it as `readonly WorkerEntry[]`, and the lookup and `capableWorkers` are pure calls over it. No diagram in the tree carries a `Registry` participant, including the claim's own. Both registry refusals therefore stop where the other node-read refusals stop, and they are drawn in the same diagram.

- **An operator handoff is `infrastructure`, so a switch consumes no attempt.** `worker.md:458` names "Operator handoff" as an `infrastructure` source in the table whose `No` column means it costs no attempt, and the EPIC 054 family's evidence union holds `operator-handoff`. The switch calls `end-attempt` rather than writing a class itself, and that nested command is one step of the drawn path.

- **`end-attempt` takes this command's transaction, and EPIC 054 declares it so.** `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:75` — `endAttempt` rules that `end-attempt` takes the caller's transaction and opens none, and that its diagrams hold no `storage.transact` step. A command that opens a transaction and calls a nested command that opens a second would contradict `AGENTS.md`, which admits a second transaction only for a journaled write, and this switch opens no journal row. The shipped idiom for a nested command is `src/commands/outcome/close-objective.ts:55-59`, which takes `(dependencies, transaction, input)`. This epic proceeds on that shape, and the `## Amendments` section carries the ask.

- **A switch validates the new worker against the registry, not against any caller's authorization.** A human may switch to a worker no current grant authorizes; minting that grant is the next step, per `worker.md:294`. Validating against a grant would make the switch depend on a credential the human has not created yet.

- **The operation is human-only by registry data, and it refuses with `actor-forbidden`.** `node.switch` declares `allowedActors: ["human"]`, and `src/http/server/authorize.ts:11` — `allowedActors` already refuses every other kind with `actor-forbidden`. `worker.md:494` states "A human holds `close`, an override, worker selection and the authorization of a worker switch. A human never claims and never reports." A bespoke `human-only-operation` code was drafted; it names no condition a client acts on differently, and `AGENTS.md` requires route lifecycle to be registry data rather than a branch in a handler. The narrowing of `node.claim` and `node.report` needs `node.switch` to exist first, so EPIC 056.1 owns it.

- **A grant caller is a third admissible kind, and `["human"]` refuses it by the same registry data.** `src/domain/actor.ts:6` — `registeredActorKinds` holds exactly `human` and `harness`, and `src/http/server/variables.ts:11` — `actor` types the middleware variable as an `ActorRow`. `.agents/plan/epics/055.1-the-grant-governs-the-run.md:53` — `allowedActors` settles the axis: `grant` is a value of `allowedActors`, added to `node.claim`, `node.report` and `node.renew` and to nothing else, and `.agents/plan/epics/055.1-the-grant-governs-the-run.md:51` — `allowedActors` states that `src/http/server/authorize.ts:11` — `allowedActors` "refuses a grant caller on every operation those handlers serve". `node.switch` declares `["human"]`, so a grant caller is refused `actor-forbidden` on it with no ruling left open and no bespoke code. **There is no `daemon` actor kind**: `src/services/storage/migration-0005-actor.ts:23` — `actor_kind` admits `daemon` on an event row the daemon itself writes, and `registeredActorKinds` admits no such actor, so no test can present one to the middleware.

- **A switch preserves every accepted checkpoint identically, and the assertion compares rows, not counts.** `worker.md:449` states "A worker switch keeps the node, its state and every accepted checkpoint." A count is equal after a delete and a re-insert. The test snapshots the full `checkpoint` rows for the node's subtree before and after and compares them by deep equality, including `id`, `attempt_id`, `caller`, `subject`, `fence` and every evidence column.

- **One event joins the registry.** `node.switched` carries `{ nodeId, from, to, runId, fence }`, with `runId` and `fence` nullable per the no-run ruling, registered in `src/domain/event-type.ts:40` — `run.opened`'s tuple and in `src/http/contract/event-payload.ts`. `from` and `to` are the assignment values, not node states, and the payload names them so a reader sees the handoff without joining the node row.

- **A refusal path of a command written from nothing is drawn, and the guard rule does not reach it.** `authoring.md` rules that "A story that inserts a refusal draws the path that still succeeds", which governs a guard inserted into a path an earlier epic drew. `switchWorker` is new, so every one of its paths is written from nothing, its prior set is empty, and its two refusal paths reach seam sets no success path reaches. Stories 3 and 4 therefore draw them, and Stories 5 and 6 draw the two success paths beside them.

## Stories

Each entry is a name and the output it contributes. The story file holds the change, the tasks and the diagrams, and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **The switch legality.** Add `src/domain/worker-switch.ts` with `switchVerdict` returning `null` or one of the six refusals of the Decisions table, in the fixed order. Insert `"056"` into `authoredEpics`. `story-foundation`.

2. **The switch contract.** Add `"switch"` to `src/http/contract/path.ts:40` — `actionSegments`, add the `node.switch` operation with its path tuple, request and response schemas, the all-or-nothing refine on the `runId` and `fence` pair, `allowedActors: ["human"]` and its `errors` record, add the five new refusal codes to `src/http/contract/errors.ts:7` — `errorStatuses` and to `src/cli/exit-code.ts`, register `node.switched` and its payload with the two nullable fields, and regenerate `src/http/contract/field-decisions.fixture.ts`. `story-foundation`.

3. **An unswitchable node refuses after the node read.** Add `src/commands/node/switch-worker.ts` and draw `switch-refusal-node`: `storage.transact`, `clock.now`, `plan.readNode`, and the refusal. The five refusals `switch-unassigned`, `switch-node-terminal`, `switch-unchanged`, `switch-worker-unknown` and `switch-incapable` stop at the same step, so they are one diagram. Its prior set is empty. `story-implement`.

4. **A stale fence refuses after the run read.** Draws `switch-refusal-fence-stale`, adding `execution.activeRunOfNode`. Its prior set is empty. `story-implement`.

5. **The switch of a node with an active run.** Draws `switch-success-active-run`: `storage.transact`, `clock.now`, `plan.readNode`, `execution.activeRunOfNode`, `end-attempt`, `execution.endRun`, `plan.setNodeAssignment` and `events.append`. Adds the handler at `src/http/server/node/switch-node.ts` and the `src/main.ts` binding. Its prior set is empty. `story-implement`.

6. **The switch of a node with no active run.** Draws `switch-success-no-run`, which is the same path without `end-attempt` and without `execution.endRun`. Its prior set is empty, and the two missing tokens are what prove `runEnded` is not a formatting choice. `story-implement`.

7. **The proposal records the switch.** Add `docs/proposal/phase-2/human-controls.md` stating the switch and its four transactional effects plus the postcondition, the seam each effect maps onto and that no fence-raise seam exists, the switch legality table and its refusal order, the all-or-nothing request pair, that a switch with no active run raises no fence and why it needs none, that a switch consumes no attempt and preserves every checkpoint, that a new external worker needs its own grant, that the attempt-workspace discard and the candidate-ref deletion belong to the epics that own them, and that the operation is human-only by registry data. Append `"056"` to `shippedEpics`. It is last in dispatch order. `story-foundation`.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **The EPIC 054 split family, its closure-table story** — `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:100` — `who discards the candidate ref` enumerates every path that calls `end-attempt`, in a table whose third column is "who discards the candidate ref", and `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:172` — `Add one case per row` adds one case per row. The switch is a further caller and appears in no row. The family must add a switch row. `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:108` — `candidate.sweep` gives the three comparable rows the value "nobody until startup — `candidate.sweep`", and `.agents/plan/epics/051.6-the-post-expiry-reap-on-the-run-operations.md:22` — `candidate.sweep` writes that reap's eligibility proof for the expiry list alone, so extending it to the switch needs its own ruling rather than an assumed one. **The default if no ruling arrives: no path owns the candidate ref a switch orphans**, and no startup step is proven to reap it.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/worker-switch.test.ts \
  src/commands/node/switch-worker.test.ts \
  src/commands/node/claim-node.test.ts \
  src/http/contract/path.test.ts \
  src/http/contract/errors.test.ts \
  src/http/server/authorize.test.ts \
  src/main.test.ts \
  test/sequence/conformance.test.ts \
  && echo "PASS EPIC-056"
```

Hermetic coverage required beyond the Proof. **Every row names exactly one proof owner.**

| #   | assertion                                                                                                                                                                                                                                                                                                                                                                     | story |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `switchVerdict` returns each of the six refusals for its own condition and `null` for both legal shapes, with and without an active run. Eight cases, each asserted by value.                                                                                                                                                                                                 | 1     |
| 2   | `switchVerdict` refuses `switch-node-terminal` for each of the three `terminalStates` values, iterated from the tuple, so a fourth terminal state fails the test. No case names a closed node, because no column records a close.                                                                                                                                             | 1     |
| 3   | Every pair of refusal conditions that can hold at once reports the earlier one of the fixed order, enumerated and not sampled. `switch-unassigned` before `switch-node-terminal` proves an unassigned terminal node reports the assignment first, and `switch-worker-unknown` before `switch-incapable` proves no capability verdict is stated over an absent registry entry. | 1     |
| 4   | `"switch"` is in `actionSegments` and the rendered path of `node.switch` equals `/node/{node}/switch` by value. A path built from a free-form segment fails to type-check, which the story states as the build check.                                                                                                                                                         | 2     |
| 5   | `node.switch` declares `allowedActors` of `["human"]`, asserted by value.                                                                                                                                                                                                                                                                                                     | 2     |
| 6   | A harness actor and an authenticated grant caller each refuse `node.switch` with `actor-forbidden` over the real route, and a human actor passes. Three cases, which is every kind `allowedActors` admits anywhere, proven in both directions with no bespoke code. No case presents a `daemon` actor, because `src/domain/actor.ts:6` — `registeredActorKinds` admits none.  | 2     |
| 7   | Each of the five new refusal codes is present in `src/http/contract/errors.ts:7` — `errorStatuses` with status `409` and in `src/cli/exit-code.ts` with a distinct exit code, asserted by iterating the names. A code absent from either file fails, which is the control. `fence-stale` is asserted present and is not counted as new, because EPIC 050.2 adds it.           | 2     |
| 8   | A request carrying `runId` and no `fence`, and one carrying `fence` and no `runId`, each refuse `invalid-request` at the schema and reach the command zero times. A request carrying both and one carrying neither each parse, which is the control.                                                                                                                          | 2     |
| 9   | A switch on an unassigned node refuses `switch-unassigned`, on a terminal node refuses `switch-node-terminal`, on the same worker refuses `switch-unchanged`, on a worker id the registry omits refuses `switch-worker-unknown`, and on a known incapable worker refuses `switch-incapable`. Five cases, each leaving `databaseBytes` byte-identical.                         | 3     |
| 10  | The five node-read refusals reach `execution.activeRunOfNode` zero times. Row 11 is the control that the call count detects a reached read.                                                                                                                                                                                                                                   | 3     |
| 11  | A switch naming a `runId` and `fence` that are not those of the active run refuses `fence-stale`, and one naming a pair on a node with no active run refuses the same, each reaching `end-attempt` zero times and leaving `databaseBytes` byte-identical. Two cases, so the pair guard covers both shapes.                                                                    | 4     |
| 12  | A switch with an active run writes the assignment, calls `end-attempt` once with `operator-handoff`, clears `node.ambiguous_used` in the same `plan.setNodeAssignment` call, ends the run, raises its fence by exactly one, and appends exactly one `node.switched` event whose payload deep-equals the stated value with `runId` and `fence` set.                            | 5     |
| 13  | A failure injected at the `node.switched` append leaves the assignment, the run state, the run fence, `node.ambiguous_used`, `attempt.termination` and the attempt event of `end-attempt` all unchanged, proving every effect of the switch and of its nested command is one transaction.                                                                                     | 5     |
| 14  | A switch resolves over the real route through the daemon `src/main.ts` builds, returning `runEnded` of `true`, which proves the handler and the binding.                                                                                                                                                                                                                      | 5     |
| 15  | The full `checkpoint` row set for the node's subtree is deep-equal before and after a switch, and the node state and `workspace.head_oid` are each unchanged by value. A row count alone is not sufficient, because it survives a delete and a re-insert.                                                                                                                     | 5     |
| 16  | A claim after a switch by the new worker, an internal worker claimed by a harness actor so the fixture mints no grant, opens a run whose `run_base` row for the node's repository carries a `base_oid` equal to `workspace.head_oid`, joined on the full key `(run_id, repository_id)`. A claim by the old worker refuses `assignment-held`. Both directions.                 | 5     |
| 17  | A switch with no active run writes the assignment, appends the event with `runId` and `fence` null, returns `runEnded` of `false`, and calls `end-attempt` and `execution.endRun` zero times each. No run fence anywhere changes, which is what proves the no-fence ruling. Row 12 is the control for both zero counts.                                                       | 6     |
| 18  | `node.assignment` is unchanged after a run expiry, an attempt-limit exhaustion, a release and an unroutable claim on another node. Four cases, so no failure path performs a switch.                                                                                                                                                                                          | 6     |
| 19  | The conformance runner replays all four diagrams of this epic by equality, and the comparison fails when `end-attempt` is removed from `switch-success-active-run`.                                                                                                                                                                                                           | 7     |
