# EPIC 056 — The worker switch and human controls

Status: **draft**. It follows EPIC 055 by sequence order.

## Goal

A human is the only actor that changes an existing assignment or ends an objective:

- a switch is one operation that ends the active run as an operator handoff, raises the fence, writes the new assignment and discards the attempt workspace;
- a switch keeps the node, its state and every accepted checkpoint, byte for byte;
- a human closes an objective against the evidence it names, and a stale reference is refused;
- `node.switch` and `node.close` refuse a grant caller, and `node.claim` and `node.report` refuse a human caller.

## Non-goals

- **No automatic switch.** No timeout, no attempt limit and no unroutable result triggers one. `worker.md` section 4 states only a human switches a worker.
- **No run adoption, and no grant minting.** A new external worker needs its own grant, and the switch mints none.
- **No first assignment.** The daemon writes an assignment at the first claim on an unassigned node, per EPIC 050. This epic owns the change of an existing one.
- **No approval evidence bundle.** `node.approvalEvidence` stays `stubbed`. EPIC 112 owns the bundle a human reads; this epic owns the reference the close carries.
- **No publish.** A close moves the node state. Remote origin is EPIC 113.
- **No unblock replacement.** `node.unblock` at `src/commands/node/unblock-node.ts` stays as it is.

## Decisions

- **A switch is one operation, `node.switch`, at `POST /node/{nodeId}/switch`.** `worker.md` section 4 lists five effects, and a human performing them as five calls would leave a node assigned to a worker whose run is still active. The request is `{ runId?, fence?, worker }` — `worker` is the new worker id, and the optional pair guards against a switch aimed at a run that already ended. The response is `{ nodeId, assignment, fence, runEnded }`.

- **The transactional effects are four, and admitting a new claim is a postcondition.** `worker.md` section 4 now states both halves. The transaction ends the active run, raises the fence, writes `node.assignment`, clears `node.ambiguous_used` of EPIC 054, writes the `attempt.termination` of `operator-handoff`, and appends the `node.switched` event. It opens no run and mints no grant, so "admits a new claim from the accepted branch head" is the state the transaction leaves behind, never a write it performs.

- **The workspace discard happens after the transaction commits, and a crash leaves an orphan directory that startup removes.** `worker.md` section 4 now states the ordering and its reason. A file system removal cannot join a SQLite transaction. Raising the fence inside the committed transaction is what makes the discard safe: a late write from the old worker fails on the fence whether the discard has run or not. `worker.md` section 8 states the attempt workspace is not durable evidence, so an orphan directory costs nothing, and `src/commands/startup/` removes any attempt directory whose run is ended.

- **A switch is legal for an assigned, non-terminal node, with or without an active run.** `worker.md` section 4 describes the switch against an active run, and a node whose run ended on an accepted report still holds an assignment a human may want to change. `switchVerdict` refuses:

  | refusal                | condition                                                                                         |
  | ---------------------- | ------------------------------------------------------------------------------------------------- |
  | `switch-unassigned`    | `node.assignment` is null. There is nothing to change, and a first assignment is the claim's job. |
  | `switch-unchanged`     | The new worker equals the current assignment. Five destructive effects for no change.             |
  | `switch-incapable`     | The new worker is not `capable` for the node's `(kind, deliverable)` pair.                        |
  | `switch-node-terminal` | The node state is `done`, `partial` or `discarded`.                                               |
  | `switch-node-closed`   | `node.closed_at` of EPIC 053 is not null.                                                         |
  | `fence-stale`          | The request named a `runId` and `fence` that are not the current ones.                            |

  With no active run the transaction performs the assignment write, the fence raise and the event, and skips the run end and the termination write. `runEnded` in the response says which happened.

- **The refusal order is fixed:** `human-only-operation`, `node-not-found`, `switch-unassigned`, `switch-node-closed`, `switch-node-terminal`, `switch-unchanged`, `switch-incapable`, `fence-stale`.

- **An operator handoff is `infrastructure`, so a switch consumes no attempt.** `worker.md` section 9 names it as an infrastructure source, and EPIC 054's evidence union holds `operator-handoff`. The switch calls `end-attempt` of EPIC 054 rather than writing a class itself.

- **A switch validates the new worker against the registry, not against any caller's authorization.** A human may switch to a worker no current grant authorizes; minting that grant is the next step. Validating against a grant would make the switch depend on a credential the human has not created yet.

- **A switch preserves every accepted checkpoint identically, and the assertion compares rows, not counts.** A count is equal after a delete and a re-insert. The test snapshots the full `checkpoint` rows for the node's subtree before and after and compares them by deep equality, including `id`, `attempt_id`, `caller`, `subject`, `fence` and every evidence column.

- **A close names the evidence it approves, and a moved evidence is refused.** `worker.md` section 10 states the human closes the objective against the accepted checkpoint. `node.close` carries `{ outcome, checkpointId?, revision? }`. An atomic objective supplies `checkpointId`, and the close refuses `checkpoint-stale` when that checkpoint is not the objective's latest accepted one. A parent objective holds no attestation of its own, per `worker.md` section 6, so it supplies `revision`, the project's `plan_revision` id the human read, and the close refuses `graph-moved` when the project has moved on. Without a reference, a close approves whatever landed after the human looked.

- **`outcome` is a terminal state, and the closed set is `done`, `partial` and `discarded`.** `src/domain/state.ts:23` already fixes the tuple. A close carrying `awaiting_approval` refuses `outcome-not-terminal`.

- **A close writes `closed_at` and `closed_actor`, so the precedence of EPIC 053 has its provenance.** The close then calls `ancestorRecomputation` from the closed objective inside the same transaction, which is the resumption EPIC 053 described.

- **The close refusals and their order:** `human-only-operation`, `node-not-found`, `not-an-objective`, `not-awaiting-approval`, `outcome-not-terminal`, `checkpoint-stale` or `graph-moved`.

- **A human never claims and never reports, and a client never switches and never closes.** `worker.md` section 10 states both halves: a human holds `close`, an override, worker selection and the authorization of a switch, and never claims or reports; an external client's grant admits `claim`, `report` and `renew` and nothing else. The middleware refuses a human caller on `node.claim` and `node.report` with `human-cannot-claim` and `human-cannot-report`, and a grant caller on `node.switch` and `node.close` with `human-only-operation`. All four directions are tested.

- **The human verb set is close, unblock, discard and switch, and this epic adds no fifth.** `node.unblock` and `node.discard` are the override, and both are already routed.

- **Two events join the registry.** `node.switched` carries `{ nodeId, from, to, runId, fence }`. `node.closed` carries `{ nodeId, outcome, checkpointId, revision, actor }`. Both are registered in `src/domain/event-type.ts` and `src/http/contract/event-payload.ts`.

## Stories

1. **The switch legality.** Add `src/domain/worker-switch.ts` with `switchVerdict` returning `null` or one of the six refusals of the Decisions table, in the fixed order. Add `src/domain/worker-switch.test.ts` with a case per refusal, a case per legal shape — with an active run and without one — and a case asserting a node in each of the three terminal states refuses `switch-node-terminal`.

2. **The switch command.** Add `src/commands/node/switch-worker.ts` performing the four transactional effects and returning `runEnded`. Add its test asserting: the assignment is written; the fence rises by exactly one; `end-attempt` is called with `operator-handoff`; `node.ambiguous_used` is cleared; the `node.switched` event is appended in the same transaction; a failure injected at the event append leaves the assignment and the fence unchanged; and a switch with no active run writes the assignment and returns `runEnded: false`.

3. **The discard is outside the transaction, and startup cleans up.** Add the workspace discard after the commit, and extend `src/commands/startup/` to remove any attempt directory whose run is ended. Add cases asserting the directory is absent after a switch, asserting a crash simulated between the commit and the discard leaves the database correct, and asserting startup then removes the directory.

4. **A switch preserves evidence.** Add cases asserting the node state, `workspace.head_oid`, the objective ref oid, and the full `checkpoint` row set for the subtree are each unchanged, the last by deep equality of whole rows.

5. **A switch admits the next claim from the accepted head.** Add a case asserting a claim after a switch, by the new worker, opens a run whose `run_base` equals `workspace.head_oid`, and asserting a claim by the old worker refuses `assignment-held`.

6. **A failure never switches.** Add cases asserting `node.assignment` is unchanged after an expiry, after an attempt-limit exhaustion, after a release and after an unroutable claim on another node.

7. **The close binds to evidence.** Extend `src/commands/outcome/close-objective.ts` with the request fields, the six refusals in the fixed order, the `closed_at` and `closed_actor` write, and the `ancestorRecomputation` call. Add cases asserting: `not-awaiting-approval` for each other `nodeStates` value; `not-an-objective` for an initiative and a task; `outcome-not-terminal` for `awaiting_approval`; `checkpoint-stale` for an atomic objective whose latest accepted checkpoint is newer; `graph-moved` for a parent objective whose project revision moved; and a successful close writing the state, the provenance and the event in one transaction.

8. **A close beats an aggregation.** Add a case with a stated legal sequence: an objective holding three `done` tasks is closed `done`; a human then discards one task through `node.discard`; the recomputation would give `partial`; the objective is asserted still `done` and `closed_at` unchanged.

9. **The four authorization directions.** Add the refusals to the authorization middleware. Add cases asserting a human caller refuses `node.claim` and `node.report`, a grant caller refuses `node.switch` and `node.close`, a grant caller passes `node.claim`, and a human caller passes `node.close`. All six assertions, so no rule is a blanket refusal.

10. **The routed operations.** Add `node.switch` to `src/http/contract/graph.ts` with its path tuple, request and response schemas, extend the `node.close` schemas, add the refusal codes to `src/http/contract/errors.ts`, register the two events and their payloads, add the handlers under `src/http/server/`, and bind them in `src/main.ts`. Update the registry, parity, coverage and example tests. Add an integration case per refusal.

11. **The proposal records the human controls.** Add `docs/proposal/phase-2/human-controls.md` stating the switch and its four transactional effects plus the postcondition, the discard-after-commit rule and its startup cleanup, the switch legality table and refusal order, that a switch consumes no attempt and preserves every checkpoint, that a new external worker needs its own grant, the close reference contract and its two staleness refusals, the precedence over aggregation, and the four authorization directions.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/worker-switch.test.ts \
  src/commands/node/switch-worker.test.ts \
  src/commands/node/claim-node.test.ts \
  src/commands/outcome/close-objective.test.ts \
  src/commands/startup/recover-workspaces.test.ts \
  src/http/server/authorization.test.ts \
  src/http/contract/graph.test.ts \
  && echo "PASS EPIC-056"
```

Hermetic coverage required beyond the Proof:

- A grant caller refuses `node.switch` and `node.close`, and a human caller refuses `node.claim` and `node.report`. A grant caller passes `node.claim` and a human caller passes `node.close`. Six assertions, so the boundary is proven in both directions.
- A switch on an unassigned node refuses `switch-unassigned`. The first assignment stays the claim's job.
- A switch on a node in each of `done`, `partial` and `discarded` refuses `switch-node-terminal`, iterated from `terminalStates`.
- A switch on a node whose `closed_at` is set refuses `switch-node-closed`.
- A switch with no active run writes the assignment, raises the fence, returns `runEnded: false`, and calls `end-attempt` zero times.
- A switch with an active run calls `end-attempt` with `operator-handoff`, and `semanticCount` is unchanged.
- `node.ambiguous_used` is cleared by a switch, asserted before and after.
- A failure injected at the `node.switched` event append leaves the assignment, the fence and the run state unchanged.
- The full `checkpoint` row set for the node's subtree is deep-equal before and after a switch. A row count is not sufficient.
- The attempt directory is absent after a switch. A simulated crash between the commit and the discard leaves the database correct, and startup then removes the directory. Two cases.
- A claim after a switch by the new worker opens a run whose `run_base` equals `workspace.head_oid`, and a claim by the old worker refuses `assignment-held`.
- `node.assignment` is unchanged after an expiry, an attempt-limit exhaustion, a release and an unroutable claim. Four cases.
- A close of an atomic objective naming a checkpoint that is not the latest accepted one refuses `checkpoint-stale`.
- A close of a parent objective naming a stale project revision refuses `graph-moved`.
- A close carrying `awaiting_approval` refuses `outcome-not-terminal`.
- A close is refused for every `nodeStates` value other than `awaiting_approval`, iterated from the tuple, and for an initiative and a task.
- The stated legal sequence — close `done`, then discard one child — leaves the objective `done` with `closed_at` unchanged.
