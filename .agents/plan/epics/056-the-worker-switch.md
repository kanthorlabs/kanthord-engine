# EPIC 056 — The worker switch

Status: **draft**. It follows EPIC 055 by sequence order, and it runs before EPIC 056.1. It consumes EPIC 054's `end-attempt` and its `operator-handoff` termination, EPIC 055's caller kinds, and EPIC 048's worker registry.

This epic and EPIC 056.1 replace the single EPIC 056 authored before `.agents/plan/authoring.md`. That document held twelve story entries, declared no story kind, and carried its verification gate as a bullet list; the standard refuses all three. EPIC 056.1 carries a decimal number because EPIC 057 is authored and numbered, and renumbering it would break every cross-reference to it.

**Dispatch prerequisite.** Story 1 inserts `"056"` into `scripts/epic-sequence-range.ts:1` — `authoredEpics` after the entry EPIC 055 adds, and Story 7 appends it to `shippedEpics`, which `test/sequence/conformance.test.ts:254` — `shippedEpics` requires to stay a prefix of `authoredEpics`. Story 7 is therefore last in dispatch order.

## Goal

A human is the only actor that changes an existing assignment:

- a switch is one operation that ends the active run as an operator handoff, raises the fence and writes the new assignment;
- a switch is legal with an active run and without one, and the response says which happened;
- a switch keeps the node, its state and every accepted checkpoint, byte for byte;
- a switch consumes no attempt, and it clears the ambiguous budget of the worker it replaces;
- `node.switch` admits a human actor and refuses every other kind.

## Non-goals

- **No automatic switch.** No timeout, no attempt limit and no unroutable result triggers one. `worker.md:190` states only a human switches a worker.
- **No workspace discard, and no startup cleanup for one.** `worker.md` section 4 lists the discard among the switch's effects, and this range has nothing to discard: `.agents/plan/epics/051-the-workspace-branch.md:26` — `Workspace` and `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:22` — `disposal` both state that no epic through this one creates an attempt workspace, and `src/services/` holds no service that could remove one. Both epics rule that **the epic that creates an attempt workspace owns its disposal**, and this epic repeats that ruling rather than writing a remover for a directory nothing creates. The fence raise inside the committed transaction is what makes the absent discard safe, because a late write from the replaced worker fails on the fence.
- **No repair of `sweep-remnants`.** `AGENTS.md:106` records that `src/commands/startup/sweep-remnants.ts` opens two transactions around filesystem I/O with no journal row, and assigns the repair to the next epic that touches startup recovery. This epic touches no startup file, so it takes neither the repair nor the obligation.
- **No close.** EPIC 056.1 owns the human close, its evidence reference and the `node.claim` and `node.report` actor narrowing.
- **No run adoption, and no grant minting.** A new external worker needs its own grant, and the switch mints none.
- **No first assignment.** The daemon writes an assignment at the first claim on an unassigned node, per EPIC 050. This epic owns the change of an existing one.
- **No unblock replacement.** `node.unblock` at `src/commands/node/unblock-node.ts` stays as it is.
- **No provenance columns.** `node.closed_at` and `node.closed_actor` are not built by any epic. The next decision states why the switch needs neither.

## Decisions

- **A switch is one operation, `node.switch`, at `POST /node/{node}/switch`.** `worker.md:190` lists five effects, and a human performing them as separate calls would leave a node assigned to a worker whose run is still active. The request is `{ runId?, fence?, worker }` — `worker` is the new worker id, and the optional pair guards against a switch aimed at a run that already ended. The response is `{ nodeId, assignment, fence, runEnded }`.

- **`actionSegments` gains `"switch"`, and that is a contract edit this epic owns.** `src/http/contract/path.ts:40` — `actionSegments` is a closed set holding no `switch`, and `AGENTS.md` requires every path segment to come from such a set. The value is added there, so the operation declares `action("switch")` and no free-form segment reaches a path.

- **The transactional effects are four, and admitting a new claim is a postcondition.** The transaction ends the active run, raises the fence, writes `node.assignment`, clears `node.ambiguous_used` of EPIC 054, writes the `attempt.termination` of `operator-handoff` through `end-attempt`, and appends the `node.switched` event. It opens no run and mints no grant, so "admits a new claim from the accepted branch head" is the state the transaction leaves behind, never a write it performs.

- **A switch is legal for an assigned, non-terminal node, with or without an active run.** `worker.md:190` describes the switch against an active run, and a node whose run ended on an accepted report still holds an assignment a human may want to change. `switchVerdict` refuses:

  | refusal                | condition                                                                                         |
  | ---------------------- | ------------------------------------------------------------------------------------------------- |
  | `switch-unassigned`    | `node.assignment` is null. There is nothing to change, and a first assignment is the claim's job. |
  | `switch-node-terminal` | The node state is `done`, `partial` or `discarded`.                                               |
  | `switch-unchanged`     | The new worker equals the current assignment. Five destructive effects for no change.             |
  | `switch-incapable`     | The new worker is not `capable` for the node's `(kind, deliverable)` pair.                        |
  | `fence-stale`          | The request named a `runId` and `fence` that are not the current ones.                            |

  With no active run the transaction performs the assignment write, the fence raise and the event, and skips the run end and the termination write. `runEnded` in the response says which happened.

- **There is no `switch-node-closed` refusal, and no column records a close.** A closed objective holds one of the three values of `src/domain/state.ts:20` — `terminalStates`, so `switch-node-terminal` already refuses it, and a second refusal over a provenance column would be a second expression of one rule. The close's provenance is in the event log: `src/services/storage/migration-0005-actor.ts:23` — `actor_kind` and `:24` — `actor_id` are `NOT NULL` on every event row, and the event id is a ULID minted by `src/services/ids/ulid.ts:11` — `mintUlid`, whose leading bits carry the mint millisecond. Nothing in the product decides on that time, so no hermetic reader of it is required.

- **The refusal order is fixed:** `actor-forbidden`, `node-not-found`, `switch-unassigned`, `switch-node-terminal`, `switch-unchanged`, `switch-incapable`, `fence-stale`. The first is decided by the authorization middleware before the command runs, the next five stop after the node read, and the last stops after the run read.

- **`switch-incapable` reaches no seam of its own.** `registry` is injected data, not a capability: `src/commands/node/claim-node.ts:97` — `registry` declares it as `readonly WorkerEntry[]`, and `capableWorkers` is a pure call over it. No diagram in the tree carries a `Registry` participant, including the claim's own. The capability refusal therefore stops where the other node-read refusals stop, and it is drawn in the same diagram.

- **An operator handoff is `infrastructure`, so a switch consumes no attempt.** `worker.md` section 9 names it as an infrastructure source, and EPIC 054's evidence union holds `operator-handoff`. The switch calls `end-attempt` of EPIC 054 rather than writing a class itself, and that nested command is one step of the drawn path.

- **A switch validates the new worker against the registry, not against any caller's authorization.** A human may switch to a worker no current grant authorizes; minting that grant is the next step. Validating against a grant would make the switch depend on a credential the human has not created yet.

- **The operation is human-only by registry data, and it refuses with `actor-forbidden`.** `node.switch` declares `allowedActors: ["human"]`, and `src/http/server/authorize.ts:11` — `allowedActors` already refuses every other kind with `actor-forbidden`. A bespoke `human-only-operation` code was drafted; it names no condition a client acts on differently, and `AGENTS.md` requires route lifecycle to be registry data rather than a branch in a handler. The narrowing of `node.claim` and `node.report` needs `node.switch` to exist first, so EPIC 056.1 owns it.

- **A switch preserves every accepted checkpoint identically, and the assertion compares rows, not counts.** A count is equal after a delete and a re-insert. The test snapshots the full `checkpoint` rows for the node's subtree before and after and compares them by deep equality, including `id`, `attempt_id`, `caller`, `subject`, `fence` and every evidence column.

- **One event joins the registry.** `node.switched` carries `{ nodeId, from, to, runId, fence }`, registered in `src/domain/event-type.ts:40` — `run.opened`'s tuple and in `src/http/contract/event-payload.ts`. `from` and `to` are the assignment values, not node states, and the payload names them so a reader sees the handoff without joining the node row.

## Stories

Each entry is a name and the output it contributes. The story file holds the change, the tasks and the diagrams, and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **The switch legality.** Add `src/domain/worker-switch.ts` with `switchVerdict` returning `null` or one of the five refusals of the Decisions table, in the fixed order. Insert `"056"` into `authoredEpics`. `story-foundation`.

2. **The switch contract.** Add `"switch"` to `src/http/contract/path.ts:40` — `actionSegments`, add the `node.switch` operation with its path tuple, request and response schemas, `allowedActors: ["human"]` and its `errors` record, add the refusal codes to `src/http/contract/errors.ts` and `src/cli/exit-code.ts`, register `node.switched` and its payload, and regenerate `src/http/contract/field-decisions.fixture.ts`. `story-foundation`.

3. **An unswitchable node refuses after the node read.** Add `src/commands/node/switch-worker.ts` and draw `switch-refusal-node`: `clock.now`, `plan.readNode`, and the refusal. The four refusals `switch-unassigned`, `switch-node-terminal`, `switch-unchanged` and `switch-incapable` stop at the same step, so they are one diagram. Its prior set is empty. `story-implement`.

4. **A stale fence refuses after the run read.** Draws `switch-refusal-fence-stale`, adding `execution.activeRunOfNode`. Its prior set is empty. `story-implement`.

5. **The switch of a node with an active run.** Draws `switch-success-active-run`: the two reads, `end-attempt`, `execution.endRun`, `plan.setNodeAssignment`, the fence raise and `events.append`. Adds the handler at `src/http/server/node/switch-node.ts` and the `src/main.ts` binding. Its prior set is empty. `story-implement`.

6. **The switch of a node with no active run.** Draws `switch-success-no-run`, which is the same path without `end-attempt` and without `execution.endRun`. Its prior set is empty, and the two missing tokens are what prove `runEnded` is not a formatting choice. `story-implement`.

7. **The proposal records the switch.** Add `docs/proposal/phase-2/human-controls.md` stating the switch and its four transactional effects plus the postcondition, the switch legality table and its refusal order, that a switch consumes no attempt and preserves every checkpoint, that a new external worker needs its own grant, that the attempt-workspace discard belongs to the epic that creates one, and that the operation is human-only by registry data. Append `"056"` to `shippedEpics`. It is last in dispatch order. `story-foundation`.

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

| #   | assertion                                                                                                                                                                                                                                                                     | story |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `switchVerdict` returns each of the five refusals for its own condition and `null` for both legal shapes, with and without an active run. Seven cases, each asserted by value.                                                                                                | 1     |
| 2   | `switchVerdict` refuses `switch-node-terminal` for each of the three `terminalStates` values, iterated from the tuple, so a fourth terminal state fails the test. No case names a closed node, because no column records a close.                                             | 1     |
| 3   | Every pair of refusal conditions that can hold at once reports the earlier one of the fixed order, enumerated and not sampled. `switch-unassigned` before `switch-node-terminal` is the pair that proves an unassigned terminal node reports the assignment first.            | 1     |
| 4   | `"switch"` is in `actionSegments` and the rendered path of `node.switch` equals `/node/{node}/switch` by value. A path built from a free-form segment fails to type-check, which the story states as the build check.                                                         | 2     |
| 5   | `node.switch` declares `allowedActors` of `["human"]`, and `node.claim` and `node.report` still declare `["human", "harness"]`, asserted by value. The second half is the control that this epic narrows neither, and EPIC 056.1 owns that change.                            | 2     |
| 6   | A harness actor and a daemon actor each refuse `node.switch` with `actor-forbidden` over the real route, and a human actor passes. Three cases, so the boundary is proven in both directions with no bespoke code.                                                            | 2     |
| 7   | Each new refusal code is present in `src/http/contract/errors.ts` with its status and in `src/cli/exit-code.ts` with a distinct exit code, asserted by iterating the names. A code absent from either file fails, which is the control.                                       | 2     |
| 8   | A switch on an unassigned node refuses `switch-unassigned`, on a terminal node refuses `switch-node-terminal`, on the same worker refuses `switch-unchanged`, and on an incapable worker refuses `switch-incapable`. Four cases, each leaving `databaseBytes` byte-identical. | 3     |
| 9   | The four node-read refusals reach `execution.activeRunOfNode` zero times. Row 10 is the control that the call count detects a reached read.                                                                                                                                   | 3     |
| 10  | A switch naming a `runId` and `fence` that are not current refuses `fence-stale`, reaches `end-attempt` zero times and leaves `databaseBytes` byte-identical.                                                                                                                 | 4     |
| 11  | A switch with an active run writes the assignment, raises the fence by exactly one, calls `end-attempt` once with `operator-handoff`, clears `node.ambiguous_used`, ends the run, and appends exactly one `node.switched` event whose payload deep-equals the stated value.   | 5     |
| 12  | A switch resolves over the real route through the daemon `src/main.ts` builds, returning `runEnded` of `true`, which proves the handler and the binding.                                                                                                                      | 5     |
| 13  | A failure injected at the `node.switched` append leaves the assignment, the fence, `node.ambiguous_used` and the run state unchanged, proving the four effects are one transaction.                                                                                           | 5     |
| 14  | The full `checkpoint` row set for the node's subtree is deep-equal before and after a switch, and the node state and `workspace.head_oid` are each unchanged by value. A row count alone is not sufficient, because it survives a delete and a re-insert.                     | 5     |
| 15  | A claim after a switch by the new worker opens a run whose `run_base` equals `workspace.head_oid`, and a claim by the old worker refuses `assignment-held`. Both directions.                                                                                                  | 5     |
| 16  | A switch with no active run writes the assignment, raises the fence, appends the event, returns `runEnded` of `false`, and calls `end-attempt` and `execution.endRun` zero times each. Row 11 is the control for both zero counts.                                            | 6     |
| 17  | `node.assignment` is unchanged after a run expiry, an attempt-limit exhaustion, a release and an unroutable claim on another node. Four cases, so no failure path performs a switch.                                                                                          | 6     |
| 18  | The conformance runner replays all four diagrams of this epic by equality, and the comparison fails when `end-attempt` is removed from `switch-success-active-run`.                                                                                                           | 7     |
| 19  | No file under `src/commands/startup/` is changed by this epic, asserted by a source scan over the directory against the shipped file set. The scan is run once against a fixture holding an added file and asserted to find it, which is the control for the negative.        | 7     |
