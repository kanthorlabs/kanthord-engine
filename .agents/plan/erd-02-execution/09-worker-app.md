# Plan 09: `worker` application

## Scope

This plan delivers `kanthord serve worker` as the host of one native instance at the `worker` placement (decision D8):

- The answer of `worker.register` with `resourceIdentity` and `workerName` beside `runtimeIdentity` (debate Q2 of this plan).
- The host tool source of the tool table and the host tool `evidence-upload` of `swe@1` (debate Q1 of this plan).
- The boundary change of decision D23, the server API bundle of the application and the injected `ModelRuntimeFactory` and `RepositoryTransport` of decision D15.
- The startup order: the client configuration, `clientSecret`, the host tool checks, the server package version, the workspace root, the registration and the record `Worker application ready` with `runtimeIdentity`, `resourceIdentity` and `workerName`.
- The heartbeat timer and the workspace sweep timer.
- The work-pull loop with backoff, and the registration again after an expiry.
- After a claim: the handover call with a new idempotency key after a lost answer, the decryption, the credential store with its report, the setup read, the hosted execution through the methods of plan 08 and the discard at the end of the execution.
- The evidence upload helper on the worker host and its host tool.
- The stop: the deregistration at a stop with no live execution, the exit codes and the watchdog of a settled state; `SIGHUP` reopens nothing.
- The in-process construction for the E2E (decision D15): the in-process worker helper of `src/apps/server/test-support.ts`.

Out of scope:

- The steps method and the evaluation method (plan 08). This plan calls them.
- The CLI leaf `evidence upload <node-id> <path>` (row 35 of `engine/docs/cli/mission.md:400`). It is the harness helper form, and the external-harness phase owns it (see "Blockers").
- The MCP server and the MCP tool source (decision D5).
- The `server` placement (decision D8).
- Every B9 item and every open HANDOFF item (decision D1). Decision D25 rules the `worker` application under the B9 gaps. Each task that meets one states the gap in one line.

## Sources

- `docs/brainstorm/worker-service.impl.md:154–161` — the runtime identity and the output of `worker.register`.
- `docs/brainstorm/worker-service.impl.md:163–181` — the registration heartbeat, the window, the idle backoff and the registration again after an expiry.
- `docs/brainstorm/worker-service.impl.md:199–210` — the deregistration and the 404 that ends a registration.
- `docs/brainstorm/worker-service.impl.md:230–252` — the `worker` application.
- `docs/brainstorm/worker-service.impl.md:254–277` — the execution setup, read after the handover.
- `docs/brainstorm/worker-service.impl.md:316–339` — the credential store of an execution and the credential handover.
- `docs/brainstorm/worker-service.impl.md:341–364` — evidence upload.
- `docs/brainstorm/worker-service.impl.md:366–377` — the tool table.
- `docs/brainstorm/worker-service.impl.md:397–405` — the workspace and its sweep.
- `docs/brainstorm/worker-service.impl.md:505–536` — stop and budget, and the trust boundary.
- `docs/brainstorm/worker-service.md:258–290` — executions, the workspace and the host-local upload.
- `docs/brainstorm/scheduler-service.md:115–130`, `:163–170`, `:217–247` — work pulls, the claim answer and liveness.
- `docs/brainstorm/scheduler-service.impl.md:21–77` — the operation contracts, the idempotency of a work pull by the runtime identity and the release.
- `docs/brainstorm/custody.impl.md:127–157` — the credential store of an execution, the handover and the refresh report.
- `docs/brainstorm/gateway-service.impl.md:65–79`, `:81–125`, `:186–197`, `:512–532` — the registration, the JWT claims, the client secret and the client configuration file.
- `docs/brainstorm/mission-service.impl.md:289–330` — object evidence.
- `docs/brainstorm/repository.impl.md:40–59` — the start gate of the repository connector and the SSH environment.
- `docs/brainstorm/architecture.impl.md:341–349`, `:440–473`, `:765` — the error codes, the start and stop contract, and the operations that the `worker` application invokes.
- `engine/docs/cli/other.md:473–524` — `serve worker`.
- `engine/docs/cli/other.md:750–837` — the shared error codes.
- `engine/docs/cli/worker.md:149–238`, `:318`, `:707–719` — `register`, `heartbeat`, `handover`, the tool fields of `agent get` and the error codes.
- `engine/docs/cli/scheduler.md` "work pull" — `WorkPull`, the answer and the wait window.
- `engine/docs/cli/mission.md:547–560`, "Execution submissions", "Object evidence schemas", `:781` — the host-local upload, `ExecutionContext`, `EvidenceSubmit`, `EvidenceSubmitResult`, `AssetUploadResult` and the presigned URL rule.
- `docs/brainstorm/HANDOFF.md` "B9, failure and recovery".
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 09 — the agent surface of the worker-host upload helper and the source of the ready record".
- The code: `engine/src/apps/worker/index.ts:25–179` (the ERD 1 skeleton), `engine/src/apps/worker/index.test.ts`, `engine/src/apps/cli/index.ts:104–123` (`serve worker`), `engine/src/apps/server/e2e-worker-app.test.ts:57–419` (the subprocess proof and the TTY shim of `jwt generate` at `:291–305`), `engine/src/gateway/client.ts:33–159`, `engine/src/gateway/client-result.ts:11–56`, `engine/src/kernel/operation.ts:165–191`, `engine/src/repository/index.ts:11–33`, `engine/eslint.config.js:107–119`.
- Root `AGENTS.md` "Contracts", "Database design" and "Rejected proposals".

### Contract keys

Every external key of this plan, with the line that owns it:

| Key                                                                            | Where                                                   | Owner line                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `runtimeIdentity`, `resourceIdentity`, `workerName`                            | the answer of `worker.register`; the ready record       | `worker-service.impl.md:157`, `:194`, `:240`; `engine/docs/cli/other.md:509`; `engine/docs/cli/worker.md:174–177` |
| `resourceIdentity`, `runtimeIdentity`                                          | `WorkPull`                                              | `scheduler-service.impl.md:46`                                                                                    |
| `kind`, `execution`                                                            | the work-pull answer                                    | `scheduler-service.impl.md:47`                                                                                    |
| `executionId`, `nodeId`, `attempt`, `pinnedRevision`, `expiredAt`, `createdAt` | `ExecutionRecord`                                       | `scheduler-service.impl.md:35`                                                                                    |
| `executionId`; `nonce`, `ciphertext`                                           | the bodies of `worker.handover` and `worker.credential` | `engine/docs/cli/worker.md:136`, `:234`                                                                           |
| `items`, `credentialId`, `providerId`, `credential`, `digest`                  | the handover payload and the refresh report             | plan 05 "Contract keys"; `custody.impl.md:144`, `:149`                                                            |
| `executionId`, `attempt`, `nodeRevision`                                       | `ExecutionContext`                                      | `engine/docs/cli/mission.md` "Execution submissions"                                                              |
| `subject`, `assets`, `kind`, `size`, `mediaType`, `sha256`                     | `EvidenceSubmit` with one `object` asset                | `engine/docs/cli/mission.md` "Execution submissions"; `mission-service.impl.md:297`                               |
| `evidence`, `uploads`, `assetId`, `putUrl`, `headers`, `expiresAt`             | `EvidenceSubmitResult`                                  | `engine/docs/cli/mission.md` "Object evidence schemas"                                                            |
| `assetId`, `evidenceId`, `uri`                                                 | `AssetUploadResult`; the result of `evidence-upload`    | `engine/docs/cli/mission.md` "Object evidence schemas"; `worker-service.impl.md:352`                              |
| `path`                                                                         | the argument of `evidence-upload`                       | `engine/docs/cli/mission.md:551` ("`evidence upload <path>`")                                                     |
| `name`, `source`, `inputSchema`                                                | a tool of `agent.get`                                   | `engine/docs/cli/worker.md:318`; the new value `host` under debate Q1                                             |

## Depends on

- ERD 1, merged. The skeleton of `src/apps/worker/index.ts:25–179`: client resolution, the `clientSecret` check, the version check, the JSON-line log, the 10-second watchdog and the ignored `SIGHUP`. `httpClient` and `resolveClient` (`src/gateway/client.ts:54–159`), the client result kinds (`src/kernel/operation.ts:165–184`), `RepositoryComponent` with its start gate (`src/repository/index.ts:11–17`), `directories` (`src/kernel/xdg.ts:4`), `CancellationContext` (`src/kernel/context.ts`).
- Plan 02, through `00-index.md` "Seams": `worker.register` over `worker_instance` (task 02.6), `worker.heartbeat` with the 204 answer (task 02.8), `worker.instance.deregister` (task 02.10), `WorkerService.declarationOf`.
- Plan 03, through `00-index.md` "Seams": `scheduler.work.pull` with the 90 s wait window and `{ kind: "claimed", execution } | { kind: "no-work" }` (task 03.9), the idempotency of a pull by the runtime identity, `scheduler.execution.release` (task 03.10), `scheduler.claim.get` (task 03.11), the execution proof with 403 `gateway.invocation.execution_proof_failed` and 409 `scheduler.execution.not_running`.
- Plan 04, through `00-index.md` "Seams" and its "Provides": `mission.evidence.submit` (task 04.6), `mission.evidence.asset.complete` (task 04.7), and the object sink of the tests `objectSink(t)` and `sinkStorage(sink)` in `src/apps/server/test-support.ts`.
- Plan 05, through `00-index.md` "Seams": the handover codec of `src/kernel/handover.ts` (`deriveHandoverKeys`, `handoverAad`, `sealEnvelope`, `openEnvelope`, `HandoverOpenError`); `handoverPayloadSchema` and `refreshReportSchema` from `src/custody/contract.ts`; `executionCredentialStore(payload, report)` with `store`, `release()` and `discard()`, plus `ExecutionStoreError` and `ExecutionCredentials`, from `src/custody/client.ts` under the approved Plan05 B1 boundary repair; `worker.handover` as a secret mutation and `worker.credential` with its 204 answer (task 05.8).
- Plan 06, through `00-index.md` "Seams": `worker.action.request`, which the methods of plan 08 call over the HTTP adapter.
- Plan 07, through its "Provides": `worker.execution.setup.get` and `executionSetupSchema`, `checkAgentTools`, `WorkspaceRoot` with `startSweeping` and `stopSweeping`, `ModelRuntimeFactory` and `defaultModelRuntimeFactory`, `RepositoryTransport`, `openNativeAgent` with `NativeAgentInput`, `sessionTools`, `toolDeclarations`, `ToolSource`, `loadPi`, the scripted fake provider `scriptedProvider` and `scriptedModelRuntime` of `src/worker/test-support.ts`; the exports of `src/worker/index.ts` (task 07.17).
- Plan 08, through `00-index.md` row 08 and the "Provides" of `08-native-methods.md`: `runNativeExecution(input: NativeExecutionInput): Promise<ExecutionEnd>` with `NativeExecutionInput = { claim; setup; clients: MethodClients; credentials: { store; release() }; handoverItem; transport; workspaces; hostHome; modelRuntimeFactory; transcript: TranscriptSink; context }`, `ExecutionEnd = { kind: "released" } | { kind: "closed" } | { kind: "ended"; reason: EndReason; code }`, `MethodClients`, `isExecutionEnd` and `noTranscript`. The entry selects the method of the worker, and it calls `credentials.release()` before the first write that can end the claim. `NativeExecutionInput` gains `hostTools: (workspace: string) => HostTools`; the entry evaluates it for the prepared workspace and passes the result to `openNativeAgent`. A cancelled `context` makes the entry abort its agent and answer with no release (decision D25).

## Provides

| Seam                                       | TypeScript signature                                                                                                                                                                                           | Owner file                                           | Consumer plans |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------- |
| The answer of `worker.register`            | `{ runtimeIdentity: string; resourceIdentity: string; workerName: string }`                                                                                                                                    | `src/worker/contract.ts`                             | 09, 10         |
| `ToolSource.Host`, `HostTool`, `HostTools` | `ToolSource.Host = "host"`; `HostTool = { EvidenceUpload: "evidence-upload" }`; `HostTools = { evidenceUpload(path: string, signal: AbortSignal \| undefined): Promise<UploadResult> }`                        | `src/worker/contract.ts`, `src/worker/host-tools.ts` | 08, 10         |
| `NativeAgentInput.hostTools`               | the host tools of the execution; `openNativeAgent` adds only the host tools that the agent declaration names                                                                                                   | `src/worker/native-agent.ts`                         | 08             |
| `WorkerApi`                                | `{ gateway; worker; scheduler; mission }` of `httpClient` over one endpoint and token                                                                                                                          | `src/apps/worker/api.ts`                             | 08, 10         |
| `WorkerOptions` (extended)                 | `modelRuntimeFactory?: ModelRuntimeFactory`; `repositoryTransport?: RepositoryTransport`                                                                                                                       | `src/apps/worker/index.ts`                           | 10             |
| `uploadEvidence`                           | `(input: { workspace; path; claim: ExecutionRecord; api: WorkerApi; context }) => Promise<UploadResult>`, with `UploadResult = { evidenceId: string; assetId: string; uri: string }`                           | `src/apps/worker/evidence-upload.ts`                 | 10             |
| In-process worker helper                   | `inProcessWorker(t, { endpoint, token, clientSecret, modelRuntimeFactory, repositoryTransport }): Promise<{ worker: Worker; env; logs: Record<string, unknown>[] }>`; `toolStubs(t): string` (a `PATH` prefix) | `src/apps/server/test-support.ts`                    | 10             |

Three differences from `00-index.md` "Seams":

- The answer of `worker.register` gains two fields (debate Q2, ruled on `worker-service.impl.md:157`). Plan 02 declares one field.
- The host tool source is a fourth source of the tool table (debate Q1, ruled on `worker-service.impl.md` "Tool table"). Plan 07 declares two source values.
- `WorkerApi`, `HostTools` and the in-process worker helper are new rows.

## Tasks

Execution order: implement the upload helper 09.10 before its consumer 09.9. Task 09.7 declares and tests the pull loop; wire it into the application with 09.9 so no claim can precede its host implementation. Registration answers the binding-derived worker name without storing a new column. `NativeExecutionInput.hostTools` is a factory `(workspace: string) => HostTools`, evaluated after workspace preparation; `NativeAgentInput.hostTools` remains the resulting `HostTools` object. The in-process helper additionally returns `running: Promise<Error | null>` for its one `worker.run()` invocation.

### 09.1 Answer `resourceIdentity` and `workerName` from `worker.register`

- Files: `src/worker/contract.ts`, `src/worker/registrations.ts`, `src/worker/service.ts`, `src/worker/service.test.ts`, `src/apps/server/test-support.ts`, `src/apps/server/gateway-registration.test.ts`, `src/apps/server/cli-worker.test.ts`, `src/apps/server/openapi-integration.test.ts` (all edit); `static/openapi.yaml` and `static/openapi/worker/register.yaml` (regenerated)
- Do:
  1. In `src/worker/contract.ts`, change the output of `worker.register` (plan 02 task 02.6 step 2) to `z.strictObject({ runtimeIdentity: identitySchema("worker_instance"), resourceIdentity: workerResourceIdentitySchema, workerName: z.string().min(1) })`. Add the binding-derived `workerName` to the registration answer; raw registration storage and lookup types gain no column.
  2. In `TableRegistrations.register(tx, client, now)`, answer `workerName` from the `workerBindingOf` row that the admission reads in the same transaction. For the live row of a repeated client identity, read `workerBindingOf` once in the same transaction and answer its `workerName`.
  3. In the handler, answer `{ runtimeIdentity, resourceIdentity: identity.resourceIdentity, workerName }`.
  4. Update `fakeMachines` to answer `workerName: "general@1"` beside the runtime identity.
  5. Regenerate OpenAPI with `pnpm run build && node bin/kanthord.mjs gateway openapi`. Assert the three properties of the 200 answer in `openapi-integration.test.ts`.
  6. Add tests: a registration answers the resource identity of the machine identity and the worker name of the latest row of the group; a repeated registration answers the same three values; `kanthord worker register` prints `runtimeIdentity`, `resourceIdentity`, `workerName` and `idempotencyKey`, and no token.
- Rules:
  - The answer holds the registration facts that the admission reads, never a later lookup. Debate Q2 (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 09", ruled on `worker-service.impl.md:157`).
  - The ready record holds `runtimeIdentity`, `resourceIdentity` and `workerName`. `worker-service.impl.md:240`; `engine/docs/cli/other.md:508–510`.
  - The request nominates no resource identity; the server takes it from the verified JWT. `gateway-service.impl.md:71`.
  - The answer holds no token. `gateway-service.impl.md:74`; `engine/docs/cli/worker.md:174–177`.
  - Every field name is the name of the owning vocabulary. Root `AGENTS.md` "Contracts".
- Done when: `pnpm run verify` passes; the tests pass; `static/openapi/worker/register.yaml` holds the three properties.

### 09.2 Add the host tool source and the host tool `evidence-upload`

- Files: `src/worker/catalog.ts`, `src/worker/catalog.test.ts`, `src/worker/contract.ts`, `src/worker/tool-table.ts`, `src/worker/tool-table.test.ts`, `src/worker/host-tools.ts` (create), `src/worker/host-tools.test.ts` (create), `src/worker/native-agent.ts`, `src/worker/native-agent.test.ts`, `src/worker/index.ts`, `src/worker/service.test.ts`, `src/apps/server/cli-worker.test.ts` (all edit); `static/openapi/worker/agent.get.yaml` (regenerated)
- Do:
  1. In `src/worker/contract.ts`, add `Host: "host"` to `ToolSource` (plan 07 task 07.2 step 5). Declare `HostTool = { EvidenceUpload: "evidence-upload" } as const`, `uploadResultSchema = z.strictObject({ evidenceId: identitySchema("evidence"), assetId: identitySchema("evidence_asset"), uri: z.string().startsWith("s3://") })` and `type HostTools = { evidenceUpload(path: string, signal: AbortSignal | undefined): Promise<UploadResult> }`.
  2. In `AgentDeclaration` (`src/worker/catalog.ts`), add `hostTools: readonly HostTool[]`. Set `[HostTool.EvidenceUpload]` on `swe@1` and `[]` on `re@1`.
  3. In `src/worker/host-tools.ts`, declare `EVIDENCE_UPLOAD_PARAMETERS = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false })` with `Type` of `@earendil-works/pi-ai`. Export `evidenceUploadTool(hostTools: HostTools): ToolDefinition`: name `evidence-upload`, a label and a description that name the workspace-relative path and the three result fields, `parameters: EVIDENCE_UPLOAD_PARAMETERS`, and `execute(_, params, signal)` that awaits `hostTools.evidenceUpload(params.path, signal)` and answers `{ content: [{ type: "text", text: canonicalJSON(result) }], details: result }`. Import `ToolDefinition` with `import type`.
  4. In `sessionTools` (`src/worker/tool-table.ts`), take `hostTools: HostTools` as a fifth argument. For each host tool of the declaration, add its name to `allowlist` and `evidenceUploadTool(hostTools)` to `customTools`. In `toolDeclarations(agentName)`, append `{ name, source: ToolSource.Host, inputSchema: JSON.parse(JSON.stringify(EVIDENCE_UPLOAD_PARAMETERS)) }` for each host tool of the declaration, after the built-in tools.
  5. Add `hostTools: HostTools` to `NativeAgentInput` (`src/worker/native-agent.ts`), and pass it to `sessionTools`. Export `HostTool`, `evidenceUploadTool` and the type `HostTools` from `src/worker/index.ts`.
  6. Regenerate OpenAPI; the source enum of a tool of `agent.get` holds `host`.
  7. Add tests: `swe@1` answers `evidence-upload` with source `host` after the seven built-in tools; `re@1` answers no host tool; the session of `re@1` holds no `evidence-upload`, although its input holds `hostTools`; a scripted tool call `evidence-upload { path: "a.txt" }` calls `hostTools.evidenceUpload` once with `a.txt` and answers the three fields; an extra argument fails the parameter schema; a rejected `evidenceUpload` answers a tool error with the message of the rejection alone.
- Rules:
  - The tool table holds a fourth source, the host-supplied tools, and the declaration of an agent names its host tools. Debate Q1, ruled on `worker-service.impl.md` "Tool table" and `engine/docs/cli/worker.md:318`.
  - `re@1` holds no write tool. `worker-service.impl.md:304`.
  - The helper returns the evidence identity, the asset identity and the `s3://` URI to the agent. `worker-service.impl.md:352`.
  - The MCP server exposes no upload write, and the MCP write set stays unchanged. `worker-service.impl.md:358`, `:364`; decision D5.
  - Only `src/worker/pi.ts` holds a value import of `@earendil-works/pi-coding-agent`. Plan 07 task 07.2 step 6.
- Done when: `pnpm run verify` passes; the tests pass; every test of plan 07 passes with the new argument.

### 09.3 Add the boundary change, the server API bundle and the injection points

- Files: `eslint.config.js`, `src/apps/worker/api.ts` (create), `src/apps/worker/api.test.ts` (create), `src/apps/worker/index.ts`, `engine/AGENTS.md` (all edit or create)
- Do:
  1. In `eslint.config.js`, add to the policy of `apps-worker` (`:107–119`) `{ to: serviceEntry("index.ts"), captured: { name: "worker" } }` in the element form of the file, and `{ to: element("repository") }`. Add one policy for the test files of `apps-server` (`src/apps/server/{test-support.ts,*.test.ts}`): `{ to: applicationEntry("apps-worker") }`.
  2. In `src/apps/worker/api.ts`, export `workerApi(endpoint, token)`: `{ gateway: httpClient(gatewayOperations, …), worker: httpClient(workerOperations, …), scheduler: httpClient(schedulerOperations, …), mission: httpClient(missionOperations, …) }` and `type WorkerApi`.
  3. Export `BACKOFF_INITIAL_MS = 1000`, `BACKOFF_MAX_MS = 30000` and `class Backoff` with `next(): number` (the delay doubles from the initial value up to the cap) and `reset()`. Export `sleep(ms, context): Promise<void>`, which resolves at once when `context` is cancelled.
  4. Export `retryIndeterminate(call: (key: string) => Promise<OperationResult<T>>, deadline: number, context): Promise<OperationResult<T>>`: call with a fresh ULID; repeat after `Backoff.next()` with a fresh ULID while the answer is indeterminate and `Date.now() + delay` is before `deadline`; answer the last result.
  5. In `WorkerOptions` (`src/apps/worker/index.ts:32–38`), add `modelRuntimeFactory?: ModelRuntimeFactory` and `repositoryTransport?: RepositoryTransport`. The defaults are `defaultModelRuntimeFactory` and a `RepositoryComponent` that task 09.4 constructs.
  6. Add tests: the backoff answers 1 s, 2 s, 4 s, … and never more than 30 s, and `reset()` answers 1 s again; `retryIndeterminate` sends a new key for each try, stops at the first completed or failure answer, and stops at the deadline; `sleep` ends at a cancellation.
  7. In `engine/AGENTS.md` "Project structure", add `api.ts` under `src/apps/worker/`.
- Rules:
  - `apps-worker` imports `src/worker/index.ts` and `src/repository`, because `kanthord serve worker` hosts the native runtime. Decision D23; `worker-service.impl.md:232`.
  - The in-process construction of the E2E imports the `Worker` of `src/apps/worker/index.ts` from the test process of `gatewayFixture`. Decision D15. The index names the in-process worker helper in `src/apps/server/test-support.ts` (`00-index.md` "Shared files"), so the test files of `apps-server` import the application entry. This is a second boundary change of decision D23 (see "Blockers").
  - The application invokes every operation through the owners' `contract.ts` imports. `architecture.impl.md:765`.
  - An instance retries with backoff, never with tight polling. `scheduler-service.md:126`.
  - The idle backoff stays under the heartbeat window: the cap of 30 s and the wait window of 90 s stay under the default window of 300 s. `worker-service.impl.md:176`, `:287`.
  - A secret mutation answers 409 on a repeat of its key, so a lost answer takes a new key. `gateway-service.impl.md:429–430`; plan 05 debate Q3.
  - No production code reads an environment variable for a fake. Decision D15.
- Done when: `pnpm run verify` passes; the tests pass.

### 09.4 Implement the startup order, the registration and the ready record

- Files: `src/apps/worker/index.ts`, `src/apps/worker/registration.ts` (create), `src/apps/worker/registration.test.ts` (create), `src/apps/worker/index.test.ts` (edit), `src/apps/cli/index.test.ts` (edit), `engine/AGENTS.md` (edit)
- Do:
  1. Keep the client resolution and the `clientSecret` check (`src/apps/worker/index.ts:63–77`). Keep the decoded secret in a private field of the `Worker`, and never log it.
  2. Then run `checkAgentTools()`. Then take `options.repositoryTransport ?? new RepositoryComponent()`; the constructor runs the gate of git, OpenSSH and bash (`src/repository/index.ts:13`).
  3. Then keep the version check (`:78–97`).
  4. Then open `WorkspaceRoot.open(directories(env).state)`.
  5. Then register. In `src/apps/worker/registration.ts`, export `register(api, context)`: call `api.worker.register({ params: {}, query: {}, body: null })` under a context that the stop does not cancel. A completed answer returns the three values. A failure throws `new Diagnostic(error.code, error.message)`. An indeterminate answer throws `Diagnostic("worker.start.registration_indeterminate", …)` (code: proposed).
  6. Log one record `Worker application ready` with `runtimeIdentity`, `resourceIdentity` and `workerName` through the operational log. Remove the notice `Worker application started`, because it stood only until the registration (`engine/docs/cli/other.md:511–512`).
  7. A signal during the startup stops the next step. A registration in flight continues to its answer, and the stop of task 09.6 deregisters that runtime identity.
  8. A startup failure releases what the start acquired in reverse order and returns the diagnostic; `src/apps/cli/index.ts:121–122` prints it and exits 1.
  9. Rewrite the tests of `index.test.ts` that expect `Worker application started` with a fake server that answers `worker.register`. Add tests: each step runs in the order of step 1 to step 6, and a failure of a step calls no later step; an empty `PATH` fails with `worker.start.tool_missing` before any request; a registration failure 409 `worker.instance.slot_unavailable` exits 1 with that code; an indeterminate registration answers `worker.start.registration_indeterminate`; the ready record is one JSON line with the three fields and no token; a `SIGTERM` during a slow registration waits for its answer and then deregisters.
  10. In `engine/AGENTS.md` "Run the worker application", replace the ERD 1 sentences on `Worker application started` and on "hosts no instances yet" with the startup order and the ready record of this task.
- Rules:
  - Startup resolves the client configuration, checks `clientSecret`, checks the server package version and registers, in that order; a host without `rg` or `fd` stops the start with `worker.start.tool_missing`. `worker-service.impl.md:239`; `engine/docs/cli/worker.md:717`.
  - The start of the repository connector requires git 2.40, OpenSSH 9.0 and bash on the host, and refuses with `repository.connector.tool_missing` or `repository.connector.tool_version`. `repository.impl.md:42–43`. The connector runs in the process of its caller. `repository.md:66–71`.
  - The workspace root is `workspaces/` of the state directory of the host. `worker-service.impl.md:236`, `:399`.
  - After the registration the application logs one ready record with the three fields; it prints no token and needs no terminal. `worker-service.impl.md:240–241`.
  - A startup failure prints its diagnostic, releases what it acquired and exits 1. `worker-service.impl.md:242`; `architecture.impl.md:440–446`.
  - `SIGINT` and `SIGTERM` stop further startup. `worker-service.impl.md:244`.
  - Code `worker.start.registration_indeterminate` (local, code: proposed): the condition is ruled at `worker-service.impl.md:243` and `:251`. No shared code of `engine/docs/cli/other.md` and no ERD 1 code covers it.
  - Gap: a registration with no answer stays B9 (`worker-service.impl.md:251`); the application exits 1, and a restarted program gets its live registration back (`scheduler-service.impl.md:65`).
- Done when: `pnpm run verify` passes; the tests pass.

### 09.5 Add the heartbeat timer and the workspace sweep timer

- Files: `src/apps/worker/registration.ts`, `src/apps/worker/registration.test.ts`, `src/apps/worker/index.ts` (all edit)
- Do:
  1. Declare `HEARTBEAT_INTERVAL_MS = 60000`. Export `startHeartbeat(api, log): { stop(): void }`: an `unref` interval that calls `api.worker.heartbeat({ params: {}, query: {}, body: null })`. A failure or an indeterminate answer logs one warning record with the code and changes nothing else.
  2. In `run()`, start the heartbeat and `workspaces.startSweeping()` after the ready record. Stop both in `quiesce()`.
  3. Add tests with fake timers: the heartbeat runs every 60 s while the application is idle and while an execution is live; a failed heartbeat logs one record and stops no timer; `quiesce()` stops both timers; the sweep runs once at the start.
- Rules:
  - Every authenticated request of a registered client identity renews its heartbeat, and `worker.heartbeat` is the explicit request. `worker-service.impl.md:165–168`.
  - A sweep every 30 s ends a registration whose last heartbeat is older than the window, and a live execution of an ended registration follows the loss rules. `worker-service.impl.md:174–175`. A native execution calls the server only at its start and its end, so the timer keeps the registration of a long execution.
  - The workspace sweep runs at the start and every hour. `worker-service.impl.md:403–404`; plan 07 task 07.13.
  - A timer starts in `run()` and stops in phase 1 of the stop. `architecture.impl.md:457–464`; `00-index.md` "Shared conventions", row "Timers".
- Done when: `pnpm run verify` passes; the tests pass.

### 09.6 Implement the stop, the deregistration, the exit codes and the watchdog

- Files: `src/apps/worker/index.ts`, `src/apps/worker/registration.ts`, `src/apps/worker/index.test.ts`, `src/apps/worker/registration.test.ts` (all edit)
- Do:
  1. Keep in the `Worker` the state `registering`, `pulling` and `execution` (the live hosted execution or null).
  2. `quiesce()` cancels the shutdown context: no further startup step, no further work pull and no further backoff sleep. It cancels no registration or work pull in flight.
  3. `stop()` first awaits the registration and the work pull in flight, and arms no watchdog while one waits.
  4. When an execution is live after that wait, `stop()` cancels the context of the execution, awaits the method, performs no release and no deregistration, and returns `Diagnostic("worker.stop.execution_live", …)` (code: proposed). A work pull in flight that answers `claimed` makes the execution live in the same way.
  5. Otherwise `stop()` arms the watchdog of `WORKER_STOP_WATCHDOG_MS` (`:122–125`), stops the timers and calls `deregister(api, runtimeIdentity)` for the known runtime identity. In `registration.ts`, `deregister` calls `api.worker["instance.deregister"]({ params: { runtimeIdentity }, query: {}, body: null })` once. A completed answer and a failure 404 `worker.instance.not_found` answer null. Another failure answers `new Diagnostic(error.code, error.message)`. An indeterminate answer answers `Diagnostic("worker.stop.deregistration_indeterminate", …)` (code: proposed). No retry.
  6. `run()` returns the result of `stop()`, so `src/apps/cli/index.ts:121–122` exits 0 on null and 1 on a diagnostic. Keep `SIGHUP` ignored (`:151`).
  7. Add tests with a fake server: a stop while idle deregisters once and answers null; a 404 answers null; a 500 answers its code with no retry; an indeterminate answer answers `worker.stop.deregistration_indeterminate`; a stop during a waiting pull waits for its `no-work` answer, then deregisters; a stop during a waiting pull that answers `claimed` deregisters nothing and answers `worker.stop.execution_live`; the watchdog exits 1 on a stalled deregistration (fake timers, a stubbed `process.exit`); no watchdog is armed while a pull waits; `SIGHUP` changes nothing.
- Rules:
  - `SIGINT` and `SIGTERM` stop further startup and further work pulls. `worker-service.impl.md:244`.
  - The application deregisters only a registration whose runtime identity it knows, and only when no execution is live. `worker-service.impl.md:245–246`.
  - It exits 0 after a successful deregistration or after the 404 that ends its registration; any other deregistration or cleanup failure exits 1 without a retry. `worker-service.impl.md:247`; `:208`.
  - The 10-second watchdog applies only when no execution is live and no registration or work pull waits for its answer. `worker-service.impl.md:249`.
  - `SIGHUP` reopens nothing. `worker-service.impl.md:250`.
  - A signal during a live execution aborts the agent, performs no release, deregisters nothing and exits 1; the deadline settles the loss. Decision D25.
  - Codes `worker.stop.execution_live` and `worker.stop.deregistration_indeterminate` (local, code: proposed): the conditions are ruled at `worker-service.impl.md:248` and decision D25. No shared code of `engine/docs/cli/other.md` and no ERD 1 code covers them.
  - Gap: shutdown during a live execution, a registration or a work pull with no answer, and a stop deadline in those cases stay B9 (`worker-service.impl.md:251`; `engine/docs/cli/other.md:523–524`).
- Done when: `pnpm run verify` passes; the tests pass.

### 09.7 Implement the work-pull loop

- Files: `src/apps/worker/pull-loop.ts` (create), `src/apps/worker/pull-loop.test.ts` (create), `src/apps/worker/index.ts` (edit)
- Do:
  1. Export `pullLoop({ api, registration, backoff, shutdown, host, register })`. While the shutdown context is not cancelled, call `api.scheduler.workPull({ params: {}, query: {}, body: { resourceIdentity, runtimeIdentity } })` with a fresh key and a context that the stop does not cancel.
  2. `claimed`: reset the backoff and await `host(execution)` of task 09.9. Then pull again at once.
  3. `no-work`, an indeterminate answer, or a failure with a status of 500 or above: `sleep(backoff.next(), shutdown)`, then pull again.
  4. A failure 403 `gateway.registration.required`: the registration ended. Call `register` of task 09.4 with a fresh key, log a new ready record and pull again. A refusal of that registration ends the loop with its diagnostic.
  5. Every other failure, for example 401 `gateway.authentication.unauthorized` or 403 `scheduler.work.claimant_mismatch`, ends the loop with `new Diagnostic(error.code, error.message)`. `run()` then stops the application with that diagnostic.
  6. Add tests with a fake server: a claim runs the host once and pulls again; `no-work` pulls again after 1 s, then 2 s; an indeterminate answer pulls again with a new key; a 503 backs off; a 403 `gateway.registration.required` registers once with a new key and logs a second ready record; a 401 ends the loop with its code and no further pull; a cancelled shutdown ends the sleep at once.
- Rules:
  - `WorkPull` holds `resourceIdentity` and `runtimeIdentity`; the answer is `claimed` with the execution record or `no-work`. `scheduler-service.impl.md:46–47`.
  - A work pull is idempotent by the runtime identity: a pull of an instance with a `running` execution answers that execution, so a lost answer is recovered by the next pull. `scheduler-service.impl.md:59–64`; `scheduler-service.md:166–167`.
  - A no-work result ends the request; an instance retries with backoff. `scheduler-service.md:125–126`.
  - Server shutdown cancels the waiting pulls. `architecture.impl.md:460–461`.
  - The same client identity registers again with a fresh key after an expiry. `worker-service.impl.md:180`.
  - The loop reads the resource identity from the registration answer of task 09.1, never from the token. Debate Q2.
- Done when: `pnpm run verify` passes; the tests pass.

### 09.8 Implement the handover, the decryption and the credential report

- Files: `src/apps/worker/handover.ts` (create), `src/apps/worker/handover.test.ts` (create)
- Do:
  1. Export `takeHandover({ api, claim, clientSecret, context }): Promise<{ credentials: ExecutionCredentials; handoverItem }>`.
  2. Call `retryIndeterminate((key) => api.worker.handover({ params: {}, query: {}, body: { executionId } }, { idempotencyKey: key, context }), claim.expiredAt, context)`.
  3. A failure throws `HandoverRefused`, a class of this module that holds the code, the message and the status of the answer. An indeterminate answer at the deadline throws `HandoverRefused` with the code `gateway.invocation.timeout`.
  4. Open the envelope with `openEnvelope(deriveHandoverKeys(clientSecret).handover, handoverAad(executionId, claim.claimant.runtimeIdentity), data)`. A `HandoverOpenError` throws `Diagnostic("worker.handover.decryption_failed", …)` (code: proposed) with no material in the message. Parse `handoverPayloadSchema`.
  5. Build `executionCredentialStore(payload, report)`. `report(r)` seals `r` with `sealEnvelope(keys.report, aad, r)` and calls `retryIndeterminate((key) => api.worker.credential({ params: {}, query: {}, body: { executionId, nonce, ciphertext } }, …), claim.expiredAt, context)`. A completed answer resolves; every other answer rejects with its code.
  6. Answer the builder result and `handoverItem = { credentialId, providerId }` of the one item.
  7. Keep the client secret, the keys and the payload in local variables; log only `{ executionId, credentialId }` with the message `credential handover received`.
  8. Add tests with a fake server that seals with a known secret: a lost first answer is retried with a new key and the second key succeeds; the store answers the key under the adapter id; a refresh through `store.modify` calls `worker.credential` once with an envelope that the report key opens; `release()` reports once; another client secret throws `worker.handover.decryption_failed`; a 403 `gateway.invocation.execution_proof_failed` throws `HandoverRefused` with that code; no log line holds the secret.
- Rules:
  - The application calls `worker.handover` once after its claim and before the first inference call; the body names the execution. `worker-service.impl.md:327`, `:329`; plan 05 debate Q1.
  - A lost answer takes a new key, because the handover is a secret mutation. `gateway-service.impl.md:429–430`; plan 05 debate Q3.
  - The application decrypts with the handover key of its own `clientSecret`, builds the in-memory store and holds the plaintext in memory alone. `worker-service.impl.md:330`.
  - The application calls `worker.credential` after each refresh and once at the release. `worker-service.impl.md:331`.
  - Every retry stays inside the deadline of the execution. `worker-service.impl.md:531`.
  - A `clientSecret` of another machine JWT fails every decryption, and the application ends the execution as a cannot-progress condition. `worker-service.impl.md:338`; decision D25.
  - Code `worker.handover.decryption_failed` (local, code: proposed): the condition is ruled at `worker-service.impl.md:338–339`. `custody.handover.report_invalid` covers the server side alone (`custody.impl.md:149`).
  - Gap: a report that the application cannot deliver leaves the server with the replaced value; the retry policy stays B9 "Cannot progress" (`docs/brainstorm/HANDOFF.md` "Cannot progress"; plan 05 task 05.3).
- Done when: `pnpm run verify` passes; the tests pass.

### 09.9 Host the execution through the entry of plan 08

- Files: `src/apps/worker/execution.ts` (create), `src/apps/worker/execution.test.ts` (create), `src/apps/worker/index.ts` (edit)
- Do:
  1. Export `hostExecution({ claim, api, clientSecret, workspaces, transport, modelRuntimeFactory, hostHome, shutdown })`. Create `context = new CancellationContext(background)` for the execution, and cancel it from `stop()` of task 09.6.
  2. Call `takeHandover` of task 09.8.
  3. Read the setup with `retryIndeterminate((key) => api.worker["execution.setup.get"]({ params: { executionId }, query: {}, body: null }, { context }), claim.expiredAt, context)`.
  4. Build `clients: MethodClients` from `WorkerApi` of task 09.3.
  5. Build `hostTools(workspace): HostTools` with an `evidenceUpload` callback bound to that prepared workspace, claim, API and execution context. Observe terminal Mission refusals before projecting a safe tool error: cancel the execution and allow no further dispatch. Other upload failures remain tool errors.
  6. Call `runNativeExecution` with `{ claim, setup, clients, credentials, handoverItem, transport, workspaces, hostHome, modelRuntimeFactory, transcript: noTranscript, hostTools, context }`.
  7. Classify the end. `released`, `closed`, `ended` with the reason `revoked`, and a handover or setup failure for which `isExecutionEnd` answers true mean that the execution ended: log one record `execution ended` with `executionId`, the kind and the code, and answer null, so the loop pulls again. `worker.handover.decryption_failed`, every other refusal of the handover or the setup read, `worker.runtime.setup_refused`, `ended` with every other reason and every error that the entry throws are a cannot-progress condition: answer a diagnostic with the code of the end, and the application stops with no release and no deregistration and exits 1.
  8. In a `finally` block, call `credentials.discard()`.
  9. Add tests with fake methods: the handover precedes the setup read, and both precede the method; the entry receives the host tools and `noTranscript`; `released` and `closed` answer null; a proof failure of the setup read answers null and the loop pulls again; a 400 `agent.enablement.unavailable` of the handover answers its code and stops the application with exit 1 and no deregistration; `ended` with `operation_failed` and a thrown entry error do the same; `discard()` runs on every path; a `SIGTERM` during the method cancels its context, and the application answers `worker.stop.execution_live`.
- Rules:
  - The execution takes its identity, its node, its attempt and its pinned revision from the claim answer. `worker-service.md:261`.
  - The binding, the worker and the agent configuration come from the server. `worker-service.impl.md:235`; plan 07 debate Q1.
  - The application discards every credential when the execution ends and writes none to a file. `worker-service.impl.md:333`.
  - A revoked or lost execution stops its agent and performs no further operation under its execution identity; it learns of the end from its first refused call. `worker-service.md:265`; `scheduler-service.md:239–240`.
  - A cannot-progress condition ends the execution under decision D25: no release, no deregistration, exit 1.
  - Gap: the disposition of an execution that cannot progress stays B9 "Cannot progress" (`docs/brainstorm/HANDOFF.md`); the deadline of the execution settles the loss.
  - Gap: the abort proves no stop of every descendant process, and the quiescence check before a workspace reuse stays B9 W5 (`worker-service.impl.md:524–525`).
- Done when: `pnpm run verify` passes; the tests pass.

### 09.10 Implement the evidence upload helper

- Files: `src/apps/worker/evidence-upload.ts` (create), `src/apps/worker/evidence-upload.test.ts` (create)
- Do:
  1. Declare `WorkerErrorCode` members `EvidenceUploadPathRefused = "worker.evidence_upload.path_refused"` and `EvidenceUploadTransferFailed = "worker.evidence_upload.transfer_failed"` (code: proposed), and `PathRefusal = { OutsideWorkspace: "outside_workspace", SymbolicLink: "symbolic_link", NotRegular: "not_regular", Replaced: "replaced" }`. Declare `OBJECT_MEDIA_TYPE = "application/octet-stream"`.
  2. Safe open: refuse absolute and escaping paths. Enforce component containment with Darwin `O_NOFOLLOW_ANY` or Linux directory-descriptor traversal with `O_NOFOLLOW`; fail closed on unsupported platforms. Retain regular-file, inode and parent checks. An `ELOOP` answers `symbolic_link`; a replaced leaf answers `replaced`. A controlled parent swap must never open an outside file.
  3. Reject a size above the 5 GiB object bound before allocation. Hash bounded 64 KiB descriptor reads, checking cancellation, byte count and metadata changes. Transfer from the same descriptor; never allocate the entire asset to hash it.
  4. Call `api.mission["evidence.submit"]({ params: { nodeId: claim.nodeId }, query: {}, body: { executionId, attempt, nodeRevision: claim.pinnedRevision, subject: <the workspace-relative path>, assets: [{ kind: "object", size, mediaType: OBJECT_MEDIA_TYPE, sha256 }] } })` with a fresh key.
  5. Send the bytes of the descriptor from position 0 with `fetch(putUrl, { method: "PUT", headers, body })`. A thrown error or a status other than 2xx throws `Diagnostic(EvidenceUploadTransferFailed, "evidence upload: the transfer failed with status <status>.")`. The message holds no URL and no header.
  6. Call `api.mission["evidence.asset.complete"]({ params: { assetId }, query: {}, body: { executionId, attempt, nodeRevision } })`.
  7. Answer `{ evidenceId, assetId, uri }`. Preserve Mission failure details for the host's terminal execution observer; terminal refusals cancel the execution before safe tool-error presentation. Close the descriptor in a `finally` block.
  8. Add tests against the object sink of plan 04: the order is submit, PUT, complete, and the asset publishes only after the complete; the answer holds the three fields alone; `../x`, an absolute path, a symbolic link that leaves the workspace, a symbolic link inside the workspace, a directory and a file that a rename replaces between the open and the check each refuse with their reason; a sink that answers 500 throws `worker.evidence_upload.transfer_failed`, and neither the message nor the details hold the `putUrl`; a changed file after the hash fails the complete through the checksum check.
- Rules:
  - The helper opens the path safely inside the execution workspace and refuses traversal, symbolic-link escapes and path replacement races. `worker-service.impl.md:345–346`; `engine/docs/cli/mission.md:552–553`.
  - It calls `mission.evidence.submit` with the execution context, the evidence metadata and one `object` asset with its size, media type and SHA-256; it sends the file directly to the presigned PUT; then it calls `mission.evidence.asset.complete`. `worker-service.impl.md:348–349`; `mission-service.impl.md:297–312`.
  - The helper supplies the SHA-256 that it computes, and the PUT sends the headers of the answer. `mission-service.impl.md:304`; debate Q1.
  - The subject is the workspace-relative path, and the media type is `application/octet-stream`; the service stores the value and never interprets it. Debate Q1; `mission-service.impl.md:285`.
  - The file path is local input, not an evidence address. `mission-service.impl.md:295`.
  - The presigned URL is an API answer, never a tool result or an agent-context value. `worker-service.impl.md:357`; `mission-service.impl.md:329`.
  - Codes `worker.evidence_upload.path_refused` and `worker.evidence_upload.transfer_failed` (local, code: proposed): the conditions are ruled at `worker-service.impl.md:347` and `:350`. No shared code and no Mission code covers a local open or a direct transfer.
- Done when: `pnpm run verify` passes; the tests pass.

### 09.11 Add the in-process worker helper

- Files: `src/apps/server/test-support.ts`, `src/apps/server/test-support.test.ts` (edit or create)
- Do:
  1. Export `toolStubs(t): string`. It writes executable `rg` and `fd` scripts that print one version line into a temporary directory, and answers that directory.
  2. Export `inProcessWorker(t, { endpoint, token, clientSecret, modelRuntimeFactory, repositoryTransport })`. Write `cli.yaml` with `clientSecret` as a private file under a temporary configuration directory, prepend `toolStubs(t)` to `process.env.PATH` and restore it in `t.after()`, and construct `new Worker({ endpoint, token, env, modelRuntimeFactory, repositoryTransport, log })` with a `log` that collects the records. Start `worker.run()`, and stop it in `t.after()`.
  3. Add a test: the helper reaches the ready record against `gatewayFixture` and stops with a null result.
- Rules:
  - The internal-harness journey constructs the `Worker` in-process with the injected `ModelRuntimeFactory` and `RepositoryTransport`. Decision D15.
  - `gatewayFixture` keeps the composition-owned services. `00-index.md` "Shared files".
  - The stubs serve the host check alone; no row of the E2E runs the pi tools `grep` or `find`.
- Done when: `pnpm run verify` passes; the test passes.

### 09.12 Add the subprocess proof of the lifecycle

- Files: `src/apps/server/e2e-worker-app.test.ts` (edit)
- Do:
  1. Build the setup of "E2E" fixture S through the CLI on one `gatewayFixture`. Take the machine token and the client secret from `jwt generate` through the TTY shim of `:291–305`.
  2. Prepend `toolStubs(t)` to the `PATH` of every spawn that must pass the host check.
  3. Rewrite E09.5 and E09.6 of ERD 1 to the ready record, and add the rows E09.7 to E09.12 of "E2E".
  4. Keep E09.1 to E09.4 and the fragment test (`:277–328`), with `Worker application ready` in place of `Worker application started` where the worker reaches the registration.
- Rules:
  - `kanthord serve worker` as a subprocess proves startup, registration, the ready record and deregistration alone. Decision D15.
  - No row of the subprocess claims a node, because the subprocess runs the default model runtime and no plan makes a real provider call. Decision D16.
  - Setup goes through the CLI; the state check is a CLI read, except the process rows, whose state is the exit code, the signal and the output. ERD 1 plan 09 "E2E".
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-worker-app.test.ts` passes; `pnpm run verify` passes.

### 09.E E2E proof

- Files: `src/apps/server/e2e-worker-host.test.ts` (create)
- Do:
  1. Start `gatewayFixture` with the ERD 1 fixture repository connector that answers the `git ls-remote` of a binding write, and with `standIns.intakeStorage = sinkStorage(await objectSink(t))` of plan 04.
  2. Build the setup of fixture H through the CLI.
  3. Create a local bare repository with a `main` commit. Build the test `RepositoryTransport` from `RepositoryComponent` with every `address` replaced by the bare path (decision D15).
  4. Run `inProcessWorker` with `scriptedModelRuntime(scriptedProvider(script, { providerId: "anthropic", modelIdentifier: "claude-sonnet-4-5" }))`.
  5. Implement the rows in one test and in table order, because each row reads the state of the rows before it.
- Rules:
  - The in-process rows host one steps execution with the scripted fake provider and a local bare repository through the methods of plan 08. Decisions D15, D16.
  - Every fixture uses `claude-sonnet-4-5` and a complete entry form. Decision D16.
  - The repository binding keeps its SSH address. Decision D15.
  - No row prints a secret; the client secret stays in local variables. Plan 05 E2E rule.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-worker-host.test.ts` passes every row; `pnpm run verify` passes.

## E2E

- Test files: `src/apps/server/e2e-worker-app.test.ts` (subprocess rows) and `src/apps/server/e2e-worker-host.test.ts` (in-process rows). Both run in `pnpm run verify`.
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI. `spawnWorker` of `e2e-worker-app.test.ts:80` starts `kanthord serve worker`. `inProcessWorker` of task 09.11 constructs the `Worker` in the test process. A human command uses `KANTHORD_TOKEN = fixture.token`.
- Rules: a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON; a record is one JSON line of stderr or of the collected log; no output holds the token, the client secret or a `putUrl`.

Fixture S, in order (each command exits 0):

1. `kanthord credential create --file anthropic.json` with `{ "name": "anthro-1", "platform": "anthropic", "metadata": null, "secret": { "key": "e2e-worker-secret" } }`; `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
2. `kanthord agent enablement put swe@1 --file enablement.json` with `{ "agentProviders": [{ "name": "default", "provider": "anthropic", "credential": "anthro-1" }], "defaultConfiguration": { "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" } }` → `revision` 1.
3. `kanthord project create --name worker-app` → `projectId`.
4. `kanthord project binding apply <projectId> --file bindings.json` with `repo` `{ "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }` and `general` `{ "kind": "worker", "config": { "worker": "general@1", "instanceCount": 1, "entries": [{ "agent": "swe@1", "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" }] } }`.
5. `kanthord jwt generate --project <projectId> --binding general --name general-a --config server.yaml` → `token`, `clientSecret`, written into `cli.yaml` with `endpoint`.
6. `kanthord agent enablement disable swe@1 --expected-revision 1`. The instance healthcheck then fails, so every work pull answers `no-work` at once and no row claims a node.

| Id     | Commands                                                                                                                                                                              | Exit | Expect                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E09.1  | `kanthord serve worker --config <path>`                                                                                                                                               | 1    | stderr starts with `cli.serve.worker_config:`                                                                                                                                                     |
| E09.2  | `spawnWorker(["serve", "worker"], env)`; no `cli.yaml`                                                                                                                                | 1    | stderr starts with `worker.start.client_secret_absent:`                                                                                                                                           |
| E09.3  | `spawnWorker`; `cli.yaml` with a 16-byte `clientSecret`                                                                                                                               | 1    | stderr starts with `worker.start.client_secret_invalid:`                                                                                                                                          |
| E09.4  | `spawnWorker`; fixture S `cli.yaml`; `PATH` without the stubs and without `rg` and `fd`                                                                                               | 1    | stderr starts with `worker.start.tool_missing:`; no request reaches the fixture                                                                                                                   |
| E09.5  | `spawnWorker`; a fake endpoint that answers version `0.0.0`                                                                                                                           | 1    | stderr starts with `worker.version.mismatch:` and holds both versions                                                                                                                             |
| E09.6  | `spawnWorker` with fixture S; `waitForLine` of `Worker application ready`; `kanthord worker instance list --project <projectId>`                                                      | 0    | the record holds `runtimeIdentity` `worker_instance_…`, `resourceIdentity` `worker:kanthord:general` and `workerName` `general@1`; the list holds that runtime identity with `registered` true    |
| E09.7  | after E09.6: send `SIGTERM`; await `proc.exited`; `kanthord worker instance get <runtimeIdentity>`                                                                                    | 0, 1 | the process exits 0 with `signal` null; every stderr line parses as JSON; stdout is empty; no line holds the token or the client secret; the read stderr starts with `worker.instance.not_found:` |
| E09.8  | `spawnWorker` with fixture S; `waitForLine` of the ready record; send `SIGHUP`; wait 200 ms; send `SIGTERM`                                                                           | 0    | the process is alive after `SIGHUP` and exits 0 after `SIGTERM`                                                                                                                                   |
| E09.9  | `spawnWorker` A with fixture S; ready record of A; `spawnWorker` B with `KANTHORD_TOKEN` of a second `jwt generate --name general-b`; then `SIGTERM` to A                             | 1, 0 | the stderr of B starts with `worker.instance.slot_unavailable:`; A exits 0                                                                                                                        |
| E09.10 | `spawnWorker` with fixture S; ready record; `kanthord worker instance deregister <runtimeIdentity>` with the machine token at once; `waitForLine` of a second ready record; `SIGTERM` | 0    | the application logs a second ready record with a new runtime identity after `gateway.registration.required`; the process exits 0                                                                 |

Fixture H, in order (each command exits 0): steps 1 to 5 of fixture S with the project `worker-host`; the storage credential `{ "name": "store", "platform": "s3", "metadata": { "endpoint": "https://s3.example.com", "bucket": "evidence", "region": "eu-central-1" }, "secret": { "accessKeyId": "AKIAEXAMPLE", "secretAccessKey": "example-secret" } }` and the binding `store` `{ "kind": "storage", "config": { "available": true, "endpoint": "https://s3.example.com", "bucket": "evidence", "region": "eu-central-1", "prefix": "kanthord", "credential": "store" } }` of plan 04; `kanthord mission get <projectId>` → `missionId`; `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Greetings", "requirement": "Say hello", "criterion": "hello.txt exists", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId`; `kanthord mission node create <missionId> --file objective-a.json` with `{ "filename": "objective-a.md", "kind": "objective", "parentId": <initiativeId>, "expectedParentRevision": 1, "content": { "name": "Say hello", "requirement": "Write hello.txt", "criterion": "hello.txt exists", "verifications": ["test -f hello.txt"], "bindings": ["repo", "store"] }, "reason": "plan", "expectedMissionVersion": 2 }` → `objectiveA`. The enablement stays enabled.

Fixture H also creates `task-a.md` under the objective, requiring `hello.txt` with verification `test -f hello.txt`; a steps objective with no task performs no task inference. Use the returned current mission and parent revisions for that creation. The ready-order proof compares the ready record with `credential handover received`, the first claim-bound log. Claim reads always supply the execution identity.

`script` names the scripted turns of the fake provider: a `bash` call `printf hello > hello.txt`, an `evidence-upload` call `{ "path": "hello.txt" }`, an `evidence-upload` call `{ "path": "../outside.txt" }` and a final text. Synthetic secret values use the approved `test_` prefix in executable fixtures.

| Id     | Commands                                                                                                                                                                                                       | Exit      | Expect                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E09.11 | `inProcessWorker` with fixture H and `script`; poll `kanthord scheduler execution list <projectId> --node <objectiveA>` until an item is `finished`                                                            | 0         | one execution of `objectiveA` with `claimState` `finished` and `credentials` of length 1; the ready record precedes the claim; the fake records the key `e2e-worker-secret` on every call                                                                                       |
| E09.12 | `kanthord mission evidence list <objectiveA> --attempt 1`; `kanthord mission evidence asset content get <asset of the object evidence>`; `GET` of its `getUrl`                                                 | 0, 0, 200 | one evidence with `subject` `hello.txt`, one `object` asset with `size` 5, `mediaType` `application/octet-stream`, a `sha256` and `publishedAt` a number; the body reads `hello`                                                                                                |
| E09.13 | the calls of the fake provider after the two `evidence-upload` calls                                                                                                                                           | —         | the first tool result holds `evidenceId`, `assetId` and `uri` alone, with `uri` starting with `s3://evidence/kanthord/`; the second is a tool error that starts with `worker.evidence_upload.path_refused`; no message of any call holds `putUrl`, the sink endpoint or `X-Amz` |
| E09.14 | `git ls-remote <bare> refs/heads/kanthord/<objectiveA>`; `kanthord mission node get <objectiveA>`                                                                                                              | 0, 0      | the node branch exists at the head that the steps method pushed; `state` follows the release of plan 08                                                                                                                                                                         |
| E09.15 | `inProcessWorker` with fixture H and a script whose first turn waits on a promise of the test; `process.emit("SIGTERM")` during that turn; `kanthord scheduler claim get <executionId>` with the machine token | 1, 0      | `worker.run()` answers `worker.stop.execution_live`; `claimState` `running`; `kanthord worker instance list` still holds the runtime identity                                                                                                                                   |
| E09.16 | `inProcessWorker` with fixture H and a `clientSecret` of another `jwt generate` written into `cli.yaml` beside the token of `general-a`                                                                        | 1         | `worker.run()` answers `worker.handover.decryption_failed`; no release; the registration stays live                                                                                                                                                                             |

E09.13, E09.15 and E09.16 assert codes of the mark `code: proposed`. The tests are committed after Aelita writes each accepted code on its page (ruling R3). E09.14 reads the node state that plan 08 rules for a steps release; the row names the state when plan 08 is committed.

## Blockers

None open. One debate settled two gaps (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 09", ruled 2026-09-30):

- DEBATE: the agent surface of the worker-host `evidence upload <path>` at the `worker` placement - rounds:1 - verdict: CHANGE to option (a), a host tool `evidence-upload { path }` in the pi session of `swe@1`, with three repairs: the tool table declares the host-supplied tools as a fourth source and `agent.get` answers the source `host`; the agent declaration names its host tools, so `re@1` holds none; a test proves that a failed upload holds no presigned URL in a tool error. SHA-256 stays optional on the page; the helper supplies the value that it computes.
- DEBATE: the source of `workerName` and `resourceIdentity` of the record `Worker application ready` - rounds:1 - verdict: AGREE, `worker.register` answers `{ runtimeIdentity, resourceIdentity, workerName }` from the verified machine identity and the worker binding row that the registration transaction reads, never from a later lookup.

Two alignments are plan work:

- The CLI leaf `evidence upload <node-id> <path>` (row 35) is the harness helper form (`engine/docs/cli/mission.md:550`). The `worker` application serves the agent-facing form through the host tool, so this plan builds no CLI leaf, and plan 10 lists row 35 as the one host-local row of the dispatcher completeness until the external-harness phase.
- The test files of `apps-server` import the application entry of `apps-worker`, because the in-process worker helper lives in `src/apps/server/test-support.ts` (`00-index.md` "Shared files"; decision D15). Decision D23 names one boundary change; this is its second part.
