# Plan 01: Mission Service — attempts and human controls

## Scope

This plan delivers:

- Migration 2 of `src/mission/migrations.ts` with the five Mission tables of ERD 2: `mission_attempt`, `mission_evidence`, `mission_evidence_asset`, `mission_assessment` and `mission_outcome`, and their four unique indexes.
- The attempt lifecycle: the opening by a claim, by a ready act and by an unblock, the pin of the node revision, and the closure with its outcome.
- The seven human controls `mission.node.pause`, `resume`, `block`, `unblock`, `ready`, `override` and `discard`, each with its answer `ControlResult`.
- The human assessment and the outcome of a human act, with the closing event that the read derives.
- The reads `mission.attempt.list`, `get`, `mission.assessment.list`, `get` (with the currency), `mission.outcome.list`, `get`, `mission.externalAction.list`, `get`, and the `blockedContext` of a node read.
- The `FrozenAction` derivation through the Project collaboration `repositoryPolicyOf`, which this plan adds to the Project Service.
- The `MissionTransitions` seam (`claim`, `release` with the release predicate, `loss`) that plan 03 consumes.
- The currency evaluator, the node conditions, the record store and the external closure, which plan 04 consumes.
- The attempt facts of the ERD 1 writes: `pinnedByAttempts`, `openAttemptsUnchanged`, the open-attempt pin of `liveNodesPinning`, the live-claim check of a priority act and of a dependency addition, and the wakeup after each commit that writes the work queue.
- The recreated `src/apps/server/unwired.ts`, the `standIns` option of `composeServices` and `gatewayFixture`, and the CLI leaves of every operation above.

Out of scope:

- `mission.evidence.submit`, `list`, `get`, the asset operations, `mission.evidence.delete`, `mission.assessment.submit`, `mission.evidence.request`, `mission.node.check` and the nine execution-scoped reads (plan 04).
- `scheduler_execution`, the work pull, the claim transaction, `scheduler.execution.release`, the loss sweep and the revocation (plan 03). This plan consumes them through stand-ins.
- `mission.delivery.admit` and every Intake table (ERD 3). The MCP server (decision D5). Every B9 item and every open HANDOFF item (decision D1).

## Sources

- `docs/reference/erd/02-execution.md:76–130` — the five Mission tables, their columns and their nullability.
- `docs/reference/erd/02-execution.md:137–150`, `:181` — the `FK` labels inside the Mission group, and `(node_id, attempt)` as a validated reference with no foreign key.
- `docs/reference/erd/02-execution.md:212–213`, `:217–224` — the claim, the release predicate, the routing of a release, the loss declaration, the settlement before a Mission transition and the revocation.
- `docs/reference/erd/02-execution.md:228` — the steps job of an initiative.
- `docs/reference/erd/02-execution.md:232–240` — the attempt rules and the human controls.
- `docs/reference/erd/02-execution.md:244–258`, `:263–283`, `:287–291` — the evidence, assessment, outcome and request rules.
- `docs/brainstorm/mission-service.md:53`, `:86` — the live-claim condition of a dependency addition and of a priority act.
- `docs/brainstorm/mission-service.md:376–394` — the three checks of the currency.
- `docs/brainstorm/mission-service.md:408–447`, `:449–471`, `:473–494`, `:496–508` — the node states, the attempt, the readiness, continuation and initiative steps conditions, and the consecutive loss limit.
- `docs/brainstorm/mission-service.md:541–613` — the resume precedence and the transition table.
- `docs/brainstorm/mission-service.md:682–693` — the work queue writes and the wakeup after the commit.
- `docs/brainstorm/mission-service.md:697–807` — the block, the human block, the unblock and the enforcement.
- `docs/brainstorm/mission-service.vocabulary.md:101–272`, `:386–404` — the attempt, the conditions, the terminal states and the currency.
- `docs/brainstorm/mission-service.impl.md:25–33` — the three actor forms.
- `docs/brainstorm/mission-service.impl.md:74–91` — `FrozenAction` and the required external actions of an attempt.
- `docs/brainstorm/mission-service.impl.md:158–172` — the node API admission and the retired and terminal refusals.
- `docs/brainstorm/mission-service.impl.md:196–229`, `:231–242`, `:244–252` — the assessment, the request record and the release admission.
- `docs/brainstorm/mission-service.impl.md:208`, `:234–239` — the currency of a human assessment and the currency evaluator.
- `docs/brainstorm/mission-service.impl.md:355–403`, `:405–425`, `:427–440`, `:442–448` — the outcome record, node ready, node resume and node override.
- `docs/brainstorm/mission-service.impl.md:462`, `:500–519`, `:528–534`, `:541–543` — `liveNodesPinning`, the mission version rules, the graph write answer and the operation contracts.
- `docs/brainstorm/mission-service.impl.md:562–583`, `:664–666` — the tests of the actor, the attempt, the controls and the loss.
- `docs/brainstorm/project-service.impl.md:18–24` — the GitHub action catalog and the key form `<binding name>.<action name>`.
- `docs/brainstorm/scheduler-service.md:174–178`, `:204–212`, `:219–245` — the claim kinds, the revocation and the liveness rules.
- `docs/brainstorm/scheduler-service.impl.md:89–100` — the loss settlement.
- `engine/docs/cli/mission.md:109–141` — the operation contracts, the scalars and the `Key` form.
- `engine/docs/cli/mission.md:312–388`, `:390–475`, `:476–515` — the control, record and external-action commands, routes and access.
- `engine/docs/cli/mission.md:682–697`, `:709–730`, `:736–741` — `HumanAct`, `Resume`, `Override`, `Unblock`, `UnblockChange`, the address schemas and `TestedInput`.
- `engine/docs/cli/mission.md:777–818` — the result schemas.
- `engine/docs/cli/mission.md:857–945` — the error codes of the Mission CLI.
- `engine/docs/cli/scheduler.md:500` — `mission.release.obligation_unmet`.
- `docs/brainstorm/architecture.impl.md:341–349` — the error code form and the CLI code form.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `.dev/erd-02/decisions-log.md` entries of 2026-09-29 for plan 01 — the wakeup stand-in and the debate record of the currency mechanism.
- Root `AGENTS.md` "Database design", "Contracts" and "Rejected proposals".

## Depends on

- ERD 1, merged. The Mission Service of `src/mission/` with `Dependencies` (`src/mission/service.ts:74–79`), `MissionBindings` and `WorkQueue` (`src/mission/contract.ts:25–54`), the routing helpers (`src/mission/routing.ts:8–93`) and the store (`src/mission/store.ts`).
- ERD 1, merged. The Project Service reads `readBindingRevision` (`src/project/store.ts:562`) and `repositoryConfigSchema` (`src/project/contract.ts:89–110`).
- Plan 03 — `SchedulerClaims.revoke`, `settle`, `liveExecutionOf`, `SchedulerWakeup.wake` and `ExecutionAttribution.of`. This plan declares each one inline in `src/mission/contract.ts`. Production passes `unwired("<seam>")` for the claim seams and the attribution, and a no-op for `SchedulerWakeup.wake` (decision D9 exception: no work pull exists before plan 03, so a wakeup has no receiver). `gatewayFixture` passes a stand-in that answers the true state of the absent Scheduler (decisions D6, D9).

## Provides

| Seam                                 | TypeScript signature                                                                                                                                                                                                                                             | Owner file                                                  | Consumer plans |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------- |
| `MissionTransitions.claim`           | `(tx: Transaction, nodeId: string, declaredStates: readonly NodeState[], opener: ExecutionActor, now: number): ClaimAdmission \| null`, with `ClaimAdmission = { kind: ClaimKind; projectId: string; attempt: number; nodeRevision: number }`                    | `src/mission/contract.ts`                                   | 03             |
| `MissionTransitions.release`         | `(tx: Transaction, execution: { executionId: string; nodeId: string; attempt: number }, furtherWork: boolean, now: number): void`                                                                                                                                | `src/mission/contract.ts`                                   | 03             |
| `MissionTransitions.loss`            | `(tx: Transaction, nodeId: string, consecutiveLosses: number, now: number): void`                                                                                                                                                                                | `src/mission/contract.ts`                                   | 03             |
| `ProjectBindings.repositoryPolicyOf` | `(tx: Transaction, bindingId: string): { bindingId: string; projectId: string; name: string; address: string; platform: string; credential: string; baseBranch: string; action: "pull_request" \| "merge_push" \| null; projectPrompt: string \| null } \| null` | `src/project/contract.ts`                                   | 01, 06, 07, 08 |
| Currency evaluator                   | `currencyOf(tx, row: AssessmentRow): Currency`; `currentAssessmentOf(tx, nodeId: string, attempt: number): AssessmentRow \| null`                                                                                                                                | `src/mission/currency.ts`                                   | 04             |
| Node conditions                      | `readinessOf(tx, node: NodeRow)`, `continuationHolds(tx, bindings, node: NodeRow)`, `closureUnsatisfied(tx, node: NodeRow)`                                                                                                                                      | `src/mission/conditions.ts`                                 | 04             |
| Required actions                     | `requiredActionsOf(tx, bindings, nodeId: string, nodeRevision: number): FrozenAction[]`; `actionStatesOf(tx, bindings, nodeId: string, attempt: number)`                                                                                                         | `src/mission/frozen-action.ts`                              | 04, 06         |
| Record store and record reads        | `src/mission/record-store.ts`, `src/mission/record-read.ts`; the schemas `evidenceSchema`, `assessmentSchema`, `outcomeSchema`, `addressSchema`, `verificationSchema`, `testedInputSchema`                                                                       | `src/mission/`                                              | 04             |
| External closure                     | `closeExternalAttempt(tx, dependencies, node: NodeRow, now: number): OutcomeRow \| null`                                                                                                                                                                         | `src/mission/control.ts`                                    | 04             |
| Unwired stand-ins                    | `unwired(seam: string)`; `composeServices({ standIns })`; `gatewayFixture(t, { standIns })`                                                                                                                                                                      | `src/apps/server/unwired.ts`, `index.ts`, `test-support.ts` | 02–10          |

The `claim` signature differs from the sketch of `00-index.md` "Seams": it takes the declared node states of the worker and answers the claim kind or `null`. The Scheduler reads no Mission table, so it cannot know the node state before the call (`scheduler-service.md:174–178`), and a stale job answers `null` so that the claim takes the next job (`scheduler-service.md:67`).

## Tasks

### 01.1 Create the migration of the five Mission tables

- Files: `src/mission/migrations.ts` (edit), `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Append the migration `createExecutionRecordTables` to `missionMigrations` after `createMissionTables` (`src/mission/migrations.ts:3–49`). Do not change migration 1.
  2. Create the tables with these exact columns.

     `mission_attempt`: `node_id TEXT NOT NULL REFERENCES mission_node(id)`, `attempt INTEGER NOT NULL`, `node_revision INTEGER NOT NULL`, `opened_by TEXT NOT NULL`, `opened_at INTEGER NOT NULL`, `closed_at INTEGER`, `PRIMARY KEY (node_id, attempt)`.
     Index: `CREATE UNIQUE INDEX mission_attempt_open ON mission_attempt (node_id) WHERE closed_at IS NULL`.

     `mission_evidence`: `id TEXT NOT NULL PRIMARY KEY`, `node_id TEXT NOT NULL REFERENCES mission_node(id)`, `attempt INTEGER NOT NULL`, `subject TEXT NOT NULL`, `requirement_key TEXT`, `end_state TEXT`, `verification TEXT`, `provenance TEXT NOT NULL`, `created_at INTEGER NOT NULL`.
     Index: `CREATE UNIQUE INDEX mission_evidence_request ON mission_evidence (node_id, attempt, requirement_key) WHERE requirement_key IS NOT NULL`.

     `mission_evidence_asset`: `id TEXT NOT NULL PRIMARY KEY`, `evidence_id TEXT NOT NULL REFERENCES mission_evidence(id)`, `kind TEXT NOT NULL`, `content TEXT NOT NULL`, `published_at INTEGER`, `expired_at INTEGER`.

     `mission_assessment`: `id TEXT NOT NULL PRIMARY KEY`, `node_id TEXT NOT NULL REFERENCES mission_node(id)`, `sequence INTEGER NOT NULL`, `attempt INTEGER NOT NULL`, `result TEXT NOT NULL`, `rationale TEXT NOT NULL`, `evidence_ids TEXT NOT NULL`, `child_outcome_ids TEXT NOT NULL`, `tested_input TEXT`, `execution_id TEXT`, `actor TEXT`, `node_revision INTEGER NOT NULL`, `created_at INTEGER NOT NULL`.
     Index: `CREATE UNIQUE INDEX mission_assessment_sequence ON mission_assessment (node_id, sequence)`.

     `mission_outcome`: `id TEXT NOT NULL PRIMARY KEY`, `node_id TEXT NOT NULL REFERENCES mission_node(id)`, `sequence INTEGER NOT NULL`, `result TEXT NOT NULL`, `assessment_id TEXT NOT NULL REFERENCES mission_assessment(id)`, `evidence_ids TEXT NOT NULL`, `created_at INTEGER NOT NULL`.
     Index: `CREATE UNIQUE INDEX mission_outcome_sequence ON mission_outcome (node_id, sequence)`.

  3. In `src/apps/server/migrations.test.ts`, add one named constant for each new table. Add the five names to `MISSION_TABLES` (`:40–45`). Add a constant `ERD2_MISSION_TABLES` and assert the table set of the test "all ERD 1 migrations produce exactly the expected tables" (`:223–246`) against `[...ERD1_TABLES, ...ERD2_MISSION_TABLES]`.
  4. Add a test that reads `sqlite_master` and asserts the four index names, with `WHERE` in the SQL of `mission_attempt_open` and `mission_evidence_request`.
- Rules:
  - No SQL `CHECK` constraint. Root `AGENTS.md` "Database design".
  - No index that is not unique. The two partial indexes and the two plain unique indexes are the only indexes. `02-execution.md:232`, `:270`, `:276`, `:288`.
  - A `REFERENCES` clause exists only for the `FK` labels inside the Mission group. `(node_id, attempt)` of an evidence and of an assessment takes no foreign key. Decision D24; `02-execution.md:137–150`, `:181`.
  - The nullable columns are the columns that the ERD diagram marks "or null" or "null until". `02-execution.md:76–130`.
  - Never edit a published migration. `engine/AGENTS.md` "Add a migration".
- Done when: `pnpm run verify` passes; the migration test lists the five tables; `sqlite_master` holds the four unique indexes.

### 01.2 Declare the record schemas and the control input schemas

- Files: `src/mission/contract.ts` (edit), `src/mission/contract.test.ts` (create)
- Do:
  1. Declare these closed sets as `as const` objects with a `z.enum` schema and a type each: `ClaimKind` (`steps`, `evaluation`); `AssessmentResult` (`success`, `criterion-not-met`, `undetermined`); `AssetKind` (`repository`, `produced`, `object`, `platform`); `EndState` (`expected`, `other`); `Resolution` (`unrequested`, `unresolved`, `expected-end`, `other-end`); `ClosingEvent` (`success-override`, `human-discard`, `human-block`, `assessment-not-passed`, `external-failed`, `assessment-passed`, `external-success`); `RepositoryAction` (`pull_request`, `merge_push`); `ExpectedEndState` (`pull_request_merged`, `base_branch_pushed`); `PlatformAddressKind` (`pull_request`, `branch_push`); `ResumeTarget` (`Available`, `Waiting`); `ReleaseObligation` (`evidence`, `assessment`, `request`); `ActorService` (`scheduler`, `mission`).
  2. Replace the `service` variant of `actorSchema` (`src/mission/contract.ts:284–287`) with `service: z.enum(ActorService)`. Replace `SCHEDULER_ACTOR_SERVICE` (`:17`) with `ActorService.Scheduler` at each use.
  3. Declare the scalar schemas: `commitSchema` (`/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`), `sha256Schema` (`/^[0-9a-f]{64}$/`), `actionKeySchema` (`/^[a-z][a-z0-9-]{0,62}\.(pull_request|merge_push)$/`), `textSchema` (`z.string().min(1)`), and use `timestamp` of `src/kernel/json.ts:5` for every time field.
  4. Declare the address schemas with `z.strictObject`: `repositoryAddressSchema` `{ kind: "repository", bindingId, commit }`; `producedAddressSchema` `{ kind: "produced", sha256 }`; `objectAddressSchema` `{ kind: "object", location, version?, sha256? }` with `location` that starts with `s3://`; `platformAddressSchema` as a discriminated union of `{ kind: "pull_request", resourceIdentity, number }` and `{ kind: "branch_push", resourceIdentity, branch, commit }`; `addressSchema` as the discriminated union of the repository, produced and object addresses; `testedInputSchema` as `z.union([addressSchema, z.array(repositoryAddressSchema).min(1)])`.
  5. Declare `verificationSchema` `{ testedInput, results: { command, exitCode: int | null, signal: text | null, timedOut: boolean }[] }`.
  6. Declare the record schemas: `frozenActionSchema` `{ key, bindingId, action, expectedEndState, follows: key | null, configuration: { baseBranch } }`; `attemptSchema` `{ nodeId, attempt, nodeRevision, requiredExternalActions, openedAt, closedAt, outcomeIds, openedBy }`; `evidenceAssetSchema` as a discriminated union on `kind` of `{ id, kind, address, publishedAt, expiredAt }`, where the `object` variant also holds `storageBindingId`, `size` and `mediaType`; `evidenceSchema` `{ id, nodeId, attempt, subject, assets, provenance, createdAt, requirementKey?, endState?, verification? }`; `currencySchema` `{ current, contextMatches, authorityAdmits, orderSelected, reasons }`; `assessmentSchema` `{ id, nodeId, executionId: execution | null, attempt, nodeRevision, evidenceIds, childOutcomeIds, result, rationale, testedInput: testedInput | null, actor, createdAt, currency: currency | null, childNodeIds, workerVersion: text | null }`; `outcomeSchema` `{ id, nodeId, attempt, nodeRevision, closingEvent, result, assessmentId, evidenceIds, createdAt }`; `externalActionSchema` `{ nodeId, attempt, action, requested, requestEvidenceId: evidence | null, resolution }`; `blockedContextSchema` `{ outcome, requests: evidence[] }`; `controlResultSchema` `{ node, attempt: attempt | null, outcome: outcome | null, actor, acceptedAt }`.
  7. Add `blockedContext: blockedContextSchema.optional()` to the initiative and objective variants of `nodeSchema` (`:475–490`). Declare the record schemas before `nodeSchema`, and `controlResultSchema` after it.
  8. Declare the input schemas with `z.strictObject`: `humanActSchema` `{ reason, expectedMissionVersion, expectedState, expectedAttempt }`; `resumeSchema` = `humanActSchema` plus `target`; `overrideSchema` = `humanActSchema` plus `result: z.enum([AssessmentResult.Success])` and `landedCommit: repositoryAddressSchema.optional()`; `unblockChangeSchema` `{ content: contentSchema, tasks: taskContentSchema[] optional, reason }`; `unblockSchema` `{ blockedAttempt, expectedRevision, expectedMissionVersion, change: unblockChangeSchema optional }`.
  9. In `contract.test.ts`, assert that each input schema refuses an unknown key and an `actor` key, that `expectedAttempt: 0` passes, that `result: "failure"` fails, and that `actionKeySchema` accepts `repo.pull_request` and refuses `repo.push`.
- Rules:
  - Every field name equals the CLI page. `HumanAct`, `Resume`, `Override`, `Unblock`, `UnblockChange`, `TaskContent`: `engine/docs/cli/mission.md:686–692`. Addresses and `Verification`: `:716–721`, `:729–730`. `TestedInput`: `:736–741`. Results: `:797–818`.
  - Every attempt field of a record is a nonnegative integer and never null; `ControlResult.attempt` is an attempt object or null. `mission-service.impl.md:360–361`; `engine/docs/cli/mission.md:790–792`.
  - `Attempt.attempt` names an opened attempt of 1 or more. `engine/docs/cli/mission.md:809`.
  - No input carries an actor. `mission-service.impl.md:33`.
  - The service actor holds `scheduler` or `mission`. `engine/docs/cli/mission.md:797`; `mission-service.impl.md:32`.
  - The closed result set of an override is `success`. `mission-service.impl.md:446`.
  - `follows` holds a key or null. `mission-service.impl.md:82`; `engine/docs/cli/mission.md:810`.
  - Every closed value set is an enum in code with named members. Root `AGENTS.md` "Database design"; `architecture.impl.md:15–19`.
- Done when: `pnpm run verify` passes; `contract.test.ts` passes; `mission.ts` of the CLI and the ERD 1 tests compile unchanged.

### 01.3 Add `repositoryPolicyOf` to the Project Service

- Files: `src/project/contract.ts` (edit), `src/project/service.ts` (edit), `src/project/service.test.ts` (edit)
- Do:
  1. Declare `RepositoryPolicy` in `src/project/contract.ts` with the fields of the Provides row: `bindingId`, `projectId`, `name`, `address`, `platform`, `credential`, `baseBranch`, `action` (`GitHubAction` value or null) and `projectPrompt` (string or null).
  2. Implement `repositoryPolicyOf(tx, bindingId): RepositoryPolicy | null` in `ProjectService` beside `getBindingRevision` (`src/project/service.ts:534`). Read the row by identity with `readBindingRevision` (`src/project/store.ts:562`). Answer null when the row is absent or its kind is not `repository`. Parse the `config` of that row with `repositoryConfigSchema` (`src/project/contract.ts:89–110`). Set `action` to `config.strategy.action?.name ?? null` and `projectPrompt` to `config.projectPrompt ?? null`.
  3. Add tests: a pinned row answers its own action after a later revision changes the strategy; a worker binding answers null; an unknown identity answers null; the call opens no transaction of its own.
- Rules:
  - The read uses the row that the identity names, never the latest row of the group. `mission-service.impl.md:77`, `:563`; `02-execution.md:20`, `:235`.
  - The Mission key needs the binding name. `project-service.impl.md:24`.
  - A collaboration takes the caller transaction and opens none. `architecture.impl.md:587–604`.
  - No ERD 1 Project operation changes. `00-index.md` "Shared files".
- Done when: `pnpm run verify` passes; the three tests pass.

### 01.4 Declare the collaborations, recreate `unwired.ts` and wire the stand-ins

- Files: `src/mission/contract.ts` (edit), `src/mission/service.ts` (edit), `src/mission/service.test.ts` (edit), `src/apps/server/unwired.ts` (create), `src/apps/server/unwired.test.ts` (create), `src/apps/server/unwired-import.test.ts` (rewrite), `src/apps/server/index.ts` (edit), `src/apps/server/test-support.ts` (edit)
- Do:
  1. Add `repositoryPolicyOf(tx, bindingId)` to `MissionBindings` (`src/mission/contract.ts:25–43`) with the inline return type of the Provides row.
  2. Declare the consumed interfaces inline, with method syntax:
     ```ts
     export interface SchedulerClaims {
       revoke(tx: Transaction, nodeId: string, now: number): string | null;
       settle(tx: Transaction, nodeId: string, now: number): void;
       liveExecutionOf(
         tx: Transaction,
         nodeId: string,
         now: number,
       ): { executionId: string } | null;
     }
     export interface SchedulerWakeup {
       wake(projectId: string): void;
     }
     export interface ExecutionAttribution {
       of(
         tx: Transaction,
         executionId: string,
       ): {
         clientId: string | null;
         name: string | null;
         workerName: string;
       } | null;
     }
     ```
  3. Declare the provided types `ExecutionActor`, `ClaimAdmission` and `MissionTransitions` with the signatures of the Provides table. Task 01.19 adds `MissionTransitions` to the `implements` clause of `MissionService`.
  4. Add `schedulerClaims: SchedulerClaims`, `wakeup: SchedulerWakeup` and `executionAttribution: ExecutionAttribution` to `Dependencies` (`src/mission/service.ts:74–79`) as required fields.
  5. In `src/mission/service.test.ts`, extend `Collaborators` (`:130`) with the three fields and give `makeService` (`:132–146`) defaults: `revoke` answers null, `settle` does nothing, `liveExecutionOf` answers null, `wake` does nothing, and `of` throws `UNEXPECTED_COLLABORATION`. Give the `bindings` default a `repositoryPolicyOf` that throws `UNEXPECTED_COLLABORATION`.
  6. Recreate `src/apps/server/unwired.ts` with the content of commit `c783ce3`: `unwired(seam: string): (...args: never[]) => never` throws `new CodedError("system.composition.unwired", seam + " is not wired.")`. Recreate `unwired.test.ts` with the assertion of the code and of the seam name in the message.
  7. Rewrite `unwired-import.test.ts`. Assert that only `index.ts` and `unwired.test.ts` import `unwired.ts`. Collect every literal of `unwired("…")` in `index.ts` and assert that the set equals `UNWIRED_SEAMS = ["SchedulerClaims.revoke", "SchedulerClaims.settle", "SchedulerClaims.liveExecutionOf", "ExecutionAttribution.of"]`.
  8. In `composeServices` (`src/apps/server/index.ts:62–72`), add the option `standIns?: { schedulerClaims?: SchedulerClaims; wakeup?: SchedulerWakeup; executionAttribution?: ExecutionAttribution }`. Pass `options.standIns?.<name> ?? <unwired object>` for `schedulerClaims` and `executionAttribution`, where each method of the unwired object is `unwired("<Interface>.<method>")`. Pass `options.standIns?.wakeup ?? { wake: () => {} }` for `wakeup`, the production no-op of the D9 exception. Add `repositoryPolicyOf: (tx, bid) => project.repositoryPolicyOf(tx, bid)` to the Mission `bindings` (`:129–132`).
  9. In `gatewayFixture` (`src/apps/server/test-support.ts:125–138`), add the option `standIns` with the same shape. Merge it over the defaults: `revoke` answers null, `settle` does nothing, `liveExecutionOf` answers null, `wake` does nothing, and `of` answers null. Pass the result to `composeServices`.
- Rules:
  - A collaboration type is declared inline in the own `contract.ts` of the service. The composition root is the only file that imports cross-service types. `00-index.md` "Collaboration-type contract rule"; `src/project/service.ts:16`.
  - Every collaboration is required. Decision D4.
  - Production passes `unwired`, and `gatewayFixture` passes a stand-in that answers the true state of the absent peer. Decisions D6, D9; ERD 1 decision D14.
  - The execution attribution follows the same rule as the three claim seams. The wakeup is the one production no-op of the plan set: no work pull exists before plan 03, so a wakeup has no receiver, and an ERD 1 graph write must not answer 500 after its commit. Decision D9 (the rows `SchedulerWakeup.wake | 01 | 03` and `ExecutionAttribution.of | 01 | 03` and the no-op exception); `.dev/erd-02/decisions-log.md` 2026-09-29 "the Scheduler wakeup before plan 03".
  - Method syntax keeps an unwired function assignable to each method, as in the ERD 1 stub of commit `c783ce3`.
  - Gap: `system.composition.unwired` stands on no page; decision D6 names it, as in ERD 1.
- Done when: `pnpm run verify` passes; `unwired.test.ts` and `unwired-import.test.ts` pass; every ERD 1 E2E test passes unchanged.

### 01.5 Add the record store and the test harness

- Files: `src/mission/record-store.ts` (create), `src/mission/record-store.test.ts` (create), `src/mission/test-support.ts` (create)
- Do:
  1. Declare the row types `AttemptRow`, `EvidenceRow`, `AssetRow`, `AssessmentRow` and `OutcomeRow` with the column names of task 01.1.
  2. Implement the attempt writes and reads: `openAttempt(tx, nodeId, nodeRevision, openedBy, now)` inserts the attempt `mission_node.attempt + 1`, sets `mission_node.attempt` to it and answers the row; `closeAttempt(tx, nodeId, attempt, now)` sets `closed_at` on the open row and asserts one changed row; `readAttempt`, `readOpenAttempt`, `listAttempts(tx, nodeId, after, count)` in descending attempt order, and `readAttemptPins(tx, nodeId)`.
  3. Implement the evidence writes and reads: `insertEvidence(tx, row, assets)` writes the evidence and every asset in the caller transaction; `readEvidence`, `readAssets(tx, evidenceId)`, `readRequests(tx, nodeId, attempt)` (the rows with a non-null `requirement_key`), `readLandedCommitEvidence(tx, nodeId, attempt)` (provenance `{ kind: "service", service: "mission" }`) and `readReleaseEvidence(tx, nodeId, attempt, executionId)` (provenance of that execution).
  4. Implement the assessment and outcome writes and reads: `insertAssessment` and `insertOutcome` set `sequence` to `COALESCE(MAX(sequence), 0) + 1` of the node inside the transaction; `readAssessment`, `listAssessments(tx, nodeId, attempt, after, count)`, `readAssessmentsOfAttempt`, `readOutcome`, `listOutcomes(tx, nodeId, attempt, after, count)`, `readCurrentOutcome(tx, nodeId)` (greatest `sequence`) and `readOutcomesOfAttempt(tx, nodeId, attempt)` through a join with the assessment of each outcome.
  5. Store each JSON set column as `canonicalJSON` (`src/kernel/json.ts:12`) of the array in ascending order, and assert that the array holds no duplicate.
  6. In `src/mission/test-support.ts`, export `missionHarness(t, identity, overrides)`. It migrates an in-memory store with `missionMigrations`, constructs `MissionService` with in-memory fakes that record every call (`bindings`, `workQueue`, `schedulerClaims`, `wakeup`, `executionAttribution`), declares the operations and answers `invoke(key, input)`, which parses the input and the output through the schemas of `missionOperations[key]` around the registered handler. The caller identity is a parameter; the module imports no `test-identity.ts`.
  7. Add tests: the sequence starts at 1 and has no gap; a second open attempt fails at the partial unique index; `closeAttempt` sets `closed_at`; a set column round-trips.
- Rules:
  - `sequence` and the attempt number take the next value inside the inserting transaction, from 1 with no gap. Decision D21; `02-execution.md:233`, `:270`, `:276`.
  - A JSON set column holds a canonical array with no duplicate. Decision D21.
  - A row is append-only, except `end_state` of a request and a human delete. `02-execution.md:252`, `:271`, `:283`.
  - Only a test file imports `test-identity.ts`. `eslint.config.js:206–224`.
- Done when: `pnpm run verify` passes; the four tests pass.

### 01.6 Derive the required external actions

- Files: `src/mission/frozen-action.ts` (create), `src/mission/frozen-action.test.ts` (create)
- Do:
  1. Implement `requiredActionsOf(tx, bindings, nodeId, nodeRevision): FrozenAction[]`. Read the revision row of the node at `nodeRevision`. Answer `[]` for an initiative. For each binding identity of the revision whose kind is `repository` (the first part of `resourceIdentity` of `bindings.getBindingRevision`), read `bindings.repositoryPolicyOf`. For a non-null `action`, answer `{ key: name + "." + action, bindingId, action, expectedEndState, follows: null, configuration: { baseBranch } }`, with `expectedEndState` `pull_request_merged` for `pull_request` and `base_branch_pushed` for `merge_push`. Sort the list by `key`.
  2. Implement `actionStatesOf(tx, bindings, nodeId, attempt)`: for each required action of the pin of the attempt, answer the action, its request evidence row or null, and its `resolution`: `unrequested` without a request, `unresolved` with `end_state` null, `expected-end` after `expected`, `other-end` after `other`.
  3. Implement `eligibleUnrequested(states)` (unrequested, and `follows` null or its predecessor at `expected-end`) and `unresolvedKeys(states)`.
  4. Add tests for each derived field, for a strategy change without a rebind, for each resolution and for an initiative.
- Rules:
  - `FrozenAction` derives from the policy of the binding row that the pinned revision names. `mission-service.impl.md:76–87`; `02-execution.md:235`.
  - The key is `<binding name>.<action name>`. `project-service.impl.md:24`; `engine/docs/cli/mission.md:137`.
  - `follows` is null while a strategy holds at most one action. `mission-service.impl.md:82`; `project-service.impl.md:23`.
  - The four resolutions. `mission-service.impl.md:239`.
  - An action is eligible when it is unrequested and follows no action or its predecessor reached its expected end state. `mission-service.impl.md:249`.
  - The derivation keeps its facts after a strategy change without a rebind. `mission-service.impl.md:563`.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.7 Add the node conditions and extend the claimability

- Files: `src/mission/conditions.ts` (create), `src/mission/conditions.test.ts` (create), `src/mission/routing.ts` (edit), `src/mission/dependency.ts` (edit), `src/mission/node-create.ts` (edit), `src/mission/node-move.ts` (edit), `src/mission/node-retire.ts` (edit), `src/mission/import-apply.ts` (edit), `src/mission/service.ts` (edit)
- Do:
  1. Implement `closureUnsatisfied(tx, node): string[]` with `buildDependencyClosureOf` (`src/mission/graph.ts:40`): the nodes of the closure that are not `Completed`.
  2. Implement `readinessOf(tx, node): { holds; objectivesNotTerminal; unresolvedActions }`. For an initiative, `objectivesNotTerminal` lists every current objective that is not terminal. `unresolvedActions` lists the `requirement_key` of each request of the open attempt with a null `end_state`; the list is empty when the attempt reads 0.
  3. Implement `continuationHolds(tx, bindings, node)`: the open attempt holds an eligible unrequested required action.
  4. Add a `bindings` parameter to `claimableMap` (`src/mission/routing.ts:8–33`) and `reconcileMission` (`:63–93`). A node is claimable when it is not retired and: `Available` for an objective, or `Available` with the initiative steps condition for an initiative; `Waiting` with the readiness condition; `External.Requested` with the continuation condition. Pass `this.dependencies.bindings` from every caller in `dependency.ts`, `node-create.ts`, `node-move.ts`, `node-retire.ts`, `import-apply.ts` and `service.ts`.
  5. Add tests for each condition, for attempt 0, and for the claimability of each of the twelve states.
- Rules:
  - The readiness condition, the continuation condition and the initiative steps condition. `mission-service.md:473–494`; `mission-service.vocabulary.md:220–258`.
  - At attempt 0, the readiness condition reads no attempt-scoped record. `mission-service.impl.md:410–412`.
  - A node is claimable when its state and its condition admit a claim; no other state admits one. `scheduler-service.md:36–43`.
  - The job of an initiative follows the terminal states of its current objectives. `02-execution.md:228`.
- Done when: `pnpm run verify` passes; the tests pass; every ERD 1 test passes unchanged.

### 01.8 Map the attempt, evidence, outcome and external-action records

- Files: `src/mission/record-read.ts` (create), `src/mission/record-read.test.ts` (create), `src/mission/node-read.ts` (edit), `src/mission/node-rebind.ts` (edit), `src/mission/service.ts` (edit)
- Do:
  1. Implement `attemptRecord(tx, bindings, row): Attempt`: `requiredExternalActions` from `requiredActionsOf` of the pin; `outcomeIds` from `readOutcomesOfAttempt`; `openedBy` from `opened_by`.
  2. Implement `evidenceRecord(tx, row): Evidence`. Map each asset `content` to its address: a repository shape to `{ kind: "repository", bindingId, commit }`; a produced shape to `{ kind: "produced", sha256 }`; an object shape to `{ kind: "object", location, version, sha256 }` from `objectVersion` and `sha256`, plus `storageBindingId`, `size` and `mediaType` on the asset; a platform shape to the `PlatformAddress` itself. Add `requirementKey`, `endState` and `verification` only when the column is not null.
  3. Implement `outcomeRecord(tx, bindings, row): Outcome`. Take `attempt` and `nodeRevision` from the named assessment. Answer `evidenceIds` as the union of the outcome set and the assessment set. Derive `closingEvent` in this order: `success-override` for a human assessment with `success`; `human-discard` for a human assessment with `undetermined` whose outcome is the current outcome of a `Discarded` node; `human-block` for every other human assessment; `assessment-not-passed` for an execution assessment that is not `success`; `external-failed` for an execution assessment with `success` and an outcome with `undetermined`; `assessment-passed` for an execution assessment with `success` when the attempt requires no external action; `external-success` otherwise.
  4. Implement `externalActionRecords(tx, bindings, nodeId, attempt): ExternalAction[]` from `actionStatesOf`.
  5. Implement `blockedContextOf(tx, bindings, node)`: the current outcome of the node, and the request evidence of the attempt of that outcome, or `[]` for attempt 0.
  6. Add a `bindings` parameter to `nodeRecord` (`src/mission/node-read.ts:91–128`), `getNode` (`:130–132`) and `nodePage` (`:144–157`). Add `blockedContext` to the record of a `Blocked` node. Pass `this.dependencies.bindings` at each call site in `service.ts` and `node-rebind.ts`.
  7. Add tests for each closing event, also after a forced delete of a request evidence, for the evidence union, and for the blocked read at attempt 0.
- Rules:
  - `Attempt`, `Evidence`, `Outcome`, `ExternalAction` and `BlockedContext`. `engine/docs/cli/mission.md:801`, `:809`, `:811`, `:816`, `:817`.
  - An outcome stores no revision, no attempt and no closing event; the read derives them. `mission-service.impl.md:367`, `:375–385`; `02-execution.md:275`, `:34`.
  - The read answers the union of the outcome set and the assessment set. `mission-service.impl.md:402`; `02-execution.md:282`.
  - Every transition into `Blocked` writes an outcome, so the blocked read returns one; at attempt 0 it returns no request evidence. `mission-service.impl.md:373–374`.
  - The read derives the cause from the basis and the results, never from the order of the records. `mission-service.md:808–814`.
  - Gap: "Record commands await external-action publication and terminal-state retention" stays open (`docs/brainstorm/HANDOFF.md:27`); the reads implement the CLI page as written.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.9 Add the currency evaluator and the assessment record

- Files: `src/mission/currency.ts` (create), `src/mission/currency.test.ts` (create), `src/mission/record-read.ts` (edit)
- Do:
  1. Implement `currencyOf(tx, row): Currency` for an execution assessment A of node N and attempt k.
     - `contextMatches`: A.`node_revision` equals the pin of `mission_attempt` (N, k); every identity of A.`evidence_ids` names an evidence row of N; for an initiative, the nodes of A.`child_outcome_ids` equal the current objectives of N, and each named outcome is the current outcome of its objective (greatest `sequence`).
     - `authorityAdmits`: no human assessment of N with attempt k has a `sequence` greater than A.`sequence`.
     - `orderSelected`: A holds the greatest `sequence` among the execution assessments of N with attempt k that pass both checks.
     - `current` is the conjunction. `reasons` holds one named constant text for each failed check.
  2. Implement `currentAssessmentOf(tx, nodeId, attempt)`: the execution assessment of that attempt with `current: true`, or null.
  3. Implement `assessmentRecord(tx, dependencies, row): Assessment`. For a human assessment, answer the stored `actor`, `executionId: null`, `testedInput: null`, `currency: null` and `workerVersion: null`. For an execution assessment, derive `actor` as `{ kind: "execution", executionId, clientId, name }` and `workerVersion` as `workerName` from `executionAttribution.of`, and assert a non-null answer. Derive `childNodeIds` from the nodes of `child_outcome_ids`.
  4. Add tests: a later human revision leaves A current; a pause and a resume leave A current; a block in attempt k fails `authorityAdmits`; a human assessment of attempt k + 1 leaves A of attempt k admitted; a closure whose outcome names A leaves A current; a new outcome of a child objective fails `contextMatches` of the initiative assessment; a later execution assessment of attempt k fails `orderSelected` of A; a human assessment answers `currency: null`.
- Rules:
  - The service computes the currency of an execution assessment at each read and stores none. The three checks and `current` follow the page bullets. `mission-service.impl.md:234–239` (ruled 2026-09-30 on `mission-service.impl.md` "The assessment").
  - The read answers `currency: null` for a human assessment. `mission-service.impl.md:208`.
  - The three checks. `mission-service.md:376–394`; `mission-service.vocabulary.md:386–404`.
  - The currency is computed at each read and the order check reads `sequence` over the execution assessments only. `02-execution.md:33`, `:270`.
  - The current outcome of a node is its outcome with the greatest `sequence`. `02-execution.md:277`; `mission-service.impl.md:236`.
  - An execution assessment stores `execution_id`, and the read derives the execution actor and `workerVersion`. `02-execution.md:263`; `mission-service.impl.md:206`, `:233`.
  - `Currency` and `Assessment`. `engine/docs/cli/mission.md:813–814`.
  - Gap: the recovery of a stale assessment stays B9 B2 (`docs/brainstorm/HANDOFF.md:103`).
- Done when: `pnpm run verify` passes; the eight tests pass.

### 01.10 Make the ERD 1 writes attempt-aware

- Files: `src/mission/revision.ts`, `src/mission/node-read.ts`, `src/mission/store.ts`, `src/mission/node-create.ts`, `src/mission/node-update.ts`, `src/mission/node-move.ts`, `src/mission/node-rebind.ts`, `src/mission/node-retire.ts`, `src/mission/import-apply.ts`, `src/mission/import-revisions.ts`, `src/mission/dependency.ts`, `src/mission/service.ts`, `src/mission/service.test.ts` (all edit)
- Do:
  1. Change `revisionFromRow(row)` (`src/mission/revision.ts:4–23`) to `revisionFromRow(tx, row)`. Set `pinnedByAttempts` to the attempts of the node that pin that revision, in ascending order. Update the twelve call sites.
  2. Set `pinnedByAttempts` of `nodeRecord` (`src/mission/node-read.ts:103`) to the attempts of the content owner that pin `visibleRevision`.
  3. Add `openAttemptsOf(tx, ownerIds): { nodeId; attempt }[]` and set `openAttemptsUnchanged` of the `NodeChange` of each write that inserts a revision: `node-update.ts:208`, `node-create.ts:278`, `node-move.ts:207`, `node-rebind.ts:222`, `node-retire.ts:288` and `import-apply.ts:258`. A dependency edit inserts no revision and keeps `[]` (`dependency.ts:91`).
  4. Extend `readLiveNodesPinning` (`src/mission/store.ts:487–510`): a node also pins the binding when the revision of its open attempt names the binding.
  5. In the priority handler (`src/mission/service.ts:261–280`), after `requireNonterminal`, read the clock once and call `schedulerClaims.liveExecutionOf`. A non-null answer throws `OperationError(409, "mission.node.claim_live", …, { nodeId, executionId })` (code: proposed).
  6. In `addDependency` (`src/mission/dependency.ts:126–151`), after `requireNonterminal`, call `schedulerClaims.settle` and then `liveExecutionOf` for the dependent and each current descendant. A non-null answer throws `mission.node.claim_live` with that `nodeId` and `executionId` (code: proposed).
  7. After `caller.commit` returns, call `wakeup.wake(projectId)` in each handler whose transaction writes the work queue: `node.create`, `import.apply`, `dependency.add`, `dependency.remove`, `node.move`, `node.retire` and `node.priority.set`.
  8. Add tests for each change, and for a priority act and a dependency addition that meet a live claim.
- Rules:
  - The read of a node names the revision that each attempt pins. `mission-service.md:223–225`.
  - `openAttemptsUnchanged` names each content owner of the change with an open attempt at the commit. `mission-service.impl.md:532`.
  - `liveNodesPinning` includes the revision of the open attempt. `mission-service.impl.md:462`.
  - A priority act requires no live claim. `mission-service.impl.md:71`; `mission-service.md:86`.
  - A dependency addition requires no live claim on the dependent or on a node of its subtree. `mission-service.md:53`.
  - Code `mission.node.claim_live` (409): proposed in `00-index.md` "Codes for Ulrich". The condition stands at `mission-service.impl.md:71` and `mission-service.md:53`. No code of `engine/docs/cli/other.md` and no ERD 1 code covers it.
  - The Mission Service wakes the Scheduler after the commit, never inside the transaction. `mission-service.md:691–692`; decision D20.
  - In production before plan 03, the wakeup is a no-op under the D9 exception, so a graph write answers as in ERD 1.
- Done when: `pnpm run verify` passes; the new tests pass; every ERD 1 test passes with the updated `pinnedByAttempts` and `openAttemptsUnchanged` expectations.

### 01.11 Add the human control core

- Files: `src/mission/control.ts` (create), `src/mission/control.test.ts` (create)
- Do:
  1. Implement `admitControl(tx, dependencies, nodeId, body, admitted, now)` with this order: `requireNode`; `requireActive` (409 `mission.node.retired`); a task throws 400 `mission.node.control_task` (code: proposed); `requireMission` with `expectedMissionVersion` (409 `mission.version.conflict`); `schedulerClaims.settle(tx, nodeId, now)`; a new read of the node; `requireNonterminal` (409 `mission.node.terminal`); `expectedState` and `expectedAttempt` against the current state and attempt (409 `mission.node.state_conflict` with `details: { state, attempt }`); a state outside `admitted` throws 409 `mission.node.control_refused` with `details: { state }` (code: proposed).
  2. Implement `requireNoUnresolvedAction(tx, node)`: a request of the open attempt with a null `end_state` throws 409 `mission.node.action_unresolved` with `details: { requirementKeys }` (code: proposed).
  3. Implement `writeHumanRecords(tx, node, result, rationale, actor, outcomeEvidenceIds, now)`. It inserts the human assessment with `attempt` equal to the node attempt, `node_revision` equal to the pin of that attempt or, at attempt 0, the current revision, empty `evidence_ids` and `child_outcome_ids`, a null `tested_input` and `execution_id`, and the human `actor`. It then inserts the outcome that names the assessment. Both rows commit in the caller transaction.
  4. Implement `endLiveClaim(tx, dependencies, node, now)`: for `Executing` and `Evaluating`, call `schedulerClaims.revoke`.
  5. Implement `transition(tx, dependencies, mission, node, state, now)`. Compute `claimableMap` before the change. Delete the job of the acted node when it was claimable, and mark it not claimable in the map. Set the state, run `routeMission` and `reconcileMission`, so that the acted node takes a new job when it is claimable after the change.
  6. Implement `controlResult(tx, dependencies, nodeId, outcome, actor, now)`: `node` as `nodeRecord`, `attempt` as the record of the node attempt when it reads 1 or more, else null, `outcome` as the outcome record or null, `actor` and `acceptedAt: now`.
  7. Implement `closeExternalAttempt(tx, dependencies, node, now)`. For `External.Success` with a current passing assessment of the open attempt, close the attempt, write the outcome with `success`, that assessment as its basis and the landed-commit evidence of the attempt, and set `Completed`. For `External.Failed` with a current passing assessment, close the attempt, write the outcome with `undetermined` and the same basis, and set `Blocked`. Otherwise change nothing and answer null.
  8. Add tests for each refusal and its order, for the records of attempt 0, for the new job identity of the acted node, and for both branches of `closeExternalAttempt`.
- Rules:
  - A stale mission version answers before the state check; a human act checks the mission version and leaves it unchanged. `engine/docs/cli/mission.md:694–697`; `mission-service.impl.md:517–518`.
  - A human act first settles each expired unsettled execution and then checks its own precondition. `02-execution.md:223`; `mission-service.md:501–503`.
  - A precondition mismatch answers `mission.node.state_conflict` with the current `state` and `attempt`. `mission-service.impl.md:391–393`.
  - Every human control on a retired node answers `mission.node.retired`. `mission-service.impl.md:161`. No human override reaches a terminal node. `mission-service.md:437–440`.
  - Code `mission.node.control_task` (400): proposed in `00-index.md`. Tasks reject state controls and record lists. `engine/docs/cli/mission.md:140`, `:325–326`, `:417–418`.
  - Code `mission.node.control_refused` (409): proposed in `00-index.md`. The eligible states of each control stand at `engine/docs/cli/mission.md:334–384`.
  - Code `mission.node.action_unresolved` (409): proposed in `00-index.md`. A node reaches a terminal state only when no external action of its open attempt is unresolved. `mission-service.md:546–548`; `engine/docs/cli/mission.md:73–74`, `:382–384`.
  - A human override, discard or block writes its human assessment and its outcome in one transaction; attempt 0 records hold `attempt: 0`. `02-execution.md:239`, `:264`; `mission-service.impl.md:362–366`.
  - An attempt closure ends every execution in flight under that attempt, and the Scheduler revokes the claim in the Mission transaction. `mission-service.md:463`; `scheduler-service.md:204–212`.
  - `ControlResult.attempt` is the attempt record after the act or null at attempt 0. `engine/docs/cli/mission.md:808`; `mission-service.impl.md:424`, `:440`.
  - The rows `External.Success -> Completed` and `External.Failed -> Blocked` fire when a current passing assessment of the attempt stands, and the outcome of `External.Failed` keeps the passing assessment as its basis. `mission-service.md:607`, `:610`; `02-execution.md:281–282`; `mission-service.vocabulary.md:128–130`.
  - A transition deletes the job of an unclaimable node and inserts the job of a claimable node in its transaction. `mission-service.md:691`; `02-execution.md:219`.
  - Gap: human-control race precedence stays B9 E3 (`docs/brainstorm/HANDOFF.md:110`); every control rechecks its admission in its one transaction.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.12 Implement `mission.node.pause` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/control-hold.ts` (create), `src/mission/control-hold.test.ts` (create), `src/apps/cli/mission-support.ts` (create), `src/apps/cli/mission.ts` (edit), `src/apps/cli/mission-control.ts` (create), `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"node.pause"` in `missionOperations`: `writeOperation`, id `mission.node.pause`, `POST /api/mission/node/:nodeId/pause`, body `humanActSchema`, output `controlResultSchema`.
  2. Implement `pauseNode` in `control-hold.ts`. Admit `Pending`, `Available`, `Executing`, `Waiting`, `Evaluating`, `External.Requested`, `External.Success` and `External.Failed`. Call `endLiveClaim`, then `transition` to `Paused`. Keep the attempt open. Register the handler in `declare` and call `wakeup.wake` after `caller.commit`.
  3. Move `client` (`src/apps/cli/mission.ts:153`), `printResult` (`:159`), `pagination` (`:164`), `mutate` (`:231`), `addPagination` (`:585`) and `addMutationOptions` (`:676`) to `src/apps/cli/mission-support.ts` without a change of behavior. Widen the `ReadCommand` name type (`:132`) to the operation key.
  4. In `mission-control.ts`, export `addControlCommands(node: Command)`. Add the leaf `node pause <node-id> --file <path> [--idempotency-key <key>]`. It validates the node identity with the code `cli.mission.node.pause.invalid_node_id` (code: proposed), reads the file with `humanActSchema` and calls `"node.pause"`. Call `addControlCommands` from `addNodeCommands` (`src/apps/cli/mission.ts:686`).
  5. Regenerate OpenAPI with `pnpm run build && node bin/kanthord.mjs gateway openapi`. In `openapi-integration.test.ts`, assert the operation id of the route.
  6. Add tests: a pause from each admitted state; a pause from `Executing` and from `Evaluating` calls `revoke`; the job leaves the queue; the attempt stays open; the mission version is unchanged; a pause of a `Blocked` node answers `mission.node.control_refused`.
- Rules:
  - The route, the input, the answer and the eligible states. `engine/docs/cli/mission.md:317`, `:334–337`.
  - A pause revokes the live claim and keeps the attempt open. `mission-service.md:563`, `:569`, `:576`, `:580`, `:586`, `:605`, `:608`, `:612`; `scheduler-service.md:207–208`.
  - The task that declares a route adds the CLI leaf and regenerates OpenAPI. ERD 1 decision D13; `00-index.md` "Shared files".
  - CLI code `cli.mission.node.pause.invalid_node_id`: proposed under the CLI rule of `architecture.impl.md:348`, as `cli.mission.node.get.invalid_node_id` (`engine/docs/cli/mission.md:877`).
  - Gap: the physical stop of a revoked execution and the reuse of its resources stay B9 SC5 (`docs/brainstorm/HANDOFF.md:114`).
- Done when: `pnpm run verify` passes; the tests pass; `kanthord mission node pause --help` exits 0.

### 01.13 Implement `mission.node.ready` and `mission.node.resume` with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/control-hold.ts`, `src/mission/control-hold.test.ts`, `src/apps/cli/mission-control.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"node.ready"` (`POST /api/mission/node/:nodeId/ready`, body `humanActSchema`) and `"node.resume"` (`POST /api/mission/node/:nodeId/resume`, body `resumeSchema`), each with the output `controlResultSchema`.
  2. Implement `readyNode`. Admit `Available`. Compute `readinessOf`; a node that is not ready throws 409 `mission.node.not_ready` with `details: { objectivesNotTerminal, unresolvedActions, unsatisfiedIds: [] }`. At attempt 0, open attempt 1 with the current revision and the human as `opened_by`. Then `transition` to `Waiting`. Answer `outcome: null`.
  3. Implement `resumeNode`. Admit `Paused`. Read `actionStatesOf` of the open attempt: an `other-end` action selects `External.Failed`; else a requested action with every action at `expected-end` selects `External.Success`; else a requested action selects `External.Requested`; else `target` selects the state. `target: Waiting` requires `readinessOf` and an empty `closureUnsatisfied`, else 409 `mission.node.not_ready` with the three lists. `target: Available` sets `Available`, and `routeMission` moves the node to `Pending` when the closure does not hold. After the state, call `closeExternalAttempt`, and answer its outcome or null.
  4. Register both handlers and call `wakeup.wake` after each commit.
  5. Add the leaves `node ready <node-id> --file <path>` and `node resume <node-id> --file <path>` with the codes `cli.mission.node.ready.invalid_node_id` and `cli.mission.node.resume.invalid_node_id` (code: proposed).
  6. Regenerate OpenAPI and assert both operation ids.
  7. Add tests: `node ready` on an initiative at attempt 0 whose objectives are terminal; on an objective at attempt 0 with and without tasks; attempt 1 pins the current revision and the job enters the queue in the same transaction; the refusal writes nothing. A resume to `Waiting` with a job; a resume refused with `unsatisfiedIds`; a resume to `Available` and to `Pending`; the precedence of a request over the target; a resume opens no attempt and resets no loss count.
- Rules:
  - `node ready`. `mission-service.impl.md:405–425`; `engine/docs/cli/mission.md:359–370`; `02-execution.md:236`.
  - `node resume` and its precedence. `mission-service.impl.md:427–440`; `mission-service.md:550–556`; `02-execution.md:237`; `engine/docs/cli/mission.md:338–347`.
  - `mission.node.not_ready` and its `details`. `mission-service.impl.md:413–417`; `engine/docs/cli/mission.md:930`.
  - The tests. `mission-service.impl.md:579–583`, `:665`.
  - CLI codes `cli.mission.node.ready.invalid_node_id` and `cli.mission.node.resume.invalid_node_id`: proposed under `architecture.impl.md:348`.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.14 Implement `mission.node.block` and `mission.node.discard` with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/control-close.ts` (create), `src/mission/control-close.test.ts` (create), `src/apps/cli/mission-control.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"node.block"` (`POST /api/mission/node/:nodeId/block`) and `"node.discard"` (`POST /api/mission/node/:nodeId/discard`), each with body `humanActSchema` and output `controlResultSchema`.
  2. Implement `blockNode`. Admit `Paused`. Close the open attempt when the attempt reads 1 or more. Call `writeHumanRecords` with `undetermined` and `reason` as the rationale, and the landed-commit evidence of the attempt as the outcome evidence. Then `transition` to `Blocked`.
  3. Implement `discardNode`. Admit `Pending`, `Available`, `Executing`, `Waiting`, `Evaluating`, `Blocked`, `Paused`, `External.Success` and `External.Failed`. Call `requireNoUnresolvedAction`, then `endLiveClaim`. Close the open attempt, except from `Blocked` and at attempt 0. Call `writeHumanRecords` with `undetermined`. Then `transition` to `Discarded`.
  4. Register both handlers and call `wakeup.wake` after each commit.
  5. Add the leaves `node block <node-id> --file <path>` and `node discard <node-id> --file <path>` with the codes `cli.mission.node.block.invalid_node_id` and `cli.mission.node.discard.invalid_node_id` (code: proposed).
  6. Regenerate OpenAPI and assert both operation ids.
  7. Add tests: a block at attempt 0 keeps the attempt at 0 and writes both records with `attempt: 0`; a block at attempt 1 closes it; a discard from `Executing` revokes the claim and closes the attempt; a discard from `Blocked` closes nothing; a discard with an unresolved request answers `mission.node.action_unresolved`; the dependents of a discarded node stay `Pending`; the last terminal objective inserts the steps job of its initiative.
- Rules:
  - The block is the only human block; it requires `Paused` and closes an open attempt. `engine/docs/cli/mission.md:348–352`; `mission-service.md:720–734`; `mission-service.md:600`.
  - The discard, its eligible states and its outcome. `engine/docs/cli/mission.md:379–384`; `mission-service.md:565`, `:571`, `:578`, `:582`, `:587`, `:593`, `:602`, `:609`, `:613`.
  - A block and a discard assert `undetermined`. `02-execution.md:280`; `mission-service.impl.md:386–387`.
  - The outcome holds the landed-commit evidence of the attempt. `mission-service.impl.md:402`.
  - A discarded node satisfies no dependency. `mission-service.md:537`.
  - The tests. `mission-service.impl.md:567–574`, `:578`.
  - CLI codes `cli.mission.node.block.invalid_node_id` and `cli.mission.node.discard.invalid_node_id`: proposed under `architecture.impl.md:348`.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.15 Implement `mission.node.override` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/control-close.ts`, `src/mission/control-close.test.ts`, `src/apps/cli/mission-control.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"node.override"` (`POST /api/mission/node/:nodeId/override`, body `overrideSchema`, output `controlResultSchema`).
  2. Implement `overrideNode`. Admit `Pending`, `Available`, `Executing`, `Waiting`, `Blocked`, `Paused`, `External.Success` and `External.Failed`. Call `requireNoUnresolvedAction`, then `endLiveClaim`.
  3. For a `landedCommit`, compare its `bindingId` with the repository binding of the revision of the act: the pin of the node attempt, or the current revision at attempt 0. A different binding, or an initiative, throws 400 `mission.evidence.binding_mismatch` (code: proposed). Insert a published evidence with `attempt` equal to the node attempt, `subject` equal to `reason`, the human actor as `provenance`, and one `repository` asset with the canonical content `{ bindingId, commit }` and `published_at: now`.
  4. Close the open attempt, except from `Blocked` and at attempt 0. Call `writeHumanRecords` with `success`, with the landed-commit evidence of the attempt and the override evidence as the outcome evidence. Then `transition` to `Completed`.
  5. Register the handler and call `wakeup.wake` after the commit.
  6. Add the leaf `node override <node-id> --result <result> --file <path>`. The CLI sets `result` from `--result`, reads the file with `overrideSchema.omit({ result: true })`, and refuses a value other than `success` with `cli.mission.node.override.invalid_result` (code: proposed) and an invalid node identity with `cli.mission.node.override.invalid_node_id` (code: proposed). A file with a `result` member fails the strict schema with `cli.file.schema_invalid`.
  7. Regenerate OpenAPI and assert the operation id.
  8. Add tests: an override at attempt 0 writes the evidence with `attempt: 0` and checks the binding of the current revision; an override from `External.Failed` closes by force; an override from `Blocked` closes nothing; a commit of another binding answers `mission.evidence.binding_mismatch`; an override from `Evaluating` answers `mission.node.control_refused`; the dependents of the node move to `Available`.
- Rules:
  - The route, the input, the eligible states and the closed set `success`. `engine/docs/cli/mission.md:322`, `:371–378`, `:689`; `mission-service.impl.md:442–448`.
  - A success override with a landed commit inserts a published evidence with the human actor as provenance, and the outcome names it. `02-execution.md:248`, `:255`, `:257`; `mission-service.impl.md:364`, `:568`.
  - Code `mission.evidence.binding_mismatch` (400): proposed in `00-index.md` "Codes for Ulrich" for plan 04; its condition includes the landed commit of an override. A supplied commit is permitted only for the repository binding of the objective. `engine/docs/cli/mission.md:689`; `02-execution.md:248`.
  - The CLI refuses a `--file` that holds a `result` member. `engine/docs/cli/mission.md:378`; `engine/docs/cli/common-flags.md:189`.
  - A success override satisfies a dependency. `mission-service.md:38`.
  - CLI codes `cli.mission.node.override.invalid_result` and `cli.mission.node.override.invalid_node_id`: proposed under `architecture.impl.md:348`.
  - Gap: a failure override waits for the B9 items of the Mission Service (`mission-service.impl.md:446`; `docs/brainstorm/HANDOFF.md:104`, `:109`).
- Done when: `pnpm run verify` passes; the tests pass.

### 01.16 Implement `mission.node.unblock` with its CLI leaf

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/control-unblock.ts` (create), `src/mission/control-unblock.test.ts` (create), `src/apps/cli/mission-control.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare `"node.unblock"` (`POST /api/mission/node/:nodeId/unblock`, body `unblockSchema`, output `controlResultSchema`).
  2. Implement `unblockNode` in this order: `requireNode`; `requireActive`; a task answers `mission.node.control_task`; `requireMission`; `settle`; `requireNonterminal`; a state other than `Blocked` answers `mission.node.control_refused`; a `blockedAttempt` other than the node attempt answers 409 `mission.node.state_conflict` with `details: { state, attempt }`; an `expectedRevision` other than the current revision answers 409 `mission.revision.conflict` with `details: { current }`.
  3. For a `change`, resolve `content` with `resolveContent` (`src/mission/node-create.ts:124`) and validate `reason` with `validateText`. For an objective, require `tasks` with exactly the current task identities, and validate each task content with an empty `bindings`; for an initiative, refuse `tasks`. A violation answers 400 `mission.node.content_invalid` with `details: { field: "tasks" }`. Insert the next revision with `change.write: "unblock"`, the changed fields, the task changes and the human actor, and increment the mission version once. A change with no changed field inserts nothing.
  4. At attempt 1 or more, open the next attempt with the revision that the act leaves current and the human as `opened_by`. At attempt 0, open none. Then `transition` to `Available`; `routeMission` moves the node to `Pending` when the closure does not hold.
  5. Register the handler and call `wakeup.wake` after the commit.
  6. Add the leaf `node unblock <node-id> --file <path>` with the code `cli.mission.node.unblock.invalid_node_id` (code: proposed).
  7. Regenerate OpenAPI and assert the operation id.
  8. Add tests: an unblock opens the next attempt with the human as `opened_by`; an unblock at attempt 0 opens none and answers `attempt: null`; a retry of an accepted unblock answers `mission.node.control_refused`; a stale `blockedAttempt` answers `mission.node.state_conflict`; a change writes one revision, increments the mission version once and pins the new revision; the routing reaches `Pending` when the closure does not hold.
- Rules:
  - The unblock is one transaction with the content revision, the opened attempt and the routing. `02-execution.md:240`; `mission-service.md:736–788`.
  - The input and the answer. `engine/docs/cli/mission.md:353–358`, `:690–692`.
  - The content rules apply to an unblock content change. `mission-service.impl.md:38`; `mission-service.vocabulary.md` "node content".
  - An unblock with a change increments the mission version, and every other human control leaves it. `mission-service.impl.md:500`, `:518`.
  - A stale expected revision answers `mission.revision.conflict` with the current value. `mission-service.impl.md:542`.
  - The eligibility of an unblock reads the state of the node alone. `mission-service.md:780–783`.
  - An unblock never routes to `Waiting`. `mission-service.md:471`.
  - The tests. `mission-service.impl.md:572–574`, `:666`.
  - CLI code `cli.mission.node.unblock.invalid_node_id`: proposed under `architecture.impl.md:348`.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.17 Add the attempt and external-action reads with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/record-list.ts` (create), `src/mission/record-list.test.ts` (create), `src/apps/cli/mission-record.ts` (create), `src/apps/cli/mission.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare four read operations with `readOperation`:
     - `"attempt.list"`: `mission.attempt.list`, `GET /api/mission/node/:nodeId/attempt`, query `pageQuery`, output `pageOf(attemptSchema)`.
     - `"attempt.get"`: `mission.attempt.get`, `GET /api/mission/node/:nodeId/attempt/:attempt`, params `attempt` as a positive safe integer, output `attemptSchema`.
     - `"externalAction.list"`: `mission.externalAction.list`, `GET /api/mission/node/:nodeId/external-action`, query `pageQuery` plus `attempt` as a nonnegative safe integer, output `pageOf(externalActionSchema)`.
     - `"externalAction.get"`: `mission.externalAction.get`, `GET /api/mission/node/:nodeId/attempt/:attempt/external-action/:actionKey`, params `actionKey` with `actionKeySchema`, output `externalActionSchema`.
  2. Implement the handlers with one `caller.commit` each. A task answers `mission.node.control_task`. An absent node answers `mission.node.not_found`. An absent attempt or an absent action key answers 404 `mission.record.not_found`. The attempt list orders by attempt in descending order, with a base64url cursor of the attempt number. The external-action list orders by attempt and key in descending order, with a base64url cursor of `attempt|key`; `attempt: 0` answers an empty page. A malformed cursor answers 400 `system.pagination.cursor_invalid`.
  3. In `src/apps/cli/mission-record.ts`, export `addRecordCommands(mission: Command)` with the leaves `attempt list <node-id> [--limit] [--cursor]`, `attempt get <node-id> <attempt>`, `external-action list <node-id> [--attempt <attempt>] [--limit] [--cursor]` and `external-action get <node-id> <attempt> <action-key>`. Call it from `addMissionCommand` (`src/apps/cli/mission.ts:599`). Use these codes (code: proposed): `cli.mission.attempt.list.invalid_node_id`, `cli.mission.attempt.get.invalid_node_id`, `cli.mission.attempt.get.invalid_attempt`, `cli.mission.external_action.list.invalid_node_id`, `cli.mission.external_action.list.invalid_attempt`, `cli.mission.external_action.get.invalid_node_id`, `cli.mission.external_action.get.invalid_attempt`, `cli.mission.external_action.get.invalid_action_key`.
  4. Regenerate OpenAPI and assert the four operation ids and the `items` and `nextCursor` properties of both pages.
  5. Add tests: the order, the cursor, the attempt filter, a task refusal, an absent attempt and an absent key.
- Rules:
  - The routes, the access, the positionals and the filter. `engine/docs/cli/mission.md:394–395`, `:410–422`, `:480–491`.
  - The reads never open, close or retry an attempt, and never inspect a platform. `engine/docs/cli/mission.md:420–422`, `:489–492`.
  - An absent record answers `mission.record.not_found`. `mission-service.impl.md:543`.
  - A list orders by its primary key in descending order. ERD 1 decision D10; `architecture.impl.md` "Pagination".
  - The CLI codes are proposed under `architecture.impl.md:348`; a hyphen of `external-action` becomes an underscore.
  - Gap: the record commands keep their HANDOFF mark (`docs/brainstorm/HANDOFF.md:27`).
- Done when: `pnpm run verify` passes; the tests pass.

### 01.18 Add the assessment and outcome reads with their CLI leaves

- Files: `src/mission/contract.ts`, `src/mission/service.ts`, `src/mission/record-list.ts`, `src/mission/record-list.test.ts`, `src/apps/cli/mission-record.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/mission/*` (regenerated)
- Do:
  1. Declare four read operations with `readOperation`:
     - `"assessment.list"`: `mission.assessment.list`, `GET /api/mission/node/:nodeId/assessment`, query `pageQuery` plus optional `attempt`, output `pageOf(assessmentSchema)`.
     - `"assessment.get"`: `mission.assessment.get`, `GET /api/mission/assessment/:assessmentId`, output `assessmentSchema`.
     - `"outcome.list"`: `mission.outcome.list`, `GET /api/mission/node/:nodeId/outcome`, query `pageQuery` plus optional `attempt`, output `pageOf(outcomeSchema)`.
     - `"outcome.get"`: `mission.outcome.get`, `GET /api/mission/outcome/:outcomeId`, output `outcomeSchema`.
  2. Implement the handlers. The lists order by identity in descending order with a cursor of the identity. An omitted `attempt` selects every record of the node, and `attempt: 0` selects the records of attempt 0. A task answers `mission.node.control_task`. An absent assessment or outcome answers `mission.record.not_found`.
  3. Add the leaves `assessment list <node-id> [--attempt <attempt>]`, `assessment get <assessment-id>`, `outcome list <node-id> [--attempt <attempt>]` and `outcome get <outcome-id>` to `addRecordCommands`, with these codes (code: proposed): `cli.mission.assessment.list.invalid_node_id`, `cli.mission.assessment.list.invalid_attempt`, `cli.mission.assessment.get.invalid_assessment_id`, `cli.mission.outcome.list.invalid_node_id`, `cli.mission.outcome.list.invalid_attempt`, `cli.mission.outcome.get.invalid_outcome_id`.
  4. Regenerate OpenAPI and assert the four operation ids.
  5. Add tests: the attempt filter with 0 and with n; the currency of an execution assessment row that a test inserts with the fake `executionAttribution`; the human assessment fields; the outcome union.
- Rules:
  - The routes, the access and the attempt filter. `engine/docs/cli/mission.md:401–405`, `:411–418`, `:456–474`; `mission-service.impl.md:370–372`.
  - A record list requires an initiative or an objective. `engine/docs/cli/mission.md:417–418`.
  - The CLI codes are proposed under `architecture.impl.md:348`.
- Done when: `pnpm run verify` passes; the tests pass.

### 01.19 Implement the `MissionTransitions` seam

- Files: `src/mission/transitions.ts` (create), `src/mission/transitions.test.ts` (create), `src/mission/service.ts` (edit), `engine/AGENTS.md` (edit)
- Do:
  1. Add `MissionTransitions` to the `implements` clause of `MissionService` (`src/mission/service.ts:81`), and delegate `claim`, `release` and `loss` to `transitions.ts`.
  2. Implement `claim(tx, nodeId, declaredStates, opener, now)`. Answer null for an absent, retired or task node, and for a state outside `declaredStates`. `Available` is a steps claim that requires the claimability of task 01.7; `Waiting` is an evaluation claim that requires `readinessOf`; `External.Requested` is an evaluation claim that requires `continuationHolds`; every other state answers null. At attempt 0, open attempt 1 with the current revision and `opener` as `opened_by`. Set `Executing` or `Evaluating`, delete the job of the node, and answer `{ kind, projectId, attempt, nodeRevision }`.
  3. Implement `release(tx, execution, furtherWork, now)`. Assert the state `Executing` or `Evaluating` and the attempt of the execution. Check the predicate before every write. For `Executing` with `furtherWork: false`, require a published evidence of the open attempt with that execution as provenance that holds, for an objective, a `repository` asset with the repository binding of the pin, and, for an initiative, a `produced` asset; else throw 409 `mission.release.obligation_unmet` with `details: { obligation: "evidence" }`. For `Evaluating`, require `currentAssessmentOf` of the attempt with `success`, else `obligation: "assessment"`, and no eligible unrequested required action, else `obligation: "request"`. Route with `transition`: `Executing` with `furtherWork: false` to `Waiting`, with `furtherWork: true` to `Available`, and `Evaluating` to `External.Requested`.
  4. Implement `loss(tx, nodeId, consecutiveLosses, now)`. Assert the state `Executing` or `Evaluating`. At `consecutiveLosses >= config.consecutiveLossLimit`, set `Paused` with no job and the attempt open. Below it, route `Executing` to `Available` and `Evaluating` to `Waiting` with `transition`.
  5. Update the `src/mission/` entry of `engine/AGENTS.md` with the new modules of this plan.
  6. Add tests: a steps claim opens attempt 1 with the execution as `opened_by`; a claim of an open attempt keeps its pin; a stale job and an undeclared state answer null; a `Blocked` node answers null. A steps release with no evidence, with a produced-only evidence and with an unpublished repository evidence answers `obligation: evidence` and changes no node and no job; a release with `furtherWork: true` checks no record; a reviewer release with no assessment answers `obligation: assessment` and with an eligible unrequested action `obligation: request`. A loss below the limit returns the node with a job; the loss that reaches the limit sets `Paused` with no job; a resume after the limit grants one more try.
- Rules:
  - The claim rechecks the state and the condition, sets the state, opens attempt 1 and deletes the job; the row holds no kind. `02-execution.md:212–213`; `scheduler-service.md:174–178`.
  - A stale job suggests a node and never authorizes it. `scheduler-service.md:67`.
  - The release predicate, its refusal and its tests. `mission-service.impl.md:244–252`; `02-execution.md:217`; `engine/docs/cli/scheduler.md:500`.
  - The routing of a release. `02-execution.md:219–220`; `mission-service.md:572–573`, `:584`.
  - The loss below and at the limit. `02-execution.md:222`; `mission-service.md:496–508`; `scheduler-service.impl.md:89–100`; `mission-service.impl.md:664`.
  - Plan 03 calls `release` for the winning terminal write only, and `loss` from the settlement in the same transaction. `02-execution.md:216`, `:222`.
  - Gap: the consecutive-loss count reads every execution row of the node; the scan stays an open HANDOFF item (`docs/brainstorm/HANDOFF.md:29`; decision D18). Plan 03 owns the count.
  - Gap: the disposition of an execution that cannot progress stays B9 (`docs/brainstorm/HANDOFF.md:91`).
- Done when: `pnpm run verify` passes; the tests pass.

### 01.E E2E proof

- Files: `src/apps/server/e2e-mission-attempts-controls.test.ts` (create)
- Do:
  1. Build the setup of the `## E2E` section through the CLI. Start `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` and the default stand-ins.
  2. Write one `test` block for each scenario E01.1 to E01.24 of the table, in table order, on the shared setup of one fixture, and a separate fixture for E01.24.
  3. Parse stdout as JSON for every success. Assert the exit code and the start of stderr for every refusal.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, never a store read. ERD 1 decision D13.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
  - The fixture inputs are the inputs that the committed validation accepts. `.dev/erd-01/decisions-log.md` 03.5, 05.E, 06.E; `src/apps/server/e2e-mission-service.test.ts:191–197`, `:344–371`, `:544–572`.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-mission-attempts-controls.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-mission-attempts-controls.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store and the default stand-ins of task 01.4. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state, `KANTHORD_ENDPOINT = fixture.endpoint` and `KANTHORD_TOKEN = fixture.token`.
- Rules: setup goes through the CLI only; the state check is a CLI read, never a store read; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON.
- No claim exists in this plan, so no node reaches `Executing` or `Evaluating` here. The `MissionTransitions` seam is proven in colocated tests, and plan 03 proves it end to end.

Setup, in order (each command exits 0):

1. `kanthord project create --name controls` → `projectId` = `id`.
2. `kanthord mission get <projectId>` → `missionId` = `id`, `version` 1.
3. `kanthord credential create --file credential.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
4. `kanthord project binding apply <projectId> --file binding.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main", "action": { "name": "pull_request", "follows": { "type": "assessment_passed" } } }, "credential": "github" } } } }` → `bindingSetVersion` 2.
5. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Recover accounts", "requirement": "Recover accounts", "criterion": "Accounts recover", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId` = `revisions[0].nodeId`.
6. `kanthord mission node create <missionId> --file objective-1.json` with the content, the reason and the verifications of step 5 and `"filename": "objective-1.md"`, `"kind": "objective"`, `"bindings": ["repo"]`, `"parentId": <initiativeId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 2` → `objectiveId`.
7. `kanthord mission node create <missionId> --file task-1.json` with the content of step 5 and `"filename": "task-1.md"`, `"kind": "task"`, `"bindings": []`, `"parentId": <objectiveId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 3` → `taskId`. The objective takes revision 2.
8. `kanthord mission node create <missionId> --file objective-2.json` with the content of step 5 and `"filename": "objective-2.md"`, `"kind": "objective"`, `"bindings": ["repo"]`, `"parentId": <initiativeId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 4` → `secondObjectiveId`.
9. `kanthord mission node get <objectiveId>` → `bindingId` = `content.bindings[0]`, `revision` = `visibleRevision`. `M` names the mission version 5.

`act(state, attempt)` names the file `{ "reason": "hold", "expectedMissionVersion": M, "expectedState": state, "expectedAttempt": attempt }`.

| Id     | Commands                                                                                                                                                                                                                                                                                                                            | Exit    | Expect                                                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01.1  | `kanthord mission node ready <initiativeId> --file act(Available, 0)`                                                                                                                                                                                                                                                               | 1       | stderr starts with `mission.node.not_ready:`                                                                                                                                                                                                              |
| E01.2  | `kanthord mission node ready <objectiveId> --file act(Available, 0)`; then `kanthord scheduler queue list <projectId>`; then `kanthord mission get <projectId>`                                                                                                                                                                     | 0, 0, 0 | first stdout `node.state` `Waiting`, `node.attempt` 1, `attempt.attempt` 1, `attempt.nodeRevision` = `revision`, `attempt.openedBy.kind` `human`, `outcome` null; the queue holds an item with `nodeId` = `objectiveId`; `version` = M                    |
| E01.3  | `kanthord mission node pause <objectiveId> --file act(Waiting, 1)`; then `kanthord scheduler queue list <projectId>`                                                                                                                                                                                                                | 0, 0    | `node.state` `Paused`, `attempt.closedAt` null; the queue holds no item with `nodeId` = `objectiveId`                                                                                                                                                     |
| E01.4  | `kanthord mission node resume <objectiveId> --file resume.json` with act(Paused, 1) plus `"target": "Waiting"`; then `kanthord scheduler queue list <projectId>`                                                                                                                                                                    | 0, 0    | `node.state` `Waiting`; the queue holds an item with `nodeId` = `objectiveId`                                                                                                                                                                             |
| E01.5  | `kanthord mission node pause <objectiveId> --file act(Waiting, 1)`; then `kanthord mission node block <objectiveId> --file act(Paused, 1)`; then `kanthord mission node get <objectiveId>`                                                                                                                                          | 0, 0, 0 | second stdout `node.state` `Blocked`, `outcome.result` `undetermined`, `outcome.closingEvent` `human-block`, `outcome.attempt` 1, `attempt.closedAt` a number; third stdout `blockedContext.outcome.id` = that outcome id, `blockedContext.requests` `[]` |
| E01.6  | `kanthord mission node unblock <objectiveId> --file unblock.json` with `{ "blockedAttempt": 1, "expectedRevision": <revision>, "expectedMissionVersion": M }`                                                                                                                                                                       | 0       | `node.state` `Available`, `attempt.attempt` 2, `attempt.openedBy.kind` `human`, `outcome` null                                                                                                                                                            |
| E01.7  | `kanthord mission attempt list <objectiveId>`; then `kanthord mission attempt get <objectiveId> 1`                                                                                                                                                                                                                                  | 0, 0    | first stdout `items[].attempt` `[2, 1]`, `nextCursor` null; second stdout `closedAt` a number, `outcomeIds` = `[<outcome id of E01.5>]`                                                                                                                   |
| E01.8  | `kanthord mission attempt get <objectiveId> 2`                                                                                                                                                                                                                                                                                      | 0       | `requiredExternalActions[0]`: `key` `repo.pull_request`, `bindingId` = `bindingId`, `action` `pull_request`, `expectedEndState` `pull_request_merged`, `follows` null, `configuration.baseBranch` `main`; `closedAt` null                                 |
| E01.9  | `kanthord mission external-action list <objectiveId> --attempt 2`; then `kanthord mission external-action get <objectiveId> 2 repo.pull_request`                                                                                                                                                                                    | 0, 0    | first stdout one item with `resolution` `unrequested`, `requested` false, `requestEvidenceId` null; second stdout `action.key` `repo.pull_request`                                                                                                        |
| E01.10 | `kanthord mission assessment list <objectiveId>`; then `kanthord mission assessment get <items[0].id>`                                                                                                                                                                                                                              | 0, 0    | one item with `actor.kind` `human`, `result` `undetermined`, `executionId` null, `testedInput` null, `currency` null, `workerVersion` null, `attempt` 1; second stdout `id` equal                                                                         |
| E01.11 | `kanthord mission outcome list <objectiveId> --attempt 1`; then `kanthord mission outcome get <items[0].id>`                                                                                                                                                                                                                        | 0, 0    | one item; second stdout `assessmentId` = the id of E01.10                                                                                                                                                                                                 |
| E01.12 | `kanthord mission node override <objectiveId> --result success --file override.json` with act(Available, 2) plus `"landedCommit": { "kind": "repository", "bindingId": <bindingId>, "commit": "<40 × a>" }`                                                                                                                         | 0       | `node.state` `Completed`, `outcome.result` `success`, `outcome.closingEvent` `success-override`, `outcome.evidenceIds` of length 1, `attempt.closedAt` a number                                                                                           |
| E01.13 | `kanthord mission node discard <secondObjectiveId> --file act(Available, 0)`                                                                                                                                                                                                                                                        | 0       | `node.state` `Discarded`, `attempt` null, `outcome.attempt` 0, `outcome.closingEvent` `human-discard`                                                                                                                                                     |
| E01.14 | `kanthord scheduler queue list <projectId>`; then `kanthord mission node ready <initiativeId> --file act(Available, 0)`                                                                                                                                                                                                             | 0, 0    | the queue holds an item with `nodeId` = `initiativeId`; second stdout `node.state` `Waiting`, `attempt.attempt` 1                                                                                                                                         |
| E01.15 | `kanthord mission node block <initiativeId> --file act(Waiting, 1)`                                                                                                                                                                                                                                                                 | 1       | stderr starts with `mission.node.control_refused:`                                                                                                                                                                                                        |
| E01.16 | `kanthord mission node pause <taskId> --file act(Waiting, 1)`                                                                                                                                                                                                                                                                       | 1       | stderr starts with `mission.node.control_task:`                                                                                                                                                                                                           |
| E01.17 | `kanthord mission node pause <objectiveId> --file act(Completed, 2)`                                                                                                                                                                                                                                                                | 1       | stderr starts with `mission.node.terminal:`                                                                                                                                                                                                               |
| E01.18 | `kanthord mission node pause <initiativeId> --file act(Waiting, 0)`                                                                                                                                                                                                                                                                 | 1       | stderr starts with `mission.node.state_conflict:`                                                                                                                                                                                                         |
| E01.19 | `kanthord mission node pause <initiativeId> --file stale.json` with act(Waiting, 1) and `"expectedMissionVersion": 4`                                                                                                                                                                                                               | 1       | stderr starts with `mission.version.conflict:`                                                                                                                                                                                                            |
| E01.20 | `kanthord mission node override <initiativeId> --result success --file mismatch.json` with act(Waiting, 1) plus `"landedCommit": { "kind": "repository", "bindingId": "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA", "commit": "<40 × a>" }`                                                                                                 | 1       | stderr starts with `mission.evidence.binding_mismatch:`                                                                                                                                                                                                   |
| E01.21 | `kanthord mission node pause invalid --file act(Waiting, 1)`; `kanthord mission node override <initiativeId> --result failure --file act(Waiting, 1)`; `kanthord mission node override <initiativeId> --result success --file with-result.json` (act(Waiting, 1) plus `"result": "success"`)                                        | 1, 1, 1 | stderr starts with `cli.mission.node.pause.invalid_node_id:`, `cli.mission.node.override.invalid_result:`, `cli.file.schema_invalid:`                                                                                                                     |
| E01.22 | `kanthord mission attempt get <objectiveId> 0`; `kanthord mission external-action get <objectiveId> 2 repo.push`                                                                                                                                                                                                                    | 1, 1    | stderr starts with `cli.mission.attempt.get.invalid_attempt:`, `cli.mission.external_action.get.invalid_action_key:`                                                                                                                                      |
| E01.23 | `kanthord mission attempt get <objectiveId> 9`                                                                                                                                                                                                                                                                                      | 1       | stderr starts with `mission.record.not_found:`                                                                                                                                                                                                            |
| E01.24 | A second fixture with `standIns.schedulerClaims.liveExecutionOf` that answers `{ "executionId": "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA" }` for each node in a set that the test fills after setup step 6; `kanthord mission node priority set <objectiveId> --file priority.json` with `{ "value": 1, "expectedMissionVersion": 3 }` | 1       | stderr starts with `mission.node.claim_live:`                                                                                                                                                                                                             |

E01.15, E01.16, E01.20, E01.21, E01.22 and E01.24 assert codes of the mark `code: proposed`. The test is committed after Aelita writes each accepted code on its page (ruling R3).

## Blockers

None open. The debate engine settled two gaps:

- DEBATE: the Scheduler wakeup before plan 03 - rounds:1 - verdict: production passes `unwired("SchedulerWakeup.wake")` under D9 and `gatewayFixture` a no-op; the D9 table takes the row, and a production no-op needs an explicit D9 exception. Aelita ruled the exception in decision D9 on 2026-09-30: production passes a no-op, because no work pull exists before plan 03.
- DEBATE: the currency mechanism and its owner - rounds:2 - verdict: plan 01 owns a read-time evaluator with an attempt-scoped authority rule (no later human assessment of the same attempt) and the order over the execution assessments of the same attempt; the release predicate also checks the eligible unrequested actions. Ruled 2026-09-30 on `mission-service.impl.md` "The assessment".
