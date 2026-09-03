# EPIC 053 — The review checkpoint and state ownership

Status: **draft**. It follows EPIC 052 by sequence order.

## Goal

A verdict is evidence, and the pair selects who owns a node state:

- a review checkpoint binds to one accepted execution checkpoint, named in the report and reachable through the review node's `depends_on`;
- a task's terminal state comes from its own accepted report;
- an atomic objective reaches `awaiting_approval` from its own accepted checkpoint, whatever the projection;
- an initiative and a parent objective derive their state from their children, and a run never sets their terminal state;
- human input overrides aggregation, and aggregation overrides attestation.

## Non-goals

- **No reviewer.** Nothing produces a verdict here. A test supplies one. The `re@1` adapter is EPIC 106.
- **No close.** A human closing an objective is EPIC 056. This epic moves an objective to `awaiting_approval` and stops there.
- **No reviewer-mutation detection.** `worker.md` section 11 states the daemon detects none. The epic states the limit and adds no check.
- **No initiative end-to-end result.** `initiativeOutcome` at `src/domain/outcome.ts:20` keeps its `e2e` parameter and its `not-applicable` default.
- **No approval evidence bundle.** `node.approvalEvidence` stays `stubbed`. EPIC 112 owns it.

## Decisions

- **A review node names what it judges through `depends_on`, and the report names the checkpoint.** A review node is atomic and holds no child, so its own subtree can never contain an execution checkpoint. `worker.md` section 11 says only that the attestation names a commit the daemon accepted, and it defines no lookup. This epic defines one: `node.report` on a review run carries `judgedCheckpointId`. The daemon refuses unless that checkpoint is `execution`, accepted, and its `node_id` is in the review node's `depends_on` set. The refusals are `judged-checkpoint-unknown`, `judged-checkpoint-not-execution`, `judged-checkpoint-unaccepted` and `judged-checkpoint-undeclared`. A subtree lookup would be unsatisfiable, and an implicit lookup would let the reviewer choose its own subject.

- **The attestation stores a checkpoint reference, not a bare oid.** `checkpoint.judged_checkpoint_id` is a foreign key to `checkpoint(id)`. A bare oid is not repository-qualified and does not name the accepted artifact, and every other reference to a commit in this block carries its repository. `judged_oid` is stored beside it, copied from the referenced row, so a reader needs no join.

- **The verdict is evidence, and both values deliver the node.** A review node's deliverable is a verdict against the acceptance criteria. Delivering `reject` is delivering the verdict, so an accepted review report moves the review node to `done` for `accept` and for `reject` alike. The verdict changes no other node's state. `worker.md` section 11 places the verdict under "Trusted", and a daemon that acted on it would be verifying it.

- **`verdict` is a closed enum, and `reason_blob` is a content address.** `verdict` is `('accept', 'reject')`. `reason_blob` is nullable and references `blob(hash)`, like every other prose field in the schema. The reason text is delivered in the report body, stored through `services/blob`, and capped at 64 KiB; a larger body refuses `reason-too-large`. `worker.md` does not require a reason, and a verdict with no stated reason is not usable evidence for the human who closes the objective.

- **Accepting an attestation lands no artifact and mutates no other node.** That is what the daemon can honestly say. It does not follow that the reviewer mutated nothing during its run: `worker.md` section 11 places reviewer mutation under "Trusted" and states the daemon detects none. The epic records both sentences and does not derive the second from the claimed-subtree rule.

- **The state owner comes from the pair, and one table maps every case.** `applyReport({ stateOwner, projected })` in `src/domain/state-ownership.ts`:

  | `stateOwner`             | `projected` | result                          |
  | ------------------------ | ----------- | ------------------------------- |
  | `report`                 | `done`      | `done`                          |
  | `report`                 | `partial`   | refuses `task-not-partial`      |
  | `report`                 | `discarded` | `discarded`                     |
  | `attestation-then-human` | any         | `awaiting_approval`             |
  | `aggregate`              | any         | refuses `state-owner-aggregate` |

  `report` covers a task, whose terminal state is its own. `worker.md` section 6 states a task is never `partial`, and `src/domain/node.ts` already refines it.

- **An atomic objective reaches `awaiting_approval` whatever the projection, and this supersedes the `discarded` branch of `objectiveOutcome`.** `worker.md` section 6 states an objective reaches a terminal state when a human closes it. `src/domain/outcome.ts:26` returns `discarded` for a `discarded` projection, which lets a worker report put an objective in a terminal state directly. That branch is removed. The projection is carried on the checkpoint as evidence, and the human reads it before closing.

- **A run against an initiative leaves the initiative `pending` or `ready`.** An initiative's only legal deliverable is `expansion`, per the pair table of EPIC 047, so its run kind is `structural`, per `runKindFor` in EPIC 050. `worker.md` section 6 states a run never sets an initiative's terminal state. The accepted checkpoint is recorded and the node state is unchanged. The initiative then moves only through `ancestorRecomputation` over the children that structural run created. `worker.md` section 6 describes this as a research worker followed by an author worker; `research` is deferred out of the deliverable enum by EPIC 047, and `(initiative, research)` was an illegal pair in that table regardless, so the run this epic asserts is the structural one.

- **A terminal state is `done`, `partial` or `discarded`, and `awaiting_approval` is not one.** `src/domain/state.ts:23` already fixes that tuple. The recomputation reads it, so a parent objective that reaches `awaiting_approval` is not a terminal child and its own parent does not move.

- **Aggregation keeps its current rule and gains one caller.** `aggregate` at `src/domain/aggregation.ts:17` gives `done` for every child `done`, `discarded` for every child `discarded`, and `partial` otherwise. `worker.md` section 6 states the same three rules. The function does not change.

- **The recomputation runs inside the report transaction, and it is a domain function plus one storage write loop.** `AGENTS.md` forbids a command importing a command, so the walk is `ancestorRecomputation({ nodes, fromNodeId })` in `src/domain/state-ownership.ts`, returning the ordered list of ancestor transitions. `report-outcome.ts` applies that list inside the transaction it already opens, appending one event per transition. A separate command would put the transitions in a second transaction.

- **The walk stops at the first ancestor that does not move, and the invariant that makes it safe is stated.** Every ancestor state is derived from its children, and every child transition recomputes its own parent, so an ancestor is synchronised with its children at the end of every transaction that touched them. If the immediate parent does not move, no ancestor's child set changed, so no ancestor can move.

- **A parent objective reaching `awaiting_approval` stops the walk, and the close resumes it.** An initiative cannot aggregate an objective that is not terminal. EPIC 056's close writes the objective's terminal state and then calls the same `ancestorRecomputation` from that objective, inside the close transaction. This epic exports the function and states the contract; EPIC 056 is its second caller.

- **Precedence needs provenance, so a human close is recorded on the node.** A state value alone does not say who set it. Migration `14` adds `node.closed_at INTEGER` and `node.closed_actor TEXT`, both nullable and written only by the close of EPIC 056. `resolveState({ closedAt, aggregated, attested })` returns the stored state when `closedAt` is not null, then the aggregated value, then the attested one. `worker.md` section 6 states the order.

- **The aggregation-versus-attestation conflict is unreachable, and the epic says so instead of testing a fiction.** A parent objective aggregates and holds no attestation; an atomic objective holds an attestation and has no children to aggregate. The pair makes the two inputs exclusive. `resolveState` still takes both, because the human input must beat whichever one is present, and the test asserts the two legal shapes plus the human override of each.

## Stories

1. **Migration 15.** Add `src/services/storage/migration-0015-attestation.ts` at version `15`: add `verdict`, `reason_blob`, `judged_checkpoint_id` and `judged_oid` to `checkpoint`, with the named CHECK constraints `checkpoint_review_verdict`, `checkpoint_review_judged` and `checkpoint_execution_no_verdict`; add `closed_at` and `closed_actor` to `node` with `CHECK ((closed_at IS NULL) = (closed_actor IS NULL))`. Register it at `src/services/storage/migrations.ts:13`. Add its test asserting each named CHECK by insert and by message, and asserting the foreign key refuses an unknown checkpoint id.

2. **The checkpoint row.** Extend `checkpointRow` in `src/domain/checkpoint.ts` with the four fields and one refine per CHECK. Add cases asserting a review row requires `verdict` and `judged_checkpoint_id`, and an execution row refuses both.

3. **The review acceptance.** Add `src/commands/checkpoint/accept-review.ts` resolving `judgedCheckpointId`, applying the four refusals of the Decisions, storing the reason through `services/blob` with the size cap, and writing the attestation with the five binding facts of EPIC 051. Add its test asserting each of the five refusals by code, asserting `judged_oid` is copied from the referenced row, and asserting an accepted review moves the review node to `done` for `accept` and for `reject` in two cases.

4. **State ownership.** Add `src/domain/state-ownership.ts` with `applyReport`, `resolveState` and `ancestorRecomputation`. Add `src/domain/state-ownership.test.ts` asserting every row of the Decisions table by value, including the `task-not-partial` and `state-owner-aggregate` refusals, and asserting `resolveState` returns the closed state over an aggregated one, and an aggregated one over an attested one.

5. **`objectiveOutcome` loses its `discarded` branch.** Change `src/domain/outcome.ts:26` so an atomic objective's accepted checkpoint gives `awaiting_approval` for every projection. Update `src/domain/outcome.test.ts`, replacing the `discarded` case with one asserting `awaiting_approval`, and add a comment-free case asserting the projection is still carried on the checkpoint row.

6. **An initiative run does not move the initiative.** Add cases to `src/commands/outcome/report-outcome.test.ts` asserting a `structural` run accepted against an initiative — the only run an initiative can take, because `(initiative, expansion)` is its only legal pair — writes the checkpoint and leaves `node.state` unchanged, run once from `pending` and once from `ready`.

7. **The recomputation.** Wire `ancestorRecomputation` into `src/commands/outcome/report-outcome.ts`, applying its transitions and events inside the existing transaction. Add cases against one named fixture — an initiative holding one objective holding three tasks — asserting: the third task reaching `done` moves the task and the objective to `awaiting_approval` and leaves the initiative unchanged, for a total of two transitions and two events; two tasks `done` and one `discarded` gives the objective `partial` through aggregation and still stops; every task `discarded` gives the objective `discarded` and then moves the initiative, for three transitions; one task still `running` moves nothing; and a failure injected mid-walk leaves every state and every event absent.

8. **Precedence at the command boundary.** Wire `resolveState` into the report path so a node whose `closed_at` is set is never overwritten by a recomputation. Add a case asserting an objective with `closed_at` set keeps its state after a child transition that would aggregate differently.

9. **The proposal records state ownership.** Amend `docs/proposal/phase-2/checkpoints.md` with the attestation contract, the `depends_on` lookup and its four refusals, and the verdict semantics. Add `docs/proposal/phase-2/node-state-ownership.md` stating the state owner per pair with the full transition table, the aggregation rules, the terminal-state tuple, the walk and its stop invariant, the precedence order and its provenance column, and that the verdict is trusted and a reviewer mutation is not detected.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/checkpoint.test.ts \
  src/domain/state-ownership.test.ts \
  src/domain/outcome.test.ts \
  src/domain/aggregation.test.ts \
  src/services/storage/migration-0015-attestation.test.ts \
  src/commands/checkpoint/accept-review.test.ts \
  src/commands/outcome/report-outcome.test.ts \
  && echo "PASS EPIC-053"
```

Hermetic coverage required beyond the Proof:

- A `judgedCheckpointId` naming a checkpoint whose node is absent from the review node's `depends_on` refuses `judged-checkpoint-undeclared`. This is the case that replaces the subtree lookup, and without it the review node has no legal subject.
- A `judgedCheckpointId` naming a structural checkpoint refuses `judged-checkpoint-not-execution`, and one naming an unaccepted checkpoint refuses `judged-checkpoint-unaccepted`.
- `judged_oid` on the attestation equals the `accepted_oid` of the referenced checkpoint, asserted by reading both rows.
- A reason body above 64 KiB refuses `reason-too-large`, and a body at the cap is stored, asserted by resolving the blob.
- An accepted review report moves the review node to `done` for `accept` and for `reject`. Two cases, so the verdict is proven to change no state.
- An execution checkpoint row carrying `verdict` is refused by the named CHECK `checkpoint_execution_no_verdict`, asserted by message.
- `applyReport` is asserted for every row of the transition table, including `task-not-partial` and `state-owner-aggregate` refusals by code.
- An atomic objective reporting a `discarded` projection reaches `awaiting_approval`, not `discarded`. The projection is asserted present on the checkpoint row. This is the assertion that supersedes the shipped `objectiveOutcome` branch.
- A `structural` run accepted against an initiative leaves `node.state` unchanged, run once from `pending` and once from `ready`. No case uses a `research` run: `research` is not in the deliverable enum, and `(initiative, research)` is not a legal pair.
- The three-task fixture is named and its initial states are stated. The `done` case asserts exactly two transitions and two events, and the initiative state unchanged. The all-`discarded` case asserts exactly three transitions and three events.
- A parent holding one `running` child moves nothing. The parent state and the event count are both asserted unchanged.
- A failure injected mid-walk leaves every ancestor state and every event absent, proving the walk and the report are one transaction.
- An objective whose `closed_at` is set keeps its state after a child transition that would aggregate to a different value.
- `aggregate` still throws `empty-parent` for a childless parent, asserted by error code, after the EPIC 052 exemption exists.
