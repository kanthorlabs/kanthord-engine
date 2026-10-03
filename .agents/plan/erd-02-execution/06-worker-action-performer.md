# Plan 06: Worker Service — action performer

## Scope

This plan delivers:

- The internal action performer of the Worker Service: the admission of one execution identity (a live claim, an evaluation claim and a current passing assessment), the eligibility read, the operand derivation from the records, the reuse of an earlier pull request through `intake.action.read`, the dispatch through `intake.action.perform`, the request submission through `mission.evidence.request`, and the four return classes.
- The per-execution-identity mutex and the in-memory dispatch reservation of the page, keyed by the node, the attempt and the requirement key, which keep the no-redispatch invariant inside one server process.
- The operation `worker.action.request`, the transport of the evaluation method of `reviewer@1` at the `worker` placement to the internal function (`worker-service.impl.md:410–414`; ruled 2026-09-30 on `worker-service.impl.md` "Action performer").
- The Mission Kind 2 read collaboration `MissionActions.actionContextOf`.
- The ERD 3 seam `IntakeActions` with its `unwired` production entries and its `gatewayFixture` fake `scriptedActions`.
- The shared node-branch name `nodeBranchOf`, which plans 07 and 08 consume.
- The refusals `worker.action_performer.claim_not_evaluation`, `worker.action_performer.assessment_not_current` and `worker.action_performer.snapshot_absent`.

Out of scope:

- The MCP server, its session, its three operations and the MCP tool `repository-action-request` (decision D5). The tool later calls the same internal function.
- The evaluation method that calls the operation (plan 08) and the `worker` application that hosts it (plan 09).
- `intake.action.perform`, `intake.action.read` and every Intake mechanism (ERD 3). Production throws internal `system.composition.unwired` at the first Intake call; the Gateway answers HTTP 500 `gateway.invocation.unknown` (decision D6).
- Real Intake outbound request persistence (ERD 3), retrieval of a lost acknowledgement (B9 W3), and what follows a failure or an uncertainty (B9 A3, W1, W4, PR2). The Intake outbound request is the durable dispatch record for configured actions; B9 W2 does not own that record.
- The `awaiting-prerequisite` production path. The first version produces no such item (`worker-service.impl.md:441`); the schema holds the variant.
- A CLI leaf. No CLI command calls the performer (`worker-service.impl.md:414`, `:467`; `engine/docs/cli/mission.md:502–503`).

This plan creates no table (`docs/reference/erd/02-execution.md:23`, `:30`).

## Sources

- `docs/brainstorm/worker-service.md:445–456` — every reviewer execution, the execution identity alone, the three checks, the operands from the records and the evidence snapshot, the Intake call, no workspace, the serialization and the no-redispatch invariant.
- `docs/brainstorm/worker-service.md:458–466` — the four return classes and no release rule for a failure or an uncertainty.
- `docs/brainstorm/worker-service.md:517–549` — the evaluation paths, the eligibility, the operand derivation, the reuse conditions, the submission through `mission.evidence.request` and the release rule of the reviewer execution.
- `docs/brainstorm/worker-service.md:292–296` — one node branch for each objective and repository binding, named from the node identity in the form `kanthord/<node identity>`.
- `docs/brainstorm/worker-service.vocabulary.md:193–221` — "action performer" and "return class", with the examples `kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAV`, `main` and pull request 42.
- `docs/brainstorm/worker-service.vocabulary.md:313–318` — "node branch".
- `docs/brainstorm/worker-service.impl.md:407–443` — one internal function, the operation `worker.action.request` and its route, the mutex, the dispatch reservation, the in-process scope, the answer `{ toolName, items }`, the item shapes and the three refusal codes.
- `docs/brainstorm/worker-service.impl.md:334`, `:467–468`, `:472`, `:485–488` — the action performer path of a platform action, no REST projection of a tool, the 900 s timeout of the MCP operations, the idempotency of the one write and the two refusal codes of the tool.
- `docs/brainstorm/worker-service.impl.md:546` — the acceptance path includes the configured repository action.
- `docs/brainstorm/intake-service.impl.md:44–49`, `:53` — the forwarded identity, `intake.action.perform`, the clone of a `merge_push` and of a pull-request reuse, `intake.action.read` and no Mission record.
- `docs/brainstorm/repository.md:56–64`, `:73–78` — the configured-action write, its operands from the records, the ownership of eligibility, operands, serialization and idempotency, and the result classes.
- `docs/brainstorm/repository.vocabulary.md:28–42` — the four result classes.
- `docs/brainstorm/repository.impl.md:17–19`, `:26`, `:34` — the pull-request read, the unchanged body and the result-class code `repository.platform.github.<class>`.
- `docs/brainstorm/mission-service.impl.md:77–93` — `FrozenAction`, `mission.evidence.request`, the reuse as a new request evidence and its refusals.
- `docs/brainstorm/mission-service.impl.md:243–249` — `requirement_key`, `PlatformAddress` and the four resolutions.
- `docs/brainstorm/mission-service.impl.md:259–260` — the eligibility of the reviewer release predicate and `mission.release.obligation_unmet`.
- `docs/brainstorm/architecture.impl.md:592–612` — the three kinds, the written atomicity reason of a Kind 2 collaboration and no peer table.
- `docs/brainstorm/architecture.impl.md:613–623`, `:647–660`, `:662–674`, `:679–703`, `:715–721`, `:737` — the two adapters, the execution proof, the one caller kind, the caller propagation, the handler that separates asynchronous work from its commit, the idempotency and the three client results.
- `docs/brainstorm/gateway-service.impl.md:293–303` — the request context, its cancellation at a disconnect, the 900 s timeout of a call that runs a tool of the Worker Service and of `worker.action.request`, and `hono/timeout`.
- `docs/reference/erd/02-execution.md` — an unrequested action, the in-memory mutex, proof inside every execution mutation, reviewer release and request rules. `intake-service.md` "Outbound requests" owns durable dispatch idempotency.
- `engine/docs/cli/worker.md:613–658`, `:686–689`, `:752–754` — the MCP and repository actions, the `worker.action.request` paragraph, the action performer results, the two refusal codes of the tool and the error rows of the three refusal codes.
- `engine/docs/cli/mission.md:493–515`, `:849` — the request evidence and `mission.evidence.request` without a CLI command.
- `docs/brainstorm/HANDOFF.md:114–123` — B9 SC5, the two live processes of one machine JWT, A3/W1/W4/PR2, W2, W3 and W7.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06" — the Mission read and the classification (debate, 2 rounds, `review:Ulrich`). The transport and the dispatch reservation are ruled 2026-09-30 on `worker-service.impl.md` "Action performer", and the branch form is ruled 2026-09-30 on `worker-service.md` "Executions".
- Root `AGENTS.md` "Contracts", "Database design" and "Rejected proposals".

## Depends on

- ERD 1, merged. The Worker Service of `src/worker/` with `Dependencies` (`src/worker/service.ts:158–166`), `declare` (`:681–739`) and `workerOperations` (`src/worker/contract.ts:209–347`); the direct adapter `directClient` (`src/gateway/direct-client.ts:4–15`); `ClientOptions` and `OperationResult` (`src/kernel/operation.ts:171–191`); `ulid` of the `ulid` package (`src/kernel/identity.ts:2`; `src/apps/cli/shared.ts:133`); the composition root (`src/apps/server/index.ts:62–191`) and `gatewayFixture` (`src/apps/server/test-support.ts:125–252`).
- Plan 01. `requiredActionsOf`, `actionStatesOf` and `eligibleUnrequested` of `src/mission/frozen-action.ts`; `currentAssessmentOf` of `src/mission/currency.ts`; `readRequests`, `readAssets` and `readAssessment` of `src/mission/record-store.ts`; the record schemas of task 01.2; `missionHarness` of `src/mission/test-support.ts`; `ProjectBindings.repositoryPolicyOf`; `src/apps/server/unwired.ts` and the `standIns` option of `composeServices` and `gatewayFixture`.
- Plan 02. `store: Store` and the inline Worker `SchedulerClaims` in `Dependencies`; `worker.register` over `worker_instance`; `MachineIdentity.resourceIdentity`; `testMachineIdentity` of `src/kernel/test-identity.ts`.
- Plan 03, through `00-index.md` "Seams": `SchedulerClaims.requireRunning`; the execution proof (`Operation.requiresExecution`, `caller.execution` with `{ executionId, projectId, nodeId, attempt, pinnedRevision, runtimeIdentity, workerBindingId }`, 403 `gateway.invocation.execution_proof_failed`); the CLI leaves `scheduler work pull`, `scheduler execution release` and `scheduler claim get`.
- Plan 04. `mission.evidence.request` at `POST /api/mission/node/:nodeId/evidence/request` with every `ExecutionContext` field plus `requirementKey`, `subject` and `address`; `mission.evidence.submit`, `mission.assessment.submit` and `mission.node.check` with their CLI leaves; `scriptedCheck` of `src/apps/server/test-support.ts`; the pre-read convention with `store: Store` (`00-index.md` "Shared conventions", row "Consumed seams").
- Plan 05, through `00-index.md` "Plans": the Worker contract edits of `worker.handover` and `worker.credential`. This plan appends after them.

## Provides

Before protected Intake operations, consume Mission authorization of the FrozenAction or request evidence. Project only resolves pinned binding revisions. Publish 403 `mission.authorization.refused` for `worker.action.request`, with the five reasons declared by `mission-service.impl.md` "Authorization integration".

The performer derives `<node id>/<attempt>/<FrozenAction.key>` and appends `/<snapshot commit>` for `merge_push`, passing it as the fourth `IntakeActions.perform` argument. The Intake outbound request is the durable dispatch record. Keep the in-memory reservation. The fake reads back a prior result for that key; another write after failure requires human removal of the failed fake request. No Intake table or production outbound-request implementation belongs to ERD 2.

| Seam                             | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Owner file                        | Consumer plans |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| `worker.action.request`          | `client` mutation, `requiresExecution: true`, `POST /api/worker/execution/:executionId/action/request`, empty body; answers `ActionRequestResult` = `{ toolName: "repository-action-request"; items: ActionResultItem[] }`                                                                                                                                                                                                                                                                                                                                | `src/worker/contract.ts`          | 08, 09, 10     |
| `ActionResultItem`               | `{ kind: "submitted"; evidence: Evidence }` \| `{ kind: "awaiting-prerequisite"; action: { key; bindingId }; prerequisite: { key; evidenceId } }` \| `{ kind: "failed-before-effect"; action: { key; bindingId }; refusal: { class: "confirmed_failure" \| "retryable_refusal" \| "final_refusal"; code; message } }` \| `{ kind: "uncertain"; action: { key; bindingId }; uncertainty: "effect" \| "recording" \| "both"; address?: PlatformAddress }`                                                                                                   | `src/worker/contract.ts`          | 08, MCP phase  |
| `MissionActions.actionContextOf` | `(tx: Transaction, nodeId: string, attempt: number): ActionContext`, with `ActionContext = { state: NodeState; currentAssessment: { result: AssessmentResult; testedInput: TestedInput } \| null; actions: { action: FrozenAction; resourceIdentity: string; resolution: Resolution; requestEvidenceId: string \| null; eligible: boolean; reuseCandidates: { evidenceId: string; attempt: number; address: PlatformAddress }[] }[] }`                                                                                                                    | `src/mission/contract.ts`         | 06             |
| `IntakeActions` (declared)       | `perform(call: IntakeActionCall, action: FrozenAction, operands: ActionOperands, requestKey: string): Promise<PlatformAddress \| ResultClassAnswer>`; `read(call: IntakeActionCall, method: "github-pull-request-get", address: PlatformAddress): Promise<{ body: unknown } \| ResultClassAnswer>` — `IntakeActionCall = { context: Context; identity: CallerIdentity; executionId: string }`, `ActionOperands = { nodeBranch; baseBranch; commit; reusedAddress: PlatformAddress \| null }`, `ResultClassAnswer = { class: ResultClass; code; message }` | `src/worker/contract.ts`          | ERD 3          |
| `nodeBranchOf`                   | `(nodeId: string): string` — `"kanthord/" + nodeId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `src/worker/node-branch.ts`       | 07, 08         |
| `scriptedActions`                | `(): { seam: IntakeActions; performAnswers: Answer[]; readAnswers: Answer[]; performCalls: Call[]; readCalls: Call[]; hold(): () => void }`                                                                                                                                                                                                                                                                                                                                                                                                               | `src/apps/server/test-support.ts` | 08, 09, 10     |

The `IntakeActions` signature differs from the sketch of `00-index.md` "Seams": each method takes `IntakeActionCall` with the execution identity, because the Intake operation runs under the forwarded execution identity and refuses another node before custody releases a secret (`intake-service.impl.md:44`, `:46`; `:79`). `perform` answers `unknown_outcome` for every failure after a write may have started (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06", Q4). A thrown error of `read` starts no write. A thrown error of `perform` proves that no write started only with the code `system.composition.unwired` of the D6 stand-in. Every other thrown error of `perform` keeps the reservation as `uncertain` with `uncertainty: "effect"` (`worker-service.impl.md:422–424`).

## Tasks

### 06.1 Declare the performer contract and its error codes

- Files: `src/worker/contract.ts` (edit), `src/worker/contract.test.ts` (create)
- Do:
  1. Declare `ACTION_REQUEST_TOOL_NAME = "repository-action-request"` and `ACTION_REQUEST_TIMEOUT_MS = 900000`.
  2. Declare these closed sets as `as const` objects with a `z.enum` schema and a type each: `ActionResultKind` (`submitted`, `awaiting-prerequisite`, `failed-before-effect`, `uncertain`); `RefusalClass` (`confirmed_failure`, `retryable_refusal`, `final_refusal`); `ResultClass` (the three values of `RefusalClass` plus `unknown_outcome`); `Uncertainty` (`effect`, `recording`, `both`); `ActionReadMethod` (`github-pull-request-get`).
  3. Declare inline with `z.strictObject`: `platformAddressSchema` as the discriminated union of `{ kind: "pull_request", resourceIdentity, number: positive safe integer }` and `{ kind: "branch_push", resourceIdentity, branch, commit }`; `actionRefSchema` `{ key, bindingId }`; `actionResultItemSchema` as the discriminated union on `kind` of the four shapes of the Provides row, where `evidence` is `z.record(z.string(), z.unknown())` described as the Mission `Evidence` record and `address` is optional; `actionRequestResultSchema` `{ toolName: z.literal(ACTION_REQUEST_TOOL_NAME), items: z.array(actionResultItemSchema) }`.
  4. Add to `WorkerErrorCode` (`src/worker/contract.ts:156–174`): `ClaimNotEvaluation: "worker.action_performer.claim_not_evaluation"`, `AssessmentNotCurrent: "worker.action_performer.assessment_not_current"`, `SnapshotAbsent: "worker.action_performer.snapshot_absent"`.
  5. In `contract.test.ts`, assert that each item shape parses, that `refusal.class: "unknown_outcome"` fails, that an unknown `kind` fails, that `toolName` accepts only the literal, and that a `branch_push` address without `commit` fails.
- Rules:
  - The answer and the item shapes. `worker-service.impl.md:432–440`; `engine/docs/cli/worker.md:632–643`.
  - The request evidence is the Mission `Evidence` record, passed unchanged. `engine/docs/cli/worker.md:642`. No service `contract.ts` imports a peer `contract.ts` (`00-index.md` "Collaboration-type contract rule"), so the field keeps the record unchanged without the Mission schema.
  - `PlatformAddress` holds `kind` and `resourceIdentity`, a `pull_request` adds `number`, a `branch_push` adds `branch` and `commit`, and it never holds a `bindingId`. `mission-service.impl.md:244`.
  - The result classes. `repository.vocabulary.md:28–37`; `worker-service.impl.md:437–438`.
  - `worker.action_performer.claim_not_evaluation` and `worker.action_performer.assessment_not_current` stand on `worker-service.impl.md:443`, `:487` and `engine/docs/cli/worker.md:688–689`. Status 409, as `mission.execution.claim_not_evaluation` (`00-index.md` "Codes for Ulrich"). The error table holds both rows at `engine/docs/cli/worker.md:752–753`.
  - `worker.action_performer.snapshot_absent` (409): the current passing assessment names no repository snapshot of the binding of the action. `worker-service.impl.md:443`; `engine/docs/cli/worker.md:754`. The condition stands at `worker-service.md:452` ("obtains every operand from the records and the evidence snapshot") and `repository.md:60`.
  - Every closed value set is an enum in code. Root `AGENTS.md` "Database design"; `architecture.impl.md:15–19`.
- Done when: `pnpm run verify` passes; `contract.test.ts` passes.

### 06.2 Add the Mission collaboration `actionContextOf`

- Files: `src/mission/contract.ts` (edit), `src/mission/action-context.ts` (create), `src/mission/action-context.test.ts` (create), `src/mission/service.ts` (edit)
- Do:
  1. Declare `ActionContext` and `MissionActions { actionContextOf(tx, nodeId, attempt): ActionContext }` in `src/mission/contract.ts` with the signature of the Provides row. Document the invariant on the interface: the claim proof of the caller, the evaluation claim, the current passing assessment and the eligibility hold on one database snapshot; the snapshot guarantees no liveness through a later external operation.
  2. Implement `actionContextOf(tx, dependencies, nodeId, attempt)` in `action-context.ts`:
     - `readNode` (`src/mission/store.ts:203`); assert a row. Answer `state`.
     - `currentAssessmentOf(tx, nodeId, attempt)`; answer its `result` and its `testedInput`, or null.
     - `actionStatesOf(tx, bindings, nodeId, attempt)` and `eligibleUnrequested(states)`. For each state answer the `FrozenAction`, `resolution`, `requestEvidenceId` (the request evidence of the attempt, or null) and `eligible` (membership in the eligible set).
     - `resourceIdentity` of the action from `bindings.getBindingRevision(tx, action.bindingId)`.
     - `reuseCandidates`: for each earlier attempt from `attempt - 1` down to 1, the rows of `readRequests(tx, nodeId, a)` whose `requirement_key` equals the key, with the `platform` asset of `readAssets` whose address kind is `pull_request`. Keep the first row of each canonical address (RFC 8785, `src/kernel/json.ts:12`).
  3. Add `MissionActions` to the `implements` clause of `MissionService` (`src/mission/service.ts:81`) and implement `actionContextOf(tx, nodeId, attempt)` beside `liveNodesPinning` (`:356`).
  4. Add tests with `missionHarness`: an initiative answers `actions: []`; an unrequested action answers `eligible: true`; a requested action of the attempt answers `unresolved` with its evidence and `eligible: false`; a request evidence of attempt 1 appears in `reuseCandidates` of attempt 2 and never in attempt 1; two earlier attempts with one address answer one candidate of the newer attempt; a `branch_push` request is no candidate; an attempt with no assessment answers `currentAssessment: null`; the call opens no transaction of its own.
- Rules:
  - A Kind 2 collaboration takes the caller transaction and serves an invariant that must hold atomically across the tables of two services; its interface documents it. `architecture.impl.md:592–595`. The invariant is the snapshot of the admission (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06", Q2, `review:Ulrich`).
  - A service names no table of a peer. `architecture.impl.md:612`.
  - The performer reads the required external actions of the attempt and the request evidence of the node across every attempt. `worker-service.md:521–522`.
  - The eligibility is the rule of the reviewer release predicate, computed by the same function. `worker-service.md:523–524`; `mission-service.impl.md:259`.
  - A reuse candidate names the same requirement key and belongs to an earlier attempt. `worker-service.md:531–532`; `mission-service.impl.md:91`.
  - A `merge_push` never reuses an address: its `branch_push` address names the commit of its own push, and the performer uses the address that the current push answers. `mission-service.impl.md:244`; `intake-service.impl.md:47`.
  - The four resolutions. `mission-service.impl.md:249`.
  - A consuming plan adds the collaboration that it needs to its owner. `00-index.md` "Shared files"; this plan adds one Mission row there (report).
- Done when: `pnpm run verify` passes; the eight tests pass.

### 06.3 Declare the consumed seams, wire them and add the fixture fake

- Files: `src/worker/contract.ts`, `src/worker/service.ts`, `src/worker/service.test.ts`, `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/unwired-import.test.ts` (all edit)
- Do:
  1. Declare inline in `src/worker/contract.ts`, with method syntax: `FrozenAction` `{ key, bindingId, action: "pull_request" | "merge_push", expectedEndState, follows: string | null, configuration: { baseBranch } }`; `ActionContext` and `MissionActions` with the shape of task 06.2; `IntakeActionCall`, `ActionOperands`, `ResultClassAnswer` and `IntakeActions` with the signatures of the Provides row; `EvidenceRequests { request(input: { params: { nodeId }; query: {}; body: { executionId; attempt; nodeRevision; requirementKey; subject; address: PlatformAddress } }, options: ClientOptions): Promise<OperationResult<unknown>> }`.
  2. Add `requireRunning(tx, executionId, runtimeIdentity, now): { executionId; nodeId; attempt; pinnedRevision }` to the inline Worker `SchedulerClaims` of plan 02.
  3. Add `missionActions: MissionActions`, `intakeActions: IntakeActions` and `evidenceRequests: EvidenceRequests` to `Dependencies` (`src/worker/service.ts:158–166`) as required fields.
  4. In `composeServices` (`src/apps/server/index.ts:62–191`): build `const missionClient = directClient(missionOperations, invocation)` after `invocation`; pass `evidenceRequests: { request: (input, options) => missionClient["evidence.request"](input, options) }`, `missionActions: { actionContextOf: (tx, n, a) => mission.actionContextOf(tx, n, a) }` and `requireRunning: (tx, e, r, n) => scheduler.requireRunning(tx, e, r, n)` to the Worker Service. Extend `standIns` with `intakeActions?`; without it pass `{ perform: unwired("IntakeActions.perform"), read: unwired("IntakeActions.read") }`.
  5. In `gatewayFixture` (`src/apps/server/test-support.ts:125–138`), extend `standIns` with `intakeActions?`. The default is the same unwired object, the true state of the absent ERD 3 peer.
  6. In `src/apps/server/test-support.ts`, export `scriptedActions()`. `perform` and `read` record `{ call: { executionId }, action, operands }` or `{ call: { executionId }, method, address }`, await the gate of `hold()` when one is set, then answer the first entry of `performAnswers` or `readAnswers` and remove it. An empty queue throws `Error("no scripted answer")`. `hold()` sets a gate and answers its release function.
  7. In `unwired-import.test.ts`, add `IntakeActions.perform` and `IntakeActions.read` to `UNWIRED_SEAMS`.
  8. In `src/worker/service.test.ts`, give every harness fakes of the three new fields and of `requireRunning` that throw `UNEXPECTED_COLLABORATION` by default.
- Rules:
  - A collaboration type is declared inline in the own `contract.ts` of the service, and the composition root is the only file that imports cross-service types. `00-index.md` "Collaboration-type contract rule"; `src/project/service.ts:16`.
  - Every collaboration is required. Decision D4.
  - An ERD 3 seam is `unwired` in production and a fake in `gatewayFixture`. Decisions D6, D9 (row `Worker IntakeActions | 06 | ERD 3`).
  - Kind 3 is the default: the performer calls `mission.evidence.request` through the direct adapter with the identity of its caller. `architecture.impl.md:607–608`, `:619–620`, `:681–684`; `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 04", Q1.
  - The client is built once and holds no fixed identity. `architecture.impl.md:619`, `:685`.
  - `intake.action.perform` and `intake.action.read` run under the forwarded execution identity. `intake-service.impl.md:44`, `:46`, `:49`.
  - A plan edits only the construction of its own service and the dependency entries that it provides or consumes. `00-index.md` "Shared files".
  - Only a test file imports `test-identity.ts`. `eslint.config.js:206–224`.
- Done when: `pnpm run verify` passes; `unwired-import.test.ts` asserts the new set; every earlier E2E test passes unchanged.

### 06.4 Add the node branch and the operand derivation

- Files: `src/worker/node-branch.ts` (create), `src/worker/node-branch.test.ts` (create), `src/worker/action-operands.ts` (create), `src/worker/action-operands.test.ts` (create)
- Do:
  1. Declare `NODE_BRANCH_PREFIX = "kanthord/"` and implement `nodeBranchOf(nodeId)`: assert a `node_<ulid>` identity and answer `NODE_BRANCH_PREFIX + nodeId`.
  2. Implement `operandsOf(nodeId, context, entry): ActionOperands`. `nodeBranch` is `nodeBranchOf(nodeId)`. `baseBranch` is `entry.action.configuration.baseBranch`. `commit` is the `commit` of `context.currentAssessment.testedInput` when it is one repository address whose `bindingId` equals `entry.action.bindingId`. Any other tested input throws `OperationError(409, WorkerErrorCode.SnapshotAbsent, "The assessment names no repository snapshot of the action binding.", { requirementKey })`. `reusedAddress` is null.
  3. Add tests: the branch of a node identity; a malformed identity fails the assertion; each operand from a context fixture; a `produced` tested input, an array tested input and a repository address of another binding answer `worker.action_performer.snapshot_absent`.
- Rules:
  - The node branch takes its name from the node identity, in the form `kanthord/<node identity>`. `worker-service.md:294` declares the form (ruled 2026-09-30 on `worker-service.md` "Executions"). The example at `worker-service.vocabulary.md:316` is `kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAV`. Plans 07 and 08 use `nodeBranchOf`.
  - The performer derives node branch and base branch from the records, with no operand from a caller. `worker-service.vocabulary.md:205`; `worker-service.md:447–448`, `:527–528`.
  - `configuration` holds `baseBranch`. `mission-service.impl.md:84`.
  - The evidence snapshot is the tested input that the current passing assessment judged. `worker-service.md:452`, `:498`; `mission-service.md:519`.
  - Named constants for every fixed string in a comparison. `architecture.impl.md:15–19`.
- Done when: `pnpm run verify` passes; the tests pass.

### 06.5 Add the execution mutex and the dispatch reservations

- Files: `src/worker/action-reservations.ts` (create), `src/worker/action-reservations.test.ts` (create)
- Do:
  1. Implement `ExecutionMutex.run(executionId, work)`: a `Map<string, Promise<void>>` chain. The next `work` of one key starts after the previous one settles; another key runs at once. The entry of a key is deleted when its chain is idle.
  2. Implement `DispatchReservations` over a `Map<string, Entry>` keyed by `nodeId + "|" + attempt + "|" + requirementKey`, with `Entry = { state: "in_flight"; owner: symbol } | { state: "uncertain"; item: ActionResultItem }`:
     - `acquire(key): { owner: symbol } | { held: ActionResultItem }` — a free key takes `in_flight` with a new owner; an `in_flight` key answers `held` with `{ kind: "uncertain", action, uncertainty: "effect" }` and changes nothing; an `uncertain` key answers its `item`.
     - `settle(key, owner, item | null)` — acts only when the entry is `in_flight` with that owner. `null` deletes the entry; an `uncertain` item stores it.
     - `prune(nodeId, attempt, actions)` — deletes the entry of each action of that attempt whose `resolution` is not `unrequested`.
  3. Add tests: two runs of one key never overlap; two keys overlap; a contending `acquire` answers `uncertain` `effect` and a later `settle` of the owner still acts; a `settle` with a foreign owner changes nothing; a stored `uncertain` answers the same item; `prune` deletes a same-attempt requested key and keeps the key of another attempt.
- Rules:
  - A per-execution-identity mutex serializes invocations inside the server. Inside one server process, the mutex and the reservation prevent a redispatch within one attempt. `worker-service.impl.md:415`, `:427`; `docs/reference/erd/02-execution.md:30`.
  - The performer never dispatches an action whose earlier dispatch is unresolved, across callers and invocations. `worker-service.md:456`; `worker-service.vocabulary.md:206`.
  - The dispatch reservation follows the fifteen lines of `worker-service.impl.md:415–429` (ruled 2026-09-30 on `worker-service.impl.md` "Action performer"). The key holds the node, the attempt and the requirement key, because a later execution of the same attempt follows a lost execution (`:416`). Only the invocation that took the reservation settles it (`:418`). A contender of an in-flight reservation answers `uncertain` with `uncertainty: "effect"`, changes nothing and does not wait (`:419`). A contender of an uncertain reservation answers the stored item and changes nothing (`:420`). A request evidence of the same attempt deletes the entry, and a request evidence of an earlier attempt deletes none (`:426`).
  - A server restart loses the in-memory reservation. The action performer derives the request key of its write, and the Intake outbound request holds the idempotency of that key. ERD 3 supplies the durable record; the fixture fake models it here.
- Done when: `pnpm run verify` passes; the six tests pass.

### 06.6 Add the reuse predicate

- Files: `src/worker/action-reuse.ts` (create), `src/worker/action-reuse.test.ts` (create)
- Do:
  1. Declare `PullRequestState.Open = "open"` and `REPOSITORY_IDENTITY_PREFIX = "repository:github:"`.
  2. Implement `repositoryOf(resourceIdentity)`: assert the prefix and answer the `owner/repository` rest.
  3. Implement `fulfils(body, operands, resourceIdentity): boolean`. Parse `body` with a local `z.looseObject` of `{ state, head: { ref, repo: { full_name } }, base: { ref, repo: { full_name } } }`; a parse failure answers false. Answer true only when `state` is `open`, `head.ref` equals `operands.nodeBranch`, `base.ref` equals `operands.baseBranch`, and both `full_name` values equal `repositoryOf(resourceIdentity)`.
  4. Implement `sameRepository(candidate, resourceIdentity)`: the `resourceIdentity` of the candidate address equals that of the pinned binding.
  5. Add tests: an open pull request of the node branch into the base branch fulfils; a closed or merged one, another head, another base, a fork head repository and a body without `head.repo` each fail; a candidate of another repository fails `sameRepository`.
- Rules:
  - A reuse needs the same requirement key, a remote thing that fulfils the operands of the current request, and a remote thing that is open. An end state of the earlier action does not close it. `worker-service.md:531–535`.
  - The reuse checks the configured action, the repository binding and the current operands. `engine/docs/cli/worker.md:645–648`.
  - The pull-request read answers the GitHub body unchanged. `repository.impl.md:17–19`; `intake-service.impl.md:49`.
  - The predicate checks the head and base repositories, not the branch names alone. `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06", round 2.
  - The repository resource identity is `repository:github:<owner>/<repository>`. `src/project/store.ts:201–222`.
- Done when: `pnpm run verify` passes; the tests pass.

### 06.7 Add the classification of the seam outcomes

- Files: `src/worker/action-classify.ts` (create), `src/worker/action-classify.test.ts` (create)
- Do:
  1. Implement `isResultClass(answer)`: an object with a `class` key.
  2. Implement `performedItem(ref, answer)`: a `ResultClassAnswer` with `unknown_outcome` answers `{ kind: "uncertain", action: ref, uncertainty: "effect" }` with no address; one of the three other classes answers `{ kind: "failed-before-effect", action: ref, refusal: { class, code, message } }`; an address answers null (the dispatch continues to the submission).
  3. Implement `readRefusalItem(ref, answer)`: the three classes keep their class; `unknown_outcome` answers `class: "confirmed_failure"`; `code` and `message` stay those of the read.
  4. Implement `recordedItem(ref, address, result)`: a `Completed` result answers `{ kind: "submitted", evidence: result.data }`; a `Failure` or an `Indeterminate` result answers `{ kind: "uncertain", action: ref, uncertainty: "recording", address }`.
  5. Add tests for each branch, and assert that no branch answers `uncertainty: "both"` or an `awaiting-prerequisite` item.
- Rules:
  - The four classes and their fields; an `unknown_outcome` produces `effect`; the address is present when the remote returned it and the Mission submission stayed uncertain. `worker-service.impl.md:435–438`.
  - A final refusal declines the request before any write, and `code` and `message` come from the Repository component. `worker-service.impl.md:437`; `repository.impl.md:26`.
  - A client returns `Completed`, `Failure` or `Indeterminate`. `architecture.impl.md:733`.
  - The first version produces no `both` item, because the performer submits no request after an unknown effect; a refused recording and an indeterminate recording both answer `recording`; a read has no effect, so its `unknown_outcome` answers `failed-before-effect` with `confirmed_failure`. `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06", Q4 (`review:Ulrich`).
  - The first version produces no `awaiting-prerequisite` item. `worker-service.impl.md:441`.
  - Gap: what follows a failure or an uncertainty stays B9 A3, W1, W4 and PR2 (`docs/brainstorm/HANDOFF.md:119`); the answer holds no release instruction (`worker-service.impl.md:442`).
- Done when: `pnpm run verify` passes; the tests pass.

### 06.8 Add the admission of the performer

- Files: `src/worker/action-performer.ts` (create), `src/worker/action-performer.test.ts` (create)
- Do:
  1. Declare `ActionPerformer` with a constructor that takes `{ store, schedulerClaims, missionActions, intakeActions, evidenceRequests }` of `Dependencies`, one `ExecutionMutex` and one `DispatchReservations`.
  2. Implement `admit(claim): Admission` as one `store.transaction`: read `now = Date.now()` once; call `schedulerClaims.requireRunning(tx, claim.executionId, claim.runtimeIdentity, now)`; call `missionActions.actionContextOf(tx, claim.nodeId, claim.attempt)`. Then check in this order: a `state` other than `Evaluating` throws `OperationError(409, WorkerErrorCode.ClaimNotEvaluation, …)`; a null `currentAssessment` or a `result` other than `success` throws `OperationError(409, WorkerErrorCode.AssessmentNotCurrent, …)`. Answer the context.
  3. Implement `perform(caller: { context; identity: MachineIdentity }, claim): Promise<ActionRequestResult>` as `mutex.run(claim.executionId, …)` around `admit`, so the mutex precedes the snapshot. With no eligible action, answer `{ toolName, items: [] }`.
  4. Add tests with fakes and `testMachineIdentity`: an ended execution answers 409 `scheduler.execution.not_running` and reads no Mission context; an `Executing` node answers `worker.action_performer.claim_not_evaluation`; no assessment and a `criterion-not-met` current assessment answer `worker.action_performer.assessment_not_current`; the three checks run in one transaction; an initiative context answers `items: []`; the performer calls no Intake method and no Mission request on a refusal.
- Rules:
  - The performer checks a live claim, an evaluation claim and a current passing assessment, in this order. `worker-service.md:449–451`; `repository.md:58–59`.
  - Every execution operation repeats the full proof inside its transaction: the claimant, a null `ended_at` and a reading before `expired_at`; a failure answers 409 `scheduler.execution.not_running`. `docs/reference/erd/02-execution.md:216`; `architecture.impl.md:657–658`.
  - The node state `Evaluating` fixes the kind of a live claim. `docs/reference/erd/02-execution.md:212`; root `AGENTS.md` "Rejected proposals" (no stored claim kind).
  - The two refusal codes. `worker-service.impl.md:443`, `:487`; `engine/docs/cli/worker.md:688–689`, `:752–753`.
  - A transaction reads the clock once at its start. `00-index.md` "Shared conventions", row "The clock of a transaction".
  - A store transaction is synchronous and spans no `await`. `architecture.impl.md:697`.
- Done when: `pnpm run verify` passes; the tests pass.

### 06.9 Add the dispatch of an eligible action

- Files: `src/worker/action-performer.ts`, `src/worker/action-performer.test.ts` (both edit)
- Do:
  1. After `admit`, call `reservations.prune(claim.nodeId, claim.attempt, context.actions)`. Compute `operandsOf` (task 06.4) for every eligible action in `key` order, so that a refusal takes no reservation. Then call `reservations.acquire` for every eligible action. Run both steps before the first `await`. A `held` answer becomes the item of that action.
  2. For each owned action, in `key` order: call `intakeActions.perform({ context, identity, executionId }, action, operands)`. Map the answer with `performedItem`; a non-null item settles the reservation (`null` for a refusal, the item for `unknown_outcome`).
  3. For an address, call `evidenceRequests.request({ params: { nodeId }, query: {}, body: { executionId, attempt, nodeRevision: pinnedRevision, requirementKey: key, subject: key, address } }, { identity, context, idempotencyKey: ulid() })`. Map it with `recordedItem`. `submitted` settles with `null`; `uncertain` settles with the item. A thrown error of the request call answers the `recording` item.
  4. Answer `{ toolName: ACTION_REQUEST_TOOL_NAME, items }` in `key` order.
  5. Add tests: a pull-request action calls `perform` once with `{ nodeBranch: "kanthord/<node>", baseBranch: "main", commit, reusedAddress: null }` and the forwarded identity, then `request` once with the address, and answers `submitted`; a `merge_push` answers the `branch_push` address of its push; a `final_refusal` answers `failed-before-effect` and a later invocation dispatches again; a `Failure` of the request answers `uncertain` `recording` with the address; a context with no eligible action answers `items: []` and calls nothing.
- Rules:
  - The performer requests each eligible action until no action is eligible. A request of the first version makes no predecessor reach its expected end state, so one pass over the snapshot suffices. `worker-service.md:525`; `mission-service.impl.md:83`.
  - A request calls `intake.action.perform`, and the performer makes no clone. `worker-service.md:526`; `worker-service.impl.md:430`.
  - The performer submits the request through `mission.evidence.request` as the request evidence of the attempt, with the address that the Intake Service answers; that submission is the accepted request. `worker-service.md:538–540`; `mission-service.impl.md:89–90`.
  - A handler that acts for its caller passes `caller.identity`, and the direct adapter enters the chain with it. `architecture.impl.md:681–684`.
  - A mutation carries an idempotency key on both adapters. `architecture.impl.md:715`; `src/gateway/idempotency.ts:66–71`.
  - The action performer takes the reservation directly after the admission snapshot, with no `await` between them, and before its first Intake call for that action. `worker-service.impl.md:417`.
  - A refusal class of `intake.action.perform` proves that no write started and removes the reservation. An uncertain result, `recording` included, stays in the reservation with its uncertainty and its known address. `worker-service.impl.md:421`, `:423`, `:437`.
  - The subject of the request evidence is the key of its `FrozenAction`; no page rules the text. `mission-service.impl.md:90`.
  - Gap: a lost answer of the Mission submission stays B9 W3 (`docs/brainstorm/HANDOFF.md:121`); a refused recording leaves the remote object with no request evidence (B9 A3, W1, W4, PR2).
- Done when: `pnpm run verify` passes; the tests pass.

### 06.10 Add the reuse to the dispatch

- Files: `src/worker/action-performer.ts`, `src/worker/action-performer.test.ts` (both edit)
- Do:
  1. For an owned `pull_request` action with `reuseCandidates`, before `perform`: for each candidate in order, skip it when `sameRepository` fails; else call `intakeActions.read(call, ActionReadMethod.PullRequestGet, candidate.address)`. A `ResultClassAnswer` settles the reservation with `null` and answers `readRefusalItem`; the action dispatches nothing more. A body that `fulfils` the operands selects the candidate and stops the loop.
  2. With a selected candidate, call `perform` with `reusedAddress` set to its address. Without one, call `perform` with `reusedAddress: null`.
  3. Add tests: an open matching pull request of attempt 1 answers `submitted` with the same address in attempt 2, and `perform` receives `reusedAddress`; a closed pull request leads to a fresh `perform`; a first candidate that fails and a second that fulfils select the second; a read `final_refusal` and a read `unknown_outcome` answer `failed-before-effect` and call no `perform`; a `merge_push` action calls no `read`.
- Rules:
  - Before it performs a request, the performer reads the request evidence of the node, and a reuse needs the three conditions. `worker-service.md:530–535`.
  - A reuse performs, through the Intake Service, the network git write that the action requires and no platform write, and it submits the address of the reused request evidence. `worker-service.md:536`, `:539`; `intake-service.impl.md:47`.
  - A reuse is a new request evidence of a later attempt with the address of an earlier request of the same node and action. `mission-service.impl.md:91`; `engine/docs/cli/mission.md:510–512`.
  - The reuse read uses `intake.action.read` under the forwarded execution identity. `intake-service.impl.md:49`; `00-index.md` "Plans", row 06.
  - A failure of `intake.action.read` removes the reservation, because the read writes nothing. `worker-service.impl.md:422`.
  - Every candidate of every earlier attempt counts, newest first. `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 06", round 2.
- Done when: `pnpm run verify` passes; the tests pass.

### 06.11 Prove the no-redispatch invariant

- Files: `src/worker/action-performer.ts`, `src/worker/action-performer.test.ts` (both edit)
- Do:
  1. Wrap the dispatch of each owned action in `try`/`finally`. A thrown error of `perform` whose code is `system.composition.unwired` proves that no write started: it settles with `null` and propagates. Every other thrown error of `perform` settles the reservation with `{ kind: "uncertain", action, uncertainty: "effect" }` and propagates. A thrown error of `read` settles with `null` and propagates. A thrown error of `evidenceRequests.request` stays the `recording` item of task 06.9 and never settles as `effect`. Before an error propagates, every other owned action that has not dispatched settles with `null`.
  2. Add tests:
     - Two concurrent invocations of one execution: `perform` runs once, and the second invocation answers `items: []` after the first submission.
     - An `unknown_outcome` answers `uncertain` `effect`; a second invocation of the same execution and an invocation of a later execution of the same attempt answer the same item and call `perform` no more.
     - A held `perform` of execution E1 and an invocation of execution E2 of the same attempt: E2 answers `uncertain` `effect` and calls nothing; the settlement of E1 then acts.
     - A `perform` that throws `Error("socket")` keeps the reservation; a later invocation answers `uncertain` `effect` and calls nothing.
     - A `perform` that throws `system.composition.unwired` releases the reservation; a later invocation calls `perform` again.
     - A same-attempt request evidence in a later context prunes an `uncertain` entry.
- Rules:
  - The performer never dispatches an action twice, and tests assert serialized calls with no duplicate dispatch. `worker-service.impl.md:488`, `:491`; `worker-service.md:455–456`.
  - A failure of `intake.action.read` and a failure of `intake.action.perform` that proves that no write started remove the reservation. Every other failure of `intake.action.perform`, an unclassified exception included, keeps it as `uncertain` with `uncertainty: "effect"`. Before a failure propagates, the invocation removes its other reservations of actions that it did not dispatch. `worker-service.impl.md:422–425` (ruled 2026-09-30 on `worker-service.impl.md` "Action performer").
  - The stand-in `unwired` throws before any work. `src/apps/server/unwired.ts` (plan 01 task 01.4); decision D6.
  - Production fails closed at the Intake call. Decision D6.
  - A server restart during a dispatch loses the reservation; the same derived request key reads the Intake outbound request rather than dispatching another write. An uncertain dispatch leaves the claim to its deadline because reviewer release refuses an eligible unrequested action (B9 A3, W1, W4, PR2).
- Done when: `pnpm run verify` passes; the tests pass.

### 06.12 Declare `worker.action.request` with its handler

- Files: `src/worker/contract.ts`, `src/worker/service.ts`, `src/worker/service.test.ts`, `src/apps/server/openapi-integration.test.ts`, `engine/AGENTS.md` (all edit); `static/openapi.yaml` and `static/openapi/worker/*` (regenerated)
- Do:
  1. Declare `"action.request"` in `workerOperations`: id `worker.action.request`, `POST /api/worker/execution/:executionId/action/request`, access `client`, `requiresExecution: true`, `mutation: true`, `lifetime: unary`, `timeoutMs: ACTION_REQUEST_TIMEOUT_MS`, store operational, `status: 200`, input `{ params: { executionId: identitySchema("execution") }, query: {}, body: null }`, output `actionRequestResultSchema`. The description names the internal function, the execution identity as the only input, the four classes and the absence of a release instruction.
  2. Construct one `ActionPerformer` in the constructor of `WorkerService`. In `declare` (`src/worker/service.ts:681`), register the handler: require a machine identity and `caller.execution`; `await performer.perform({ context: caller.context, identity }, caller.execution)`; `return caller.commit(() => answer)`.
  3. Regenerate OpenAPI with `pnpm run build && node bin/kanthord.mjs gateway openapi`. In `openapi-integration.test.ts`, assert the operation id of the route and the `kind` discriminator of `items`.
  4. In `src/worker/service.test.ts`, assert that the handler forwards `caller.identity` and `caller.execution` and reads no input field but the path.
  5. Update the `src/worker/` and `src/mission/` entries of `engine/AGENTS.md` with the modules of this plan.
- Rules:
  - The evaluation method of `reviewer@1` at the `worker` placement reaches the internal function through this operation; the later MCP tool calls the same function. `worker-service.impl.md:409–410` (ruled 2026-09-30 on `worker-service.impl.md` "Action performer"); decisions D5, D8.
  - `worker-service.impl.md` "Action performer" declares `worker.action.request` and its route (`:410–414`). The operation has no CLI command (`:414`; `engine/docs/cli/worker.md:628`).
  - The performer serves every reviewer execution, whichever harness hosts it, under the full execution proof and its own admission. `worker-service.md:445`; `architecture.impl.md:660`.
  - Both callers pass the execution identity and nothing else. `worker-service.md:447–448`; `worker-service.impl.md:412`, `:498`.
  - The chain proves the execution identity and passes the claim; the handler reads none of its fields from the input. `architecture.impl.md:647–655`; decision D10.
  - The timeout is 900 s, because the operation runs the action performer. `gateway-service.impl.md:302`; `worker-service.impl.md:413`.
  - A mutation route is idempotent or it completes: a replay inside the TTL answers the recorded items, and after the TTL the Mission record and the reservation refuse a second dispatch. `gateway-service.impl.md:303`; `architecture.impl.md:717–721`; `worker-service.impl.md:485`.
  - A handler runs its asynchronous work first and performs one `caller.commit` at the end. `architecture.impl.md:698–699`; decision D3; precedent `src/custody/service.ts:799–830`.
  - Each task publishes exactly the operations that it registers. `00-index.md` "Shared files", row `openapi-integration.test.ts`.
- Done when: `pnpm run verify` passes; the OpenAPI assertion passes.

### 06.13 Add the integration tests through both adapters

- Files: `src/apps/server/action-performer-integration.test.ts` (create)
- Do:
  1. Build the setup of the `## E2E` section through the direct adapter and the HTTP adapter of `gatewayFixture` with `standIns: { intakeActions: actions.seam }`, up to an evaluation claim with a current passing assessment on objective G. The machine identity of the direct adapter is `await fixture.gateway.authentication.authenticate("Bearer " + W)`.
  2. Test: with `actions.hold()`, one call through the HTTP adapter and one through the direct adapter under the same execution, each with its own idempotency key; release the gate; exactly one `perform` call, one `submitted` item across both answers and one request evidence in `mission.evidence.list`.
  3. Test: a repeat of a completed call with the same key and payload answers the recorded items and calls `perform` no more.
  4. Test: a call with the execution identity of another registration answers 403 `gateway.invocation.execution_proof_failed` through both adapters and calls nothing.
  5. Test: an HTTP call without `standIns.intakeActions` answers 500 `gateway.invocation.unknown` on a second fixture; the stand-in throws internal `system.composition.unwired` before work (decision D6).
  6. Test: the shared error envelope, the 900 s timeout and the lifetime of the route.
- Rules:
  - Both adapters enter one invocation chain. `architecture.impl.md:614–618`.
  - Serialized calls with no duplicate dispatch. `worker-service.impl.md:491`.
  - A replay holds inside one process and inside the TTL. `architecture.impl.md:719`.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
- Done when: `node --test --test-timeout=30000 src/apps/server/action-performer-integration.test.ts` passes; `pnpm run verify` passes.

### 06.14 Refuse a non-null `follows` in the binding write

- Files: `src/project/contract.ts`, `src/project/store.test.ts` (both edit)
- Do:
  1. In `refineBindingRelations` (`src/project/contract.ts:216–243`), add an issue at `followsPath(name)` with the message `Action follows must name the passing assessment until a claim-source contract exists.` for every repository binding whose `follows.type` is `FollowsType.ActionEndState`, before the target check. Keep the schema shapes, the target check and `refineFollowsCycles`, so the refusal is one issue of the existing validation and no new code.
  2. Update the ERD 1 tests of the absent-target and cycle checks in `src/project/store.test.ts`: an `action_end_state` value answers the refusal issue first.
  3. Add tests: a strategy with `follows: { type: "assessment_passed" }` passes; `action_end_state` with an existing target is refused with the message and the path; the refusal reaches the CLI as the ERD 1 validation failure of `project binding apply`.
- Rules:
  - The Project Service refuses `follows.type = "action_end_state"` in a binding write until a retry-safe claim-source contract exists. `mission-service.impl.md:83`; `engine/docs/cli/project.md:348`.
  - Every evaluation claim comes from `Waiting`, so a reviewer execution performs the evaluation on every claim. `worker-service.md:517`; plan 08 task 08.16.
  - The first version produces no `awaiting-prerequisite` item. `worker-service.impl.md:441`.
  - Prefer to forbid a configuration change over a mechanism that handles its edge case. Root `AGENTS.md` "Work with Ulrich".
- Done when: `pnpm run verify` passes; the tests pass.

### 06.E E2E proof

- Files: `src/apps/server/e2e-worker-action-performer.test.ts` (create)
- Do:
  1. Create `actions = scriptedActions()`. Start `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` and `standIns: { intakeActions: actions.seam, intakeCheck: scriptedCheck({ endState: "other", landedCommits: [] }) }`.
  2. Build the setup of the `## E2E` section through the CLI. Write one `test` block for each scenario E06.1 to E06.17, in table order, on the shared setup of one fixture.
  3. Parse stdout as JSON for every CLI success. Assert the exit code and the start of stderr for every CLI refusal, and the status and `error.code` for every refusal of the HTTP adapter.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, never a store read. ERD 1 decision D13.
  - One step uses the HTTP adapter `httpClient(workerOperations, fixture.endpoint, <machine token of W>)` from the test: `worker.action.request`, because no CLI command calls the performer (`worker-service.impl.md:414`), as plan 04 drives `mission.evidence.request` (task 04.E).
  - The fake answers a scripted `PlatformAddress` or result class, and no plan performs a real platform call. `00-index.md` "Consumed seams"; decision D16.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
  - The fixture inputs are the inputs that the committed validation accepts. `.dev/erd-01/decisions-log.md` 03.5, 05.E, 06.E; `src/project/contract.ts:89–109`; `src/worker/catalog.ts:70–71` (`claude@1`); plan 04 "E2E".
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-worker-action-performer.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-worker-action-performer.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store, the fake `scriptedActions` of task 06.3 and the scripted Intake check of plan 04 that answers `other`. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state and `KANTHORD_ENDPOINT = fixture.endpoint`. `H` names `KANTHORD_TOKEN = fixture.token`; `W` names `KANTHORD_TOKEN = await fixture.machineToken(harnessBindingId)`.
- Rules: setup goes through the CLI only, except the HTTP-adapter step `request(e)`; the state check is a CLI read or the recorded calls of the fake; a refusal asserts the exact exit code or HTTP status and the error code; stdout is parsed as JSON.
- The worker `claude@1` declares `Available`, `Waiting` and `External.Requested` and names no agent, so one instance takes both claim kinds with no enablement and no agent runtime (`src/worker/catalog.ts:70–71`). The priorities make the queue order fixed: objective G before objective P, and the initiative never holds a job, because G ends nonterminal.

Setup, in order (each command exits 0, token H):

1. `kanthord project create --name actions` → `projectId` = `id`.
2. `kanthord mission get <projectId>` → `missionId` = `id`.
3. `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
4. `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "gated": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/gated.git", "strategy": { "baseBranch": "main", "action": { "name": "pull_request", "follows": { "type": "assessment_passed" } } }, "credential": "github" } }, "pushed": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/pushed.git", "strategy": { "baseBranch": "main", "action": { "name": "merge_push", "follows": { "type": "assessment_passed" } } }, "credential": "github" } }, "harness": { "kind": "worker", "config": { "worker": "claude@1", "instanceCount": 1 } } } }` → `gatedBindingId`, `gatedResource` = `bindings.gated.resourceIdentity`, `pushedBindingId`, `harnessBindingId`, `harnessResource` = `bindings.harness.resourceIdentity`.
5. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Ship accounts", "requirement": "Ship accounts", "criterion": "Accounts ship", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId`.
6. `kanthord mission node create <missionId> --file objective-g.json` with the content of step 5 and `"filename": "objective-g.md"`, `"kind": "objective"`, `"bindings": ["gated"]`, `"parentId": <initiativeId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 2` → `G`.
7. `kanthord mission node create <missionId> --file objective-p.json` with `"filename": "objective-p.md"`, `"bindings": ["pushed"]` and `"expectedMissionVersion": 3` → `P`.
8. `kanthord mission node priority set <G> --file { "value": 3, "expectedMissionVersion": 4 }` and `kanthord mission node priority set <P> --file { "value": 2, "expectedMissionVersion": 4 }`. `M` names the `version` of `kanthord mission get <projectId>` after this step.
9. With token W: `kanthord worker register` → `runtimeIdentity`. `pull.json` names `{ "resourceIdentity": <harnessResource>, "runtimeIdentity": <runtimeIdentity> }`.

`ctx(e, n)` names `"executionId": e, "attempt": n, "nodeRevision": 1`. `C40(x)` names 40 characters `x`. `work(e, n, b, c)` names `{ ctx(e, n), "subject": "head commit", "assets": [{ "kind": "repository", "address": { "kind": "repository", "bindingId": b, "commit": c } }] }`. `run(e, n, b, c)` names `{ ctx(e, n), "subject": "verification run", "assets": [{ "kind": "produced", "content": { "mediaType": "text/plain", "encoding": "base64", "data": "b2s=" } }], "verification": { "testedInput": { "kind": "repository", "bindingId": b, "commit": c }, "results": [{ "command": "true", "exitCode": 0, "signal": null, "timedOut": false }] } }`. `pass(e, n, ids, b, c)` names `{ ctx(e, n), "evidenceIds": ids, "childOutcomeIds": [], "result": "success", "rationale": "met", "testedInput": { "kind": "repository", "bindingId": b, "commit": c } }`. `act(state, n)` names `{ "reason": "hold", "expectedMissionVersion": M, "expectedState": state, "expectedAttempt": n }`. `request(e)` names the HTTP-adapter call `worker.action.request` with `{ "params": { "executionId": e }, "query": {}, "body": null }` and a new idempotency key under W. `pr42` names `{ "kind": "pull_request", "resourceIdentity": <gatedResource>, "number": 42 }`.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exit              | Expect                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E06.1  | W: `kanthord scheduler work pull --file pull.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0                 | `kind` `claimed`, `execution.nodeId` = `G`, `execution.attempt` 1 → `e1`                                                                                                                                                                                                                                                                      |
| E06.2  | `request(e1)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 409               | `error.code` `worker.action_performer.claim_not_evaluation`; `actions.performCalls` empty                                                                                                                                                                                                                                                     |
| E06.3  | W: `kanthord mission evidence submit <G> --file` work(e1, 1, gatedBindingId, C40(b)); then `kanthord scheduler execution release <e1> --file { "furtherWork": false }`                                                                                                                                                                                                                                                                                                                                                   | 0, 0              | → `gWork1`                                                                                                                                                                                                                                                                                                                                    |
| E06.4  | W: `kanthord scheduler work pull --file pull.json`; then `request(e2)`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0, 409            | first `execution.nodeId` = `G`, `execution.attempt` 1 → `e2`; second `error.code` `worker.action_performer.assessment_not_current`                                                                                                                                                                                                            |
| E06.5  | W: `kanthord mission evidence submit <G> --file` run(e2, 1, gatedBindingId, C40(b)); then `kanthord mission assessment submit <G> --file` pass(e2, 1, [gRun1, gWork1], gatedBindingId, C40(b))                                                                                                                                                                                                                                                                                                                           | 0, 0              | first → `gRun1`; second `node.state` `Evaluating`, `outcome` null                                                                                                                                                                                                                                                                             |
| E06.6  | Queue `performAnswers` `{ "class": "final_refusal", "code": "repository.platform.github.final_refusal", "message": "Bad credentials" }`; `request(e2)`                                                                                                                                                                                                                                                                                                                                                                   | 200               | `toolName` `repository-action-request`; `items[0].kind` `failed-before-effect`, `items[0].action` `{ "key": "gated.pull_request", "bindingId": <gatedBindingId> }`, `items[0].refusal.class` `final_refusal`; `performCalls[0].operands` = `{ "nodeBranch": "kanthord/" + G, "baseBranch": "main", "commit": C40(b), "reusedAddress": null }` |
| E06.7  | Repeat the failed request and assert read-back without another dispatch; model human removal of the failed fake outbound request; queue `performAnswers` pr42; `request(e2)`                                                                                                                                                                                                                                                                                                                                             | 200               | `items[0].kind` `submitted`, `items[0].evidence.requirementKey` `gated.pull_request`, `items[0].evidence.attempt` 1, `items[0].evidence.assets[0].address` = pr42 → `request1`; `performCalls` of length 2                                                                                                                                    |
| E06.8  | `request(e2)`; then W: `kanthord scheduler execution release <e2> --file { "furtherWork": false }`; then H: `kanthord mission node get <G>`                                                                                                                                                                                                                                                                                                                                                                              | 200, 0, 0         | first `items` `[]`, `performCalls` of length 2; third `state` `External.Requested`                                                                                                                                                                                                                                                            |
| E06.9  | H: `kanthord mission external-action list <G> --attempt 1`; then `kanthord mission node check <G> --file { "expectedMissionVersion": M }`; then `kanthord mission node get <G>`                                                                                                                                                                                                                                                                                                                                          | 0, 0, 0           | first `items[0].resolution` `unresolved`, `items[0].requestEvidenceId` = `request1`; second `results[0].resolution` `other-end`; third `state` `Blocked`                                                                                                                                                                                      |
| E06.10 | H: `kanthord mission node unblock <G> --file { "blockedAttempt": 1, "expectedRevision": 1, "expectedMissionVersion": M }`; then W: `kanthord scheduler work pull --file pull.json`; then `kanthord mission evidence submit <G> --file` work(e3, 2, gatedBindingId, C40(d)); then `kanthord scheduler execution release <e3> --file { "furtherWork": false }`                                                                                                                                                             | 0, 0, 0, 0        | first `node.state` `Available`, `attempt.attempt` 2; second `execution.nodeId` = `G`, `execution.attempt` 2 → `e3`; third → `gWork2`                                                                                                                                                                                                          |
| E06.11 | W: `kanthord scheduler work pull --file pull.json`; then `kanthord mission evidence submit <G> --file` run(e4, 2, gatedBindingId, C40(d)); then `kanthord mission assessment submit <G> --file` pass(e4, 2, [gRun2, gWork2], gatedBindingId, C40(d))                                                                                                                                                                                                                                                                     | 0, 0, 0           | first `execution.attempt` 2 → `e4`; second → `gRun2`; third `node.state` `Evaluating`                                                                                                                                                                                                                                                         |
| E06.12 | Queue `readAnswers` `{ "body": { "state": "open", "head": { "ref": "kanthord/" + G, "repo": { "full_name": "owner/gated" } }, "base": { "ref": "main", "repo": { "full_name": "owner/gated" } } } }` and `performAnswers` pr42; `request(e4)`                                                                                                                                                                                                                                                                            | 200               | `items[0].kind` `submitted`, `items[0].evidence.attempt` 2, `items[0].evidence.assets[0].address` = pr42; `readCalls[0].method` `github-pull-request-get`, `readCalls[0].address` = pr42; `performCalls[2].operands.reusedAddress` = pr42, `performCalls[2].operands.commit` = C40(d)                                                         |
| E06.13 | W: `kanthord scheduler execution release <e4> --file { "furtherWork": false }`; then H: `kanthord mission evidence list <G> --attempt 2`                                                                                                                                                                                                                                                                                                                                                                                 | 0, 0              | second holds one evidence with `requirementKey` `gated.pull_request` and the address pr42                                                                                                                                                                                                                                                     |
| E06.14 | W: `kanthord scheduler work pull --file pull.json` → `e5` (`execution.nodeId` = `P`); `kanthord mission evidence submit <P> --file` work(e5, 1, pushedBindingId, C40(e)) → `pWork`; `kanthord scheduler execution release <e5> --file { "furtherWork": false }`; `kanthord scheduler work pull --file pull.json` → `e6`; `kanthord mission evidence submit <P> --file` run(e6, 1, pushedBindingId, C40(e)) → `pRun`; `kanthord mission assessment submit <P> --file` pass(e6, 1, [pRun, pWork], pushedBindingId, C40(e)) | 0 each            | the last `node.state` `Evaluating`                                                                                                                                                                                                                                                                                                            |
| E06.15 | Queue `performAnswers` `{ "class": "unknown_outcome", "code": "repository.platform.github.unknown_outcome", "message": "No response" }`; `request(e6)`; then `request(e6)`                                                                                                                                                                                                                                                                                                                                               | 200, 200          | both `items[0]` = `{ "kind": "uncertain", "action": { "key": "pushed.merge_push", "bindingId": <pushedBindingId> }, "uncertainty": "effect" }`; `performCalls` of length 4 after both calls                                                                                                                                                   |
| E06.16 | W: `kanthord scheduler execution release <e6> --file { "furtherWork": false }`                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1                 | stderr starts with `mission.release.obligation_unmet:`                                                                                                                                                                                                                                                                                        |
| E06.17 | H: `kanthord mission node pause <P> --file` act(Evaluating, 1); then `kanthord mission node resume <P> --file` act(Paused, 1) plus `"target": "Waiting"`; then W: `kanthord scheduler work pull --file pull.json`; then `request(e7)`; then `request(e1)`                                                                                                                                                                                                                                                                | 0, 0, 0, 200, 403 | third `execution.nodeId` = `P`, `execution.attempt` 1 → `e7`; fourth `items[0].kind` `uncertain`, `items[0].uncertainty` `effect`, `performCalls` of length 4; fifth `error.code` `gateway.invocation.execution_proof_failed`                                                                                                                 |

E06.2, E06.4, E06.6, E06.7, E06.12, E06.15 and E06.17 assert the operation `worker.action.request` and the refusal codes `worker.action_performer.claim_not_evaluation` and `worker.action_performer.assessment_not_current`. `worker-service.impl.md:410–414`, `:443` and `engine/docs/cli/worker.md:628`, `:752–753` declare them.

## Blockers

None open. The debate engine settled the four gaps in two rounds:

- DEBATE: the transport from the `worker` placement to the internal performer with the MCP server out of scope - rounds:2 - verdict: (a), one `client` operation `worker.action.request` that calls the internal function, ruled 2026-09-30 on `worker-service.impl.md` "Action performer"; (b) drops required behavior of plan 08 and D5 exempts only the external-harness journey of plan 10; (c) contradicts ruling R1.
- DEBATE: the Mission read of the performer - rounds:2 - verdict: (a), a Mission Kind 2 collaboration `actionContextOf` in one transaction with `requireRunning`; its invariant is bounded to the snapshot and guarantees no liveness through the external operation.
- DEBATE: the no-redispatch invariant across executions of one attempt - rounds:2 - verdict: a reservation keyed by `(nodeId, attempt, requirementKey)` and taken before the first Intake call, beside the per-execution mutex; only the owner settles; a contender answers `uncertain` `effect` and does not wait; ruled 2026-09-30 on `worker-service.impl.md` "Action performer".
- DEBATE: the classification of the seam outcomes - rounds:2 - verdict: qualified yes; `uncertain` `recording` for an address with an unconfirmed or refused submission; no `both`, because no submission follows an unknown effect; every failure after a write may have started keeps the protection, and the reuse considers every earlier candidate, checks the head and base repositories, and uses one declared branch-name function.
