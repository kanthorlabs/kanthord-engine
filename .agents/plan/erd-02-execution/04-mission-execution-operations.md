# Plan 04: Mission Service — execution operations

## Scope

This plan delivers:

- The execution submissions `mission.evidence.submit`, `mission.evidence.asset.complete`, `mission.assessment.submit` and `mission.evidence.request`, each under the execution proof of decision D10.
- The closure of an evaluation claim by a current assessment: `Evaluating -> Completed` for a current passing assessment on a node that requires no external action, and `Evaluating -> Blocked` for a current assessment that does not pass.
- The human evidence reads `mission.evidence.list`, `mission.evidence.get` and `mission.evidence.asset.content.get`.
- The human deletes `mission.evidence.asset.delete` and `mission.evidence.delete`.
- The human check `mission.node.check` with the end state of a request, the landed-commit evidence, the fold into `External.Success` or `External.Failed` and the closure of plan 01.
- The nine execution-scoped reads of `engine/docs/cli/mission.md:523–531`.
- The Project collaboration `storageBindingOf`, the ERD 3 seams `IntakeStorage` and `IntakeCheck` with their `unwired` production entries and their `gatewayFixture` fakes, and the in-process object sink of the tests (decisions D6, D17).
- The CLI leaves of every operation above that has a CLI row, except row 35 `evidence upload` (see "Out of scope").

Out of scope:

- The CLI leaf `evidence upload <node-id> <path>` (row 35). Plans 09 and 10 reconcile it with the worker-host helper of plan 09 (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 04 — four gaps", Q3).
- `mission.delivery.admit`, the `mission_delivery_admission` table and every Intake table (ERD 3). The MCP server (decision D5).
- The action performer (plan 06). This plan provides its Mission write `mission.evidence.request`.
- Every B9 item and every open HANDOFF item (decision D1). Each task states its gap in one line.

## Sources

- `docs/reference/erd/02-execution.md:216` — the full proof inside every execution mutation and 409 `scheduler.execution.not_running`.
- `docs/reference/erd/02-execution.md:221` — the closure of an evaluation claim by a current assessment.
- `docs/reference/erd/02-execution.md:244–259` — the evidence rules: attempt, provenance, one transaction, the asset shapes, the binding rule, publication, the 5 GiB bound, the delete, the landed commit and the verification.
- `docs/reference/erd/02-execution.md:263–271`, `:275–283`, `:287–291` — the assessment, outcome and request rules.
- `docs/brainstorm/mission-service.md:293–307` — an execution submits the evidence of its own node, and a late submission never becomes current.
- `docs/brainstorm/mission-service.md:355–394` — the assessment, its result order and its currency.
- `docs/brainstorm/mission-service.md:519`, `:583–585`, `:603–604`, `:607`, `:610` — the tested input and the transitions of an assessment and of an end state.
- `docs/brainstorm/mission-service.md:691–692`, `:794–800`, `:851–855` — the work queue writes, the enforcement and the human check.
- `docs/brainstorm/mission-service.impl.md:25–33` — the three actor forms.
- `docs/brainstorm/mission-service.impl.md:74–92` — `FrozenAction`, the required external actions and `mission.evidence.request`.
- `docs/brainstorm/mission-service.impl.md:177–232` — the verifications and the assessment.
- `docs/brainstorm/mission-service.impl.md:234–245` — the request record and `mission.node.check`.
- `docs/brainstorm/mission-service.impl.md:257–357` — evidence content, object evidence and evidence retention.
- `docs/brainstorm/mission-service.impl.md:359–408` — the outcome record and the current outcome.
- `docs/brainstorm/mission-service.impl.md:522`, `:546–548` — the mission version of a human write, `Text` and the absent-record codes.
- `docs/brainstorm/mission-service.impl.md:559`, `:564–565`, `:569–570`, `:580`, `:596–629`, `:699–701` — the tests of this plan.
- `docs/brainstorm/intake-service.impl.md:48`, `:50–52` — the Intake check and the four storage operations.
- `docs/brainstorm/project-service.impl.md:142–161` — the storage binding configuration.
- `docs/brainstorm/worker-service.md:494`, `:517–519` — the reviewer reads the evidence set of the attempt, and a passing assessment ends the claim.
- `docs/brainstorm/scheduler-service.md:204–212`, `:224–237` — the revocation, the claim states and the proof inside the transaction.
- `docs/brainstorm/architecture.impl.md:117–119`, `:663–676`, `:694–699` — the synchronous transaction, the read of a worker keyed by the execution identity, and the handler that separates asynchronous work from its commit.
- `engine/docs/cli/mission.md:145–153` — the access legend H and E.
- `engine/docs/cli/mission.md:198–200` — the one cross-node read of an execution.
- `engine/docs/cli/mission.md:396–407`, `:409–474` — the evidence and assessment commands, routes, access and effects.
- `engine/docs/cli/mission.md:482`, `:493–515` — `node check` and the request evidence.
- `engine/docs/cli/mission.md:517–543` — the nine execution-scoped reads.
- `engine/docs/cli/mission.md:545–582` — the object flow.
- `engine/docs/cli/mission.md:699–775` — `EvidenceDelete`, `NodeCheck`, the execution submissions, the object schemas, `TestedInput` and the result order.
- `engine/docs/cli/mission.md:777–822` — the result schemas.
- `engine/docs/cli/mission.md:857–968` — the error codes of the Mission CLI.
- `engine/docs/cli/scheduler.md:499` — `scheduler.execution.not_running`.
- `engine/docs/cli/other.md:810` — `gateway.request.validation_failed`.
- `docs/brainstorm/architecture.impl.md:341–349` — the error code form and the CLI code form.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `engine/.agents/plan/erd-02-execution/01-mission-attempts-controls.md` — the tables, the record store, the record reads, the currency evaluator, the conditions, the required actions and the external closure.
- `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 04 — four gaps of the execution operations" — the request route, the delete flag, the CLI surface of object evidence and the content read of a platform asset.
- Root `AGENTS.md` "Database design", "Contracts" and "Rejected proposals".

## Depends on

- ERD 1, merged. The Mission Service of `src/mission/` with `Dependencies` (`src/mission/service.ts:74–79`), `MissionBindings` (`src/mission/contract.ts:25–43`), the operation helpers (`src/mission/contract.ts:506–529`), the revision reads (`src/mission/node-read.ts:134–176`, `src/mission/store.ts:259–275`, `:343–355`) and the routing (`src/mission/routing.ts:8–93`).
- ERD 1, merged. The Project reads `readBindingRevision` (`src/project/store.ts:562`), `readLatestBinding` (`:578`) and `storageConfigSchema` (`src/project/contract.ts:131–138`).
- Plan 01. The five Mission tables, `src/mission/record-store.ts`, `src/mission/record-read.ts`, `src/mission/currency.ts`, `src/mission/conditions.ts`, `src/mission/frozen-action.ts`, `src/mission/control.ts` (`endLiveClaim`, `transition`, `closeExternalAttempt`), the record schemas of task 01.2, the harness `missionHarness` of `src/mission/test-support.ts`, `src/apps/server/unwired.ts` and the `standIns` option of `composeServices` and `gatewayFixture`.
- Plan 03, through `00-index.md` "Seams": the execution proof (`Operation.requiresExecution`, `caller.execution` with `{ executionId, projectId, nodeId, attempt, pinnedRevision, runtimeIdentity, workerBindingId }`, 403 `gateway.invocation.execution_proof_failed`); `SchedulerClaims.revoke`, `settle`, `liveExecutionOf`; `ExecutionAttribution.of`; `SchedulerWakeup.wake`; the CLI leaves `scheduler work pull`, `scheduler execution release` and `scheduler claim get`.
- Plan 02, through `00-index.md` "Seams": `worker.register` over `worker_instance`, and the 204 answer on both adapters, which `worker.heartbeat` needs first (`engine/docs/cli/worker.md:226`).

## Publication prerequisite resolved

Ulrich approved the Plan04 B1 repair on 2026-10-01. `docs/brainstorm/mission-service.impl.md` "Execution CLI validation" publishes all 24 unchanged local code/condition pairs from `engine/docs/cli/mission.md` "Error codes". Tasks 04.6, 04.8, 04.9, 04.11 and 04.13–04.18 use those exact declarations; their publication prerequisite is resolved. The `code: proposed` and proposed-CLI wording below is historical and grants no naming discretion. Existing domain-code declarations remain authoritative under D2. Implementation, E2E and completed-plan review gates still apply.

Resume at 04.6, preserving completed independent tasks 04.1–04.5, 04.7, 04.10 and 04.12 and the original review baseline `099e442a75bfcd1c9491bd1b15a711c269d85d5a`. Task 04.7 remains independently implementable with seeded pending assets and does not require the submit handler of 04.6. The response schema is `assessmentSubmitResultSchema`; the existing `assessmentResultSchema` is the result enum.

## Provides

| Seam                               | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                                                                                          | Owner file                        | Consumer plans |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| `ProjectBindings.storageBindingOf` | `(tx: Transaction, bindingId: string): { bindingId: string; projectId: string; endpoint: string; bucket: string; region: string; prefix: string; credential: string; available: boolean } \| null` — the row that the identity names                                                                                                                                                                                                                          | `src/project/contract.ts`         | 04             |
| `IntakeStorage` (declared)         | `put(call, binding, key, size, sha256): Promise<{ putUrl; headers; expiresAt }>`; `check(call, binding, key, size, sha256): Promise<{ location; version }>`; `get(call, binding, key, version): Promise<{ getUrl; expiresAt }>`; `executionGet(call, binding, key, version)`: the same answer; `delete(call, binding, key, version): Promise<void>` — `call` is `{ context: Context; identity: CallerIdentity }`, `sha256` and `version` are `string \| null` | `src/mission/contract.ts`         | ERD 3          |
| `IntakeCheck` (declared)           | `check(context: Context, request: { frozenAction: FrozenAction; address: PlatformAddress }): Promise<{ endState: "expected" \| "other" \| "none"; landedCommits: string[] }>`                                                                                                                                                                                                                                                                                 | `src/mission/contract.ts`         | ERD 3          |
| Execution submissions              | `mission.evidence.submit`, `mission.evidence.asset.complete`, `mission.assessment.submit`, `mission.evidence.request`                                                                                                                                                                                                                                                                                                                                         | `src/mission/contract.ts`         | 06, 08, 09, 10 |
| Execution-scoped reads             | the nine operations of `engine/docs/cli/mission.md:523–531`                                                                                                                                                                                                                                                                                                                                                                                                   | `src/mission/contract.ts`         | 07, 08, 09     |
| Object sink of the tests           | `objectSink(t): Promise<{ endpoint: string; objects: Map<string, Uint8Array> }>`; `sinkStorage(sink): IntakeStorage`; `scriptedCheck(answer): IntakeCheck`                                                                                                                                                                                                                                                                                                    | `src/apps/server/test-support.ts` | 09, 10         |

`IntakeStorage` differs from the sketch of `00-index.md` "Seams": it adds `executionGet`, because the pages name two operations that sign a GET, `intake.storage.get` under `human` access and `intake.execution.storage.get` under `client` access (`intake-service.impl.md:51`), and no handler shapes its result by the kind of the caller (`architecture.impl.md:670`).

## Tasks

### 04.1 Add `storageBindingOf` to the Project Service

- Files: `src/project/contract.ts` (edit), `src/project/service.ts` (edit), `src/project/service.test.ts` (edit)
- Do:
  1. Declare `StorageBinding` in `src/project/contract.ts` with the fields of the Provides row.
  2. Implement `storageBindingOf(tx, bindingId): StorageBinding | null` in `ProjectService` beside `getBindingRevision` (`src/project/service.ts:534`). Read the row with `readBindingRevision` (`src/project/store.ts:562`). Answer null when the row is absent or its kind is not `storage`. Parse `config` with `storageConfigSchema` (`src/project/contract.ts:131–138`). Answer the fields of the parsed row, never of the latest row of the group.
  3. Add tests: a pinned row answers its own `prefix` after a later revision changes it; a repository binding answers null; an unknown identity answers null; the call opens no transaction of its own.
- Rules:
  - The asset pins the storage binding revision that the pinned node revision names. `mission-service.impl.md:300`; `02-execution.md:247`.
  - The storage configuration holds `endpoint`, `bucket`, `region`, `prefix`, `credential` and `available`. `project-service.impl.md:146–152`.
  - A collaboration takes the caller transaction and opens none. `architecture.impl.md:592–593`.
  - A consuming plan adds the Project collaboration that it needs, and no ERD 1 Project operation changes. `00-index.md` "Shared files", row `src/project/contract.ts`.
- Done when: `pnpm run verify` passes; the four tests pass.

### 04.2 Declare the Intake seams and the Mission store, and wire the stand-ins

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/test-support.ts`, `src/mission/service.test.ts`, `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/unwired-import.test.ts` (all edit)
- Do:
  1. Add `storageBindingOf(tx, bindingId)` to `MissionBindings` (`src/mission/contract.ts:25–43`) with the inline return type of task 04.1.
  2. Declare inline, with method syntax, `IntakeCall`, `StorageBinding`, `IntakeStorage` and `IntakeCheck` with the signatures of the Provides table. Declare the closed set `CheckEndState` (`expected`, `other`, `none`) with a `z.enum` schema.
  3. Widen the answer of `SchedulerClaims.liveExecutionOf` of task 01.4 to `{ executionId: string; runtimeIdentity: string; attempt: number; pinnedRevision: number } | null`, the fields of the `ExecutionRow` of `00-index.md` "Seams" that this plan reads.
  4. Add `store: Store`, `intakeStorage: IntakeStorage` and `intakeCheck: IntakeCheck` to `Dependencies` (`src/mission/service.ts:74–79`) as required fields.
  5. In `composeServices` (`src/apps/server/index.ts:62–72`, `:123–131`), pass `store: options.store`, add `storageBindingOf: (tx, bid) => project.storageBindingOf(tx, bid)` to the Mission `bindings`, and extend `standIns` with `intakeStorage?` and `intakeCheck?`. Without a stand-in, pass an object whose every method is `unwired("<Interface>.<method>")`.
  6. In `gatewayFixture` (`src/apps/server/test-support.ts:125–138`), extend `standIns` with the same two fields. The default of each is the same unwired object, the true state of the absent ERD 3 peer.
  7. In `src/apps/server/test-support.ts`, export `objectSink(t)`: a `node:http` server on `127.0.0.1` port 0 that stores the body of each `PUT` by path, answers `GET` with the stored bytes or 404, and closes in `t.after`. Export `sinkStorage(sink)`: `put` answers `{ putUrl: endpoint + "/" + key, headers, expiresAt: now + 3600000 }` with the header `x-amz-checksum-sha256` only for a non-null `sha256`; `check` answers `{ location: "s3://" + bucket + "/" + key, version: null }` when the stored length equals `size`, and throws an `Error` with the message `object size mismatch` otherwise; `get` and `executionGet` answer the `GET` URL; `delete` removes the entry. Export `scriptedCheck(answer)`, which answers the given value to each call and records the calls.
  8. In `unwired-import.test.ts`, add `IntakeStorage.put`, `IntakeStorage.check`, `IntakeStorage.get`, `IntakeStorage.executionGet`, `IntakeStorage.delete` and `IntakeCheck.check` to `UNWIRED_SEAMS`.
  9. In `missionHarness` and in `makeService` of `src/mission/service.test.ts`, pass the store of the harness, and fakes of both seams that throw `UNEXPECTED_COLLABORATION` by default. Give the `bindings` default a `storageBindingOf` that throws the same error.
- Rules:
  - A collaboration type is declared inline in the own `contract.ts` of the service, and the composition root is the only file that imports cross-service types. `00-index.md` "Collaboration-type contract rule"; `src/project/service.ts:16`.
  - Every collaboration is required. Decision D4.
  - An ERD 3 seam is `unwired` in production and a fake in `gatewayFixture`. Decisions D6, D17.
  - A handler runs asynchronous work first and performs one `caller.commit` at the end; the store handle serves the reads before that asynchronous work. `architecture.impl.md:694–699`. Precedent: `src/custody/service.ts:799`; `src/project/service.ts:569`.
  - A store transaction is synchronous and never nests. `architecture.impl.md:117`; `src/kernel/store.ts:66–67`.
  - The checksum header exists only when the submission supplies a SHA-256. `mission-service.impl.md:302`; `engine/docs/cli/mission.md:564`.
  - Only a test file imports `test-identity.ts`. `eslint.config.js:206–224`.
  - Gap: the service identity of the Mission Service for the Intake check stays with the composition of ERD 3 (`intake-service.impl.md:48`); no service identity exists in ERD 2 code (`src/kernel/caller.ts:2`).
- Done when: `pnpm run verify` passes; `unwired-import.test.ts` asserts the new set; every earlier E2E test passes unchanged.

### 04.3 Declare the execution schemas and the error codes

- Files: `src/mission/contract.ts` (edit), `src/mission/contract.test.ts` (edit)
- Do:
  1. Declare `mediaTypeSchema` (ASCII `type/subtype`, no parameter, at most 255 bytes), `contentBytesSchema` `{ mediaType, encoding: "base64", data: string }`, and `OBJECT_SIZE_MAX = 5 * 1024 ** 3`, `INLINE_BYTES_MAX = 5 * 1024 ** 2`, `UPLOAD_LIFETIME_MS = 3600000`.
  2. Declare with `z.strictObject`: `executionContextSchema` `{ executionId: identitySchema("execution"), attempt: positive safe integer, nodeRevision: positive safe integer }`; `assetSubmitSchema` as the discriminated union of `{ kind: "repository", address: repositoryAddressSchema }`, `{ kind: "produced", content: contentBytesSchema }` and `{ kind: "object", size: z.number().int().min(0).max(OBJECT_SIZE_MAX), mediaType, sha256?: sha256Schema }`; `evidenceSubmitSchema` = the context plus `subject: textSchema`, `assets` with at least one item, `verification?: verificationSchema`; `assessmentSubmitSchema` = the context plus `evidenceIds`, `childOutcomeIds` (duplicate-free arrays), `result`, `rationale: textSchema`, `testedInput: testedInputSchema`; `evidenceRequestSchema` = the context plus `requirementKey: actionKeySchema`, `subject: textSchema`, `address: platformAddressSchema`; `evidenceDeleteSchema` `{ expectedMissionVersion, force: boolean, reason?: textSchema }` with a `superRefine` that requires `reason` when `force` is true; `nodeCheckSchema` `{ expectedMissionVersion }`.
  3. Declare the answers: `evidenceSubmitResultSchema` `{ evidence, uploads: { assetId, putUrl, headers, expiresAt }[] }`; `assetUploadResultSchema` `{ assetId, evidenceId, uri }` with `uri` that starts with `s3://`; `assessmentSubmitResultSchema` `{ assessment, node, outcome: outcome | null }` (the existing `assessmentResultSchema` remains the result enum); `storedContentSchema` as the union of the inline shape `{ assetId, address: producedAddressSchema, mediaType, encoding, data }` and the object shape `{ assetId, address: objectAddressSchema, mediaType, size, getUrl, expiresAt }`; `nodeCheckResultSchema` `{ results: { evidenceId, requirementKey, resolution: "unresolved" | "expected-end" | "other-end" }[], failures: { evidenceId, error: errorSchema }[] }`; `executionObjectiveSchema` as the union of the objective variant of `nodeSchema` and `z.strictObject({ id, state })`.
  4. Add to `MissionErrorCode` (`src/mission/contract.ts:61–98`) the written codes `EvidenceBindingMismatch`, `EvidenceTooLarge`, `EvidenceUploadExpired`, `EvidenceContentRepository`, `EvidenceRemoveNodeLive`, `EvidenceRequestForceRequired`, `EvidenceRequestAssetRefused`, `AssessmentEvidenceUnpublished`, `AssessmentVerificationFailed`, `NoUnresolvedRequest`, `RecordNotFound`, and the proposed codes of this plan: `mission.execution.context_mismatch`, `mission.evidence.storage_binding_absent`, `mission.evidence.content_platform`, `mission.execution.claim_not_evaluation`, `mission.request.requirement_unknown`, `mission.request.already_requested`, `mission.request.address_mismatch`, `mission.execution.revision_above_pin` (code: proposed, each).
  5. In `contract.test.ts`, assert that each input refuses an unknown key and an `actor` key, that `attempt: 0` fails the context, that `force: true` without `reason` fails, that a size of 5 GiB passes and one byte more fails, that `text/plain; charset=utf-8` fails and `text/plain` passes, and that an assessment with a `method` key fails.
- Rules:
  - Every field name equals the CLI page: `ExecutionContext`, `EvidenceSubmit`, `ContentBytes`, `Verification`, `AssessmentBody`, `AssessmentSubmit` (`engine/docs/cli/mission.md:715–723`); `EvidenceDelete`, `NodeCheck` (`:706–707`); `EvidenceSubmitResult`, `AssetUploadResult` (`:731–732`); `StoredContent`, `AssessmentResult`, `NodeCheckResult` (`:812`, `:815`, `:818`).
  - `EvidenceRequest` holds every field of `ExecutionContext` plus `requirementKey`, `subject` and `address`. `mission-service.impl.md:89–90` (ruled 2026-09-30); decision D10.
  - An execution submission names an attempt of 1 or more. `engine/docs/cli/mission.md:711`; `02-execution.md:244`.
  - An object is at most 5 GiB; the server checks that bound at submit. `02-execution.md:251`; `mission-service.impl.md:297`. A value outside the schema answers 400 `gateway.request.validation_failed`. `engine/docs/cli/other.md:810`.
  - `mediaType` is an RFC 6838 `type/subtype` with no parameter, in ASCII, at most 255 bytes. `mission-service.impl.md:284`.
  - Force without a reason answers HTTP 400 with a validation issue list. `mission-service.impl.md:346`.
  - An objective read without an outcome carries its identity and its state only. `engine/docs/cli/mission.md:543`.
  - No input carries an actor, and no assessment holds a `method` field. `mission-service.impl.md:33`, `:203`, `:224`.
  - The `ProducedAddress` of an inline asset derives from its content; `ContentBytes` carries no digest, so the server computes the SHA-256. `mission-service.impl.md:261–262`, `:269`; `02-execution.md:247`.
  - Every proposed code follows `<namespace>.<component>…<error>`. `architecture.impl.md:343–347`. Aelita writes each accepted code before the plan commits. Ruling R3.
- Done when: `pnpm run verify` passes; `contract.test.ts` passes.

### 04.4 Add the execution admission core

- Files: `src/mission/execution.ts` (create), `src/mission/execution.test.ts` (create)
- Do:
  1. Implement `admitExecution(tx, dependencies, claim, routeNodeId, context, now): { node; attempt; revision; actor }` in this order:
     - `schedulerClaims.liveExecutionOf(tx, claim.nodeId, now)`. An answer of null, another `executionId` or another `runtimeIdentity` throws `OperationError(409, "scheduler.execution.not_running", …)`.
     - A `routeNodeId` other than `claim.nodeId`, or a `context` whose `executionId`, `attempt` or `nodeRevision` differs from `claim.executionId`, `claim.attempt` or `claim.pinnedRevision`, throws 409 `mission.execution.context_mismatch` (code: proposed) with `details: { field }`.
     - Read the node, the open attempt and the pinned revision. Assert that the node is an initiative or an objective, that the open attempt equals `claim.attempt` and that its `node_revision` equals `claim.pinnedRevision`.
     - Derive `actor` as `{ kind: "execution", executionId, clientId, name }` from `executionAttribution.of(tx, executionId)`, and assert a non-null answer.
  2. Implement `requireEvaluationClaim(node)`: a state other than `Evaluating` throws 409 `mission.execution.claim_not_evaluation` (code: proposed).
  3. Implement `requireTextBound(field, value, textMaxBytes)`: a value above the bound throws `OperationError(400, "gateway.request.validation_failed", "Request validation failed.", [{ path: [field], code: "too_big" }])`.
  4. Add tests with `missionHarness`: an ended execution answers `scheduler.execution.not_running`; each mismatched field answers `mission.execution.context_mismatch`; a route that names a task answers the same code; a `Executing` node answers `mission.execution.claim_not_evaluation`; a subject of `textMaxBytes` bytes passes and one byte more fails.
- Rules:
  - Every execution mutation repeats the full proof in its write transaction: the claimant, a null `ended_at` and a reading before `expired_at`. A failed check answers 409 `scheduler.execution.not_running`. `02-execution.md:216`; `scheduler-service.md:231–237`; `engine/docs/cli/scheduler.md:499`.
  - The chain passes the node, the attempt and the pinned revision, and the handler reads none of them from the input. `architecture.impl.md:654`; decision D10.
  - `ExecutionContext` must match the authenticated live claim. `engine/docs/cli/mission.md:715`. Code `mission.execution.context_mismatch` (409): proposed in `00-index.md` "Codes for Ulrich". No code of `engine/docs/cli/other.md` and no ERD 1 code covers it.
  - An execution submission names the claimed node and the open attempt of the claim. `02-execution.md:244`.
  - The provenance of an execution submission is that execution, in the execution actor form. `02-execution.md:245`; `mission-service.impl.md:31`.
  - An assessment and a request need an evaluation claim; the node state `Evaluating` fixes the kind of a live claim. `engine/docs/cli/mission.md:458`; `mission-service.impl.md:89`; `02-execution.md:212`. Code `mission.execution.claim_not_evaluation` (409): proposed in `00-index.md`.
  - A `Text` value above `mission.textMaxBytes` answers HTTP 400 with an issue list. `mission-service.impl.md:546`; `engine/docs/cli/other.md:810`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.5 Add the evidence content validation

- Files: `src/mission/evidence-content.ts` (create), `src/mission/evidence-content.test.ts` (create)
- Do:
  1. Implement `repositoryBindingOf(tx, bindings, revision)` and `storageBindingIdOf(tx, bindings, revision)`: the one binding identity of the pinned revision whose `resourceIdentity` kind is `repository` or `storage`, or null.
  2. Implement `requireRepositoryAddress(tx, bindings, node, revision, address)`. For an objective, a `bindingId` other than the repository binding of the pinned revision throws 400 `mission.evidence.binding_mismatch` with `details: { bindingId }`. For an initiative, a `bindingId` that names no repository binding row of the project throws the same code.
  3. Implement `requireTestedInput(tx, bindings, node, revision, testedInput)`. For an objective, the input is one `Address`, and a repository address passes step 2. For an initiative, the repository bindings of its current objectives, discarded objectives included, form a set of resource identities. A nonempty set requires an array with one address for each resource identity and no other; an empty set requires a `produced` or an `object` address. A wrong form throws 400 `gateway.request.validation_failed` with the path `testedInput`; a wrong binding throws `mission.evidence.binding_mismatch`.
  4. Implement `producedContent(bytes)`: refuse noncanonical base64 with 400 `gateway.request.validation_failed`; refuse more than `INLINE_BYTES_MAX` decoded bytes with 413 `mission.evidence.too_large`; answer the shape `{ mediaType, sha256, data }` with the SHA-256 of the decoded bytes.
  5. Implement `objectKey(binding, projectId, missionId, nodeId, attempt, assetId)` as `[prefix, projectId, missionId, nodeId, attempt, assetId].join("/")`, `objectLocation(binding, key)` as `"s3://" + bucket + "/" + key`, and `keyOfLocation(binding, location)`, which asserts the bucket prefix and answers the key.
  6. Implement `requiredVerifications(tx, node, revision)`: the verifications of the pinned revision and, for an objective, the verifications of each task of its `tasks` snapshot. Implement `verificationPasses(verification, expected)`: `results` hold exactly one entry for each expected command, as a multiset of `command`, and every `exitCode` is 0.
  7. Add tests: 40 and 64 lower-case hexadecimal commits pass; an abbreviation, upper case and a ref name fail at the schema; a foreign binding answers `mission.evidence.binding_mismatch`; an initiative with two objectives on one binding needs one address; a discarded objective contributes its binding; 5 MiB decoded passes and one byte more answers 413; the SHA-256 is the digest of the bytes; the key and the location follow the page form; a run with an extra entry, an absent entry or a failed entry does not pass.
- Rules:
  - The asset shapes: `bindingId` and `commit`; `mediaType`, `sha256` and canonical base64 `data` of at most 5 MiB decoded; `location`, `size`, `mediaType`, `storageBindingId`, `objectVersion` when returned and an optional `sha256`. `02-execution.md:247`; `mission-service.impl.md:268–269`.
  - `bindingId` names a repository binding row of the project in every context, and for an objective it equals the repository binding of the pinned revision. `02-execution.md:248`; `mission-service.impl.md:279–283`.
  - The tested input of an initiative holds one commit per distinct binding of its current objectives, discarded objectives included; with no repository it is a produced or an object address. `engine/docs/cli/mission.md:736–741`; `mission-service.vocabulary.md:313–343`.
  - The service checks the commit form alone and never the repository. `mission-service.impl.md:278`.
  - Larger inline content answers 413 `mission.evidence.too_large`; the service never truncates. `mission-service.impl.md:259–264`; `engine/docs/cli/mission.md:927`.
  - The object key is `<prefix>/<project>/<mission>/<node>/<attempt>/<evidence asset id>`. `mission-service.impl.md:299`; `engine/docs/cli/mission.md:561`.
  - A run passes when `results` hold one entry per verification and every entry has `exitCode` 0; for an objective, the verifications of each current task of the pinned revision count. `mission-service.impl.md:189`, `:196`; `02-execution.md:268`.
  - The CLI page fixes no order across the objective and its tasks, so the check compares a multiset. `engine/docs/cli/mission.md:721`, `:751`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.6 Implement `mission.evidence.submit` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-submit.ts` (create), `src/mission/evidence-submit.test.ts` (create), `src/apps/cli/mission-evidence.ts` (create), `src/apps/cli/mission.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.submit"`: `writeOperation` with `access: AccessPolicy.Client` and `requiresExecution: true`, id `mission.evidence.submit`, `POST /api/mission/node/:nodeId/evidence`, body `evidenceSubmitSchema`, output `evidenceSubmitResultSchema`.
  2. Implement `prepareEvidence(tx, dependencies, claim, nodeId, body, now)`: `admitExecution`; `requireTextBound` on `subject`; each repository asset through `requireRepositoryAddress`; each produced asset through `producedContent`; a `verification` through `requireTestedInput`. For an object asset, read `storageBindingIdOf` of the pinned revision; null throws 409 `mission.evidence.storage_binding_absent` (code: proposed); read `storageBindingOf`. Mint the evidence identity and each asset identity, and answer the rows and the object keys.
  3. In the handler, run `prepareEvidence` in `dependencies.store.transaction` only when the body holds an object asset, and call `intakeStorage.put(call, binding, key, size, sha256 ?? null)` for each object asset. Then call `caller.commit`: read the clock once, run `prepareEvidence` again with the minted identities, and `insertEvidence` (`src/mission/record-store.ts`) with the evidence, `requirement_key` null, `end_state` null, the `verification`, the execution actor as `provenance`, and each asset. A `repository` or `produced` asset takes `published_at = now`; an `object` asset takes `published_at` null, `expired_at = now + UPLOAD_LIFETIME_MS` and the content `{ location, size, mediaType, storageBindingId, sha256? }`. Answer `{ evidence: evidenceRecord(…), uploads }`.
  4. In `src/apps/cli/mission-evidence.ts`, export `addEvidenceCommands(mission: Command)` with the leaf `evidence submit <node-id> --file <path> [--idempotency-key <key>]`. It validates the node identity with `cli.mission.evidence.submit.invalid_node_id` (code: proposed) and reads the file with `evidenceSubmitSchema`. A file with an `object` asset fails before any request with `cli.mission.evidence.submit.object_asset` (code: proposed). Call `addEvidenceCommands` from `addMissionCommand` (`src/apps/cli/mission.ts:599`).
  5. Regenerate OpenAPI with `pnpm run build && node bin/kanthord.mjs gateway openapi`, and assert the operation id in `openapi-integration.test.ts`.
  6. Add tests: a repository evidence of an objective is published at once; a produced evidence stores the SHA-256; an object evidence answers one upload with a 1 hour `expiresAt` and a pending asset; a node without a storage binding answers `mission.evidence.storage_binding_absent`; a repeat creates a second evidence; a failed `put` writes no row; a submission under an evaluation claim passes; a claim that ends between the pre-read and the commit answers `scheduler.execution.not_running`; a human caller answers 401 at the chain.
- Rules:
  - The route, the input, the answer and the access E. `engine/docs/cli/mission.md:398`, `:556`, `:719`, `:731`.
  - The submission writes the evidence row and every asset row in one transaction; no asset joins it later. `02-execution.md:246`; `mission-service.impl.md:270`.
  - A `repository`, `produced` or `platform` asset sets `published_at` at the insert; an `object` asset sets `expired_at` 1 hour after the submission. `02-execution.md:249`; `mission-service.impl.md:271`.
  - A node without a storage binding accepts no object asset. `02-execution.md:251`; `mission-service.impl.md:265`, `:298`. Code `mission.evidence.storage_binding_absent` (409): proposed in `00-index.md` "Codes for Ulrich".
  - The Intake Service signs a presigned PUT with a lifetime of 1 hour, and the answer supplies one PUT for each object asset. `mission-service.impl.md:301`; `engine/docs/cli/mission.md:563`.
  - A row that records a remote effect follows that effect; the signature is asynchronous work before the commit. `02-execution.md:187`; `architecture.impl.md:697–699`.
  - An evidence has no natural key; a repeat creates a second row. `02-execution.md:245`; `architecture.impl.md:717`.
  - Presigned URLs never reach agent-facing stdout, so the CLI leaf refuses an object asset and directs it to the host helper. `engine/docs/cli/mission.md:781`, `:549`, `:540` (ruled 2026-09-30).
  - CLI codes `cli.mission.evidence.submit.invalid_node_id` and `cli.mission.evidence.submit.object_asset`: proposed under `architecture.impl.md:348`.
  - The task that declares a route adds the CLI leaf and regenerates OpenAPI; an oversized fragment takes the named exception. ERD 1 decision D13; decision D23.
- Done when: `pnpm run verify` passes; the tests pass; `kanthord mission evidence submit --help` exits 0.

### 04.7 Implement `mission.evidence.asset.complete`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-complete.ts` (create), `src/mission/evidence-complete.test.ts` (create), `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.asset.complete"`: client write with `requiresExecution: true`, id `mission.evidence.asset.complete`, `POST /api/mission/evidence/asset/:assetId/complete`, body `executionContextSchema`, output `assetUploadResultSchema`.
  2. Implement `prepareComplete(tx, dependencies, claim, assetId, context, now)`: an absent asset or an asset of another kind than `object` throws 404 `mission.record.not_found`; `admitExecution` with the node of its evidence; an evidence whose `attempt` differs from `claim.attempt` throws `mission.execution.context_mismatch`; answer the published answer at once when `published_at` is set; `expired_at <= now` throws 409 `mission.evidence.upload_expired`; read `storageBindingOf` of `storageBindingId`.
  3. In the handler, run `prepareComplete` in `dependencies.store.transaction`. For a pending asset, call `intakeStorage.check(call, binding, key, size, sha256 ?? null)` and assert that its `location` equals the stored `location`. Then call `caller.commit`: run `prepareComplete` again with the clock of the commit, set `published_at = now`, and write the content with `objectVersion` when `version` is not null. Answer `{ assetId, evidenceId, uri: location }`.
  4. Regenerate OpenAPI and assert the operation id.
  5. Add tests: a complete publishes the asset and its evidence; a repeat after the publication answers the same result and calls no `check`; a thrown `check` keeps the asset pending and propagates; an expired asset answers `mission.evidence.upload_expired`; an asset of another node answers `mission.execution.context_mismatch`; a returned version reads back as `address.version`.
- Rules:
  - The route, the input and the answer. `engine/docs/cli/mission.md:557`, `:732`, `:734`.
  - The server checks the live claim, and the Intake Service checks the size and the optional checksum; a mismatch prevents publication. `mission-service.impl.md:305–308`; `engine/docs/cli/mission.md:566–568`.
  - The asset holds the location, the version when the store returns one, the size, the media type and the optional SHA-256; the answer holds the identity and the `s3://` URI. `mission-service.impl.md:309–310`; `02-execution.md:247`.
  - An asset whose `expired_at` passed never completes, and a complete of it answers 409 `mission.evidence.upload_expired`. `02-execution.md:249`; `mission-service.impl.md:313`; `engine/docs/cli/mission.md:928`.
  - A mutation is idempotent by its own natural key, the asset identity. `engine/AGENTS.md` "Add an operation".
  - An absent record answers 404 `mission.record.not_found`; only an `object` asset holds a pending upload. `mission-service.impl.md:548`; `engine/docs/cli/mission.md:966`; `mission-service.vocabulary.md:91–94`.
  - An evidence is published when every asset of it holds `published_at`. `02-execution.md:250`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.8 Implement `mission.evidence.list` and `mission.evidence.get` with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-read.ts` (create), `src/mission/evidence-read.test.ts` (create), `src/mission/record-store.ts`, `src/apps/cli/mission-evidence.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.list"` (`mission.evidence.list`, `GET /api/mission/node/:nodeId/evidence`, query `pageQuery` plus optional nonnegative `attempt`, output `pageOf(evidenceSchema)`) and `"evidence.get"` (`mission.evidence.get`, `GET /api/mission/evidence/:evidenceId`, output `evidenceSchema`), both `readOperation` under `human` access.
  2. Add `listEvidence(tx, nodeId, attempt, after, count)` to the record store: the rows of the node in descending identity order, of one attempt when `attempt` is given.
  3. Implement the handlers with one `caller.commit` each. A task answers 400 `mission.node.control_task`; an absent node answers 404 `mission.node.not_found`; an absent evidence answers 404 `mission.record.not_found`; a malformed cursor answers 400 `system.pagination.cursor_invalid`.
  4. Add the leaves `evidence list <node-id> [--attempt <attempt>] [--limit] [--cursor]` and `evidence get <evidence-id>` to `addEvidenceCommands`, with `cli.mission.evidence.list.invalid_node_id`, `cli.mission.evidence.list.invalid_attempt` and `cli.mission.evidence.get.invalid_evidence_id` (code: proposed).
  5. Regenerate OpenAPI and assert both operation ids.
  6. Add tests: the order, the cursor, `--attempt 0` with the landed commit of an override, a pending asset with `publishedAt: null`, a request evidence with `requirementKey` and no `endState`, a task refusal and an absent evidence.
- Rules:
  - The routes, the access H, the filter and the answers. `engine/docs/cli/mission.md:396–397`, `:409–418`, `:432`.
  - A record list requires an initiative or an objective. `engine/docs/cli/mission.md:417–418`; `mission-service.impl.md:174`.
  - A list orders by its primary key in descending order. `engine/docs/cli/mission.md:788`; ERD 1 decision D10.
  - CLI codes: proposed under `architecture.impl.md:348`, within the family row `cli.mission.<command>.invalid_<argument>` of `00-index.md`.
  - Gap: the record commands keep their HANDOFF mark (`docs/brainstorm/HANDOFF.md:27`); the reads implement the CLI page as written.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.9 Implement the two content reads with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-content-read.ts` (create), `src/mission/evidence-content-read.test.ts` (create), `src/apps/cli/mission-evidence.ts`, `src/apps/cli/mission-execution.ts` (create), `src/apps/cli/mission.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.asset.content.get"` (`mission.evidence.asset.content.get`, `GET /api/mission/evidence/asset/:assetId/content`, `human` read) and `"execution.evidence.asset.content.get"` (`mission.execution.evidence.asset.content.get`, `GET /api/mission/execution/:executionId/evidence/asset/:assetId/content`, `client` read with `requiresExecution: true`), each with output `storedContentSchema`.
  2. Implement one domain query `contentOf(tx, assetId, bound)` with a required bound. The human bound admits every asset. The execution bound admits an asset whose evidence names the claimed node and attempt and, for an initiative claim, an asset of an evidence that the current outcome of a current objective names; any other asset throws 404 `mission.record.not_found`. A `repository` asset throws 409 `mission.evidence.content_repository` with `details: { evidenceId, address }`. A `platform` asset throws 409 `mission.evidence.content_platform` (code: proposed) with the same `details`. A `produced` asset answers the inline shape.
  3. For an `object` asset, run `contentOf` in `dependencies.store.transaction`, call `intakeStorage.get` or `intakeStorage.executionGet` with the key and the recorded version, then answer from `caller.commit`, which runs `contentOf` again and adds `getUrl` and `expiresAt`.
  4. Add the leaf `evidence asset content get <asset-id>` to `addEvidenceCommands` with `cli.mission.evidence.asset.content.get.invalid_asset_id` (code: proposed); it prints the answer. In `src/apps/cli/mission-execution.ts`, export `addExecutionCommands(mission: Command)` with the leaf `execution evidence asset content get <execution-id> <asset-id>` and the codes `cli.mission.execution.evidence.asset.content.get.invalid_execution_id` and `cli.mission.execution.evidence.asset.content.get.invalid_asset_id` (code: proposed). It prints an inline answer; for an object answer it prints nothing and fails with `cli.mission.execution.evidence.asset.content.get.object_content` (code: proposed). Call `addExecutionCommands` from `addMissionCommand`.
  5. Regenerate OpenAPI and assert both operation ids.
  6. Add tests: an inline answer holds the bytes and the derived address; an object answer holds the GET of the recorded version; an object without a version signs the key alone; a repository asset answers `mission.evidence.content_repository` with the address; a platform asset answers `mission.evidence.content_platform`; an asset of another node answers 404 under the execution bound; a deleted asset answers 404 with no bytes and no URL.
- Rules:
  - The routes and the access. `engine/docs/cli/mission.md:399`, `:527`.
  - Both reads call one domain query with a required bound that the server derives from the caller, and return one record schema. `engine/docs/cli/mission.md:153`; `architecture.impl.md:671–674`.
  - An execution reads no content of another node, except a current child objective of its initiative at the revision of its current outcome. `engine/docs/cli/mission.md:198–200`, `:541–542`.
  - An identity that a caller guesses conveys no authority, so an asset outside the bound answers 404. `engine/docs/cli/mission.md:145–146`.
  - A repository asset answers 409 `mission.evidence.content_repository` with `evidenceId` and the address, after the authorization and the bound checks. `mission-service.impl.md:285`; `engine/docs/cli/mission.md:812`, `:923`.
  - A platform asset answers 409 `mission.evidence.content_platform` with `evidenceId` and the address. `mission-service.impl.md:293`; `engine/docs/cli/mission.md:949` (ruled 2026-09-30).
  - The Intake Service signs the GET through `intake.storage.get` for a human and `intake.execution.storage.get` for an execution, at the recorded version. `mission-service.impl.md:325–326`; `intake-service.impl.md:51`.
  - The reader's component keeps the GET URL outside the agent context, so the E leaf refuses an object answer. `engine/docs/cli/mission.md:540`, `:781`, `:904` (ruled 2026-09-30).
  - A read of a deleted asset answers 404 `mission.record.not_found` with no content. `mission-service.impl.md:356`; `engine/docs/cli/mission.md:821`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.10 Add the assessment admission checks

- Files: `src/mission/assessment-admit.ts` (create), `src/mission/assessment-admit.test.ts` (create)
- Do:
  1. Implement `admitAssessment(tx, dependencies, node, attempt, revision, body)` in this order:
     - `requireTextBound` on `rationale`.
     - Each identity of `evidenceIds` names an evidence of the node and of the attempt; else 400 `gateway.request.validation_failed` with the path `evidenceIds`.
     - Each named evidence is published; else 409 `mission.assessment.evidence_unpublished`.
     - `childOutcomeIds` is empty for an objective. For an initiative it equals the set of the current outcomes of its current objectives that hold an outcome. Else 400 `gateway.request.validation_failed` with the path `childOutcomeIds`.
     - `testedInput` passes `requireTestedInput`.
     - For `success`: exactly one named evidence holds a `verification`, that run passes `verificationPasses` against `requiredVerifications`, and its `testedInput` equals the body `testedInput` in canonical JSON. A failed run, no verification or a second verification answers 409 `mission.assessment.verification_failed`. A different tested input answers 400 `gateway.request.validation_failed` with the path `testedInput`.
     - For `undetermined`: a named verification that does not pass answers 400 `gateway.request.validation_failed` with the path `result`.
  2. Add tests: each refusal and its order; `criterion-not-met` with a failed verification passes; a success whose `results` miss a task verification answers `mission.assessment.verification_failed`; an evidence of another attempt answers 400; an initiative child set with an extra outcome answers 400; a pending asset and an expired asset answer `mission.assessment.evidence_unpublished`.
- Rules:
  - The evidence, the tested input and the child outcomes of an assessment belong to the node and to the context of its attempt. `02-execution.md:265`; `engine/docs/cli/mission.md:722`.
  - `childOutcomeIds` of an initiative names the current outcome of each current objective and no other; for an objective it is empty; the service refuses every other set with HTTP 400 and an issue list. `mission-service.impl.md:227`; `02-execution.md:266`.
  - An assessment that names an evidence with a pending or expired asset answers 409 `mission.assessment.evidence_unpublished`. `mission-service.impl.md:230`; `engine/docs/cli/mission.md:916`.
  - A success names exactly one evidence with a passing `verification` that covers the objective and each current task of the pinned revision; otherwise 409 `mission.assessment.verification_failed`. `mission-service.impl.md:194–196`; `02-execution.md:267–268`; `engine/docs/cli/mission.md:917`.
  - The assessment names the tested input of the verification that it names. `mission-service.md:519`.
  - A result that violates the result order answers HTTP 400 with an issue list. `mission-service.impl.md:212–224`; `engine/docs/cli/mission.md:757–766`.
  - The server checks no default-standard violation; the worker applies that rule. `02-execution.md:269`; `mission-service.impl.md:217`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.11 Implement `mission.assessment.submit` with the closure and its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/assessment-submit.ts` (create), `src/mission/assessment-submit.test.ts` (create), `src/apps/cli/mission-record.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"assessment.submit"`: client write with `requiresExecution: true`, id `mission.assessment.submit`, `POST /api/mission/node/:nodeId/assessment`, body `assessmentSubmitSchema`, output `assessmentSubmitResultSchema`.
  2. Implement `submitAssessment(tx, dependencies, claim, nodeId, body, now)`: `admitExecution`; `requireEvaluationClaim`; `admitAssessment`; `insertAssessment` with `execution_id = claim.executionId`, `actor` null, `node_revision` = the pin, the attempt and the canonical sets.
  3. Compute `currencyOf` of the new row and `requiredActionsOf` of the pin. For a current `success` with no required action, and for a current result other than `success`: call `endLiveClaim` (the Scheduler revokes the claim), `closeAttempt`, `insertOutcome` with the result of the assessment, the assessment as its basis and the landed-commit evidence of the attempt, then `transition` to `Completed` or `Blocked`. Otherwise write no outcome and change no state.
  4. Answer `{ assessment: assessmentRecord(…), node: nodeRecord(…), outcome: outcomeRecord(…) | null }`. Call `wakeup.wake(projectId)` after `caller.commit`.
  5. In `src/apps/cli/mission-record.ts`, add the leaf `assessment submit <node-id> --file <path> [--idempotency-key <key>]` with `cli.mission.assessment.submit.invalid_node_id` (code: proposed); it reads the file with `assessmentSubmitSchema`.
  6. Regenerate OpenAPI and assert the operation id.
  7. Add tests: a current pass on an objective with no required action completes the node, closes the attempt, writes the outcome `assessment-passed` and revokes the claim; a `criterion-not-met` and an `undetermined` block the node with the outcome `assessment-not-passed`; a pass on a node with a required action keeps `Evaluating` and answers `outcome: null`; an initiative pass inserts no job of a dependent before its terminal state; a dependent of a completed node moves to `Available` with a job; a pass whose child set is not current writes no outcome; a later submission under the same claim fails the proof after a closure.
- Rules:
  - The route, the input, the answer and the evaluation claim. `engine/docs/cli/mission.md:403`, `:456–462`, `:723`, `:815`.
  - Exactly one of `execution_id` and `actor` is set; an execution assessment stores the execution. `02-execution.md:263`; `mission-service.impl.md:205`.
  - `sequence` takes the next value inside the inserting transaction. `02-execution.md:270`; decision D21.
  - A current passing assessment on a node that requires no external action closes the attempt with `Completed` and ends the claim; a current assessment that does not pass closes the attempt with `Blocked` and ends the claim. `02-execution.md:221`; `mission-service.md:583`, `:585`; `engine/docs/cli/mission.md:463–465`.
  - A passing assessment with no required external action ends the claim, and no release follows. `worker-service.md:519`; `engine/docs/cli/scheduler.md` "execution release", effect 3.
  - The revocation sets `ended_at` in the Mission transaction and counts as no loss. `02-execution.md:224`; `scheduler-service.md:208–209`, `:226`.
  - The outcome asserts the result of its execution assessment; only an execution assessment supports `criterion-not-met`. `02-execution.md:280`; `mission-service.md:533`.
  - The outcome holds the landed-commit evidence of the attempt, and the read answers the union with the assessment set. `02-execution.md:282`; `mission-service.impl.md:407`.
  - A transition inserts the job of a claimable node and deletes the job of an unclaimable node in its transaction, and the service wakes the Scheduler after the commit. `mission-service.md:691–692`; decision D20.
  - A late submission never becomes current because it arrives last. `mission-service.md:297`, `:794`.
  - CLI code `cli.mission.assessment.submit.invalid_node_id`: proposed under `architecture.impl.md:348`.
  - Gap: the recovery of a stale assessment stays B9 B2 (`docs/brainstorm/HANDOFF.md:103`); a pass that is not current leaves the claim to its deadline.
  - Gap: the resumption of an incomplete evaluation stays B9 W7 (`docs/brainstorm/HANDOFF.md:123`).
- Done when: `pnpm run verify` passes; the tests pass.

### 04.12 Implement `mission.evidence.request`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-request.ts` (create), `src/mission/evidence-request.test.ts` (create), `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.request"`: client write with `requiresExecution: true`, id `mission.evidence.request`, `POST /api/mission/node/:nodeId/evidence/request`, body `evidenceRequestSchema`, output `evidenceSchema`.
  2. Implement `requestEvidence(tx, dependencies, claim, nodeId, body, now)` in this order: `admitExecution`; `requireEvaluationClaim`; `requireTextBound` on `subject`; the `FrozenAction` of `requirementKey` in `requiredActionsOf` of the pin, else 400 `mission.request.requirement_unknown` (code: proposed); an address whose `kind` does not match the action (`pull_request` for `pull_request`, `branch_push` for `merge_push`) or whose `resourceIdentity` differs from the `resourceIdentity` of `getBindingRevision(frozenAction.bindingId)` answers 400 `mission.request.address_mismatch` (code: proposed) with `details: { requirementKey }`; a request of the same key in the attempt answers 409 `mission.request.already_requested` (code: proposed).
  3. Insert the evidence with `requirement_key`, `end_state` null, the execution actor as `provenance`, and one `platform` asset with the canonical `PlatformAddress` and `published_at = now`. Answer `evidenceRecord`.
  4. Regenerate OpenAPI and assert the operation id. Declare no CLI leaf.
  5. Add tests: a request writes one evidence with one `platform` asset; the external-action read answers `unresolved`; a steps claim answers `mission.execution.claim_not_evaluation`; an unknown key answers `mission.request.requirement_unknown`; a `branch_push` address for a `pull_request` action and a foreign resource identity answer `mission.request.address_mismatch`; a second request answers `mission.request.already_requested`; the unique index refuses a direct second insert.
- Rules:
  - A `client` operation under the live evaluation claim; it checks the node, the open attempt, the required external action and its binding, and it answers `Evidence`. `mission-service.impl.md:89–90`.
  - The route and the input with every field of `ExecutionContext`. `mission-service.impl.md:89–90` (ruled 2026-09-30); decision D10.
  - No CLI command projects the operation. `engine/docs/cli/mission.md:502–503`, `:847`.
  - `requirement_key` equals the key of a required external action of the attempt, and the evidence holds exactly one `platform` asset. `02-execution.md:287`; `mission-service.md:256–260`. Code `mission.request.requirement_unknown` (400): proposed in `00-index.md` "Codes for Ulrich".
  - `PlatformAddress` holds the `kind` and the `resourceIdentity` of the binding and never a `bindingId`. `mission-service.impl.md:237`; `engine/docs/cli/mission.md:730`. Code `mission.request.address_mismatch` (400): proposed; the condition stands at `mission-service.impl.md:89` ("its binding"). No code of `engine/docs/cli/other.md` and no ERD 1 code covers it.
  - One attempt holds at most one request for each required external action. `02-execution.md:288`; `engine/docs/cli/mission.md:508–509`. Code `mission.request.already_requested` (409): proposed in `00-index.md`.
  - The request asset is a `platform` asset with `published_at` at the insert. `02-execution.md:249`.
  - Gap: the dispatch record and the recovery of a lost answer stay B9 W2 and W3 (`docs/brainstorm/HANDOFF.md:120–121`); a repeat answers `mission.request.already_requested`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.13 Implement `mission.node.check` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/node-check.ts` (create), `src/mission/node-check.test.ts` (create), `src/apps/cli/mission-control.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"node.check"`: `writeOperation`, id `mission.node.check`, `POST /api/mission/node/:nodeId/check`, body `nodeCheckSchema`, output `nodeCheckResultSchema`.
  2. In `dependencies.store.transaction`, run the admission: `requireNode`; a task throws 400 `mission.node.control_task`; `requireMission` with `expectedMissionVersion`; the requests of the open attempt with a null `end_state`, each with its `FrozenAction` and its address. A node with none throws 409 `mission.node.no_unresolved_request`.
  3. For each request in identity order, call `intakeCheck.check(caller.context, { frozenAction, address })`. A thrown error adds `{ evidenceId, error }` to `failures`, with the shared envelope and `caller.requestId`.
  4. Commit each answer in its own `dependencies.store.transaction` with `applyEndState(tx, dependencies, evidenceId, answer, now)`:
     - Compute `claimableMap` first. Read the request again; a set `end_state` or the answer `none` writes nothing.
     - Otherwise set `end_state`. For `expected` of a repository action, insert one evidence for each landed commit: the attempt of the request, the subject `LANDED_COMMIT_SUBJECT`, the provenance `{ kind: "service", service: "mission" }` and one published `repository` asset `{ bindingId, commit }` of the `FrozenAction`.
     - When the request names the open attempt of a node in `External.Requested`, read `actionStatesOf`: an `other-end` action sets `External.Failed`; a requested action with every action at `expected-end` sets `External.Success`; then call `closeExternalAttempt`. Otherwise run `reconcileMission` with the map of step 1, so that a continuation condition inserts its evaluation job.
  5. Answer from `caller.commit`: each checked request with its resolution after its commit, and the failures. Call `wakeup.wake(projectId)` after the commit.
  6. Add the leaf `node check <node-id> --file <path> [--idempotency-key <key>]` to `addControlCommands` with `cli.mission.node.check.invalid_node_id` (code: proposed); it reads the file with `nodeCheckSchema`.
  7. Regenerate OpenAPI and assert the operation id.
  8. Add tests: `expected` with two commits writes two landed-commit evidences and reaches `Completed` with the outcome `external-success`; `other` reaches `Blocked` with the outcome `external-failed`; `none` writes nothing and answers `unresolved`; a thrown check answers `failures` and commits the other results; a request set by a concurrent write keeps its end state; a paused node keeps `Paused`; a node with no unresolved request answers `mission.node.no_unresolved_request`; the mission version stays unchanged.
- Rules:
  - The route, the access H, the input and the answer. `mission-service.impl.md:244`; `engine/docs/cli/mission.md:482`, `:493–497`, `:707`, `:818`.
  - The check calls the Intake check for each unresolved request of the open attempt and commits each result in its own transaction; a node with no unresolved request refuses the check. `mission-service.md:851–855`; `engine/docs/cli/mission.md:955`.
  - `endState` is `expected`, `other` or `none`; the service sets `end_state` once and refuses a later conclusive result; `none` writes nothing. `mission-service.impl.md:239–240`; `02-execution.md:290`.
  - An `expected` result of a repository action writes each landed commit as its own evidence with the service provenance and the attempt of the request. `mission-service.impl.md:241`; `02-execution.md:256`.
  - The transitions `External.Requested -> External.Success` and `-> External.Failed`, then `External.Success -> Completed` and `External.Failed -> Blocked`. `mission-service.md:603–604`, `:607`, `:610`.
  - The transaction that makes the continuation condition hold inserts the evaluation job. `02-execution.md:220`; `mission-service.md:691`.
  - A node check leaves the mission version unchanged and names `expectedMissionVersion`. `mission-service.impl.md:517`, `:522`.
  - A task rejects the external-action calls. `engine/docs/cli/mission.md:486`. The code `mission.node.control_task` extends its command list with `node check` (code: proposed extension).
  - A handler runs asynchronous work before its commit, and a transaction awaits nothing. `architecture.impl.md:117`, `:697`; `mission-service.impl.md:243`.
  - `LANDED_COMMIT_SUBJECT` is a named constant, because `subject` is a nonblank `Text` and no page names its value. `02-execution.md:89`; `architecture.impl.md:15–19`.
  - Gap: the deduplication of an unchanged state stays B9 C3, and a reversed platform state and an end state that never arrives stay C5 and C6 (`docs/brainstorm/HANDOFF.md:105–107`).
  - Gap: the service identity of the Intake check stays with the composition of ERD 3 (`intake-service.impl.md:48`).
- Done when: `pnpm run verify` passes; the tests pass.

### 04.14 Implement `mission.evidence.asset.delete` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-delete.ts` (create), `src/mission/evidence-delete.test.ts` (create), `src/mission/record-store.ts`, `src/apps/cli/mission-evidence.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.asset.delete"`: `writeOperation` with `method: DELETE`, `status: HttpStatus.NoContent`, id `mission.evidence.asset.delete`, `/api/mission/evidence/asset/:assetId`, body `evidenceDeleteSchema`, output `z.null()`.
  2. Implement `admitDelete(tx, node, body)`: `requireMission` with `expectedMissionVersion`; without `force`, a node of the evidence or an ancestor that is not `Completed` or `Discarded` throws 409 `mission.evidence.remove_node_live`.
  3. Implement `prepareAssetDelete(tx, dependencies, assetId, body)`: an absent asset throws 404 `mission.record.not_found`; the `platform` asset of a request evidence throws 409 `mission.evidence.request_asset_refused`; `admitDelete`.
  4. In the handler, run `prepareAssetDelete` in `dependencies.store.transaction`. For an `object` asset, call `intakeStorage.delete(call, binding, keyOfLocation(…), objectVersion ?? null)` with the pinned storage binding. Then call `caller.commit`: run `prepareAssetDelete` again and add `deleteAsset(tx, assetId)` to the record store. Answer null.
  5. Add the leaf `evidence asset delete <asset-id> --expected-mission-version <version> [--force] [--reason <text>] [--idempotency-key <key>]` with `cli.mission.evidence.asset.delete.invalid_asset_id` and `cli.mission.evidence.asset.delete.invalid_expected_mission_version` (code: proposed). It builds the body from the flags, with `force: false` without `--force`, sends it with no local check of `reason`, and prints `{ idempotencyKey }`.
  6. Regenerate OpenAPI and assert the operation id.
  7. Add tests: a delete on a terminal chain removes the row and keeps the evidence with zero assets; a live chain answers `mission.evidence.remove_node_live`; `force` with a reason deletes on a live chain; a failed object delete keeps the row, and a repeat deletes again; the delete of the last pending asset publishes the evidence; a request asset answers `mission.evidence.request_asset_refused`; a stale version answers `mission.version.conflict`; the mission version stays unchanged; no row records the remover.
- Rules:
  - The route, the access H, the input and the answer 204. `mission-service.impl.md:339`, `:341`; `engine/docs/cli/mission.md:406`, `:448–453`.
  - The flag `--expected-mission-version` supplies `expectedMissionVersion`. `engine/docs/cli/mission.md:406–407`, `:451` (ruled 2026-09-30); precedent `engine/docs/cli/worker.md:131–133`. The value is a positive safe integer. `engine/docs/cli/mission.md:124`.
  - Without force, the node and every ancestor hold a terminal state; a live chain answers 409 `mission.evidence.remove_node_live`. `mission-service.impl.md:343–344`; `engine/docs/cli/mission.md:924`.
  - The service deletes the content first and the row after it; a failed content delete keeps the row. `mission-service.impl.md:348–349`.
  - The object delete uses the storage binding revision that the asset pins and the recorded version. `mission-service.impl.md:348`.
  - The asset delete refuses the `platform` asset of a request evidence. `mission-service.impl.md:353`; `engine/docs/cli/mission.md:925`.
  - A delete of an expired asset can publish its evidence. `mission-service.impl.md:355`.
  - No row records the remover, the reason or the time. `02-execution.md:253`; `mission-service.impl.md:351`.
  - CLI codes: proposed under `architecture.impl.md:348`.
  - Gap: a disabled or removed storage binding refuses the object delete through the binding authorization of the Intake operation (`mission-service.impl.md:350`); ERD 3 wires it.
  - Gap: the audit record of a human delete stays POSTPONED (`docs/brainstorm/HANDOFF.md:71`).
- Done when: `pnpm run verify` passes; the tests pass.

### 04.15 Implement `mission.evidence.delete` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/evidence-delete.ts`, `src/mission/evidence-delete.test.ts`, `src/mission/record-store.ts`, `src/apps/cli/mission-evidence.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"evidence.delete"`: `writeOperation` with `method: DELETE`, `status: HttpStatus.NoContent`, id `mission.evidence.delete`, `/api/mission/evidence/:evidenceId`, body `evidenceDeleteSchema`, output `z.null()`.
  2. Implement `prepareEvidenceDelete(tx, dependencies, evidenceId, body)`: an absent evidence throws 404 `mission.record.not_found`; a request evidence without `force` throws 409 `mission.evidence.request_force_required`; `admitDelete`.
  3. In the handler, run the preparation in `dependencies.store.transaction`, and call `intakeStorage.delete` for each `object` asset. Then call `caller.commit`, read the clock once and run the preparation again:
     - Delete every asset, then the evidence.
     - Remove the identity from `evidence_ids` of every assessment and every outcome of the node, as a canonical set.
     - For a forced delete of a request of the open attempt on a node that is not `Paused`, call `schedulerClaims.settle`, `endLiveClaim` and `transition` to `Paused`.
     - Answer null, and call `wakeup.wake(projectId)` after the commit.
  4. Add the leaf `evidence delete <evidence-id> --expected-mission-version <version> [--force] [--reason <text>] [--idempotency-key <key>]` with `cli.mission.evidence.delete.invalid_evidence_id` and `cli.mission.evidence.delete.invalid_expected_mission_version` (code: proposed).
  5. Regenerate OpenAPI and assert the operation id.
  6. Add tests: a delete removes the identity from each set and keeps the effect of the outcome; the derived closing event stays after the forced delete of a request; a request without force answers `mission.evidence.request_force_required`; a forced delete of a request of the open attempt holds the node in `Paused` and revokes a live claim; a request of a closed attempt changes no state; a read after the delete answers `mission.record.not_found`.
- Rules:
  - The route, the access H, the input and the answer 204. `mission-service.impl.md:340–341`; `engine/docs/cli/mission.md:407`, `:448–454`.
  - The flag `--expected-mission-version`. `engine/docs/cli/mission.md:406–407`, `:451` (ruled 2026-09-30).
  - The delete removes every asset and the evidence row, and it removes the identity from every `evidenceIds` set. `02-execution.md:253`; `mission-service.impl.md:340`.
  - A request evidence is deleted only with force, in every node state. `mission-service.impl.md:352`; `engine/docs/cli/mission.md:926`.
  - A forced delete of a request of the open attempt holds the node in `Paused` in the same transaction, unless the node is already `Paused`; a request of a closed attempt or of a terminal node changes no state. `mission-service.impl.md:354`; `02-execution.md:291`; `mission-service.md:558`.
  - Every Mission transition first settles each expired unsettled execution, and a hold ends a live claim. `02-execution.md:223`; `scheduler-service.md:204–208`.
  - A delete admits an outcome reference and changes no effect of that outcome. `mission-service.impl.md:357`; `mission-service.md:318–319`.
  - The derived closing event of an outcome survives the delete of a request evidence. `mission-service.impl.md:389`, `:581`.
  - Gap: `mission_delivery_admission.evidence_id` waits for the table of ERD 3 (`mission-service.impl.md:340`); this plan clears no admission row.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.16 Implement the execution revision reads with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/execution-read.ts` (create), `src/mission/execution-read.test.ts` (create), `src/mission/node-read.ts`, `src/mission/store.ts`, `src/apps/cli/mission-execution.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare three `client` reads with `requiresExecution: true`: `"execution.pinnedRevision.get"` (`mission.execution.pinnedRevision.get`, `GET /api/mission/execution/:executionId/pinned-revision`, output `revisionSchema`); `"execution.revision.list"` (`mission.execution.revision.list`, `GET /api/mission/execution/:executionId/revision`, query `pageQuery`, output `pageOf(revisionSchema)`); `"execution.revision.get"` (`mission.execution.revision.get`, `GET /api/mission/execution/:executionId/revision/:revision`, output `revisionSchema`).
  2. Add an optional upper bound to `listRevisions` (`src/mission/store.ts:259–275`) and to `revisionPage` (`src/mission/node-read.ts:159–176`).
  3. Implement the handlers from `caller.execution` alone: the pinned revision through `getRevision`; the list with the bound `pinnedRevision`; a `revision` above `pinnedRevision` throws 404 `mission.execution.revision_above_pin` (code: proposed) before the read.
  4. Add the leaves `execution pinned-revision get <execution-id>`, `execution revision list <execution-id> [--limit] [--cursor]` and `execution revision get <execution-id> <revision>` to `addExecutionCommands`, with `cli.mission.execution.pinned_revision.get.invalid_execution_id`, `cli.mission.execution.revision.list.invalid_execution_id`, `cli.mission.execution.revision.get.invalid_execution_id` and `cli.mission.execution.revision.get.invalid_revision` (code: proposed).
  5. Regenerate OpenAPI and assert the three operation ids.
  6. Add tests: the pinned read answers the tasks and the complete content; a human revision after the claim stays outside the list; a revision above the pin answers `mission.execution.revision_above_pin`; the list pages in descending order.
- Rules:
  - The routes, the access E and the answers. `engine/docs/cli/mission.md:523–525`, `:533–535`.
  - The server derives the node, the attempt and the pinned revision from the live claim, and a read under E never returns a revision newer than the pinned one. `engine/docs/cli/mission.md:151`, `:519`.
  - Revision list and get reject a requested revision above the pinned one. `engine/docs/cli/mission.md:535`. Code `mission.execution.revision_above_pin` (404): proposed in `00-index.md` "Codes for Ulrich".
  - The read of a worker is a `client` operation keyed by the execution identity. `architecture.impl.md:673`.
  - CLI codes: proposed under `architecture.impl.md:348`; a hyphen of `pinned-revision` becomes an underscore.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.17 Implement the execution evidence and cleared-outcome reads with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/execution-read.ts`, `src/mission/execution-read.test.ts`, `src/apps/cli/mission-execution.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare two `client` reads with `requiresExecution: true`: `"execution.evidence.list"` (`mission.execution.evidence.list`, `GET /api/mission/execution/:executionId/evidence`, query `pageQuery`, output `pageOf(evidenceSchema)`) and `"execution.clearedOutcome.get"` (`mission.execution.clearedOutcome.get`, `GET /api/mission/execution/:executionId/cleared-outcome`, output `outcomeSchema`).
  2. Implement the evidence list over `listEvidence` with the claimed node and attempt. Implement the cleared outcome: for a claimed attempt k of 2 or more, assert that `opened_by` of attempt k is a human, and answer the current outcome of attempt k − 1; for attempt 1, throw 404 `mission.record.not_found`.
  3. Add the leaves `execution evidence list <execution-id> [--limit] [--cursor]` and `execution cleared-outcome get <execution-id>` with `cli.mission.execution.evidence.list.invalid_execution_id` and `cli.mission.execution.cleared_outcome.get.invalid_execution_id` (code: proposed).
  4. Regenerate OpenAPI and assert both operation ids.
  5. Add tests: the list holds the evidence of the claimed attempt only; an unblocked attempt answers the outcome of the blocked attempt; a block and an unblock at attempt 0 and a claim of attempt 1 answer 404.
- Rules:
  - The routes, the access E and the answers. `engine/docs/cli/mission.md:526`, `:531`, `:536`, `:539–540`.
  - The reviewer reads the evidence set of the attempt. `worker-service.md:494`; `engine/docs/cli/mission.md:519`.
  - The cleared-attempt outcome answers 404 `mission.record.not_found` when no unblock opened the claimed attempt; an attempt of 2 or more always opens by an unblock. `mission-service.impl.md:392–394`; `02-execution.md:234`.
  - The current outcome of a node in an attempt is its outcome with the greatest `sequence` among the outcomes whose assessment names that attempt. `02-execution.md:277`.
  - CLI codes: proposed under `architecture.impl.md:348`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.18 Implement the execution objective reads with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/execution-read.ts`, `src/mission/execution-read.test.ts`, `src/apps/cli/mission-execution.ts`, `src/apps/server/openapi-integration.test.ts`, `engine/AGENTS.md` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare three `client` reads with `requiresExecution: true` and `pageQuery`: `"execution.objective.list"` (`mission.execution.objective.list`, `GET /api/mission/execution/:executionId/objective`, output `pageOf(executionObjectiveSchema)`); `"execution.objective.outcome.list"` (`mission.execution.objective.outcome.list`, `GET /api/mission/execution/:executionId/objective/outcome`, output `pageOf(outcomeSchema)`); `"execution.objective.evidence.list"` (`mission.execution.objective.evidence.list`, `GET /api/mission/execution/:executionId/objective/evidence`, output `pageOf(evidenceSchema)`).
  2. Implement `currentObjectivesOf(tx, initiativeId)`: the current objectives of the claimed initiative, each with its current outcome or null. An objective claim answers an empty page.
  3. The objective list answers, for an objective with an outcome, `nodeRecord` with `content`, `visibleRevision` and `pinnedByAttempts` of the `nodeRevision` of its outcome; and `{ id, state }` for an objective without one. The outcome list answers those current outcomes. The evidence list answers the evidence that those outcomes name through the union of `outcomeRecord`. Each list orders by identity in descending order.
  4. Add the leaves `execution objective list <execution-id>`, `execution objective outcome list <execution-id>` and `execution objective evidence list <execution-id>`, each with `[--limit] [--cursor]` and the code `cli.mission.execution.objective.list.invalid_execution_id`, `cli.mission.execution.objective.outcome.list.invalid_execution_id` or `cli.mission.execution.objective.evidence.list.invalid_execution_id` (code: proposed).
  5. Regenerate OpenAPI and assert the three operation ids.
  6. Update the `src/mission/` entry of `engine/AGENTS.md` with the modules of this plan.
  7. Add tests: an objective with an outcome of attempt 0 resolves to the revision current at the act; an objective created during the claim carries its identity and its state only; a discarded objective answers its discard outcome; a retired objective leaves every list; an objective claim answers empty pages.
- Rules:
  - The routes, the access E and the answers. `engine/docs/cli/mission.md:528–530`, `:541–543`.
  - Each objective resolves to the `nodeRevision` of its current outcome; an objective without an outcome carries its identity and its state only. `engine/docs/cli/mission.md:542–543`; `mission-service.impl.md:372`, `:580`.
  - An execution reads no content of another node, except a current child objective of its initiative. `engine/docs/cli/mission.md:198–200`.
  - The current outcome of a node is its outcome with the greatest `sequence`. `02-execution.md:277`.
  - A retirement removes a node from the current children. `mission-service.md:481`.
  - CLI codes: proposed under `architecture.impl.md:348`.
- Done when: `pnpm run verify` passes; the tests pass.

### 04.E E2E proof

- Files: `src/apps/server/e2e-mission-execution-operations.test.ts` (create)
- Do:
  1. Start `objectSink(t)`. Start `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` and `standIns: { intakeStorage: sinkStorage(sink), intakeCheck: scriptedCheck({ endState: "expected", landedCommits: [<40 × c>] }) }`.
  2. Build the setup of the `## E2E` section through the CLI. Write one `test` block for each scenario E04.1 to E04.30, in table order, on the shared setup of one fixture.
  3. Parse stdout as JSON for every success. Assert the exit code and the start of stderr for every refusal.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, never a store read. ERD 1 decision D13.
  - Two steps use the HTTP adapter `httpClient(missionOperations, fixture.endpoint, machineToken)` from the test: the object transfer, because the test acts as the host component (decision D17; `.dev/erd-02/decisions-log.md` 2026-09-30 Q3), and `mission.evidence.request`, because no CLI command projects it (`engine/docs/cli/mission.md:502–503`).
  - The machine token comes from `fixture.machineToken(<projectId>, "harness")`, as the human token comes from `fixture.token`. `src/apps/server/test-support.ts:239–247`.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
  - The fixture inputs are the inputs that the committed validation accepts. `.dev/erd-01/decisions-log.md` 03.5, 05.E, 06.E; `src/custody/platforms.ts:43–46`, `:83–87`; `src/project/contract.ts:89–134`; `src/worker/catalog.ts` `claude@1`.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-mission-execution-operations.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-mission-execution-operations.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store, the object sink and the scripted Intake check of task 04.2. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state and `KANTHORD_ENDPOINT = fixture.endpoint`. `H` names `KANTHORD_TOKEN = fixture.token`; `W` names `KANTHORD_TOKEN = fixture.machineToken(harnessBindingId)`.
- Rules: setup goes through the CLI only, except the two HTTP-adapter steps of task 04.E; the state check is a CLI read; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON.
- The worker `claude@1` declares `Available`, `Waiting` and `External.Requested` and names no agent, so one instance takes both claim kinds with no enablement and no agent runtime (`src/worker/catalog.ts`). The priorities make the queue order fixed: objective A before objective B, and the initiative last.

Setup, in order (each command exits 0, token H):

1. `kanthord project create --name execution` → `projectId` = `id`.
2. `kanthord mission get <projectId>` → `missionId` = `id`.
3. `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
4. `kanthord credential create --file store.json` with `{ "name": "store", "platform": "s3", "metadata": { "endpoint": "https://s3.example.com", "bucket": "evidence", "region": "eu-central-1" }, "secret": { "accessKeyId": "AKIAEXAMPLE", "secretAccessKey": "example-secret" } }`.
5. `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }, "gated": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/gated.git", "strategy": { "baseBranch": "main", "action": { "name": "pull_request", "follows": { "type": "assessment_passed" } } }, "credential": "github" } }, "store": { "kind": "storage", "config": { "available": true, "endpoint": "https://s3.example.com", "bucket": "evidence", "region": "eu-central-1", "prefix": "kanthord", "credential": "store" } }, "harness": { "kind": "worker", "config": { "worker": "claude@1", "instanceCount": 1 } } } }` → `repoBindingId`, `gatedBindingId`, `gatedResource` = `bindings.gated.resourceIdentity`, `harnessBindingId`, `harnessResource` = `bindings.harness.resourceIdentity`.
6. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Recover accounts", "requirement": "Recover accounts", "criterion": "Accounts recover", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId`.
7. `kanthord mission node create <missionId> --file objective-a.json` with the content of step 6 and `"filename": "objective-a.md"`, `"kind": "objective"`, `"bindings": ["repo", "store"]`, `"parentId": <initiativeId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 2` → `objectiveA`.
8. `kanthord mission node create <missionId> --file objective-b.json` with `"filename": "objective-b.md"`, `"bindings": ["gated"]` and `"expectedMissionVersion": 3` → `objectiveB`. `M` names the mission version 4.
9. `kanthord mission node priority set <objectiveA> --file { "value": 3, "expectedMissionVersion": 4 }` and `kanthord mission node priority set <objectiveB> --file { "value": 2, "expectedMissionVersion": 4 }`.
10. With token W: `kanthord worker register` → `runtimeIdentity`. `pull.json` names `{ "resourceIdentity": <harnessResource>, "runtimeIdentity": <runtimeIdentity> }`.

`ctx(e, n)` names `"executionId": e, "attempt": n, "nodeRevision": 1`. `C40(x)` names 40 characters `x`. `pass` names `[{ "command": "true", "exitCode": 0, "signal": null, "timedOut": false }]`.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                | Exit       | Expect                                                                                                                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E04.1  | W: `kanthord scheduler work pull --file pull.json`                                                                                                                                                                                                                                                                                                                                                                      | 0          | `kind` `claimed`, `execution.nodeId` = `objectiveA`, `execution.attempt` 1, `execution.pinnedRevision` 1 → `e1`                                                                                                                       |
| E04.2  | W: `kanthord mission execution pinned-revision get <e1>`; then `kanthord mission execution revision get <e1> 2`                                                                                                                                                                                                                                                                                                         | 0, 1       | first `revision` 1, `content.verifications` `["true"]`; second stderr starts with `mission.execution.revision_above_pin:`                                                                                                             |
| E04.3  | W: `kanthord mission evidence submit <objectiveA> --file work.json` with `{ ctx(e1, 1), "subject": "head commit", "assets": [{ "kind": "repository", "address": { "kind": "repository", "bindingId": <repoBindingId>, "commit": C40(b) } }] }`                                                                                                                                                                          | 0          | `evidence.provenance.kind` `execution`, `evidence.provenance.executionId` = `e1`, `evidence.attempt` 1, `evidence.assets[0].publishedAt` a number, `uploads` `[]` → `workEvidence`                                                    |
| E04.4  | W: `kanthord mission evidence submit <objectiveA> --file stale.json` with work.json and `"attempt": 2`                                                                                                                                                                                                                                                                                                                  | 1          | stderr starts with `mission.execution.context_mismatch:`                                                                                                                                                                              |
| E04.5  | W: `kanthord mission evidence submit <objectiveA> --file object.json` with `{ ctx(e1, 1), "subject": "recording", "assets": [{ "kind": "object", "size": 5, "mediaType": "text/plain" }] }`                                                                                                                                                                                                                             | 1          | stderr starts with `cli.mission.evidence.submit.object_asset:`                                                                                                                                                                        |
| E04.6  | HTTP adapter under W: `mission.evidence.submit` with the body of object.json                                                                                                                                                                                                                                                                                                                                            | —          | `uploads[0].putUrl` starts with the sink endpoint; `evidence.assets[0].publishedAt` null, `expiredAt` a number → `objectEvidence`, `objectAsset`                                                                                      |
| E04.7  | W: `kanthord mission assessment submit <objectiveA> --file early.json` with `{ ctx(e1, 1), "evidenceIds": [<workEvidence>], "childOutcomeIds": [], "result": "success", "rationale": "met", "testedInput": { "kind": "repository", "bindingId": <repoBindingId>, "commit": C40(b) } }`                                                                                                                                  | 1          | stderr starts with `mission.execution.claim_not_evaluation:`                                                                                                                                                                          |
| E04.8  | W: `kanthord mission execution evidence list <e1>`                                                                                                                                                                                                                                                                                                                                                                      | 0          | `items` of length 2, `nextCursor` null                                                                                                                                                                                                |
| E04.9  | W: `kanthord scheduler execution release <e1> --file { "furtherWork": false }`; then H: `kanthord mission node get <objectiveA>`                                                                                                                                                                                                                                                                                        | 0, 0       | second `state` `Waiting`, `attempt` 1                                                                                                                                                                                                 |
| E04.10 | W: `kanthord scheduler work pull --file pull.json`                                                                                                                                                                                                                                                                                                                                                                      | 0          | `execution.nodeId` = `objectiveA`, `execution.attempt` 1 → `e2`                                                                                                                                                                       |
| E04.11 | W: `kanthord mission evidence submit <objectiveA> --file run.json` with `{ ctx(e2, 1), "subject": "verification run", "assets": [{ "kind": "produced", "content": { "mediaType": "text/plain", "encoding": "base64", "data": "b2s=" } }], "verification": { "testedInput": { "kind": "repository", "bindingId": <repoBindingId>, "commit": C40(b) }, "results": pass } }`                                               | 0          | `evidence.verification.results[0].exitCode` 0 → `runEvidence`                                                                                                                                                                         |
| E04.12 | W: `kanthord mission evidence submit <objectiveA> --file failed.json` with run.json and `"results": [{ "command": "true", "exitCode": 1, "signal": null, "timedOut": false }]`; then `kanthord mission assessment submit <objectiveA> --file bad.json` with `{ ctx(e2, 1), "evidenceIds": [<failedEvidence>], "childOutcomeIds": [], "result": "success", "rationale": "met", "testedInput": <testedInput of E04.11> }` | 0, 1       | first → `failedEvidence`; second stderr starts with `mission.assessment.verification_failed:`                                                                                                                                         |
| E04.13 | W: `kanthord mission assessment submit <objectiveA> --file pending.json` with bad.json and `"evidenceIds": [<runEvidence>, <objectEvidence>]`                                                                                                                                                                                                                                                                           | 1          | stderr starts with `mission.assessment.evidence_unpublished:`                                                                                                                                                                         |
| E04.14 | HTTP adapter under W: `PUT` of `hello` to the `putUrl` of E04.6; then `mission.evidence.asset.complete` of `objectAsset` with `ctx(e2, 1)`; then H: `kanthord mission evidence get <objectEvidence>`                                                                                                                                                                                                                    | 200, —, 0  | complete answers `uri` that starts with `s3://evidence/kanthord/`; the read holds `assets[0].publishedAt` a number                                                                                                                    |
| E04.15 | H: `kanthord mission evidence asset content get <objectAsset>`; then `GET` of its `getUrl`; then W: `kanthord mission execution evidence asset content get <e2> <objectAsset>`                                                                                                                                                                                                                                          | 0, 200, 1  | first `size` 5, `mediaType` `text/plain`; the body reads `hello`; third stderr starts with `cli.mission.execution.evidence.asset.content.get.object_content:`                                                                         |
| E04.16 | H: `kanthord mission evidence asset content get <asset of workEvidence>`                                                                                                                                                                                                                                                                                                                                                | 1          | stderr starts with `mission.evidence.content_repository:`                                                                                                                                                                             |
| E04.17 | W: `kanthord mission assessment submit <objectiveA> --file pass.json` with bad.json and `"evidenceIds": [<runEvidence>, <workEvidence>]`                                                                                                                                                                                                                                                                                | 0          | `assessment.actor.kind` `execution`, `assessment.currency.current` true, `assessment.workerVersion` `claude@1`, `node.state` `Completed`, `outcome.result` `success`, `outcome.closingEvent` `assessment-passed`, `outcome.attempt` 1 |
| E04.18 | W: `kanthord scheduler claim get <e2>`; then `kanthord scheduler execution release <e2> --file { "furtherWork": false }`; then `kanthord mission execution evidence list <e2>`                                                                                                                                                                                                                                          | 0, 1, 1    | first `claimState` `finished`; second and third stderr start with `gateway.invocation.execution_proof_failed:`                                                                                                                        |
| E04.19 | H: `kanthord mission evidence list <objectiveA> --attempt 1`; then `kanthord mission attempt get <objectiveA> 1`                                                                                                                                                                                                                                                                                                        | 0, 0       | first `items` of length 4; second `closedAt` a number, `outcomeIds` of length 1                                                                                                                                                       |
| E04.20 | H: `kanthord mission evidence delete <failedEvidence> --expected-mission-version 4`; then with `--force`; then with `--force --reason cleanup`; then `kanthord mission evidence get <failedEvidence>`                                                                                                                                                                                                                   | 1, 1, 0, 1 | stderr starts with `mission.evidence.remove_node_live:`, `gateway.request.validation_failed:`; third stdout holds `idempotencyKey`; fourth stderr starts with `mission.record.not_found:`                                             |
| E04.21 | W: `kanthord scheduler work pull --file pull.json`; then `kanthord mission evidence submit <objectiveB> --file gated-work.json` with work.json, `ctx(<e3>, 1)` and `"bindingId": <gatedBindingId>`; then `kanthord scheduler execution release <e3> --file { "furtherWork": false }`                                                                                                                                    | 0, 0, 0    | first `execution.nodeId` = `objectiveB` → `e3`                                                                                                                                                                                        |
| E04.22 | W: `kanthord scheduler work pull --file pull.json`; then `kanthord mission evidence submit <objectiveB>` with run.json, `ctx(<e4>, 1)` and the gated tested input `{ "kind": "repository", "bindingId": <gatedBindingId>, "commit": C40(b) }`; then `kanthord mission assessment submit <objectiveB>` naming that evidence with the gated tested input                                                                  | 0, 0, 0    | first → `e4`; second → `gatedRun`; third `node.state` `Evaluating`, `outcome` null                                                                                                                                                    |
| E04.23 | HTTP adapter under W: `mission.evidence.request` on `objectiveB` with `{ ctx(e4, 1), "requirementKey": "gated.pull_request", "subject": "pull request 42", "address": { "kind": "pull_request", "resourceIdentity": <gatedResource>, "number": 42 } }`; then the same body again                                                                                                                                        | —, —       | first answers `requirementKey` `gated.pull_request`, one `platform` asset → `requestEvidence`; second answers 409 `mission.request.already_requested`                                                                                 |
| E04.24 | W: `kanthord scheduler execution release <e4> --file { "furtherWork": false }`; then H: `kanthord mission external-action list <objectiveB> --attempt 1`                                                                                                                                                                                                                                                                | 0, 0       | second `items[0].resolution` `unresolved`, `requestEvidenceId` = `requestEvidence`                                                                                                                                                    |
| E04.25 | H: `kanthord mission evidence asset content get <asset of requestEvidence>`; `kanthord mission evidence asset delete <asset of requestEvidence> --expected-mission-version 4`; `kanthord mission evidence delete <requestEvidence> --expected-mission-version 4`                                                                                                                                                        | 1, 1, 1    | stderr starts with `mission.evidence.content_platform:`, `mission.evidence.request_asset_refused:`, `mission.evidence.request_force_required:`                                                                                        |
| E04.26 | H: `kanthord mission node check <objectiveB> --file { "expectedMissionVersion": 4 }`; then `kanthord mission node get <objectiveB>`; then `kanthord mission outcome list <objectiveB>`                                                                                                                                                                                                                                  | 0, 0, 0    | first `results[0].resolution` `expected-end`, `failures` `[]`; second `state` `Completed`; third `items[0].closingEvent` `external-success`, `items[0].evidenceIds` holds a landed-commit evidence                                    |
| E04.27 | H: `kanthord mission evidence list <objectiveB> --attempt 1`; then `kanthord mission node check <objectiveB> --file { "expectedMissionVersion": 4 }`                                                                                                                                                                                                                                                                    | 0, 1       | first holds one evidence with `provenance.service` `mission` and a repository asset with `commit` C40(c); second stderr starts with `mission.node.no_unresolved_request:`                                                             |
| E04.28 | W: `kanthord scheduler work pull --file pull.json`; then `kanthord mission execution objective list <e5>`; then `kanthord mission execution objective outcome list <e5>`; then `kanthord mission execution objective evidence list <e5>`                                                                                                                                                                                | 0, 0, 0, 0 | first `execution.nodeId` = `initiativeId` → `e5`; second two items with `visibleRevision` 1; third two outcomes; fourth `items` of length 4: `runEvidence`, `workEvidence`, `gatedRun` and the landed-commit evidence                 |
| E04.29 | W: `kanthord mission execution cleared-outcome get <e5>`                                                                                                                                                                                                                                                                                                                                                                | 1          | stderr starts with `mission.record.not_found:`                                                                                                                                                                                        |
| E04.30 | `kanthord mission evidence get invalid`; `kanthord mission execution revision get <e5> 0`; `kanthord mission evidence delete <runEvidence> --expected-mission-version 0`                                                                                                                                                                                                                                                | 1, 1, 1    | stderr starts with `cli.mission.evidence.get.invalid_evidence_id:`, `cli.mission.execution.revision.get.invalid_revision:`, `cli.mission.evidence.delete.invalid_expected_mission_version:`                                           |

E04.2, E04.4, E04.5, E04.7, E04.15, E04.23, E04.25 and E04.30 assert codes of the mark `code: proposed`. The test is committed after Aelita writes each accepted code on its page (ruling R3).

## Blockers

None open. The debate engine settled four gaps in one run:

- DEBATE: the route and the input of `mission.evidence.request` - rounds:1 - verdict: `POST /api/mission/node/:nodeId/evidence/request` with a body of every field of `ExecutionContext` plus `requirementKey`, `subject` and `address`; the page repair names the complete input; `client` access and no CLI leaf.
- DEBATE: the `expectedMissionVersion` of the two evidence deletes - rounds:1 - verdict: a required flag `--expected-mission-version <version>` on both leaves, by the precedent `--expected-revision`; the local validation codes are documented.
- DEBATE: object evidence and presigned URLs on the CLI of an execution - rounds:1 - verdict: corrected option (a); `evidence submit` refuses an object asset and `execution evidence asset content get` refuses an object answer, each as an explicit CLI rule; row 35 is not external-harness-only, plan 09 owns the worker-host helper, and plans 09 and 10 reconcile row 35 before a dispatcher exception.
- DEBATE: the content read of a `platform` asset - rounds:1 - verdict: 409 `mission.evidence.content_platform` with `{ evidenceId, address }` after the access checks, and no fetch of external content.
