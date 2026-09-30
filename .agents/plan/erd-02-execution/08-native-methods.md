# Plan 08: Worker Service — steps and evaluation methods

## Scope

This plan delivers:

- The steps method on an objective: the start check of every task at the head of the node branch, the task loop of the pinned revision in the order that the method chooses, the task commit, the verification run against it, the discard of the changes of the run, the revision within the budget, the judgement after every verification passes, the node-branch push before every release, the evidence of the head commit and the release with no further work.
- The budget end of the steps method on an objective: the checkpoint commit, the push and the release with further work, or the head-commit evidence and the release with no further work, under the boundary of debate Q1. Every cleanup command is bounded by `expired_at`.
- The steps method on an initiative: the read of the current objectives, the report of the agent as produced evidence and the release with no further work, or the release with further work when a graph change adds a nonterminal objective.
- The evaluation method: the fresh workspace of the snapshot or of the initiative, the verifications of the node and of each current task, the evidence with the `verification`, the assessment without a judgement after a failed or unrun verification, the judgement after every verification passes, the assessment submission, the call of `worker.action.request` over the HTTP adapter when a current passing assessment stands on a node that requires an external action, and the release after the requests.
- The abort on a revocation or a loss at the first refused call, and the transcript telemetry as a no-op record.
- The method entry `runNativeExecution` that plan 09 hosts. It receives every dependency from plan 09 and reads no server configuration.

Out of scope:

- The `worker` application, the work pull, the handover, the refresh report callback, the discard of the credential store and the evidence upload helper (plan 09). This plan edits no file of `src/apps/worker/` (`00-index.md` "Shared files", row `src/apps/worker/index.ts`).
- The MCP server and the MCP tool source (decision D5). The steps execution after an unblock fetches no external content through `intake.action.read`, because the pages give the `worker` placement that read only as an MCP tool (`worker-service.md:273`, `:486`; `worker-service.impl.md:300`).
- The continuation claim from `External.Requested` (debate Q2): the first version admits no such claim, and the claim carries no source.
- Every B9 item and every open HANDOFF item: the cannot-progress disposition, the typed handoff protocol, W5, W7 and the budgets accounting (decision D1). A task that meets one states the gap in one line.
- A table, an operation, a CLI leaf and an error code. This plan declares none.

## Sources

- `docs/brainstorm/worker-service.md:258–323` — executions, the workspace, the node branch, the task loop, the start check, the evidence, the budget end and the checkpoint.
- `docs/brainstorm/worker-service.md:378–404` — the steps method on an initiative.
- `docs/brainstorm/worker-service.md:406–441` — the end conditions, the revocation and the loss.
- `docs/brainstorm/worker-service.md:492–549` — evaluation, the verification evidence, the judgement, the two claim sources, the action performer call and the release rule.
- `docs/brainstorm/worker-service.md:815–824` — memory.
- `docs/brainstorm/worker-service.vocabulary.md:50–60`, `:320–330` — evaluation method, task commit, checkpoint commit.
- `docs/brainstorm/worker-service.impl.md:227–247` — the `worker` application and the B9 cases.
- `docs/brainstorm/worker-service.impl.md:293–304` — the credential handover and the report at the release.
- `docs/brainstorm/worker-service.impl.md:339–363` — the verifications and the workspace.
- `docs/brainstorm/worker-service.impl.md:441–480` — commit attribution, stop and budget, traces.
- `docs/brainstorm/worker-service.impl.md:482–486` — the acceptance path.
- `docs/brainstorm/mission-service.md:327–401`, `:437–438`, `:483–494`, `:560–613`, `:766–773` — evaluation and assessment, the terminal states, the continuation and initiative steps conditions, the transitions and the unblock reads.
- `docs/brainstorm/mission-service.impl.md:75–93`, `:178–234`, `:248–257`, `:258–288` — the attempt, the verifications, the assessment, the release admission and the evidence content.
- `docs/brainstorm/mission-service.vocabulary.md:236–250` — continuation condition.
- `docs/brainstorm/overview.md:48–78` — kanthord's own harness and the end of an execution.
- `docs/brainstorm/architecture.impl.md:711–712`, `:765` — the idempotency key of a mutation and the peer contracts of the `worker` application.
- `docs/brainstorm/tracking-service.impl.md:18–19` — the no-op tracer of the first phase.
- `docs/reference/erd/02-execution.md:212`, `:216–221`, `:227` — the claim kind, the proof, the release predicate, the lost release answer, the routing and the claim state.
- `engine/docs/cli/mission.md:432–475`, `:518–545`, `:711–769`, `:804`, `:813–818` — the record commands, the execution-scoped reads, the execution submissions and the result schemas.
- `engine/docs/cli/scheduler.md:336–352`, `:361–413` — `ExecutionRecord` and the release.
- `docs/brainstorm/HANDOFF.md:58`, `:91`, `:99`, `:103`, `:119–123` — the handoff protocol, cannot progress, the repeat bound, B2, A3/W1/W4/PR2, W2, W3, W5, W7.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- Plans 03, 04, 05, 06 and 07 of this directory — the Provides tables and the tasks of the seams below.
- `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 08" — the budget-end boundary and the claim source (debate, 2 rounds, ruled 2026-09-30).
- Root `AGENTS.md` "Contracts", "Database design" and "Rejected proposals".

## Depends on

- ERD 1, merged. The worker catalog with `WorkerMethod` and `getWorkerDeclaration` (`src/worker/catalog.ts:7–11`, `:97–102`); `ServiceClient`, `ClientOptions`, `OperationResult` and `OperationResultType` (`src/kernel/operation.ts:165–200`); `httpClient` (`src/gateway/client.ts:82`); `Context` and `CancellationContext` (`src/kernel/context.ts:6–60`); `timestamp` (`src/kernel/json.ts:5–9`); the idempotency key form (`src/gateway/idempotency.ts:66–71`); the boundary that lets a service import a peer `contract.ts` and the kernel alone (`eslint.config.js:67–75`).
- Plan 03: `schedulerOperations.executionRelease` and `schedulerOperations.claimGet` (tasks 03.10, 03.11), `ExecutionRecord` with `createdAt` and `expiredAt`, the proof codes 403 `gateway.invocation.execution_proof_failed` and 409 `scheduler.execution.not_running`.
- Plan 04: `missionOperations["evidence.submit"]`, `["assessment.submit"]` and the execution-scoped reads `["execution.pinnedRevision.get"]`, `["execution.evidence.list"]`, `["execution.evidence.asset.content.get"]`, `["execution.objective.list"]`, `["execution.objective.outcome.list"]`, `["execution.objective.evidence.list"]`, `["execution.clearedOutcome.get"]` (tasks 04.6, 04.9, 04.11, 04.16–04.18).
- Plan 05: `executionCredentialStore` and its `release()`, which reports the current value once (task 05.3).
- Plan 06: `workerOperations["action.request"]`, `ActionRequestResult` and `ActionResultItem` (tasks 06.1, 06.12); `nodeBranchOf` (task 06.4); `scriptedActions` (task 06.3).
- Plan 07: `openNativeAgent` and `NativeAgent`, `ExecutionBudget`, `WorkspaceRoot`, `renderWorkPrompt`, `runVerifications`, `verificationPassed`, `discardChanges`, `headCommit`, `RepositoryTransport`, `ModelRuntimeFactory`, `executionSetupSchema` and `worker.execution.setup.get`, `scriptedProvider` and `scriptedModelRuntime` (plan 07 "Provides").

## Provides

| Seam                                                         | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Owner file                     | Consumer plans |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------- |
| `MethodClients`                                              | `{ mission: Pick<ServiceClient<typeof missionOperations>, "evidence.submit" \| "assessment.submit" \| "execution.pinnedRevision.get" \| "execution.evidence.list" \| "execution.evidence.asset.content.get" \| "execution.objective.list" \| "execution.objective.outcome.list" \| "execution.objective.evidence.list" \| "execution.clearedOutcome.get">; scheduler: Pick<ServiceClient<typeof schedulerOperations>, "executionRelease" \| "claimGet">; worker: Pick<ServiceClient<typeof workerOperations>, "action.request"> }`                                                                                                                                                                                         | `src/worker/method-clients.ts` | 09, 10         |
| `isExecutionEnd`                                             | `(result: OperationResult<unknown>): boolean` — true for 403 `gateway.invocation.execution_proof_failed` and 409 `scheduler.execution.not_running`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/worker/execution-run.ts`  | 09             |
| `runNativeExecution`, `NativeExecutionInput`, `ExecutionEnd` | `runNativeExecution(input: NativeExecutionInput): Promise<ExecutionEnd>`; `NativeExecutionInput = { claim: { executionId; nodeId; attempt; pinnedRevision; createdAt; expiredAt; traceId }; setup: ExecutionSetup; clients: MethodClients; credentials: { store: CredentialStore; release(): Promise<void> }; handoverItem: { credentialId; providerId }; transport: RepositoryTransport; workspaces: WorkspaceRoot; hostHome: string; modelRuntimeFactory: ModelRuntimeFactory; transcript: TranscriptSink; hostTools: HostTools; context: Context }`; `ExecutionEnd = { kind: "released"; furtherWork: boolean } \| { kind: "closed"; outcomeId: string } \| { kind: "ended"; reason: EndReason; code: string \| null }` | `src/worker/native-method.ts`  | 09, 10         |
| `TranscriptSink`, `noTranscript`                             | `{ record(entry: { executionId: string; attempt: number; traceId: string; messages: readonly unknown[] }): void }`; `noTranscript` records nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/worker/transcript.ts`     | 09             |
| `NativeAgent.instruct`, `lastText`, `transcript`             | `instruct(work: WorkPrompt, text: string): Promise<void>`; `lastText(): string \| undefined`; `transcript(): readonly unknown[]` — added to the `NativeAgent` of plan 07                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/worker/native-agent.ts`   | 08             |
| `commitWork`                                                 | `(directory: string, message: string, context: Context, deadlineMs: number): Promise<string \| null>` — beside `discardChanges` and `headCommit` of plan 07                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `src/worker/local-git.ts`      | 08             |

Three differences from `00-index.md` "Seams":

- The index names no seam of plan 08. The rows above are new; plan 09 consumes `runNativeExecution`, `MethodClients`, `isExecutionEnd` and `TranscriptSink`.
- `NativeAgent` of plan 07 answers no text of the agent. The judgement, the report and the transcript need that text, so this plan edits `src/worker/native-agent.ts` of plan 07 (task 08.1).
- Plan 09 passes the object of `executionCredentialStore`. This plan calls its `release()` once, before the first write that can end the claim, because `worker.credential` requires a live execution (`worker-service.impl.md:298`; plan 05 task 05.8). Plan 09 calls `discard()` after the method answers.

## Tasks

### 08.1 Extend the native agent with instructions, its last text and its transcript

- Files: `src/worker/native-agent.ts`, `src/worker/native-agent.test.ts` (both edit)
- Do:
  1. Add `instruct(work: WorkPrompt, text: string): Promise<void>` to `NativeAgent` (plan 07 task 07.17). It calls `pins.setWork(work)`, then `session.prompt(text, { expandPromptTemplates: false })`, then `session.waitForIdle()`. The pinned work layer stays in the context, and `text` is an ordinary user message.
  2. Add `lastText(): string | undefined`, which answers `session.getLastAssistantText()` (`dist/core/agent-session.d.ts:714`), and `transcript(): readonly unknown[]`, which answers a copy of `session.messages` (`:331`).
  3. Add tests with the scripted provider: after `prompt(work)` and `instruct(work, "judge")` the second recorded call holds the pinned work layer once and the text `judge` as the last user message; `lastText` answers the final text of the script; `transcript` holds both user messages and every assistant message; `instruct` after `dispose` rejects.
- Rules:
  - The work prompt renders for each unit of work, and every other layer holds from the start of the execution. `worker-service.md:158–163`.
  - No model inference call of the execution drops a layer of its prompt. `worker-service.md:164`; plan 07 task 07.9.
  - The agent judges the result against the criterion only after every verification passes; the execution code asks for that judgement. `worker-service.md:303`, `:307`.
  - The pi session entries become the transcript telemetry. `worker-service.impl.md:478`.
  - The session API exists in pi 0.86.0: `prompt`, `waitForIdle`, `getLastAssistantText`, `messages` (`dist/core/agent-session.d.ts:331`, `:486`, `:714`).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.2 Add the commit of the work

- Files: `src/worker/local-git.ts`, `src/worker/local-git.test.ts` (both edit)
- Do:
  1. Export `commitWork(directory, message, context, deadlineMs): Promise<string | null>` beside `discardChanges` and `headCommit` (plan 07 task 07.11), over the same `simpleGit({ baseDir, abort, timeout: { block: deadlineMs } })`. Run `git add --all`, then `git status --porcelain`. An empty status answers null and commits nothing. Otherwise run `git commit --message <message>` and answer `git rev-parse HEAD`.
  2. Export `taskCommitMessage(taskId, attempt)` = `"kanthord: task " + taskId + " attempt " + attempt` and `checkpointCommitMessage(taskId, attempt)` = `"kanthord: checkpoint of task " + taskId + " attempt " + attempt`.
  3. Add tests in a temporary repository with a git identity in its local configuration: a tracked edit and an untracked file make one commit whose message names the task and the attempt; a clean tree answers null and moves no ref; an ignored file stays out of the commit; a deadline of 1 ms rejects; the commit never amends and never rewrites an earlier commit.
- Rules:
  - The execution commits the changes of the task work; a revision is a new commit. `worker-service.md:301`, `:306`.
  - The execution never rewrites a commit that it pushed or that a record names. `worker-service.md:296`.
  - A local git operation runs in the workspace and passes through no connector. `worker-service.md:59`.
  - Every commit is attributable to its task and its attempt. `worker-service.md:297`. Gap: the carrier of that attribution is an epic decision (`worker-service.impl.md:441–444`); the plan uses the plain message of step 2, and the author and committer identity come from the git configuration of the host.
  - A comparison against a fixed string uses a named constant. `architecture.impl.md:15–19`.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.3 Declare the method clients and the execution run

- Files: `src/worker/method-clients.ts` (create), `src/worker/execution-run.ts` (create), `src/worker/execution-run.test.ts` (create)
- Do:
  1. In `src/worker/method-clients.ts`, declare `MethodClients` with the signature of "Provides", through `import type` of `missionOperations`, `schedulerOperations` and `workerOperations` from their `contract.ts` and `ServiceClient` from `src/kernel/operation.ts`.
  2. In `src/worker/execution-run.ts`, declare the closed set `EndReason = { Revoked: "revoked", OperationFailed: "operation_failed", JudgementInvalid: "judgement_invalid", ReportAbsent: "report_absent", ActionUnsettled: "action_unsettled", AssessmentAbsent: "assessment_absent" }` and `ExecutionEnd` of "Provides".
  3. Export `isExecutionEnd(result)`: true for a `Failure` with status 403 and code `gateway.invocation.execution_proof_failed`, or status 409 and code `scheduler.execution.not_running`. Declare both codes as named constants.
  4. Export `class ExecutionStop extends Error` with `reason: EndReason` and `code: string | null`.
  5. Export `class ExecutionRun`. The constructor takes `{ claim, clients, credentials, context }` and holds one `CancellationContext` child of `context`. `context()` answers the `ExecutionContext` body fields `{ executionId, attempt, nodeRevision: pinnedRevision }`. `onStop(listener)` registers a listener. `call(invoke)` awaits `invoke({ context, idempotencyKey })` with a new `ulid()` for each call; a `Completed` result answers `data`; a result that `isExecutionEnd` accepts stops the run with `revoked`; every other `Failure` and an `Indeterminate` result stop the run with `operation_failed` and the error code or null. A stop cancels the child context, calls every listener once and throws `ExecutionStop`. A call after a stop throws the same `ExecutionStop` and invokes nothing.
  6. `settleCredentials()` awaits `credentials.release()` once; a second call does nothing. A rejection stops the run with `operation_failed`.
  7. Add tests with fake clients: a `Completed` read answers its data; each proof code stops the run with `revoked` and calls the listeners once; a 500 stops it with `operation_failed` and the code; an `Indeterminate` result stops it with a null code; a call after a stop invokes nothing; each mutation carries a canonical ULID key; `settleCredentials` reports once.
- Rules:
  - The `worker` application invokes the operations of the server through the `contract.ts` of their owners, and every server call goes through the HTTP adapter. `architecture.impl.md:765`; `src/gateway/client.ts:82`. A service imports a peer `contract.ts` and the kernel, never `src/gateway/client.ts` (`eslint.config.js:67–75`), so plan 09 builds the clients with `httpClient` and passes them.
  - An execution at the `worker` placement learns of the end from its first refused call and aborts then; after a revocation or a loss it dispatches nothing. `worker-service.impl.md:461–462`; `worker-service.md:265`.
  - A failed chain proof answers 403 `gateway.invocation.execution_proof_failed`; a failed in-transaction proof answers 409 `scheduler.execution.not_running`. `architecture.impl.md:655`; `docs/reference/erd/02-execution.md:216`.
  - A mutation carries an idempotency key, and the key is a canonical ULID. `architecture.impl.md:711`; `src/gateway/idempotency.ts:66–71`.
  - The application reports the credential once at the release, which requires a live execution. `worker-service.impl.md:298`; plan 05 tasks 05.3, 05.8.
  - Gap: a failure that is not a revocation or a loss ends the execution with no release, and the deadline settles the loss; the disposition of an execution that cannot progress stays B9 (`docs/brainstorm/HANDOFF.md:91`; decision D25).
  - Every closed value set is an enum in code. Root `AGENTS.md` "Database design".
- Done when: `pnpm run verify` passes; the tests pass.

### 08.4 Add the release and the submissions of the run

- Files: `src/worker/execution-run.ts`, `src/worker/execution-run.test.ts` (both edit)
- Do:
  1. `submitEvidence(nodeId, body)` calls `mission["evidence.submit"]({ params: { nodeId }, query: {}, body: { ...context(), ...body } }, options)` and answers `evidence`.
  2. `submitAssessment(nodeId, body)` calls `settleCredentials()` first, then `mission["assessment.submit"]` with the context fields, and answers `{ assessment, node, outcome }`.
  3. `requestActions()` calls `worker["action.request"]({ params: { executionId }, query: {}, body: null }, options)` and answers `items`.
  4. `release(furtherWork)` calls `settleCredentials()`, then `scheduler.executionRelease({ params: { executionId }, query: {}, body: { furtherWork } }, options)`. An `Indeterminate` answer reads `scheduler.claimGet({ params: { executionId }, query: {}, body: null })`: `claimState: "finished"` answers the release; every other answer stops the run with `operation_failed`. The call answers `{ kind: "released", furtherWork }`.
  5. Add tests: the evidence body carries the three context fields and nothing that the caller named; the assessment reports the credential before the submission; a lost release answer followed by a `finished` claim answers the release; a lost answer followed by `running` stops the run; a release refused with 409 `mission.release.obligation_unmet` stops the run with `operation_failed` and that code.
- Rules:
  - `ExecutionContext` holds `executionId`, `attempt` and `nodeRevision`, and every value equals the live claim. `engine/docs/cli/mission.md:717`.
  - The release body holds `furtherWork` alone and answers `{ executionId, endedAt }`. `engine/docs/cli/scheduler.md:371–375`, `:401–403`.
  - After a lost release answer, the worker reads `claim get`, which shows `finished`; no release receipt exists. `docs/reference/erd/02-execution.md:218`; `engine/docs/cli/scheduler.md:405–407`.
  - A current passing assessment on a node with no required external action and a current assessment that does not pass end the claim, so the credential report precedes the assessment. `docs/reference/erd/02-execution.md:221`; `worker-service.impl.md:298`.
  - The operation `worker.action.request` takes the execution identity alone. `worker-service.md:447–448`; plan 06 task 06.12.
  - A refusal of the release predicate changes nothing, and the execution stays `running`. `mission-service.impl.md:254`. Gap: the execution code satisfies the predicate before the release (`mission-service.impl.md:255`); a refusal ends the execution with no release (decision D25).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.5 Add the judgement and the instructions of the agent

- Files: `src/worker/judgement.ts` (create), `src/worker/judgement.test.ts` (create)
- Do:
  1. Declare `JUDGEMENT_MARKER = "kanthord-judgement:"`, `taskJudgementSchema = z.strictObject({ criterionMet: z.boolean(), rationale: z.string().trim().min(1) })` and `evaluationJudgementSchema = z.strictObject({ result: z.enum(AssessmentResult), rationale: z.string().trim().min(1) })`, where `AssessmentResult` is the inline closed set `success`, `criterion-not-met`, `undetermined`.
  2. Export `parseJudgement(text: string | undefined, schema)`: take the last line of `text` that starts with `JUDGEMENT_MARKER`, parse the rest as JSON and with `schema`; answer the value or null.
  3. Export the instruction texts: `taskJudgementInstruction(task)`; `taskRevisionInstruction(verification, commands)`, which names each result and the first failed or unrun command; `criterionRevisionInstruction(rationale)`; `evaluationInstruction(input: { tasks; testedInput; evidence })`, which asks for one result over the criterion of the node, the criterion of each current task and the default standard; `reportInstruction(objectives, outcomes, evidence)`. Each judgement instruction ends with the exact answer form `kanthord-judgement: {…}`.
  4. Export `failedVerificationRationale(verification, commands)`: for the first result with an `exitCode` other than 0, "Verification <n> `<command>` failed with exit code <code>.", "… was ended by signal <signal>." or "… reached its deadline."; for a short run with every result 0, "Verification <n> `<command>` was not run.".
  5. Add tests: a last marker line wins over an earlier one; a missing marker, invalid JSON, an unknown key and a blank rationale answer null; each rationale form names the verification and its command; an instruction names every task criterion; no instruction names a value of the effective configuration.
- Rules:
  - The agent judges the result against the criterion only after every verification passes; a task is complete when its verifications pass and the agent judges its criterion met. `worker-service.md:307–308`.
  - The judgement gives `success`, `criterion-not-met` or `undetermined`; a default-standard violation turns `success` into `criterion-not-met`; the rationale of an objective names each current task whose criterion is unmet. `mission-service.impl.md:213–223`.
  - A failed or unrun verification gives `criterion-not-met` without a judgement, and the required rationale names that verification. `mission-service.impl.md:215–216`; `worker-service.md:511–512`.
  - A layer names no value of the effective configuration. `worker-service.md:142–144`.
  - Gap: the typed handoff of the agent is the next-phase protocol (`docs/brainstorm/HANDOFF.md:58`). Until it lands, the marker line of the last assistant text carries the judgement, and a missing or malformed line is an invalid handoff that ends the execution with no release (decision D25). The marker, the schemas and the instruction texts are plan text that no page names; the report lists them for Ulrich.
  - A comparison against a fixed string uses a named constant. `architecture.impl.md:15–19`.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.6 Add the reads of the claimed node

- Files: `src/worker/node-reads.ts` (create), `src/worker/node-reads.test.ts` (create)
- Do:
  1. Export `readAllPages(run, read)`: call `read(cursor)` through `run.call` from a null cursor until `nextCursor` is null, and concatenate `items`. Bound the loop by `READ_PAGE_LIMIT = 1000` pages; a longer chain stops the run with `operation_failed`.
  2. Export `readPinnedRevision(run)` over `execution.pinnedRevision.get`, and `nodeKindOf(revision)`: `objective` when `tasks` is present, else `initiative`.
  3. Export `readAttemptEvidence(run)` over `execution.evidence.list`; `readObjectives(run)` over the three objective lists, answering `{ objectives, outcomes, evidence }`; `readClearedOutcome(run)` over `execution.clearedOutcome.get`, called only for an attempt of 2 or more.
  4. Export `TERMINAL_STATES = ["Completed", "Discarded"]` and `allTerminal(objectives)`.
  5. Add tests with fake clients: two pages concatenate in order; a revision with `tasks: []` is an objective and one without `tasks` is an initiative; attempt 1 reads no cleared outcome; attempt 2 reads it; an objective in `Blocked` is not terminal.
- Rules:
  - The execution reads the node revision that its attempt pins; after an unblock it performs the unblock reads. `worker-service.md:271–272`; `mission-service.md:766–768`.
  - The pinned-revision read answers `Revision` with the tasks and the complete content; `tasks` is present for objectives only. `engine/docs/cli/mission.md:535`, `:804`.
  - The cleared-attempt read answers 404 when no unblock opened the claimed attempt, and an attempt of 2 or more always opens by an unblock. `engine/docs/cli/mission.md:542`; plan 04 task 04.17.
  - `Completed` and `Discarded` are the two terminal states. `mission-service.md:437`.
  - A list pages by `nextCursor`. `engine/docs/cli/mission.md:798`.
  - Gap: the next execution after an unblock fetches the external content through `intake.action.read` (`mission-service.md:773`); at the `worker` placement that read is an MCP tool, which is out of scope (decision D5).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.7 Add the start check of the steps method on an objective

- Files: `src/worker/steps-objective.ts` (create), `src/worker/steps-objective.test.ts` (create)
- Do:
  1. Export `prepareStepsWorkspace(input, run)`: `repository = setup.repositories[0]`; `workspaces.prepareObjective({ objectiveId: claim.nodeId, repository, transport, context, deadlineMs })` answers `{ directory, head, nodeBranch }`.
  2. Export `startCheck(state)`: for each task of `revision.tasks` in list order, run `runVerifications({ directory, commands: task.content.verifications, testedInput: { kind: "repository", bindingId, commit: head }, deadline: budget.wallDeadline(), context })`, then `discardChanges`. A passing run is followed by `agent.instruct(work(task), taskJudgementInstruction(task))` and `parseJudgement(agent.lastText(), taskJudgementSchema)`; `criterionMet: true` marks the task complete. A failed run marks the task pending with no agent call. A null judgement stops the run with `judgement_invalid`.
  3. `work(task)` is `renderWorkPrompt({ nodeId: task.id, revision: claim.pinnedRevision, content: task.content })`.
  4. Add tests with a local bare repository and the scripted provider: a task whose verification fails at the head is pending and makes no agent call; a passing task with a scripted `criterionMet: true` is complete; a passing task with `false` is pending; the discard removes the changes of the run; the order is the list order.
- Rules:
  - The workspace of an objective is a checkout of the repository that the pinned revision names, on the node branch, keyed by the objective and the repository binding, and brought to the head of the node branch at the repository. `worker-service.md:277–280`; plan 07 task 07.14.
  - At its start the execution runs the verifications of each task against the head of the node branch; a task whose verifications pass and whose criterion the agent judges met is complete; no record of an earlier execution decides it. `worker-service.md:311–314`.
  - The steps method chooses the order of the tasks; this plan takes the list order of the pinned revision. `worker-service.md:300`.
  - The execution code runs the verifications and discards every change that they make. `worker-service.md:303–304`.
  - Each item runs under `min(createdAt + wallTimeMs, expiredAt)`. Plan 07 task 07.11; `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 07" Q2.
  - Gap: the quiescence check before a workspace reuse stays B9 W5 (`worker-service.impl.md:464`); the hold of plan 07 is in-process only.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.8 Add the task loop

- Files: `src/worker/steps-objective.ts`, `src/worker/steps-objective.test.ts` (both edit)
- Do:
  1. Export `runTask(state, task): Promise<TaskResult>`, with `TaskResult = { kind: "complete" } | { kind: "budget_end"; boundary: "in_progress" | "run_failed" | "run_passed" }`.
  2. Loop: send the work to the agent — `agent.prompt(work(task))` the first time, then the revision instruction of the previous step. When `budget.exhausted()` holds after the agent returns, answer `budget_end` with `in_progress`. Otherwise call `commitWork(directory, taskCommitMessage(task.id, claim.attempt), agentContext, …)`; run the verifications of the task against the head; call `discardChanges`.
  3. A run that fails or leaves an item unrun: when `budget.exhausted()` holds, answer `budget_end` with `run_failed`; else send `taskRevisionInstruction(verification, commands)` and loop.
  4. A passing run: `agent.instruct(work(task), taskJudgementInstruction(task))`. When the budget ended during the judgement, answer `budget_end` with `run_passed`. A null judgement stops the run with `judgement_invalid`. `criterionMet: true` answers `complete`; `false` sends `criterionRevisionInstruction(rationale)` and loops.
  5. Add tests with the scripted provider: a task that passes on the first commit answers `complete` with one task commit; a failed run leads to a revision, a second commit and a second run, and the second commit is the task commit; a judgement `false` leads to a revision; a budget of 1 turn that ends during the task work answers `in_progress` and makes no commit; a budget that ends at a failed run answers `run_failed`; a verification that the deadline cuts records `timedOut: true` and answers `run_failed`; the discard keeps the task commit and removes every change of the run.
- Rules:
  - For each task the agent performs the steps and the execution commits the changes of the task work; the task commit is the head after the last commit of the task work. `worker-service.md:301–302`; `worker-service.vocabulary.md:320–324`.
  - The execution code runs the verifications against the task commit and discards their changes; a failed verification leads the agent to revise within the budget; a revision is a new commit, verified again. `worker-service.md:303–306`; `worker-service.impl.md:350`.
  - The agent judges only after every verification passes. `worker-service.md:307–308`.
  - The execution enforces the turn budget on pi turn events and aborts the agent when either budget ends. `worker-service.impl.md:466`; plan 07 task 07.10.
  - The boundary of debate Q1, ruled on `worker-service.md:318–320`: work that the budget ends before its task commit is task work in progress; a task commit whose run failed or left an item unrun, with no later task work, is a failed or unrun verification at the end of the budget. `worker-service.md:318–320`; `worker-service.vocabulary.md:326–330`.
  - The execution writes no evidence, no assessment and no outcome for a task. `worker-service.md:309`.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.9 Add the end of the steps method on an objective

- Files: `src/worker/steps-objective.ts`, `src/worker/steps-objective.test.ts` (both edit)
- Do:
  1. Export `runStepsObjective(input, run, agent)`: `prepareStepsWorkspace`, `startCheck`, then `runTask` for each pending task in list order until a `budget_end` answer or the last task.
  2. Every task complete, or a `budget_end` with `run_failed`: `transport.pushNodeBranch(directory, nodeBranch, cleanup, …)`; `head = headCommit(directory, …)`; `run.submitEvidence(nodeId, { subject: HEAD_COMMIT_SUBJECT, assets: [{ kind: "repository", address: { kind: "repository", bindingId, commit: head } }] })`; `run.release(false)`.
  3. A `budget_end` with `in_progress` or `run_passed`: `agent.abort()`; `commitWork(directory, checkpointCommitMessage(task.id, claim.attempt), cleanup, …)`; the push; `run.release(true)`. No evidence.
  4. `cleanup = budget.cleanupContext(input.context)` bounds every command after the agent stops; its deadline is `expiredAt`.
  5. In `finally`, `workspaces.release(objectiveKey, "objective")`, which keeps and touches the directory.
  6. A thrown `repository.connector.git_failed` or a failed `commitWork` stops the run with `operation_failed` and its code, before any release.
  7. Add tests with a local bare repository, the scripted provider and fake clients: an objective with one task pushes the node branch, submits the head commit and releases with `furtherWork: false`, and the evidence commit equals the remote ref; an objective with no task submits the head commit with no agent call; a budget end in progress writes one checkpoint commit, pushes it and releases with `furtherWork: true` with no evidence; a budget end at a failed run submits the head and releases with `false`; the push precedes every release; a cleanup command runs after the wall deadline and before `expiredAt`; a rejected push performs no release.
- Rules:
  - The execution uses the node-branch push before every release. `worker-service.md:298`.
  - Before every release with no further work, the execution submits the head commit of the node branch as the evidence of the objective, whatever the task results establish. `worker-service.md:316`.
  - Every task complete releases with no further work; a failed or unrun verification at the budget end ends the task work and releases with no further work; otherwise the execution code writes the checkpoint commit, pushes and releases with further work. `worker-service.md:317–320`; `worker-service.impl.md:361`, `:479`; debate Q1, ruled on `worker-service.md:318–320`.
  - Every cleanup command, the push included, is bounded by `expired_at`, not by the remaining budget. `worker-service.md:321`; `worker-service.impl.md:469`.
  - A checkpoint commit establishes no completion and no verification result. `worker-service.md:322`.
  - A steps release with no further work requires a published evidence of the releasing execution with one `repository` asset of the pinned repository binding; a release with further work checks no record. `mission-service.impl.md:251–252`.
  - The steps workspace of an objective is retained 7 days after its last execution. `worker-service.impl.md:361`; plan 07 task 07.13.
  - An objective with no task holds no task to execute, so the page gives the release with no further work after the head-commit evidence. `worker-service.md:317`.
  - Gap: a commit or push failure ends the agent, the execution performs no release, and the deadline settles the loss (`worker-service.impl.md:246`; decision D25; `docs/brainstorm/HANDOFF.md:91`).
  - Gap: the bound on repeated releases with further work stays B9 (`docs/brainstorm/HANDOFF.md:99`).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.10 Add the steps method on an initiative

- Files: `src/worker/steps-initiative.ts` (create), `src/worker/steps-initiative.test.ts` (create)
- Do:
  1. Export `runStepsInitiative(input, run, agent)`: `workspaces.prepareExecution({ executionId })`; `readObjectives(run)`. When `allTerminal` fails, answer `run.release(true)` with no agent call.
  2. `work = renderWorkPrompt({ nodeId, revision: claim.pinnedRevision, content: revision.content })`; `agent.instruct(work, reportInstruction(objectives, outcomes, evidence))`. When the budget ended, answer `run.release(true)`.
  3. `report = agent.lastText()`. An absent or blank report stops the run with `report_absent`.
  4. Read `readObjectives(run)` again. When `allTerminal` fails, answer `run.release(true)` with no evidence.
  5. `run.submitEvidence(nodeId, { subject: REPORT_SUBJECT, assets: [{ kind: "produced", content: { mediaType: REPORT_MEDIA_TYPE, encoding: "base64", data: Buffer.from(report, "utf8").toString("base64") } }] })` with `REPORT_MEDIA_TYPE = "text/markdown"`, then `run.release(false)`.
  6. In `finally`, `workspaces.release(executionKey, "execution")`.
  7. Add tests with fake clients and the scripted provider: every objective terminal gives one produced evidence of the report and a release with `false`; an objective in `Available` at the start releases with `true` and calls no agent; an objective added during the report releases with `true` and submits no evidence; a blank report ends the execution with no release; the workspace holds no checkout and is removed.
- Rules:
  - The steps method on an initiative reads the current objectives; every objective terminal lets the agent write a report on the outcome of each objective, the execution submits it as produced evidence and releases with no further work; a graph change that adds a nonterminal objective releases with further work. `worker-service.md:378–381`.
  - The agent reads the outcome and the evidence set of each objective. `worker-service.md:395`; `engine/docs/cli/mission.md:543–545`.
  - A steps release with no further work on an initiative requires one `produced` asset of the releasing execution. `mission-service.impl.md:251`.
  - The workspace of the steps method on an initiative holds no checkout and is removed at the release. `worker-service.md:283`; plan 07 debate Q5.
  - A resource limit reaches the Mission Service as a release, and after the agent stops at the budget end the execution releases with further work. `worker-service.md:408`; `worker-service.impl.md:468`.
  - Inline content holds at most 5 MiB decoded. `mission-service.impl.md:260`.
  - Gap: an absent report is an invalid handoff (`docs/brainstorm/HANDOFF.md:58`); the execution performs no release (decision D25).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.11 Add the tested input and the workspace of the evaluation

- Files: `src/worker/evaluation-input.ts` (create), `src/worker/evaluation-input.test.ts` (create)
- Do:
  1. Export `snapshotOf(evidence, bindingId)`: the evidence of the greatest `id` with no `verification`, no `requirementKey` and one `repository` asset of `bindingId`; answer `{ evidenceId, commit }` or null.
  2. Export `placedOf(evidence)`: the evidence of the greatest `id` with no `verification` and no `requirementKey` that holds a `produced` or an `object` asset; answer its first such asset and its `evidenceId`, or null.
  3. Export `prepareEvaluation(input, run, kind, evidence)`:
     - Objective with a snapshot: `workspaces.prepareSnapshot({ executionId, repository: setup.repositories[0], commit, transport, … })`; `testedInput = { kind: "repository", bindingId, commit }`; `evidenceIds = [snapshot.evidenceId]`.
     - Initiative: `workspaces.prepareInitiative({ executionId, repositories: setup.repositories, transport, … })`; its `testedInput` when not null.
     - Otherwise the evidence-placement rule: `prepareExecution`; read the placed asset through `execution.evidence.asset.content.get`; write the decoded bytes of an inline answer, or the body of the GET of an object answer, to `join(directory, assetId)` with mode `0600`; `testedInput` is the `address` of the asset. No placed asset stops the run with `operation_failed`.
  4. Export `verificationCommands(revision)`: the verifications of the node, then those of each task of `revision.tasks` in list order.
  5. Add tests: the newest head-commit evidence wins; a request evidence and a verification evidence are no snapshot; an initiative of two bindings answers two commits; an initiative with no repository places the produced report and answers its produced address; an objective with no repository evidence uses the placement rule; the commands of an objective with two tasks list the objective first; the object GET URL never reaches a returned value.
- Rules:
  - For an objective the reviewer makes a clean isolated checkout of the repository snapshot that the evidence names, through the Repository component, in a fresh workspace. `worker-service.md:498–499`, `:282`.
  - For an initiative the reviewer checks out the head of the base branch of each distinct binding of its current objectives, discarded objectives included, under a directory named after that binding; the tested input names every commit. `worker-service.md:500–504`; plan 07 task 07.14.
  - With no repository, and for an objective whose evidence names no snapshot, the reviewer places the produced evidence of the attempt in its workspace. `worker-service.md:505–507`; `engine/docs/cli/mission.md:742–743`.
  - The reviewer runs the verifications of the objective and of each current task of the pinned revision. `worker-service.md:497`; `mission-service.impl.md:197`.
  - The reader's component keeps the GET URL outside the agent context. `engine/docs/cli/mission.md:539`.
  - The file name of a placed asset is its asset identity. Plan text that no page names; the report lists it for Ulrich.
  - A directory under the root holds mode `0700`. `worker-service.impl.md:360`.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.12 Add the verification and the assessment of the evaluation

- Files: `src/worker/evaluation.ts` (create), `src/worker/evaluation.test.ts` (create)
- Do:
  1. Export `runEvaluation(input, run, openAgent)`: `readPinnedRevision`; `readAttemptEvidence`; `prepareEvaluation`; `commands = verificationCommands(revision)`; `verification = runVerifications({ directory, commands, testedInput, deadline: budget.wallDeadline(), context })`.
  2. `run.submitEvidence(nodeId, { subject: VERIFICATION_SUBJECT, assets: [{ kind: "produced", content: { mediaType: "application/json", encoding: "base64", data: base64(canonicalJSON(verification.results)) } }], verification })` answers `verificationEvidenceId`.
  3. `evidenceIds = [verificationEvidenceId, ...placedIds]`. For an initiative, `childOutcomeIds` is the identity of each outcome of `readObjectives(run).outcomes`; for an objective it is `[]`.
  4. A run that `verificationPassed` refuses: `result: "criterion-not-met"`, `rationale: failedVerificationRationale(verification, commands)`, and no agent opens.
  5. A passing run: `agent = await openAgent()`; `agent.instruct(work, evaluationInstruction(…))`; `parseJudgement(agent.lastText(), evaluationJudgementSchema)`. A null judgement stops the run with `judgement_invalid`; a budget end before the judgement stops the run with `assessment_absent`.
  6. `answer = run.submitAssessment(nodeId, { evidenceIds, childOutcomeIds, result, rationale, testedInput })`. A non-null `answer.outcome` answers `{ kind: "closed", outcomeId }`.
  7. In `finally`, `workspaces.release(executionKey, "execution")`.
  8. Add tests with fake clients and the scripted provider: a failed item submits the verification evidence and a `criterion-not-met` assessment whose rationale names the command, with no model call; a passing run on an objective with a scripted `success` submits both identities and an empty child set; an initiative names the child outcomes; a malformed judgement submits no assessment and performs no release; the workspace is removed in each case; the system prompt of the agent holds no workspace `AGENTS.md`.
- Rules:
  - The reviewer execution code runs the verifications from the workspace root and records the results as an evidence with a `verification`, bound to the tested input and the pinned revision; the assessment names that evidence. `worker-service.md:508–510`.
  - A failed or unrun verification causes an assessment that does not pass, without a judgement; its rationale names that verification. `worker-service.md:511–512`; `engine/docs/cli/mission.md:761–762`.
  - Only after every verification passes does the agent judge; the reviewer of an objective judges each task criterion. `worker-service.md:513`, `:497`.
  - A success names exactly one evidence with a passing `verification` whose `results` cover the objective and each current task; `childOutcomeIds` of an initiative names the current outcome of each current objective. `mission-service.impl.md:196–197`, `:228`.
  - An assessment names the tested input of the verification that it names. `mission-service.md:519`; plan 04 task 04.10.
  - A current assessment on a node with no required external action closes the attempt and ends the claim; nothing more follows. `worker-service.md:519`; `docs/reference/erd/02-execution.md:221`.
  - The evaluation workspace is removed at the release. `worker-service.impl.md:359`.
  - The composer of the evaluation method reads no agent file of the workspace. `worker-service.impl.md:262`; plan 07 task 07.5.
  - Gap: an evaluation that ends with no assessment is B9 W7 and the outcome without assessment (`docs/brainstorm/HANDOFF.md:98`, `:123`); the execution performs no release.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.13 Add the action request and the reviewer release

- Files: `src/worker/evaluation.ts`, `src/worker/evaluation.test.ts` (both edit)
- Do:
  1. Export `ACCEPTED_ITEM_KINDS = ["submitted", "awaiting-prerequisite"]` and `requestAndRelease(run)`: `items = run.requestActions()`; when every item holds a kind of `ACCEPTED_ITEM_KINDS`, answer `run.release(false)`; otherwise stop the run with `action_unsettled`.
  2. In `runEvaluation`, a null `answer.outcome` with `answer.assessment.result` `success` calls `requestAndRelease(run)`. A null outcome with another result stops the run with `operation_failed`.
  3. Add tests with fake clients: a `submitted` item releases with `false`; an empty item list releases with `false`; a `failed-before-effect` item and an `uncertain` item perform no release; a 409 `worker.action_performer.assessment_not_current` stops the run with `operation_failed` and that code; the performer call carries the execution identity alone.
- Rules:
  - When the node requires an external action, the reviewer execution invokes the action performer after a current passing assessment stands. `worker-service.md:520`.
  - The reviewer execution releases after its requests when the return holds only submitted request evidence and actions that await a prerequisite. `worker-service.md:547`; `engine/docs/cli/scheduler.md:387–390`.
  - A reviewer release requires a current passing assessment and no eligible unrequested action; it routes `Evaluating -> External.Requested`. `mission-service.impl.md:253`; `mission-service.md:584`.
  - The evaluation method at the `worker` placement reaches the performer through `worker.action.request`. Plan 06 task 06.12; decision D5.
  - Gap: the page states no release rule for a failure or an uncertainty (`worker-service.md:465`); B9 A3, W1, W4 and PR2 own it (`docs/brainstorm/HANDOFF.md:119`), and the claim waits for its deadline.
  - Gap: a passing assessment that is not current writes no outcome; its recovery stays B9 B2 (`docs/brainstorm/HANDOFF.md:103`).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.14 Add the abort on a revocation or a loss

- Files: `src/worker/native-method.ts` (create), `src/worker/native-method.test.ts` (create)
- Do:
  1. Implement `stopOnEnd(run, agent)`: `run.onStop(() => void agent.abort())`, registered before the first prompt of the agent.
  2. Every method catches `ExecutionStop` at its top, performs no further server call and answers `{ kind: "ended", reason, code }`. The `finally` of the method keeps its workspace disposition: an objective key keeps and touches its directory, an execution key is removed.
  3. Add tests with fake clients: a revocation that answers 409 `scheduler.execution.not_running` at the task-commit evidence aborts nothing more and performs no release; a 403 `gateway.invocation.execution_proof_failed` at the verification evidence of an evaluation opens no agent and submits no assessment; a refused call while the agent runs aborts the agent at once; after a stop no client method is called again.
- Rules:
  - A revoked or lost execution stops its agent and performs no further operation under its execution identity. `worker-service.md:265`, `:433–437`.
  - An execution at the `worker` placement learns of the end from its first refused call and aborts then; it dispatches nothing after. `worker-service.impl.md:461–462`.
  - A human pause, a human discard and a success override reach the execution as a revocation. `worker-service.md:407`.
  - Gap: abort does not prove that every descendant process stops, and the stop behaviour after a revocation, the workspace disposition included, stays B9 W5 (`worker-service.impl.md:463`; `docs/brainstorm/HANDOFF.md:122`).
  - Gap: an execution that makes no server call during a long agent run learns of a revocation only at its next call; the page names no other channel at the `worker` placement (`worker-service.impl.md:460–461`).
- Done when: `pnpm run verify` passes; the tests pass.

### 08.15 Add the transcript telemetry as a no-op record

- Files: `src/worker/transcript.ts` (create), `src/worker/transcript.test.ts` (create), `src/worker/native-method.ts` (edit)
- Do:
  1. Declare `TranscriptSink` of "Provides" and export `noTranscript = { record() {} }`.
  2. In `native-method.ts`, before `agent.dispose()`, call `transcript.record({ executionId, attempt, traceId, messages: agent.transcript() })` once, also after a stop.
  3. Add tests: the sink receives the execution identity, the attempt, the trace identity and every session message once; a method with no agent records nothing; no entry holds the handover payload or the refresh report.
- Rules:
  - The pi session entries become the transcript telemetry with the execution identity, the attempt and the trace identity; the handover and the report enter no transcript. `worker-service.impl.md:478–480`.
  - The first phase ships a no-op implementation of the interface of the Tracking Service; ERD 4 stores the telemetry. `tracking-service.impl.md:18–19`; `00-index.md` "Scope", out-of-scope boundary.
  - Gap: the redaction of secrets in a transcript is ERD 4 work; the no-op record stores nothing.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.16 Add the method entry

- Files: `src/worker/native-method.ts`, `src/worker/native-method.test.ts`, `src/worker/index.ts`, `engine/AGENTS.md` (all edit)
- Do:
  1. Export `runNativeExecution(input)`. `declaration = getWorkerDeclaration(setup.workerName)`; `run = new ExecutionRun(…)`; `revision = readPinnedRevision(run)`; `kind = nodeKindOf(revision)`.
  2. `openAgent()` calls `openNativeAgent({ setup, claim, nodeKind: kind, method: declaration.method, credentials: credentials.store, handoverItem, workspace, hostHome, modelRuntimeFactory, hostTools, context: run.context })` (plan 07 task 07.17), then `stopOnEnd`.
  3. Dispatch: `steps` and `objective` → `runStepsObjective`; `steps` and `initiative` → `runStepsInitiative`; `evaluation` → `runEvaluation` on every evaluation claim. A declaration with no `method` stops with `operation_failed`.
  4. In `finally`, record the transcript and dispose the agent when one opened.
  5. Export `runNativeExecution`, `MethodClients`, `isExecutionEnd`, `ExecutionEnd`, `EndReason`, `TranscriptSink` and `noTranscript` from `src/worker/index.ts`.
  6. In `engine/AGENTS.md` "Project structure", add one line for each new module of `src/worker/` of this plan.
  7. Add tests with fake clients: `general@1` on an objective and on an initiative and `reviewer@1` reach their method; an evaluation claim whose attempt holds a request evidence with `endState: "expected"` still performs the evaluation; the answer of each path is its `ExecutionEnd`.
- Rules:
  - `general@1` holds the steps method and `reviewer@1` the evaluation method. `src/worker/catalog.ts:48–65`; `mission-service.md:340`.
  - A reviewer execution that claims from `Waiting` performs the evaluation. `worker-service.md:517`.
  - Debate Q2, ruled on `mission-service.impl.md:83`: no claim answer and no execution-scoped read carries the claim source, and the Project Service refuses `follows.type = "action_end_state"` in a binding write (plan 06 task 06.14), so every evaluation claim comes from `Waiting` and step 3 performs the evaluation on each. Gap: the continuation claim that performs no evaluation (`worker-service.md:518`) waits for a retry-safe claim-source contract.
  - Each execution starts with a fresh agent context, and the context ends with the execution. `worker-service.md:822`.
  - The method receives its dependencies from plan 09 and reads no server configuration. `worker-service.impl.md:230–232`.
  - Each plan updates the entry of its directory in `engine/AGENTS.md`. `00-index.md` "Shared files", row `AGENTS.md`.
- Done when: `pnpm run verify` passes; the tests pass.

### 08.E E2E proof

- Files: `src/apps/server/e2e-native-methods.test.ts` (create)
- Do:
  1. Create `actions = scriptedActions()`. Start `gatewayFixture` with the ERD 1 fixture repository connector that answers the `git ls-remote` of a binding write and `standIns: { intakeActions: actions.seam }`.
  2. Run the setup steps of the `## E2E` section through the CLI.
  3. Create two local bare repositories with a `main` commit, one for `git@github.com:owner/repo.git` and one for `git@github.com:owner/gated.git`. Build the test `RepositoryTransport` from `RepositoryComponent` with each address replaced by its bare path (decision D15). Point `GIT_CONFIG_GLOBAL` of the test process to a temporary file with `user.name` and `user.email`.
  4. For each execution row, act as plan 09 does: pull through the CLI; take the envelope of `worker.handover`, open it and build the store with `executionCredentialStore` and a report callback over `worker.credential`; read `worker.execution.setup.get`; build `MethodClients` with `httpClient(missionOperations | schedulerOperations | workerOperations, fixture.endpoint, token)`; call `runNativeExecution` with `scriptedModelRuntime(scriptedProvider(script, { providerId: "anthropic", modelIdentifier: "claude-sonnet-4-5" }))`, a temporary host home and state directory, and `noTranscript`.
  5. Implement the rows in one test and in table order, because each row reads the state of the rows before it.
- Rules:
  - The E2E runs the methods in-process against `gatewayFixture` with the scripted fake provider and local bare repositories. Decisions D15, D16.
  - Setup goes through the CLI; the state check is a CLI read, the bare repositories or the recorded calls of a fake. ERD 1 decision D13.
  - Every fixture uses `claude-sonnet-4-5` and a complete entry form. Decision D16.
  - No test performs a real provider call or a real platform call. Decision D16; `00-index.md` "Consumed seams".
  - No test prints a secret. Plan 05 E2E rule.
  - The test imports `scriptedProvider` and `scriptedModelRuntime` through the path that plan 07 task 07.E uses; `eslint.config.js:76–89` admits no import of `src/worker/test-support.ts` from `src/apps/server/` (report).
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-native-methods.test.ts` passes every row; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-native-methods.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` with a real server on a loopback port and the fake `scriptedActions` of plan 06. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI. `H` names the human token `fixture.token`; machine tokens come from `kanthord jwt generate` in the form of `03-scheduler-execution.md` "E2E".
- Rules: a refusal asserts the exit code and the error code at the start of stderr; stdout is parsed as JSON; the method assertions read the `ExecutionEnd`, the bare repositories, the CLI reads and the calls of the fakes.

Setup, in order (each command exits 0, token H):

1. `kanthord credential create --file anthropic.json` with `{ "name": "anthro-1", "platform": "anthropic", "metadata": null, "secret": { "key": "e2e-methods-secret" } }`; the same for `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
2. `kanthord worker agent enablement put swe@1 --file enablement.json` with `{ "agentProviders": [{ "name": "default", "provider": "anthropic", "credential": "anthro-1" }], "defaultConfiguration": { "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" } }`; the same for `re@1`.
3. `kanthord project create --name methods` → `projectId`; `kanthord mission get <projectId>` → `missionId`.
4. `kanthord project binding apply <projectId> --file bindings.json` with `repo` `{ "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }`, `gated` `{ "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/gated.git", "strategy": { "baseBranch": "main", "action": { "name": "pull_request", "follows": { "type": "assessment_passed" } } }, "credential": "github" } }`, `general` `{ "kind": "worker", "config": { "worker": "general@1", "instanceCount": 1, "entries": [SWE] } }`, `lab` `{ "kind": "worker", "config": { "worker": "general@1", "instanceCount": 1, "resourceBudget": { "turns": 1, "wallTimeMs": 600000 }, "entries": [SWE] } }` and `review` `{ "kind": "worker", "config": { "worker": "reviewer@1", "instanceCount": 1, "entries": [RE] } }`, where `SWE` is `{ "agent": "swe@1", "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" }` and `RE` is the same entry with `"agent": "re@1"` → `repoBindingId`, `gatedBindingId`, `gatedResource`.
5. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Greetings", "requirement": "Say hello", "criterion": "hello.txt exists", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId`. Then `kanthord mission node create <missionId> --file <file>` for objectives A and B on `repo` and objective C on `gated`, each `{ "filename": <file name>, "kind": "objective", "parentId": <initiativeId>, "expectedParentRevision": 1, "content": { "name": "Say hello", "requirement": "Write hello.txt", "criterion": "hello.txt exists", "verifications": ["test -f hello.txt"], "bindings": [<binding>] }, … }`; then one task under each, `{ "filename": <file name>, "kind": "task", "parentId": <objective>, "expectedParentRevision": 1, "content": { "name": "Write hello", "requirement": "Write hello.txt", "criterion": "hello.txt holds hello", "verifications": ["grep -q hello hello.txt"], "bindings": [] }, … }`. Each write names the `version` of `kanthord mission get <projectId>` read just before it and the current revision of its parent → `A`, `B`, `C`, `TA`, `TB`, `TC`.
6. `kanthord mission node priority set <node-id> --file priority.json` with `{ "value": <value>, "expectedMissionVersion": <version> }`: A to 5, C to 4 and B to 3.
7. `kanthord jwt generate --project <projectId> --binding <name> --name <name>-a --config server.yaml` for `general`, `lab` and `review` → tokens G, L and R with their client secrets; `kanthord worker register` with each token.

`hello(script)` names the scripted turns: a `bash` tool call `printf hello > hello.txt`, a final text, then the judgement text `kanthord-judgement: {"criterionMet": true, "rationale": "hello.txt holds hello"}`. `review(result)` names the one scripted turn `kanthord-judgement: {"result": "success", "rationale": "hello.txt exists and holds hello; task met."}`.

| Id    | Commands                                                                                                                                                                               | Exit | Expect                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E08.1 | G: `kanthord scheduler work pull`; `runNativeExecution` with `hello`                                                                                                                   | 0, — | `execution.nodeId` = A → X; the answer is `{ kind: "released", furtherWork: false }`; `git ls-remote <repo bare> refs/heads/kanthord/<A>` answers one commit whose message names `TA` and attempt 1; `mission evidence list <A> --attempt 1` holds one evidence with one `repository` asset of `repoBindingId` at that commit; `mission node get <A>` answers `Waiting`                                             |
| E08.2 | G: `kanthord scheduler work pull`; `runNativeExecution` with `hello`                                                                                                                   | 0, — | `execution.nodeId` = C → W; the answer releases with `furtherWork: false`; the remote ref `kanthord/<C>` of the gated bare repository equals the commit of the evidence of C; `mission node get <C>` answers `Waiting`                                                                                                                                                                                              |
| E08.3 | L: `kanthord scheduler work pull`; `runNativeExecution` with a script of one `write` tool call of `notes.txt` and a second tool call                                                   | 0, — | `execution.nodeId` = B → Y; the fake records one call; the answer is `{ kind: "released", furtherWork: true }`; the remote ref `kanthord/<B>` names a checkpoint commit whose message names `TB` and attempt 1 and whose tree holds `notes.txt`; `mission evidence list <B>` is empty; `mission node get <B>` answers `Available`; `scheduler claim get <Y>` answers `finished`                                     |
| E08.4 | R: `kanthord scheduler work pull`; `runNativeExecution` with `review(success)`                                                                                                         | 0, — | `execution.nodeId` = A → Z; the answer is `{ kind: "closed" }`; `mission evidence list <A> --attempt 1` adds one evidence whose `verification.results` hold `test -f hello.txt` and `grep -q hello hello.txt`, each with `exitCode` 0, and whose `testedInput` is the commit of E08.1; `mission assessment list <A>` holds one `success`; `mission node get <A>` answers `Completed`; the workspace of Z is removed |
| E08.5 | Queue `performAnswers` `{ "kind": "pull_request", "resourceIdentity": <gatedResource>, "number": 42 }`; R: `kanthord scheduler work pull`; `runNativeExecution` with `review(success)` | 0, — | `execution.nodeId` = C → V; `actions.performCalls[0].operands` = `{ "nodeBranch": "kanthord/" + C, "baseBranch": "main", "commit": <commit of E08.2>, "reusedAddress": null }`; the answer is `{ kind: "released", furtherWork: false }`; `mission evidence list <C> --attempt 1` holds a request evidence with `requirementKey` `gated.pull_request`; `mission node get <C>` answers `External.Requested`          |

## Blockers

Two gaps went through the debate engine. Both verdicts extended a page, and Ulrich ruled them on 2026-09-30 (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 08"):

- DEBATE: the routing of a steps execution on an objective at the end of its resource budget - rounds:1 - verdict: CHANGE to A, the task-commit boundary: work that the budget ends before its task commit takes the checkpoint commit and the release with further work; a task commit whose run failed or left an item unrun, with no later task work, takes the head-commit evidence and the release with no further work; ruled on `worker-service.md:318–320` and `worker-service.impl.md:479`; the B9 repeat bound stays open.
- DEBATE: the claim source of an evaluation claim (`Waiting` or `External.Requested`) - rounds:2 - verdict: CHANGE to E, repaired: build the evaluation method and the performer path now, with no evidence heuristic, no stored claim kind and no `claimed_from`. Ruled 2026-09-30: the Project Service refuses a non-null `follows` (`mission-service.impl.md:83`; plan 06 task 06.14), so the dispatch of every evaluation claim to the evaluation stands.
