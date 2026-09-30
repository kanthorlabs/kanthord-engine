# ERD 2 plan decisions

The plans cite these decisions as D1 to D26. Each decision binds every plan and every task. A decision that repeats an ERD 1 decision names it, and the ERD 1 wording stands where this file says nothing else.

## D1 — A blocker is only a real gap

A blocker is a behavior question that no page, sibling, ERD page or CLI page answers, or a real conflict between two of them. Grep the sources before you write a blocker. Cite the line that proves the gap. Cross-plan alignment, reading a source, splitting a task and a one-line fix are plan work, never a blocker. A gap that an open HANDOFF item names is no blocker: the task implements the page as written and states the gap in one line (`docs/brainstorm/HANDOFF.md`; `.dev/erd-02/README.md` "Decision").

## D2 — Error codes

Every error code has at least three parts (`architecture.impl.md:341–349`, enforced by `engine/src/kernel/errors.ts:8`). Ulrich ruled on 2026-09-29 (R3 of `.dev/erd-02-author/rulings.md`): Aelita chooses every code that a plan needs and no page names, under the naming rule of `architecture.impl.md` "The error codes". A sub-agent proposes the code with the mark `code: proposed` and the page line that rules the condition. Aelita writes the accepted code on its owning page and its `engine/docs/cli/` page before the plan is committed, and `00-index.md` "Codes for Ulrich" lists every such code for the review of Ulrich. A plan uses each code verbatim from its page after that write. A task never marks a code `code: pending`.

## D3 — Reads use `caller.commit`

ERD 1 decision D3 stands. Task 01.0 of ERD 1 fixed the read commit gate (`eba3a9d`). Every handler performs one `caller.commit` at the end on the declared store (`architecture.impl.md:698–699`). The work pull of plan 03 runs rolled-back probe transactions of the full claim on the same store before its one `caller.commit` in the same synchronous tick (`.dev/erd-02/decisions-log.md` 2026-09-30 "the wait mechanism of the work pull", `review:Ulrich`).

## D4 — Collaborations are required

ERD 1 decision D4 stands. Every collaboration in a `Dependencies` type is required. Colocated tests inject fakes. The composition root wires the real implementation in the plan that provides the seam.

## D5 — Boundary, order and the MCP server

Ulrich ruled on 2026-09-29 (R1): the candidate boundary and the candidate order of `.dev/erd-02-author/session-prompt.md` stand, and the MCP server is out of scope. The operations `worker.mcp.message`, `worker.mcp.listen` and `worker.mcp.close`, the record `mcp_session_<ulid>` and the MCP tool source of the tool table belong to the phase that follows the external-harness setup. Plan 06 delivers the action performer as the internal function that the evaluation method of `reviewer@1` calls (`worker-service.impl.md:409–410`). At the `worker` placement (D8) that method runs in `kanthord serve worker`, and the pages give it no transport to the server-internal function without the MCP tool, so plan 06 declares the `client` operation `worker.action.request` as that transport (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06", Q1, `review:Ulrich`); the later MCP tool calls the same function. The external-harness E2E journey of plan 10 covers a node that requires no external action.

## D6 — Consumed seams and stand-ins

An ERD 3 or ERD 4 seam is an inline dependency type in the `contract.ts` of the consuming service, required, never optional (D4). The composition root injects one of two things:

- For an ERD 3 seam (`intake.storage.put`, `get`, `executionGet`, `check`, `delete`; `intake.action.perform`, `intake.action.read`; `intake.action.check`), `src/apps/server/index.ts` passes `unwired("<seam name>")` from `src/apps/server/unwired.ts`, which plan 01 recreates under the ERD 1 D14 mechanism: the call throws `new CodedError("system.composition.unwired", "<seam name> is not wired.")` before work, so the production server fails closed at the call and nowhere else. `architecture.impl.md` "Unwired collaborations" and `engine/docs/cli/other.md` "Error codes" declare this internal code and its Gateway mapping to HTTP 500 `gateway.invocation.unknown` with message `Internal server error.`; Ulrich approved the declaration repair on 2026-09-30. Tests of the helper and internal action-performer classification assert `system.composition.unwired`; HTTP response tests assert `gateway.invocation.unknown`. `gatewayFixture` injects a fake through `standIns` for the E2E of the plan that consumes the seam. The ERD 3 plan set deletes the stand-in and the `unwired` entry of each seam.
- For the ERD 4 seam `TraceIdentity`, the composition root injects the minting stand-in of D7 in production too, because a claim needs a value.

Plan 01 rewrites `src/apps/server/unwired-import.test.ts` so that it asserts the exact set of `unwired` seam names of the plan set, and plan 10 asserts the final set: the eight ERD 3 seams alone.

## D7 — The trace identity and the root span identity

Ulrich ruled on 2026-09-29 (R2): `traceId` is 16 random bytes and `rootSpanId` is 8 random bytes, each written as lower-case hexadecimal under the W3C Trace Context representation, and the all-zero value is invalid (`tracking-service.impl.md` "Trace model"; `scheduler-service.impl.md` "Operation contracts"). No no-op Tracking interface exists in the code (ERD 1 D8), so plan 03 declares `TraceIdentity { mint(): { traceId: string; rootSpanId: string } }` inline in `src/scheduler/contract.ts`, and the composition root injects `{ mint: () => ({ traceId: randomBytes(16).toString("hex"), rootSpanId: randomBytes(8).toString("hex") }) }` from `node:crypto`. The ERD 4 plan set replaces that stand-in with the tracer.

## D8 — Placement

The first version supports a native agent at the `worker` placement, and no proxy exists (`worker-service.impl.md:19`). ERD 2 builds no `server` placement pool and no in-process execution view of custody at the `server` placement (`custody.impl.md:136`). `worker.instance.list` and `worker.instance.get` answer registered instances alone (`worker-service.impl.md:187–189`). Every native execution runs inside `kanthord serve worker` (plan 09) and reaches the server over the HTTP adapter.

## D9 — Plan order and the stand-in table

The order is 01 Mission attempts and human controls, 02 Worker registration, 03 Scheduler execution, 04 Mission execution operations, 05 Custody handover, 06 Worker action performer, 07 native agent runtime, 08 native methods, 09 `worker` application, 10 Gateway composition, CLI and E2E. A plan constructs its seams in `src/apps/server/index.ts` in the ERD 1 construction order scheduler, custody, worker, mission, project, gateway. For a peer seam that a later plan provides, the earlier plan passes `unwired("<seam>")` in production and a `standIns` fake in `gatewayFixture` that answers the true state of the absent peer (ERD 1 D14).

| Seam                                                                              | Placed by | Replaced by |
| --------------------------------------------------------------------------------- | --------- | ----------- |
| Mission `SchedulerClaims.revoke`, `settle`, `liveExecutionOf`                     | 01        | 03          |
| Mission `SchedulerWakeup.wake` (production: a no-op, see below)                   | 01        | 03          |
| Mission `ExecutionAttribution.of`                                                 | 01        | 03          |
| Worker `SchedulerClaims.runningExecutionOfRuntime`                                | 02        | 03          |
| Worker `SchedulerClaims.activityOf` (a pure read: `idle`, `pulling`, `executing`) | 02        | 03          |
| Mission `IntakeStorage`, `IntakeCheck`                                            | 04        | ERD 3       |
| Worker `IntakeActions`                                                            | 06        | ERD 3       |
| Scheduler `TraceIdentity`                                                         | 03        | ERD 4       |

One exception: the production stand-in of `SchedulerWakeup.wake` is a no-op until plan 03, because no work pull exists before plan 03 and a wakeup has no receiver. An ERD 1 graph write answers as before; an `unwired` wake would throw after the commit, and the invocation chain would record a 500 for a committed write. Every production stand-in except `SchedulerWakeup.wake` and `TraceIdentity` is `unwired`; decision D6 states the `TraceIdentity` stand-in. Ulrich confirmed the exception on 2026-09-30.

## D10 — The execution proof

`src/kernel/operation.ts` gains `requiresExecution?: boolean` beside `requiresRegistration` (`operation.ts:54`). For an operation with `requiresExecution: true`, the invocation chain of `src/gateway/invocation.ts` proves the execution identity of the input once before the handler (`architecture.impl.md:646–659`): the claimant runtime identity equals the runtime identity of the live registration that the machine identity names, `ended_at` is null and the time is before `expired_at`. The chain reads the execution row through a Scheduler lookup in `createInvocation(options.lookups.scheduler)`, which plan 03 adds beside `lookups.project` and `lookups.worker`. A failed proof answers 403 `gateway.invocation.execution_proof_failed`. The chain passes `caller.execution = { executionId, projectId, nodeId, attempt, pinnedRevision, runtimeIdentity, workerBindingId }` to the handler, and the handler reads none of them from the input. The execution identity of the input is the path parameter `executionId` where the route holds one, and otherwise the body field `executionId` of `ExecutionContext` (`engine/docs/cli/mission.md` "Execution submissions"). Every execution mutation repeats the full proof inside its write transaction and answers 409 `scheduler.execution.not_running` on failure. Plan 03 owns the chain edit; every later plan declares the flag on its operations.

## D11 — Registration store

Plan 02 replaces `InMemoryRegistrations` (`src/worker/registrations.ts`) with an implementation over `worker_instance`. The `WorkerRegistrations` interface of `src/worker/contract.ts:144` keeps `findByClient(clientId)` for the Gateway lookup of `createInvocation`, and that read runs outside a transaction on the store, because authentication runs before the handler and before `caller.commit` (`src/gateway/authentication.ts:56–72`). `register(transaction, client)` and `deregister` take the transaction of the handler. The runtime identity prefix becomes `worker_instance` (`worker-service.impl.md:153`), and the output schema of `worker.register` validates it with `identitySchema("worker_instance")` in place of the 128-character bound. The composition root passes no `registrations` option for the production server; `gatewayFixture` keeps its `machines` option for the tests that fake the binding resolver.

## D12 — Heartbeat clock

The time of the last heartbeat is a monotonic value in memory (`docs/reference/erd/02-execution.md:28`), a `Map<runtimeIdentity, number>` from `performance.now()`. The server start sets every live row to the start reading. A sweep every 30 s ends every registration whose reading is older than `worker.heartbeatWindow` seconds (`worker-service.impl.md:171`). Every authenticated request of a registered client identity renews the reading in the invocation chain after authentication, so plan 02 adds that renewal to `resolveMachine` of `src/gateway/authentication.ts` through an `AuthenticationLookups.worker.heartbeat(runtimeIdentity)` closure, after the registration checks pass.

## D13 — Handover codec

The AES-256-GCM envelope and the two HKDF keys of the handover (`custody.impl.md:85–92`, `:140–157`) live in `src/kernel/handover.ts`, because the `worker` application and custody both need them and the boundaries of `eslint.config.js` permit a kernel import from every element. Custody owns the payload selection and the pin; the kernel module owns the codec alone. `deriveHandoverKeys(clientSecret)` answers the handover key and the refresh-report key. The additional authenticated data concatenates the length-prefixed execution identity and runtime identity.

## D14 — Prompt assets

The three prompt texts of `docs/brainstorm/assets/prompt/` (`base.md`, `swe@1.md`, `re@1.md`) are copied verbatim into `engine/static/prompt/` by plan 07, next to `static/openapi/`. The catalog declaration reads them at startup and refuses a missing file. `worker.agent.get` answers `basePrompt` and `agentPrompt` from those files (`worker-service.impl.md:186`). A change of a text is a new worker version and a root ruling, never a plan task.

## D15 — E2E of the native runtime

The internal-harness journey constructs the `Worker` application of `src/apps/worker/index.ts` in-process, in the test process of `gatewayFixture`, with two injected dependencies in `WorkerOptions`: a `ModelRuntime` factory that installs the scripted fake provider of D16, and a `RepositoryConnector` whose clone, fetch and push target a local bare repository that the test creates. The repository binding keeps its SSH address, and the fixture repository connector of ERD 1 answers the `git ls-remote` of the binding write. `kanthord serve worker` as a subprocess proves startup, registration, the ready record and deregistration alone. No production code reads an environment variable for a fake.

## D16 — The scripted fake provider

The E2E of a plan with an agent runtime uses the scripted fake provider (`worker-service.impl.md:482`). The fake is a pi-ai 0.86.0 provider registered under the provider id of the enablement through the provider registration of pi-ai (`setProvider`, `worker-service.impl.md:101`) inside the test process only, with an `api` that answers a scripted sequence of assistant turns and tool calls. Every fixture uses the model `claude-sonnet-4-5` and a complete entry form `{ agent, agentProvider, modelIdentifier, reasoningEffort }` (ERD 1 decision log 03.5 and 05.E). No plan performs a real provider call. The real-provider smoke run stays out of scope.

## D17 — Object evidence in the E2E

Plan 04 proves the object flow with a `standIns` fake of `IntakeStorage` in `gatewayFixture` that answers a presigned PUT and GET against an in-process HTTP sink of the test, and a `check` that reads the sink. Production passes `unwired` under D6, so `mission.evidence.submit` with an `object` asset throws internal `system.composition.unwired` and the Gateway answers HTTP 500 `gateway.invocation.unknown` until ERD 3. The object transfer and the `mission.evidence.request` step of an E2E run through `httpClient(missionOperations, …)` from the test process, because the test acts as the host component and no CLI command projects the request.

## D18 — Consecutive loss count

The loss declaration counts the lost rows of the attempt after its latest finished row with a scan of the `scheduler_execution` rows of the node (`docs/reference/erd/02-execution.md:222`). The open HANDOFF item of the Mission Service on that scan names the gap, so the plan implements the scan and raises no blocker (D1).

## D19 — Handover payload

In ERD 2 the handover carries the credential of the effective agent provider of the execution and nothing else (`custody.impl.md:143`, `worker-service.impl.md:285`). A network git operation uses the SSH configuration of the host (`repository.impl.md` "The SSH environment"), and every platform action runs on the server (`worker-service.md:219`), so no repository platform key enters a handover.

## D20 — Wakeups

Plan 03 declares `SchedulerWakeup { wake(projectId: string): void }` in `src/scheduler/contract.ts`. The Mission Service calls it after `caller.commit` returns, never inside the transaction (`mission-service.md:692`). The Scheduler coalesces wakeups per project and serves the waiting work pulls of that project in queue order (`scheduler-service.md:116–117`).

## D21 — Counters of the Mission records

`mission_attempt.attempt`, `mission_assessment.sequence` and `mission_outcome.sequence` take `max(current) + 1` inside the inserting transaction, from 1 with no gap (`docs/reference/erd/02-execution.md:233`, `:270`, `:276`). `mission_node.attempt` equals the highest attempt number. A JSON set column (`evidence_ids`, `child_outcome_ids`, `credentials`) holds a canonical JSON array with no duplicate.

## D22 — Plan size

A task is one commit of fewer than about 400 changed lines. A plan holds at most twenty tasks. The native agent runtime is split into plan 07 (the runtime foundation) and plan 08 (the two methods) for that reason.

## D23 — Standing precedents

Two ERD 1 precedents need no debate (`.dev/erd-02/README.md`): an OpenAPI fragment over the line bound takes a named, shape-checked exception in `src/apps/server/openapi-integration.test.ts`, listed in the decision log; a colocated service test that needs a minted identity takes the per-file eslint exception of `eslint.config.js`, once per service. Commit `bf550c2` of ERD 1 replaced the per-file exceptions with the `test-identity.ts` seam, so no ERD 2 plan changes an identity exception of `eslint.config.js`. One named boundary change stands: plan 09 lets the element `apps-worker` import `src/worker/index.ts` (the native runtime entry of plan 07) and `src/repository` (the transport), because `kanthord serve worker` hosts the native runtime (`worker-service.impl.md:227`) and the ERD 1 boundary admitted only `contract.ts` and the Gateway client. Plan 02 adds `testMachineIdentity` to `src/kernel/test-identity.ts`, and plan 03 adds it only when plan 02 has not. Two test-file allowances follow from decision D15, because the in-process journeys run in `src/apps/server/`: the test files of `apps-server` (`src/apps/server/test-support.ts` and `src/apps/server/*.test.ts`) import `src/worker/test-support.ts` (the scripted provider; plan 07 task 07.E adds the policy) and the application entry of `apps-worker` (the in-process worker helper; plan 09 task 09.3 adds the policy). No production file of `src/apps/server/` gains either import.

## D24 — Database conventions

No SQL `CHECK`. No index that is not unique; a partial unique index is allowed. No `REFERENCES` clause across owners; the ERD marks every cross-owner reference `no FK`, and the `FK` labels inside the Mission group (`mission_attempt.node_id`, `mission_evidence.node_id`, `mission_evidence_asset.evidence_id`, `mission_assessment.node_id`, `mission_outcome.node_id`, `mission_outcome.assessment_id`) take a `REFERENCES` clause. Every closed value set is an enum in code. A table carries the prefix of its owner. `project_id` is the second key column of `worker_instance` and `scheduler_execution` alone; the Mission records are keyed by `node_id`.

## D25 — The `worker` application under B9 gaps

Shutdown during a live execution, a registration or a work pull with no answer, and a stop deadline in those cases stay B9 (`worker-service.impl.md:246`). Plan 09 implements the page as written: a `SIGINT` or `SIGTERM` during a live execution aborts the agent, performs no release, deregisters nothing and exits 1, and the deadline of the execution settles the loss. A `clientSecret` that fails every decryption ends the execution the same way (`worker-service.impl.md:304`). Each task that meets one of these cases states the gap in one line.

## D26 — Pre-existing deviations are findings, not blockers

ERD 1 decision D16 stands. `static/openapi.yaml` predates ERD 1. Seven items of `.dev/erd-01/report.md` "Pending for Ulrich" stay pending, and no ERD 2 plan resolves one of them. `worker provider check` (`engine/docs/cli/worker.md` "provider check") has no ERD 1 or ERD 2 plan; Ulrich left it to the phase after the external harness (2026-09-30), and plan 10 task 10.6 exempts it by name. Plan 02 owns the complete machine-JWT claim transition (`project_id`, `resource_identity`, the tombstone rule of `gateway-service.impl.md:129–131`, the direct-adapter recheck, the CLI form `jwt generate --project <projectId> --binding <binding name>` and the affected fixtures; ruled 2026-09-30, S8), because the ERD 1 resolver let a token of a removed binding resolve again after a rebind.
