---
epic: .agents/plan/epics/019-outcome-report.md
opened: 2026-08-17
opener: test-engineer
base-ref: 46a7f1c49b057d9e1a25c2013a0d72b4bf4f4bbf
---

# Implementation cycle — 019-outcome-report

Pulled from EPIC: `.agents/plan/epics/019-outcome-report.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/outcome-report.test.ts \
>   src/domain/attempt-accounting.test.ts \
>   src/domain/external-transition.test.ts \
>   src/domain/aggregation.test.ts \
>   src/domain/outcome.test.ts \
>   src/domain/event-type.test.ts \
>   src/services/execution/sqlite.test.ts \
>   src/commands/outcome/report-outcome.test.ts \
>   src/commands/outcome/report-objective.test.ts \
>   src/commands/outcome/aggregate-initiative.test.ts \
>   src/commands/outcome/close-objective.test.ts \
>   src/commands/node/unblock-node.test.ts \
>   src/commands/node/claim-node.test.ts \
>   src/queries/node/show-node.test.ts \
>   src/http/contract/path.test.ts \
>   src/http/contract/event-payload.test.ts \
>   src/http/contract/event.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/server/node/report-node.test.ts \
>   src/http/server/node/unblock-node.test.ts \
>   src/cli/node/report.test.ts \
>   src/cli/node/attest.test.ts \
>   src/cli/node/close.test.ts \
>   src/cli/node/unblock.test.ts \
>   src/main.report.test.ts \
>   && echo "PASS EPIC-019"
> ```
>
> Every path is named one by one, and no directory glob stands in for one. `node --test` exits non-zero on a named path that is absent, so the Proof fails before this epic is built rather than collecting a green sibling suite. **Eighteen of these paths do not exist in the repository today.** Three of the eighteen belong to EPIC 014 and EPIC 018, so fifteen remain after 014 to 018 land, and those fifteen are this epic's own. Three of the fifteen are the `node.unblock` paths.
>
> Hermetic coverage required beyond the Proof:
>
> - **The whole loop against the real composition root.** `src/main.report.test.ts` drives the sequence over HTTP: a harness claims the one `ready` task of an objective; `node.report` with `accepted`, the live fence and an object id answers `200`; the task is `done`; the objective is still `running` and its `objectiveProjection` in the response is `done`; **the objective `lease` row still names the reporting harness at the fence the claim minted, asserted from the row before the attestation runs**; `node.show` on the objective returns `projection: "done"` and a null `attestedObjectId`; the harness attests through `node.report` with `attested` and the objective fence, and that attestation answers `200` rather than `409 lease-held`; the objective is `awaiting_approval` and its active run carries the attested object id in `head_oid`; `node.show` returns that same `attestedObjectId`; a `human` token closes it and the objective is `done`; the objective run is `ended` with outcome `done`; the initiative is `done`; and a second objective that depended on the first is `ready`. Every state is asserted by identity, never by count.
> - `unimplementedFor(handlers)` built from the **production** handler map of `src/main.ts` does not contain `node.report`. The assertion imports the composition function and never `createTestApp`.
> - A report that carries a fence other than the live one is `409 lease-held`, and the database is byte-identical before and after. A report from an authenticated actor that is not the lease owner is the same code and the same non-write, with the live fence presented. Both run after the expiry sweep and a re-claim by a second actor have minted a new fence, which is the case `018-claim-and-lease.md:45` names.
> - **A report whose owner and fence both match a lease that expired at the command's captured `now` is `409 lease-held`**, and the database is byte-identical before and after. The fixture advances the fake clock past `expires_at` and triggers no claim, so the sweep never ran and the row still names the old owner and the old fence.
> - A report on a task that is `pending`, `ready`, `blocked`, `awaiting_approval`, `done`, `partial` or `discarded` is `409 illegal-transition` and names the current state. All seven states are asserted.
> - An accepted report closes exactly one attempt row with outcome `accepted` and the reported object id in `head_oid`, ends the task run with outcome `done` and the same object id, and leaves the attempt row count of the run unchanged apart from that close.
> - A rejected report under the limit moves the task to `ready`, leaves the task run `active`, frees the task lease, and leaves the objective lease held by the same actor at an unchanged fence. **The next claim by that same actor** adopts that same run id, mints attempt number 2 over the surviving rows, and mints a new task fence. The run id is asserted equal across the two claims. A second actor's claim on that task is `409 lease-held`, because the objective lease still names the first actor.
> - **The active run survives a daemon restart, and adoption is the only recovery.** The fixture reports `rejected` under the limit, stops the daemon, launches a second daemon on the same home, and claims again **with the same harness token**. The claim adopts the same run id, mints attempt number 2, and mints a new task fence. The objective lease survives the restart with the same owner and the same fence, because a `lease` row is durable. The expiry sweep is asserted to touch nothing: the task lease is free and carries no `expires_at`, and the objective lease is live.
> - A failed report behaves as a rejected report under the limit, and the attempt row records `failed`.
> - The third rejected report under a run whose `attempt_limit` is 3 moves the task to `blocked` with reason `attempt-limit`, ends the task run with outcome `blocked`, frees the task lease, **leaves the objective lease held by the same actor at an unchanged fence**, and leaves the objective run `active` and the objective in `running`. Each fact is asserted from the row. A second actor's claim on any sibling task of that objective is still `409 lease-held`.
> - **No task report touches the objective lease.** The objective `lease` row is compared field by field before and after each of the four task report outcomes, and after the report that closes the last task of the objective. `owner`, `owner_kind` and `fence` are equal in all five cases. The `expires_at` is equal too, because a report is not a heartbeat.
> - **Two sequential sibling tasks stay with one harness.** One objective holds two tasks in dependency order. The harness claims the first, reports it `accepted`, and the second task becomes `ready`. A second actor's claim on that second task is `409 lease-held`. The first harness then claims it with `200`, reports it, and attests the objective with `200`. This is the journey the whole block exists for, and it fails the moment a task report frees the objective lease.
> - **An objective abandoned after a task report is recovered by expiry.** The harness reports its last task `accepted` and attests nothing. The fake clock advances past `leaseTtlMs`, and a second actor claims an unrelated task. The objective lease then holds a null owner and the objective is claimable by the second actor, per `018-claim-and-lease.md:31`. The objective state stays `running` throughout.
> - **Three cancelled reports under a limit of 3 reach `blocked` with reason `attempt-limit`**, exactly as three rejected reports do, and the attempt numbers are 1, 2 and 3. Three failed reports reach it the same way. The three fixtures are asserted side by side, which is what the widened `exhausted` exists for.
> - **A blocked task returns to the pool and runs again, driven through the real composition root.** The fixture of the previous assertion leaves one task `blocked` with reason `attempt-limit` and its task run ended `blocked`. A `human` token calls `node.unblock`; the answer is `200`; the task is `ready` and its `block_reason` is null; the events are `node.unblocked` attributed to that human with `clearedReason: "attempt-limit"`, then `node.ready` attributed to the daemon instance. The same harness then claims that task with `200`, and the claim opens a **new** run id, asserted not equal to the ended run id, whose first attempt number is 1. That harness reports the task `accepted` and the task is `done`. The objective then attests and closes, so the objective this fixture would otherwise strand reaches `done`.
> - **An unblock on a task whose dependencies are not satisfied stays `pending`.** The same fixture with one unsatisfied dependency leaves the task `pending` after the unblock, writes `node.unblocked` and writes no `node.ready`, and a claim on it is refused by the state check of `018-claim-and-lease.md`.
> - Each `node.unblock` refusal is asserted with a byte-identical database before and after: a `harness` token is `403 actor-forbidden`; an absent node is `404 not-found`; an objective and an initiative are each `400 invalid-request` with `details.refusal = "node-kind-invalid"`; a task in each of `pending`, `ready`, `running`, `awaiting_approval`, `done`, `partial` and `discarded` is `409 illegal-transition` with `details.refusal = "not-blocked"`; and a task `blocked` with reason `dependency-discarded` is `409 illegal-transition` with `details.refusal = "block-reason-not-clearable"` and `details.blockReason` naming that reason.
> - `unimplementedFor(handlers)` built from the production handler map does not contain `node.unblock`, and `src/http/contract/registry.test.ts` finds `node.unblock` with `allowedActors: ["human"]`. The harness-admitting set is unchanged by this epic, which `020-wiring-and-scenarios.md` asserts at sixteen names.
> - A cancelled report under the limit leaves the task run `active`, which is the one way it differs from `node.release` of `018-claim-and-lease.md:98`. The same fixture driven through `node.release` ends the run, asserted side by side in one test.
> - `attemptsRemaining` equals `limit - counter` under the limit, and it equals `0` when the counter reaches or passes the limit. A run whose `attempt_limit` is 3 and whose counter is 4 returns `0` and never `-1`.
> - A report body carrying `timed-out` is `400 invalid-request`. An `accepted` body with no `objectId`, a `rejected` body with no `reason`, and an `accepted` body carrying a `reason` are each `400 invalid-request` from the schema. **A body carrying an `owner` key is `400 invalid-request`**, because every member is strict and no member declares that key.
> - A 40-character object id and a 64-character object id are each accepted. A 39-character, a 41-character and a 63-character object id are each `400 invalid-request`. An uppercase object id is refused.
> - A task `report` value sent to an objective and an objective `report` value sent to a task are each `400 invalid-request` with `details.refusal = "body-kind-mismatch"`. A report on an initiative is `400 invalid-request` with `details.refusal = "initiative-not-reportable"`. All three write nothing.
> - A task report by a `human` token is `403 actor-forbidden` and writes nothing. An attestation by a `human` token is the same. A close by a `harness` token is the same. Each refusal is asserted with a byte-identical database before and after.
> - **An objective whose tasks are all terminal stays `running` until an attestation arrives.** No `node.awaitingApproval` event exists, `node.show` returns the computed `projection`, and the accepted task report response carries the same `objectiveProjection`. The objective moves only on the attestation, and its `head_oid` equals the object id of that attestation and not the object id of any task report.
> - An attestation on an objective whose tasks are not all terminal is `409 illegal-transition` and writes nothing. An attestation on an objective that is not `running` is the same. An attestation with a stale fence, a wrong owner or an expired lease is `409 lease-held`.
> - An attestation whose objective projection is `discarded` is `409 illegal-transition`. The fixture writes every task `discarded` directly in the database, because no route discards one in this block.
> - The `node.awaitingApproval` event carries `actorKind = 'harness'` and the attesting actor id. It is asserted different from the `node.ready` event of the same transaction, which carries `actorKind = 'daemon'`.
> - The `outcome.reported` event payload holds exactly `runId`, `attemptId`, `attemptNo`, `outcome`, `reason`, `objectId`, `attemptsRemaining`, `fromState` and `toState`, in that key order. A rejected report stores its reason there verbatim, and a cancelled report with no reason stores null. The key set is asserted exactly, so a tenth key fails the test.
> - A close of an objective that is not in `awaiting_approval` is `409 illegal-transition`. A close of an objective whose active run carries `driver = 'internal'` is `409 illegal-transition`. A close of an objective whose run holds a null `head_oid` is `409 illegal-transition`.
> - The close writes no candidate row, calls no method of the `Git` fake, and writes no `check_result` and no `agent_invocation` row. The fake counts its calls and the count is zero.
> - A derived `partial` with no `acknowledgePartial` is `409 acknowledgement-required` and writes nothing, and the same request with the flag answers `200` and writes `partial`. The fixture builds a `discarded` task directly in the database.
> - **`aggregateInitiative` is asserted over four objective sets.** One `partial` objective gives `partial`. `done` plus `partial` gives `partial`. `partial` plus `discarded` gives `partial`. Every objective `discarded` gives `discarded` and never `partial`. Each case asserts the written state, the trigger and the event type. The initiative stays `running` while one objective is not terminal.
> - The initiative roll-up runs before the objective run ends: the run row is `active` when the `initiative-aggregated-done` write commits, asserted from an `Execution` fake that records the call order.
> - The close makes a dependent objective `ready` through EPIC 016, with one `node.ready` event attributed to the daemon inside the same transaction. The accepted task report makes a dependent task `ready` the same way.
> - `externalTransitions` holds ten trigger ids, asserted exactly, against the eight `018-claim-and-lease.md:102` leaves. The two new rows are asserted field by field over all seven `ExternalPrecondition` members, and `canTransition` returns `true` for each cell they name.
> - The three initiative roll-up triggers are asserted absent from `externalTransitions` and present in `internalTransitions`, so a later epic cannot move a daemon-derived write into the external table. `canTransition("initiative", "running", to)` returns `true` for `done`, `partial` and `discarded`.
> - Every path in `externalTriggerConsumer` exists on disk, and each named file holds its own trigger id as a literal. The assertion is total over the trigger ids and it fails when one file is absent. `src/commands/outcome/aggregate-objective.ts` appears in no value.
> - **Every node state write of this epic names its trigger**, asserted through a `PlanStore` fake that records its calls. An accepted task report records `outcome-accepted`, a rejected report `attempt-rejected`, a failed report `attempt-failed`, a cancelled report `report-cancelled`, a report at the limit `attempt-limit-reached`, the attestation `object-reported`, the close `human-close` or `human-close-partial`, and the roll-up `initiative-aggregated-done`, `initiative-aggregated-partial` or `initiative-aggregated-discarded`. No other trigger appears.
> - A `setNodeState` call whose trigger row disagrees with the pair written throws and commits nothing. The assertion drives `outcome-accepted` over a `running → ready` pair and drives `human-close` on a `task` node, and the database is byte-identical before and after each.
> - `taskReportEffect` is asserted over the full cross product of the four task outcomes and the exhausted and not-exhausted accountings. **The returned `nodeState` is asserted equal to the `to` of the row that the returned `trigger` names**, so the two representations of the destination can never disagree.
> - `node.show` on a task and on an initiative returns a null `attestedObjectId` and a null `projection`. `node.show` on an objective with one non-terminal task returns a null `projection`. `node.show` on a closed objective still returns the attested object id, read through `latestRunOfNode` from the ended run.
> - A claim over an active run whose `driver` is not the driver of the claim is `409 illegal-transition` and adopts nothing. The fixture writes an internal active run under the objective directly and claims as a harness.
> - `node.report` declares `allowedActors: ["human", "harness"]`, `idempotency: "memory"` and `replayable: [200]`, asserted by operation id. A harness token calling `actor.register` is still `403 actor-forbidden`, so the widening reached this operation only.
> - A replayed `node.report` under a repeated `Idempotency-Key` returns the captured `200` and closes no second attempt. The `attempt` row count and the node row are compared before and after. The same report sent again with no key is `409 illegal-transition`, because the task is already `done`.
> - **The event payload map is total, in both directions.** The scanned event type set of `src/commands/` and `src/services/`, the members of `eventTypes`, and the keys of `eventPayloads` satisfy three relations: every scanned literal of the event-type grammar is a member of `eventTypes`, `eventTypes` minus `retiredEventTypes` is a subset of the scanned set, and the keys of `eventPayloads` equal `eventTypes` by exact set comparison. The assertion is proved to have read at least one file, and it names `src/services/readiness/dependency.ts` among them. It reports a failure when a fixture file writes a thirty-sixth type with no member, and it reports a failure when `eventPayloads` holds a key `eventTypes` does not. `retiredEventTypes` is empty at this epic, and a non-empty value is a finding rather than a pass.
> - `eventTypes` holds thirty-five members, is sorted bytewise through `Buffer.compare`, and holds no duplicate. `eventPayloads[type]` exists for every member, asserted by iteration and never by count.
> - One recorded payload of every **distinct producer shape** parses through `eventPayloads[type]`, taken from the fixture of the test that produces it. `node.done` and `node.partial` each carry two shapes, the close payload and the roll-up payload. An `outcome.reported` payload with a tenth key fails its schema, because every schema is strict on every branch.
> - `eventView.payload` stays `z.unknown()`, so `event.list` parses a row written by an earlier build, and `eventView.type` still accepts an unlisted type string. A test asserts both against a payload that matches no current schema.
> - The parity assertion covers the new row, `src/http/contract/parity.test.ts:16,25` each rise by one, `src/http/contract/field-decisions.fixture.ts` gains the two `node.show` rows plus the derived `node.report.request` and `node.report.response` rows and loses none, and `registryFaults(registry)` is empty.
> - `buildProgram` registers `node report`, `node attest` and `node close`, asserted over the commander command tree of `src/cli/program.ts` and not over the file list. The EPIC 009 inventory parity assertion covers all three, and all three name `node.report`.
> - Every hermetic assertion of `018-claim-and-lease.md:169-215` still passes. The claim-side run reuse is the regression risk, because a second claim now adopts an active run instead of opening one.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 019-outcome-report · Story 19 confirmed + Story 19a node unblock (RED)

**Cycle.** Confirm GREEN for Story 19, then RED for Story 19a (`19a-node-unblock.md`).
**Story 19 GREEN confirmed.**

- command: `npm test -- src/cli/node/report.test.ts src/cli/node/attest.test.ts src/cli/node/close.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/main.test.ts src/http/server/dispatch.test.ts`
- exit: 0 — 83 pass, 0 fail.
- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `src/commands/node/unblock-node.test.ts` (new) — suite: `src/commands/node/unblock-node.test` — methods: `an unblock of an attempt-limit task returns it to the pool`, `readiness promotes a satisfied task in the same transaction`, `an unsatisfied task stays pending`, `the unblock and its event commit together`, `a harness actor is actor-forbidden`, `an absent node is not-found`, `an objective and an initiative are node-kind-invalid`, `a task that is not blocked is not-blocked`, `a block reason other than attempt-limit is block-reason-not-clearable`, `the trigger is manual-unblock`, `the command reads no run, no lease and no workspace`.
- file: `src/http/server/node/unblock-node.test.ts` (new) — suite: `src/http/server/node/unblock-node.test` — methods: `each refusal maps to its declared status`, `the handler parses, invokes once and formats`.
- file: `src/cli/node/unblock.test.ts` (new) — suite: `src/cli/node/unblock.test` — methods: `node unblock prints the returned state`, `node unblock prints a refusal and calls fail`.
- file: `test/helpers/rows.ts` (edited) — added the test-only blocked-reason seed seam.
- asserts: the unblock state, readiness result, event actor and exact payload, atomic rollback in both directions, every refusal without writes, the internal trigger, dependency surface, handler mapping and CLI request/output contract.
  **RED proof.**
- command: `npm test -- src/commands/node/unblock-node.test.ts src/http/server/node/unblock-node.test.ts src/cli/node/unblock.test.ts`
- exit: 1 — 3 fail, 0 pass; failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/cli/node/unblock.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/cli/node/unblock.test.ts`.
- stub probe: `src/commands/node/unblock-node.ts` — clean; `src/http/server/node/unblock-node.ts` — clean; `src/cli/node/unblock.ts` — clean; `npm run typecheck` exited 0, then all stubs were deleted.
  **Open to Software Engineer.**
- `src/commands/node/unblock-node.ts` — exports `UnblockNodeDependencies`, `UnblockNodeInput`, `UnblockNodeResult`, `UnblockNodeError`, and `unblockNode(dependencies, input)`.
- `src/http/server/node/unblock-node.ts` — exports `UnblockNodeHandlerDependencies` and `unblockNodeHandler(dependencies): Handler`.
- `src/cli/node/unblock.ts` — exports `NodeUnblockCliInput` and `registerNodeUnblock(input): void`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · node.unblock

**Cycle.** GREEN+REFACTOR for Story 19a node unblock.
**Files changed.**

- `src/commands/node/unblock-node.ts` (new) — atomic human-only unblock command.
- `src/http/server/node/unblock-node.ts` (new) — request handler and refusal mapping.
- `src/cli/node/unblock.ts` (new) — `node unblock --node <id>` registration.
- `src/http/contract/outcome.ts`, `src/http/contract/error-details.ts` — routed operation contract.
- `src/main.ts`, `src/cli/program.ts`, `src/cli/inventory.ts` — composition and CLI wiring.
- `src/domain/node-trigger.ts`, `src/services/plan/sqlite.ts` — manual trigger and reason clearing.
- `docs/proposal/api/outcome.md` — proposal lifecycle row and unblock contract.
  **Seam (GREEN).** The command uses only storage, plan, events and clock, then commits state and event in one transaction.
  **Refactor.** Applied the named lifecycle, trigger, contract, composition-root and CLI wiring cleanup.
  **Build check.**
- typecheck: exit 0
- app launch: `npm start -- --help` exit 0
  **Assumptions.**
- VERIFIED: `PlanStore.setNodeState` clears `block_reason` when `blockReason` is null, required by the unblock contract.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 19a GREEN confirmation

**Cycle.** Confirm GREEN for Story 19a (`19a-node-unblock.md`).
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
- command: `npm start -- --help`
- exit: 0
  **GREEN proof.**
- command: `npm test -- src/commands/node/unblock-node.test.ts src/http/server/node/unblock-node.test.ts src/cli/node/unblock.test.ts`
- exit: 1 — failure: `✖ an unsatisfied task stays pending (7.7835ms)`; `true !== false`
- result: `ℹ pass 14`, `ℹ fail 1`

ATTEMPT-FAILED: 19a-node-unblock — confirm-GREEN remains red: `an unsatisfied task stays pending` reports `true !== false`

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · unsatisfied unblock readiness

**Cycle.** GREEN+REFACTOR for `src/commands/node/unblock-node.test.ts`.
**Files changed.**

- `src/domain/readiness.ts` (edited) — focused readiness derivation.
- `src/services/readiness/index.ts` (edited) — readiness focus input.
- `src/services/readiness/dependency.ts` (edited) — focused readiness application.
- `src/services/plan/sqlite.ts` (edited) — focus state readiness on the changed node.
  **Seam (GREEN).** `setNodeState` evaluates the changed node and its direct dependents, so an unsatisfied dependency emits no unrelated `node.ready` event.
  **Refactor.** Deferred: no named refactor in the active handoff.
  **Build check.**
- typecheck: exit 0
- app launch: `npm start -- --help` exit 0
  **Assumptions.**
- VERIFIED: dependency state lookup still uses the complete graph while transition emission uses the focused subjects.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · real-composition-root-loop

**Cycle.** RED for Story 20 (`20-real-composition-root-loop.md`).
**Test written.**

- file: `src/main.report.test.ts` (new) — suite: `src/main.report.test` — methods: `the whole loop reaches done through the real composition root`, `two sequential sibling tasks stay with one harness`, `the active run survives a daemon restart and adoption is the only recovery`, `an objective abandoned after a task report is recovered by expiry`, `a replayed report under a repeated Idempotency-Key closes no second attempt`, `a report by a human token and a close by a harness token are each 403 actor-forbidden`, `a task blocked at the attempt limit runs again after an unblock`, `an unblock by a harness token is 403 actor-forbidden`.
- asserts: the real composition root preserves leases, run adoption, idempotent reports, actor policy, aggregation, unblock recovery and durable state.
  **RED proof.**
- command: `npm test -- src/main.report.test.ts`
- exit: 1 — 6 pass, 2 fail; failure: `'running' !== 'done'`
- failure: `actual: [ 'node.ready', 'node.unblocked' ], expected: [ 'node.unblocked', 'node.ready' ]`
- typecheck: `npm run typecheck` — exit 0.
  **Open to Software Engineer.**
- `src/main.ts` — production composition root exercised by `launchDaemon`.
- `src/commands/node/unblock-node.ts` — `node.unblock` behavior exercised through the real HTTP route.

OPEN: 20-real-composition-root-loop — Story 20 requires an initiative `done` with a same-parent dependent objective `ready`; validation rejects cross-parent dependencies, and aggregation requires every child objective terminal.
ATTEMPT-FAILED: 20-real-composition-root-loop — the RED suite exposes an internally inconsistent Story 20 lifecycle contract.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · real-composition-root-loop

**Cycle.** GREEN+REFACTOR for `src/main.report.test.ts`.
**Files changed.**

- none — no production seam can satisfy the exact lifecycle contract.
  **Seam (GREEN).** No valid seam exists: readiness promotes the dependent objective to `ready`, while initiative aggregation requires every child objective to be terminal.
  **Refactor.** Deferred: no safe production refactor exists until Story 20 resolves the contradictory acceptance criteria.
  **Build check.**
- typecheck: exit 0

OPEN: 20-real-composition-root-loop — Story 20 requires an initiative `done` while its same-parent dependent objective is `ready`; `aggregateInitiative` requires every child objective terminal, and `ready` is non-terminal. No existing production seam can satisfy both without changing the contract or violating architecture.
ATTEMPT-FAILED: 20-real-composition-root-loop — the lifecycle assertions are mutually inconsistent; no production edit is valid.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · real-composition-root-loop remains blocked

**Cycle.** Confirm GREEN for Task `20-real-composition-root-loop` (`20-real-composition-root-loop.md`).
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **GREEN proof.**
- command: `npm test -- src/main.report.test.ts`
- exit: 1 — 6 pass, 2 fail; failures: `'running' !== 'done'`; `actual: [ 'node.ready', 'node.unblocked' ], expected: [ 'node.unblocked', 'node.ready' ]`
  **Contract finding.**
- No testable correction preserves the Story 20 assertions: the initiative must be `done` while its same-parent dependent objective is `ready`, but the aggregation contract requires every child objective to be terminal and `ready` is non-terminal. Cross-parent dependency placement is rejected by plan validation.
- The unblock journey also remains red because the Story requires `node.unblocked` before `node.ready`, while the real route returns the reverse event order.
  **Open to Software Engineer.**
- `src/main.ts` — real composition root exercised by `launchDaemon`.
- `src/commands/node/unblock-node.ts` — real HTTP unblock behavior exercised.

ATTEMPT-FAILED: 20-real-composition-root-loop — the lifecycle assertions remain mutually inconsistent, and the event-order assertion remains red

END: TEST-ENGINEER

## HUMAN — 019-outcome-report · escalation resolved

**Cycle.** Resolve the escalation of Task `20-real-composition-root-loop`.
**B1 — lifecycle contract — RESOLVED by amendment.**

- finding: `src/commands/outcome/aggregate-initiative.ts:41` rolls up only when every child objective is terminal. `OBJECTIVE_BETA` is a child of `INITIATIVE_ALPHA`, and `src/domain/plan-validate.ts:273` refuses a cross-parent dependency, so beta cannot move to another initiative. Story 20 step 12 and step 13 could not both hold.
- decision: extend the journey rather than drop the assertion.
- `.agents/plan/stories/019-outcome-report/20-real-composition-root-loop.md` — step 12 now reads `the initiative is still running`, step 13 keeps `the second objective is ready`, and new steps 14 and 15 drive the second objective to `done` and then assert the initiative `done`. Step 5 now names the one task of the second objective.
- `.agents/plan/epics/019-outcome-report.md:145` — the hermetic clause carries the same amendment.
- `src/main.report.test.ts` — the first test asserts `running` after the alpha close, then claims, reports, attests and closes beta, then asserts the initiative `done`.
  **B2 — unblock event order — RESOLVED in production.**
- finding: `unblockNode` called `setNodeState` first, and readiness appends `node.ready` inside that call, so `node.unblocked` landed second. The order the Story names is the causal one.
- `src/commands/node/unblock-node.ts` — the `node.unblocked` append now precedes the state write, inside the same transaction.
- `src/commands/node/unblock-node.test.ts` — the recorder now inserts each append into the `event` table, so `the unblock and its event commit together` proves the rollback in database bytes instead of in a call counter.
  **B3 — awaitingApproval versus ready — RESOLVED by amendment.**
- finding: the focused readiness of the previous cycle derives from the changed node and its direct dependents. An attestation writes `running -> awaiting_approval`, which satisfies no dependency, so no `node.ready` can share that transaction. The EPIC clause was unsatisfiable.
- decision: keep focused readiness. It is the correct incremental rule, and the earlier global sweep promoted unrelated pending nodes inside another actor's transaction.
- `.agents/plan/epics/019-outcome-report.md:172` — the clause now pairs the harness-attributed `node.awaitingApproval` with the daemon-attributed `node.ready` of the task write.
- `src/commands/outcome/report-objective.test.ts` — the fixture drives the task to `done` through the plan store instead of seeding the row, so the daemon-attributed `node.ready` is real.
  **Story 19a gate fallout — RESOLVED in part.**
- `src/http/contract/registry.test.ts` — routed 40, stubbed 26, phase-1 37, phase-2 26, and `node.unblock` added to the response list.
  **Proof.**
- command: the EPIC Proof block of `019-outcome-report.md`
- exit: 0 — 520 pass, 0 fail.
- command: `npm run verify`
- exit: 1 — 4568 tests, 4533 pass, 35 fail.
  **Open.**
- The 35 remaining failures are Story 19a fallout and predate this escalation. Every one is a count or a fixture that the new `node.unblock` operation, the `manual-unblock` trigger and the `node unblock` CLI command move by one: `scripts/publish-contract.test.ts`, `src/cli/inventory.test.ts`, `src/cli/parity.test.ts`, `src/domain/node-trigger.test.ts`, `src/http/contract/coverage.test.ts`, `src/http/contract/example.test.ts`, `src/http/contract/openapi.test.ts`, `src/http/contract/system.test.ts`, `src/http/server/app.test.ts`, `src/http/server/dispatch.test.ts`, `src/http/server/node/list-node.test.ts`, `src/main.test.ts`.
- The dispatch tests need a different stubbed operation id, because the one they name is now routed.

OPEN: 19a-node-unblock — the gate sweep of the new operation is unfinished; `npm run verify` stays red until the twelve files above move their counts.

END: HUMAN

## HUMAN — 019-outcome-report · S1 gate sweep

**Cycle.** Close the Story 19a gate fallout that `npm run verify` reported.
**Production change.**

- `src/domain/state.ts` — new `unblockRefusals` array and `UnblockRefusal` type.
- `src/http/contract/error-details.ts` — `nodeUnblockDetails` imports that array. The restated `z.enum([...])` literal broke the rule that every contract enum traces to a `domain/` import.
  **Count and fixture moves for the new `node.unblock` operation, the `manual-unblock` trigger and the `node unblock` command.**
- `src/cli/inventory.test.ts` — 32 commands, 39 flattened entries, 32 distinct ids, and `node unblock` in the pinned path list.
- `src/cli/parity.test.ts` — 32 program paths, 29 calling entries, 32 distinct ids.
- `src/domain/node-trigger.test.ts` — 16 internal ids and 16 rows, the `manual-unblock` row in the expected table, union 26, and the pair `task|blocked|pending`.
- `src/http/contract/coverage.test.ts` — `node.unblock` adds `illegal-transition`, 36 scoped routed operations, 26 stubbed.
- `src/http/contract/field-decisions.fixture.ts` — the twenty-one `node.unblock.response` rows.
- `src/http/contract/example.test.ts` — 36 scoped operations.
- `src/http/contract/system.test.ts` — 39 responses and `node.unblock` in the list.
- `src/http/contract/openapi.test.ts` — the `node.unblock.error` and `node.unblock.response` components, and the stub check repointed to `node.abandon`.
- `src/http/server/app.test.ts` — 38 unimplemented ids.
- `src/http/server/dispatch.test.ts` — every stubbed-route case repointed to `node.abandon`, 38 unimplemented ids, 26 stubbed routes driven.
- `src/http/server/node/list-node.test.ts` — the `unblock` case removed from the stubbed outcome routes.
- `src/main.test.ts` — a `node.unblock` fixture answering `404`, so no routed operation is left unbound.
- `scripts/publish-contract.test.ts` — 39 example files.
  **Gate.**
- command: `npm run verify`
- exit: 0 — 4567 tests, 4567 pass, 0 fail.
- command: `npm run lint`
- exit: 0.
- command: the EPIC Proof block of `019-outcome-report.md`
- exit: 0 — 520 pass, 0 fail.

END: HUMAN

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** All 21 Stories (01–20, including 19a) are green. No Story remains outstanding. Independent handoff verification passed.

**Gates.**

- `npm run typecheck` — exit 0, through `npm run verify`.
- `npm test` — exit 0 — 4567 pass, 0 fail, 0 cancelled.
- `npm run verify` — exit 0 — lint clean; `kanthord: verify db status ok`.

**Proof.**

- command:
  ```bash
  node --test \
    src/domain/outcome-report.test.ts \
    src/domain/attempt-accounting.test.ts \
    src/domain/external-transition.test.ts \
    src/domain/aggregation.test.ts \
    src/domain/outcome.test.ts \
    src/domain/event-type.test.ts \
    src/services/execution/sqlite.test.ts \
    src/commands/outcome/report-outcome.test.ts \
    src/commands/outcome/report-objective.test.ts \
    src/commands/outcome/aggregate-initiative.test.ts \
    src/commands/outcome/close-objective.test.ts \
    src/commands/node/unblock-node.test.ts \
    src/commands/node/claim-node.test.ts \
    src/queries/node/show-node.test.ts \
    src/http/contract/path.test.ts \
    src/http/contract/event-payload.test.ts \
    src/http/contract/event.test.ts \
    src/http/contract/parity.test.ts \
    src/http/contract/registry.test.ts \
    src/http/server/node/report-node.test.ts \
    src/http/server/node/unblock-node.test.ts \
    src/cli/node/report.test.ts \
    src/cli/node/attest.test.ts \
    src/cli/node/close.test.ts \
    src/cli/node/unblock.test.ts \
    src/main.report.test.ts \
    && echo "PASS EPIC-019"
  ```
- exit: 0 — real output:
  ```text
  ℹ tests 520
  ℹ suites 41
  ℹ pass 520
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  PASS EPIC-019
  ```

**Tasks closed.** 21 across 21 Stories (01–20, including 19a), with no Story outstanding.

```
IMPLEMENTATION_READY_FOR_REVIEW:
- gates: PASS
- proof: PASS (exact EPIC Proof command above) — "PASS EPIC-019"
- stories: 21/21 complete
- date: 2026-08-17
- state: local-uncommitted
```

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 5 action:YES finding(s) to the TDD loop; 5 action:NO finding(s) recorded for the human.
BLOCKER: B3 event payload schemas use invented producer shapes — transcribe affected schemas and fixtures from actual producers.
BLOCKER: B6 stale lease coverage omits expiry sweep and reclaim — add the required sweep, reclaim, stale-owner, and stale-fence scenario.
BLOCKER: B7 unsatisfied unblock coverage omits claim refusal — assert the pending task claim refusal after unblock.
BLOCKER: B8 CLI fence parsing accepts malformed values — validate the whole positive-integer token before the client call.
BLOCKER: S1 redundant field-decision script — remove scripts/derive-field-decisions.mjs and retain the verified coverage assertion.
INFO: B1 node.report error contract mismatch — public details shapes conflict between Story and runtime mapping; human decision required.
INFO: B2 claim driver mismatch details — public discriminator is unspecified; human decision required.
INFO: B4 event registry honesty exceptions — scanner scope versus exact set relations requires human decision.
INFO: B5 objective report clock ownership — Story directives conflict over timestamp capture; human decision required.
INFO: B9 reportOutcome trigger source — literal-consumption heuristic conflicts with single trigger source; human decision required.

## TEST-ENGINEER — reviewer auto-fix · B3/B6/B7/B8/S1

**Cycle.** RED for AUTO_REVIEW findings B3, B6, B7, B8 and S1. Verify paths: `src/http/contract/event-payload.test.ts`, `src/main.report.test.ts`, `src/cli/node/report.test.ts`, `src/cli/node/attest.test.ts` and `src/http/contract/coverage.test.ts`.
**Test written.**

- file: `src/http/contract/event-payload.test.ts` (edited) — suite: `src/http/contract/event-payload.test` — methods: `lease event payloads reject invented string fences`, `credential rejection payloads reject failures the producer never emits`
- file: `src/main.report.test.ts` (edited) — suite: `src/main.report.test` — methods: `an expired lease is swept before reclaim, and stale owner and fence reports are refused`, `an unblocked task with an unsatisfied dependency stays unclaimable`
- file: `src/cli/node/report.test.ts` (edited) — suite: `src/cli/node/report.test` — method: `node report with a fence token that has a numeric prefix refuses and records zero calls`
- file: `src/cli/node/attest.test.ts` (edited) — suite: `src/cli/node/attest.test` — method: `node attest with a fence token that has a numeric prefix refuses and records zero calls`
- file: `src/http/contract/coverage.test.ts` (edited) — suite: `src/http/contract/coverage.test` — method: `the reviewed field-decision coverage has no redundant derivation script`
- asserts: producer payloads use numeric fences and emitted failure values, expired leases sweep before reclaim, stale reports write nothing, pending unblocked tasks refuse claims, malformed fence tokens never call the client, and the redundant script is absent.
  **RED proof.**
- command: `npm test -- src/http/contract/event-payload.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/main.report.test.ts src/cli/node/report.test.ts src/cli/node/attest.test.ts src/cli/node/close.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/commands/node/unblock-node.test.ts src/http/server/node/unblock-node.test.ts src/cli/node/unblock.test.ts`
- exit: 1 — 106 pass, 5 fail; failures: `✖ node attest with a fence token that has a numeric prefix refuses and records zero calls`, `✖ node report with a fence token that has a numeric prefix refuses and records zero calls`, `✖ the reviewed field-decision coverage has no redundant derivation script`, `✖ lease event payloads reject invented string fences`, `✖ credential rejection payloads reject failures the producer never emits`
- typecheck: `npm run typecheck` — exit 0.
  **Open to Software Engineer.**
- `src/http/contract/event-payload.ts` — `eventPayloads: Readonly<Record<EventType, ZodType>>`; the tested producer shapes must parse and invented values must refuse.
- `src/main.ts` — real composition root launched by `test/helpers/daemon.ts` for the lease and unblock route assertions.
- `src/cli/node/report.ts` — `registerNodeReport(input: NodeReportCliInput): void`; reject any fence token that is not one whole positive integer.
- `src/cli/node/attest.ts` — `registerNodeAttest(input: NodeAttestCliInput): void`; reject any fence token that is not one whole positive integer.
- `scripts/derive-field-decisions.mjs` — the redundant script must be absent.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · reviewer auto-fix B3/B6/B7/B8/S1

**Cycle.** GREEN+REFACTOR for AUTO_REVIEW findings B3, B6, B7, B8 and S1.
**Files changed.**

- `src/http/contract/event-payload.ts` (edited) — producer-shaped fence, field, import and credential schemas.
- `src/cli/node/report.ts` (edited) — whole-token safe positive-integer fence validation.
- `src/cli/node/attest.ts` (edited) — whole-token safe positive-integer fence validation.
- `scripts/derive-field-decisions.mjs` (deleted) — removed redundant derivation script.
  **Seam (GREEN).** Event contracts use producer vocabularies, and CLI fences validate before client calls.
  **Refactor.** Removed the redundant field-decision derivation script. B6 and B7 already use the claim sweep and state gate.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: B6 sweeps expired leases before reclaim, and B7 refuses a pending task after unblock in the existing production paths.
- UNVERIFIED: test execution was not run because it belongs to the test-engineer lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Handoff verification.**

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**AUTO_REVIEW action:YES regressions.**

- B3 — PASS — `event-payload.test.ts` parses every producer fixture and rejects invented values.
- B6 — PASS — `main.report.test.ts` covers expiry sweep, reclaim, stale owner and stale fence refusal.
- B7 — PASS — `main.report.test.ts` refuses a claim after an unsatisfied unblock.
- B8 — PASS — `report.test.ts` and `attest.test.ts` reject malformed whole-token fences before client calls.
- S1 — PASS — coverage confirms `scripts/derive-field-decisions.mjs` is absent.

**Test updated.**

- `src/http/contract/event-payload.test.ts` — corrected three fixtures to match producer values: `title`, `import_1` and `auth-failed`.
- Regression command — exit 0 — 111 pass, 0 fail.

**EPIC verification gate.** All 21 Tasks across 21 Stories are green.

- `npm run typecheck` — exit 0.
- `npm test` — exit 0 — 4574 pass, 0 fail, 0 cancelled.
- `npm run verify` — exit 0 — 4574 pass, 0 fail; `kanthord: verify db status ok`.

**Tasks closed.**

- `01` proposal amendment — full `npm run verify` pass.
- `02` EPIC 014 precondition check — `external-transition.test.ts` pass.
- `03` attempt spend clause — `attempt-accounting.test.ts` pass.
- `04` external transition rows — `external-transition.test.ts` pass.
- `05` report effect data — `outcome-report.test.ts` pass.
- `06` execution service methods — `execution/sqlite.test.ts` pass.
- `07` report outcome command — `report-outcome.test.ts` pass.
- `08` outcome event payload — `report-outcome.test.ts` payload cases pass.
- `09` report objective — `report-objective.test.ts` pass.
- `10` aggregate initiative — `aggregate-initiative.test.ts` pass.
- `11` close objective — `close-objective.test.ts` pass.
- `12` consumer on-disk assertion — `external-transition.test.ts` on-disk suite pass.
- `13` event type registry — `event-type.test.ts` pass.
- `14` event payload contract — `event-payload.test.ts` pass.
- `15` node show attested data — `show-node.test.ts` pass.
- `16` readiness after terminal transition — report, attestation, close and roll-up suites pass.
- `17` claim run reuse — `claim-node.test.ts` pass.
- `18` contract row, handler and actor — path, parity, registry and report-handler suites pass.
- `19` composition root and CLI — report, attest, close, program and full verify suites pass.
- `19a` node unblock — command, handler and CLI suites pass.
- `20` real composition-root loop — `main.report.test.ts` pass.

**Proof.**

- command: the exact EPIC Proof command from `.agents/plan/epics/019-outcome-report.md:110-138`
- exit: 0 — real output:
  ```text
  ℹ tests 526
  ℹ suites 41
  ℹ pass 526
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  PASS EPIC-019
  ```

**Tasks closed.** 21 across 21 Stories (01–20, including 19a), with no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (exact EPIC Proof command) — "PASS EPIC-019"
- stories: 21/21 complete
- date: 2026-08-17
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
