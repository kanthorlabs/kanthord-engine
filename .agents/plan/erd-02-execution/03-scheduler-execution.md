# Plan 03: Scheduler Service — execution

## Scope

This plan delivers:

- Migration 2 of `src/scheduler/migrations.ts` with the `scheduler_execution` table and its two partial unique indexes.
- The configuration fragment `scheduler.releaseReserve` and the fixed deadline of a claim.
- `scheduler.work.pull` with the claim transaction, the wait window of 90 s, the wakeups and the instance healthcheck.
- `scheduler.execution.release`, `scheduler.claim.get`, `scheduler.execution.list` and `scheduler.execution.get`, with their CLI leaves and their OpenAPI.
- The loss declaration, the loss sweep every 30 s, the settlement before every Mission transition and the revocation.
- The execution proof of the invocation chain: `Operation.requiresExecution`, `caller.execution` and `lookups.scheduler` (decision D10).
- The seams that later plans consume: `SchedulerClaims` (`revoke`, `settle`, `liveExecutionOf`, `runningExecutionOfRuntime`, `requireRunning`), `pinCredential`, `liveExecutionsPinning`, `SchedulerWakeup.wake`, `ExecutionAttribution.of` and `pulling`.
- The `TraceIdentity` dependency with its minting stand-in (decision D7).
- The replacement of every stand-in that plans 01 and 02 place for a Scheduler seam (decision D9).

Out of scope:

- The on-demand request (`scheduler-service.md:118–119`). No ERD 2 service issues one.
- The `server` placement and the in-process abort of a hosted execution (decision D8).
- Numeric bounds of the processor pool, the discovery lag and the claim latency. HANDOFF names them (`docs/brainstorm/HANDOFF.md:35`).
- Every B9 item and every open HANDOFF item (decision D1). Each task that meets one states the gap in one line.
- Delivery admission and every Intake seam (ERD 3). The stored telemetry and the tracer (ERD 4).

## Sources

- `docs/reference/erd/02-execution.md:59–74` — the columns of `scheduler_execution`.
- `docs/reference/erd/02-execution.md:133–135`, `:298–306` — every reference of `scheduler_execution` holds no foreign key.
- `docs/reference/erd/02-execution.md:206–228` — the Scheduler constraints: the indexes, the count, the claim, the deadline, the proof, the release, the loss, the settlement, the revocation and the claim state.
- `docs/brainstorm/scheduler-service.md:26–33`, `:63–67`, `:89–132` — the wakeups, the stale job, the work pull and the wait.
- `docs/brainstorm/scheduler-service.md:134–215` — the claim, the execution record, the declared node states, the count and the revocation.
- `docs/brainstorm/scheduler-service.md:217–267` — liveness, the proof in the write transaction and the settlement.
- `docs/brainstorm/scheduler-service.vocabulary.md:20–31`, `:92–106` — the declared node states, the deadline and the instance healthcheck.
- `docs/brainstorm/scheduler-service.impl.md:12–19` — the identities.
- `docs/brainstorm/scheduler-service.impl.md:21–54` — the operation contracts, `ExecutionRecord`, `WorkPull`, `ExecutionRelease` and the list filters.
- `docs/brainstorm/scheduler-service.impl.md:56–76` — the durable requests and `claim get`.
- `docs/brainstorm/scheduler-service.impl.md:78–100` — the configuration and the loss settlement.
- `docs/brainstorm/scheduler-service.impl.md:102–142` — the retention and the tests.
- `docs/brainstorm/tracking-service.impl.md:23` — the form of `traceId` and `rootSpanId`.
- `docs/brainstorm/architecture.impl.md:179–189` — pagination.
- `docs/brainstorm/architecture.impl.md:341–349` — the error code form and the CLI code form.
- `docs/brainstorm/architecture.impl.md:453–473` — the stop phases, the quiescence of the Scheduler and the timers.
- `docs/brainstorm/architecture.impl.md:592–598`, `:628–634`, `:646–659`, `:694–699` — the collaborations, the wait lifetime, the execution proof and the one commit of a handler.
- `docs/brainstorm/gateway-service.impl.md:156`, `:221` — the target machine JWT and the machine identity that names its project and its resource identity.
- `docs/brainstorm/gateway-service.impl.md:282–309` — the cancellation of a waiting work pull and the route timeouts.
- `docs/brainstorm/worker-service.md:21–42`, `:202–215` — the declarations of a worker and the instance healthcheck.
- `docs/brainstorm/worker-service.vocabulary.md:270–285` — the compatibility declarations and the required node format.
- `docs/brainstorm/worker-service.impl.md:158`, `:189`, `:207–223`, `:443–451` — the client attribution, the instance activity, the registration resume and the budget.
- `docs/brainstorm/custody.impl.md:159–167` — `pinCredential` and `liveExecutionsPinning`.
- `docs/brainstorm/project-service.impl.md:126` — the worker of a binding group never changes.
- `docs/brainstorm/mission-service.md:691–692` — the wakeup after a Mission commit.
- `engine/docs/cli/scheduler.md:34–156` — the shared input, output and access rules.
- `engine/docs/cli/scheduler.md:159–175` — the command inventory and the routes.
- `engine/docs/cli/scheduler.md:225–447` — `work pull`, `claim get`, `execution list`, `execution get`, `ExecutionRecord` and `execution release`.
- `engine/docs/cli/scheduler.md:490–501` — the error codes of the Scheduler CLI.
- `engine/docs/cli/other.md:834–835` — the shared `token_required` and `indeterminate` codes.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `engine/.agents/plan/erd-02-execution/01-mission-attempts-controls.md` "Provides", tasks 01.4 and 01.19 — the `MissionTransitions` seam and the stand-ins.
- `.dev/erd-02/decisions-log.md` — the entry of 2026-09-30 for plan 03 (the wait mechanism).
- Root `AGENTS.md` "Database design", "Contracts" and "Rejected proposals".

## Depends on

- ERD 1, merged. `SchedulerService` and `WorkQueue` (`src/scheduler/service.ts:72–220`, `src/scheduler/contract.ts:16–25`), the invocation chain (`src/gateway/invocation.ts:202–373`), `createInvocation` (`src/gateway/index.ts:15–31`) and the composition root (`src/apps/server/index.ts:62–191`).
- Plan 01. `MissionTransitions.claim`, `release` and `loss` (plan 01 "Provides"; task 01.19). The Mission declarations of `SchedulerClaims`, `SchedulerWakeup` and `ExecutionAttribution` (task 01.4, step 2). `unwired.ts`, the `standIns` option and `UNWIRED_SEAMS` (task 01.4, steps 6–9). The attempt reads `mission attempt get` and `list` (task 01.17) for the E2E.
- Plan 02, through `00-index.md` "Seams":
  - `WorkerRegistrations.clientAttributionOf(tx, runtimeIdentity)` and `instanceHealthcheck(tx, runtimeIdentity)`.
  - `WorkerCatalog.declarationOf(workerName)`.
  - `ProjectBindings.workerBindingOf(tx, projectId, resourceIdentity)`.
  - The Worker dependency for `SchedulerClaims.runningExecutionOfRuntime` with its `unwired` entry and its `standIns` fake (decision D9).
  - The machine identity names `projectId` and `resourceIdentity` (`gateway-service.impl.md:221`), which plan 02 takes from the resolver of the ERD 1 claim `binding` (plan 02 task 02.3 and 02.4; decision D26). `kanthord jwt generate --binding <binding row identity>` issues the token (`engine/docs/cli/other.md:603`; `src/apps/server/e2e-worker-app.test.ts:291–305`).
  - `kanthord worker register` over `worker_instance` with runtime identities `worker_instance_<ulid>` (decision D11).
- The E2E also runs `kanthord worker agent enablement disable` of ERD 1 (`src/apps/cli/worker.ts:356`).

## Provides

| Seam                                        | TypeScript signature                                                                                                                                                                                                                                                                                                    | Owner file                                                                     | Consumer plans  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- |
| `ExecutionRow`                              | `{ executionId; projectId; nodeId; workerBindingId; resourceIdentity; runtimeIdentity; attempt: number; pinnedRevision: number; credentials: string[]; expiredAt: number; traceId; rootSpanId; createdAt: number; endedAt: number \| null }`                                                                            | `src/scheduler/contract.ts`                                                    | 01, 02, 04–06   |
| `SchedulerClaims.revoke`                    | `(tx: Transaction, nodeId: string, now: number): string \| null`                                                                                                                                                                                                                                                        | `src/scheduler/contract.ts`                                                    | 01, 04          |
| `SchedulerClaims.settle`                    | `(tx: Transaction, nodeId: string, now: number): void`                                                                                                                                                                                                                                                                  | `src/scheduler/contract.ts`                                                    | 01, 04          |
| `SchedulerClaims.liveExecutionOf`           | `(tx: Transaction, nodeId: string, now: number): ExecutionRow \| null`                                                                                                                                                                                                                                                  | `src/scheduler/contract.ts`                                                    | 01, 04, 06      |
| `SchedulerClaims.runningExecutionOfRuntime` | `(tx: Transaction, runtimeIdentity: string, now: number): ExecutionRow \| null` — settles the expired unsettled row of the runtime identity first                                                                                                                                                                       | `src/scheduler/contract.ts`                                                    | 02              |
| `SchedulerClaims.requireRunning`            | `(tx: Transaction, executionId: string, runtimeIdentity: string, now: number): ExecutionRow` — throws 409 `scheduler.execution.not_running` unless the row is `running` and its claimant is `runtimeIdentity`                                                                                                           | `src/scheduler/contract.ts`                                                    | 04, 05, 06      |
| `pinCredential`, `liveExecutionsPinning`    | `(tx: Transaction, executionId: string, credentialId: string): void`; `(tx: Transaction, credentialId: string): string[]`                                                                                                                                                                                               | `src/scheduler/contract.ts`                                                    | 05              |
| `SchedulerWakeup.wake`                      | `(projectId: string): void` — in memory, after a commit, no transaction                                                                                                                                                                                                                                                 | `src/scheduler/contract.ts`                                                    | 01, 04, Project |
| `ExecutionAttribution.of`                   | `(tx: Transaction, executionId: string): { clientId: string \| null; name: string \| null; workerName: string } \| null`                                                                                                                                                                                                | `src/scheduler/contract.ts`                                                    | 01, 04          |
| `pulling`                                   | `(runtimeIdentity: string): boolean` — in memory; true while a work pull of that runtime identity waits                                                                                                                                                                                                                 | `src/scheduler/contract.ts`                                                    | 02              |
| `TraceIdentity`                             | `{ mint(): { traceId: string; rootSpanId: string } }` — the stand-in of decision D7                                                                                                                                                                                                                                     | `src/scheduler/contract.ts`                                                    | 03, ERD 4       |
| Execution proof                             | `Operation.requiresExecution?: boolean`; `CallerContext.execution?: ExecutionClaim` with `ExecutionClaim = { executionId; projectId; nodeId; attempt; pinnedRevision; runtimeIdentity; workerBindingId }`; `createInvocation({ lookups: { scheduler: { executionOf(executionId): ExecutionProofRow \| undefined } } })` | `src/kernel/operation.ts`, `src/gateway/invocation.ts`, `src/gateway/index.ts` | 04, 05, 06, 08  |
| `testMachineIdentity`                       | `(fields, jti, runtimeIdentity?) => MachineIdentity` for colocated tests                                                                                                                                                                                                                                                | `src/kernel/test-identity.ts`                                                  | 03–06           |

The `ExecutionRow` return of `liveExecutionOf` is a superset of the `{ executionId }` that plan 01 declares, so the Mission type accepts it. `requireRunning` and `pulling` are new seams beside the index sketch.

## Tasks

### 03.1 Create the migration of `scheduler_execution`

- Files: `src/scheduler/migrations.ts` (edit), `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Append the migration `createExecutionTable` to `schedulerMigrations` after `createJobTable` (`src/scheduler/migrations.ts:3–15`). Do not change migration 1.
  2. Create the table with these exact columns in this order: `id TEXT NOT NULL PRIMARY KEY`, `project_id TEXT NOT NULL`, `node_id TEXT NOT NULL`, `worker_binding_id TEXT NOT NULL`, `resource_identity TEXT NOT NULL`, `runtime_identity TEXT NOT NULL`, `attempt INTEGER NOT NULL`, `pinned_revision INTEGER NOT NULL`, `credentials TEXT NOT NULL`, `expired_at INTEGER NOT NULL`, `trace_id TEXT NOT NULL`, `root_span_id TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `ended_at INTEGER`.
  3. Create `CREATE UNIQUE INDEX scheduler_execution_node_live ON scheduler_execution (node_id) WHERE ended_at IS NULL` and `CREATE UNIQUE INDEX scheduler_execution_runtime_live ON scheduler_execution (runtime_identity) WHERE ended_at IS NULL`.
  4. In `src/apps/server/migrations.test.ts`, add the constant `SCHEDULER_EXECUTION_TABLE`, add it to the scheduler table list of the ownership checks, and add it to the combined table assertion that plans 01 and 02 extend.
  5. Add a test that reads `sqlite_master` and asserts the two index names, each with `UNIQUE` and `WHERE ended_at IS NULL` in its SQL, and that no other index of `scheduler_execution` exists.
- Rules:
  - The columns and their nullability equal the diagram; only `ended_at` is null before a terminal write. `02-execution.md:59–74`.
  - The two partial unique indexes are the only indexes of the table. `02-execution.md:206–207`; root `AGENTS.md` "Database design".
  - No `REFERENCES` clause: every reference of the table holds no foreign key. `02-execution.md:133–135`, `:298–306`; decision D24.
  - No SQL `CHECK`. No claim state column. `02-execution.md:227`; root `AGENTS.md` "Database design".
  - `project_id` is the second key column. Decision D24; root `AGENTS.md` "Database design".
  - Never edit a published migration. `engine/AGENTS.md` "Add a migration".
- Done when: `pnpm run verify` passes; the migration test lists `scheduler_execution` and the two partial unique indexes.

### 03.2 Add the Scheduler configuration fragment

- Files: `src/scheduler/config.ts` (create), `src/scheduler/index.ts` (edit), `src/scheduler/service.ts` (edit), `src/config/index.ts` (edit), `src/config/index.test.ts` (edit), `src/apps/server/index.ts` (edit), `engine/docs/cli/other.md` (edit)
- Do:
  1. In `src/scheduler/config.ts`, declare `SchedulerConfig { releaseReserve: number }` and `schedulerConfigSchema` with `releaseReserve`: a format that accepts a positive safe integer only, as `gateway.idempotencyTtl` does (`src/gateway/config.ts:52–62`), default `DEFAULT_RELEASE_RESERVE_SECONDS = 600`.
  2. Export `schedulerConfigSchema` and `type SchedulerConfig` from `src/scheduler/index.ts` in place of the empty object (`:3`).
  3. Change `Dependencies.config` of `SchedulerService` (`src/scheduler/service.ts:67–70`) to `SchedulerConfig`.
  4. In `src/config/index.ts`, add `scheduler: schedulerConfigSchema` to `fragments` (`:47–52`) and `scheduler: SchedulerConfig` to `ServerConfig` (`:29–32`).
  5. In `src/apps/server/index.ts`, pass `options.config.scheduler` to `SchedulerService` (`:94–97`).
  6. In `src/config/index.test.ts`, assert the default `600`, the key list of the section, and the refusal of `0`, `-1`, `1.5` and a string with the field path in the message.
  7. In `engine/docs/cli/other.md` "Document and field validation" (`:328–350`), add the implemented field `scheduler.releaseReserve` with its format and default.
- Rules:
  - `scheduler.releaseReserve` is a positive safe integer in seconds and defaults to 600. `scheduler-service.impl.md:82–83`; `architecture.impl.md:325`.
  - A service reads no configuration itself; the root passes the parsed section. `architecture.impl.md` "The sections of the file".
  - The steps to add a field. `engine/AGENTS.md` "Add a configuration field".
- Done when: `pnpm run verify` passes; `kanthord config init` writes `scheduler.releaseReserve: 600`.

### 03.3 Declare the execution contract and the consumed collaborations

- Files: `src/scheduler/contract.ts` (edit), `src/scheduler/contract.test.ts` (create), `src/scheduler/service.ts` (edit), `src/scheduler/service.test.ts` (edit), `src/scheduler/test-support.ts` (create), `src/kernel/test-identity.ts` (edit), `src/apps/server/index.ts` (edit)
- Do:
  1. Declare `EXECUTION_IDENTITY_PREFIX = "execution"`, `WORKER_INSTANCE_IDENTITY_PREFIX = "worker_instance"`, `WORK_PULL_TIMEOUT_MS = 120000`, `WORK_PULL_WAIT_MS = 90000` and `LOSS_SWEEP_INTERVAL_MS = 30000`.
  2. Declare the closed sets as `as const` objects with a `z.enum` schema and a type each: `ClaimState` (`running`, `lost`, `finished`); `WorkPullKind` (`claimed`, `no-work`); `ClaimNodeState` (`Available`, `Waiting`, `External.Requested`); `NodeFormatField` (`name`, `requirement`, `criterion`, `verifications`, `bindings`).
  3. Declare `traceIdSchema` (`/^[0-9a-f]{32}$/`, refine not all zero) and `spanIdSchema` (`/^[0-9a-f]{16}$/`, refine not all zero).
  4. Declare with `z.strictObject`: `claimantSchema` `{ workerBindingId: identitySchema("binding"), resourceIdentity: z.string().min(1), runtimeIdentity: identitySchema("worker_instance"), clientId: identitySchema("client_identity").optional(), name: nonblank 1–64 characters optional }`; `executionRecordSchema` `{ executionId, projectId, nodeId, claimant, attempt, pinnedRevision, credentials: identitySchema("credential")[], claimState, expiredAt, createdAt, endedAt: timestamp nullable, traceId, rootSpanId }` with positive safe integers for `attempt` and `pinnedRevision` and `timestamp` of `src/kernel/json.ts:5`; `workPullSchema` `{ resourceIdentity: z.string().min(1), runtimeIdentity: identitySchema("worker_instance") }`; `workPullResultSchema` as the discriminated union of `{ kind: "claimed", execution }` and `{ kind: "no-work" }`; `executionReleaseSchema` `{ furtherWork: z.boolean() }`; `releaseResultSchema` `{ executionId, endedAt }`.
  5. Declare the row type `ExecutionRow` of the Provides table and the provided interfaces `SchedulerClaims`, `SchedulerWakeup` and `ExecutionAttribution` with the signatures of the Provides table, with method syntax.
  6. Declare the consumed interfaces inline, with method syntax:
     ```ts
     export interface MissionTransitions {
       claim(
         tx: Transaction,
         nodeId: string,
         declaredStates: readonly string[],
         opener: {
           kind: "execution";
           executionId: string;
           clientId: string | null;
           name: string | null;
         },
         now: number,
       ): {
         kind: string;
         projectId: string;
         attempt: number;
         nodeRevision: number;
       } | null;
       release(
         tx: Transaction,
         execution: { executionId: string; nodeId: string; attempt: number },
         furtherWork: boolean,
         now: number,
       ): void;
       loss(
         tx: Transaction,
         nodeId: string,
         consecutiveLosses: number,
         now: number,
       ): void;
     }
     export interface InstanceRegistrations {
       clientAttributionOf(
         tx: Transaction,
         runtimeIdentity: string,
       ): { clientId: string; name: string } | null;
       instanceHealthcheck(tx: Transaction, runtimeIdentity: string): boolean;
     }
     export interface WorkerDeclarations {
       declarationOf(workerName: string): {
         declaredNodeStates: readonly string[];
         requiredNodeFormat: readonly string[];
         resourceBudget: { wallTimeMs: number };
       } | null;
     }
     export interface WorkerBindings {
       workerBindingOf(
         tx: Transaction,
         projectId: string,
         resourceIdentity: string,
       ): {
         bindingId: string;
         workerName: string;
         instanceCount: number;
         resourceBudget?: { wallTimeMs: number } | null;
         tombstone: boolean;
       } | null;
     }
     export interface TraceIdentity {
       mint(): { traceId: string; rootSpanId: string };
     }
     ```
  7. Add `store: Store`, `transitions`, `registrations`, `declarations`, `bindings` and `traceIdentity` to `Dependencies` of `SchedulerService` as required fields, and keep them as private fields.
  8. In `src/apps/server/index.ts`, pass `store: options.store`, the thunks `transitions: { claim: (...a) => mission.claim(...a), release: …, loss: … }`, `registrations: { clientAttributionOf, instanceHealthcheck }` over the `WorkerRegistrations` seam of plan 02, `declarations: { declarationOf }` over the `WorkerCatalog.declarationOf` seam of plan 02, `bindings: { workerBindingOf: (tx, p, r) => project.workerBindingOf(tx, p, r) }`, and `traceIdentity: { mint: () => ({ traceId: randomBytes(16).toString("hex"), rootSpanId: randomBytes(8).toString("hex") }) }` from `node:crypto`.
  9. Add `testMachineIdentity(fields, jti, runtimeIdentity?)` to `src/kernel/test-identity.ts` over `mintMachineIdentity` of `src/kernel/caller-mint.ts`, unless plan 02 already added it.
  10. In `src/scheduler/test-support.ts`, export `schedulerHarness(t, overrides)`: it migrates an in-memory store with `schedulerMigrations`, constructs `SchedulerService` with fakes that record every call, declares the operations and answers `invoke(key, input, caller)`, which parses the input and the output through the schemas of `schedulerOperations[key]` around the registered handler. The module imports no `test-identity.ts`.
  11. Update `makeScheduler` of `src/scheduler/service.test.ts` with the new required fields.
  12. In `contract.test.ts`, assert that every input schema refuses an unknown key, that `workPullSchema` refuses a bare ULID and the prefix `runtime_identity`, that `executionRecordSchema` refuses `null` for `claimant.clientId` and accepts the record without `clientId` and `name`, and that `traceIdSchema` refuses 32 zeros, upper case and 31 characters.
- Rules:
  - A collaboration type is declared inline in the own `contract.ts`; the composition root is the only file that imports cross-service types. `00-index.md` "Collaboration-type contract rule"; `src/project/service.ts:16`.
  - Every collaboration is required. Decision D4.
  - Method syntax keeps the Mission method with `readonly NodeState[]` assignable to `readonly string[]`, as plan 01 task 01.4 does.
  - A construction cycle uses a thunk. `architecture.impl.md:435`.
  - `ExecutionRecord`, `claimant`, `WorkPull`, `ExecutionRelease` and the release answer. `scheduler-service.impl.md:34–50`; `engine/docs/cli/scheduler.md:236–239`, `:341–352`, `:373–375`, `:405–406`.
  - `traceId` and `rootSpanId` are 32 and 16 lower-case hexadecimal characters, never all zero. `tracking-service.impl.md:23`; `scheduler-service.impl.md:44`; decision D7.
  - The production stand-in of `TraceIdentity` mints from `node:crypto`. Decision D7; ruling R2.
  - The claim states and the node states that admit a claim are closed sets. `scheduler-service.md:222–226`; `scheduler-service.vocabulary.md:22–27`.
  - The required node format is the closed set of five fields. `worker-service.vocabulary.md:276–285`.
  - Every field name equals the CLI page and the vocabulary sibling. Root `AGENTS.md` "Contracts".
- Done when: `pnpm run verify` passes; `contract.test.ts` passes; every ERD 1 Scheduler test passes.

### 03.4 Add the execution store and the record mapping

- Files: `src/scheduler/execution-store.ts` (create), `src/scheduler/execution-store.test.ts` (create)
- Do:
  1. Implement `insertExecution(tx, row)`, `readExecution(tx, executionId)`, `readUnendedOfNode(tx, nodeId)`, `readUnendedOfRuntime(tx, runtimeIdentity)`, `readExpiredUnsettled(tx, now)` (every row with `ended_at IS NULL AND expired_at <= now`, ordered by `id`), `countRunningOfGroup(tx, projectId, resourceIdentity, now)`, `endExecution(tx, executionId, now)` (sets `ended_at` where it is null and asserts one changed row) and `listExecutions(tx, projectId, filter, after, count)`.
  2. `listExecutions` filters by `project_id`, then by `node_id` when `filter.nodeId` is set and by `attempt` when `filter.attempt` is set, orders by `id DESC` and reads `count + 1` rows.
  3. Implement `claimStateOf(row, now)`: `running` when `endedAt` is null and `now < expiredAt`; `lost` when `endedAt` is null and `now >= expiredAt`, or `endedAt >= expiredAt`; `finished` when `endedAt < expiredAt`.
  4. Implement `executionRecord(tx, registrations, row, now)`. Map the columns to the fields of `executionRecordSchema`. Set `claimant` to `{ workerBindingId, resourceIdentity, runtimeIdentity }` plus `clientId` and `name` from `registrations.clientAttributionOf(tx, runtimeIdentity)` when it answers a value.
  5. Store `credentials` as `canonicalJSON` (`src/kernel/json.ts:12`) of the array and parse it on read.
  6. Add tests: each claim state before, at and after the deadline, with and without `ended_at`; a second unended row of one node fails at the partial unique index; a second unended row of one runtime identity fails; `endExecution` twice asserts; the list filters, the order and the page bound; the record without attribution holds no `clientId` and no `name`; a record of an ended registration keeps its attribution.
- Rules:
  - The claim state is derived at each read and never stored. `02-execution.md:227`; `scheduler-service.md:221–226`.
  - Equality with `expired_at` is a loss. `02-execution.md:216`; `scheduler-service.md:236`.
  - The claimant attribution comes from the registration of the runtime identity, also after deregistration, and is absent for a hosted instance. `scheduler-service.md:155`; `scheduler-service.impl.md:35`; `worker-service.impl.md:158`.
  - A list orders by `executionId` descending in every mode. `scheduler-service.impl.md:54`; `architecture.impl.md:181`.
  - The live executions of a binding are the `running` rows of the group, whatever revision each row pins. `02-execution.md:208`.
  - No sweep deletes an execution row, and no function of the module deletes one. `02-execution.md:226`; `scheduler-service.impl.md:104`.
  - A JSON list column holds a canonical JSON array with no duplicate. Decision D21.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.5 Add the loss declaration, the settlement and the revocation

- Files: `src/scheduler/settlement.ts` (create), `src/scheduler/settlement.test.ts` (create), `src/scheduler/service.ts` (edit)
- Do:
  1. Implement `declareLoss(tx, dependencies, row, now)`. Call `endExecution(tx, row.id, now)`. Count the lost rows of `(node_id, attempt)` whose `ended_at` is greater than the greatest `ended_at` of a finished row of that attempt, or every lost row when the attempt holds no finished row. Call `transitions.loss(tx, row.node_id, count, now)`.
  2. Implement `settleNode(tx, dependencies, nodeId, now)` and `settleRuntime(tx, dependencies, runtimeIdentity, now)`: each reads the unended row, and when `expired_at <= now` it calls `declareLoss`.
  3. Implement `revoke(tx, nodeId, now)`: for the unended row of the node with `now < expired_at`, call `endExecution` and answer its identity; else answer null.
  4. Implement `liveExecutionOf(tx, nodeId, now)`: the unended row of the node when `now < expired_at`, else null.
  5. Implement `runningExecutionOfRuntime(tx, runtimeIdentity, now)`: `settleRuntime` first, then the unended row of the runtime identity when it is `running`, else null.
  6. Implement `requireRunning(tx, executionId, runtimeIdentity, now)`: answer the row when it exists, its `runtime_identity` equals `runtimeIdentity`, `ended_at` is null and `now < expired_at`; else throw `OperationError(409, "scheduler.execution.not_running", …)`.
  7. Expose the five functions as the `SchedulerClaims` methods of `SchedulerService`.
  8. Add tests with a fake `transitions`: a loss at the start reading sets `ended_at` to that reading and calls `loss` once; the count after a finished row, after a revocation and with no finished row; a revocation before expiry answers the identity, sets `finished` and calls no `loss`; a revocation at or after expiry answers null and ends nothing; `settleNode` on a running row changes nothing; `runningExecutionOfRuntime` settles an expired row and answers null; `requireRunning` refuses another runtime identity, an ended row and a reading equal to `expired_at`.
- Rules:
  - The loss declaration sets `ended_at` to the clock reading of its transaction, counts the lost rows of the attempt after its latest finished row and hands the count to the Mission Service in that transaction. `02-execution.md:222`; `scheduler-service.impl.md:89–100`.
  - A release ends the count, and a revocation is a finished row. `02-execution.md:222`, `:227`; `scheduler-service.md:226`.
  - A loss closes no attempt; the Mission Service owns the node transition. `scheduler-service.md:261`; plan 01 task 01.19.
  - A claim, the work-pull lookup, the registration resume and every Mission transition settle each expired unsettled row that they meet. `02-execution.md:223`; `scheduler-service.md:242–245`.
  - A revocation before expiry sets `ended_at` in the Mission transaction and counts as no loss; a revocation of a lost claim takes effect at the expiry. `02-execution.md:224`; `scheduler-service.md:208–210`.
  - The pull lookup and the registration resume read a `running` execution, never a null `ended_at` alone. `02-execution.md:223`; `worker-service.impl.md:210–212`.
  - Every execution mutation repeats the full proof in its write transaction; a failed check answers 409 `scheduler.execution.not_running`. `02-execution.md:216`; `scheduler-service.md:231–237`; `engine/docs/cli/scheduler.md:499`.
  - The end of a registration ends no execution row. `02-execution.md:225`.
  - A collaboration takes the caller transaction and opens none. `architecture.impl.md:592–598`.
  - Gap: the count scans every execution row of the node; the scan stays an open HANDOFF item (`docs/brainstorm/HANDOFF.md:29`; decision D18).
- Done when: `pnpm run verify` passes; the tests pass.

### 03.6 Add the execution proof to the invocation chain

- Files: `src/kernel/operation.ts` (edit), `src/kernel/operation.test.ts` (edit), `src/gateway/invocation.ts` (edit), `src/gateway/index.ts` (edit), `src/gateway/invocation.test.ts` (edit), `src/scheduler/service.ts` (edit), `src/apps/server/index.ts` (edit)
- Do:
  1. In `src/kernel/operation.ts`, add `requiresExecution?: boolean` to `Operation` beside `requiresRegistration` (`:54`). Declare `ExecutionClaim { executionId; projectId; nodeId; attempt; pinnedRevision; runtimeIdentity; workerBindingId }` and `ExecutionProofRow = ExecutionClaim & { endedAt: number | null; expiredAt: number }`. Add `execution?: ExecutionClaim` to `CallerContext` (`:64–75`).
  2. In `OperationRegistry.register` (`:89–142`), refuse `requiresExecution: true` on an operation whose access is not `client`, and on an operation with `requiresRegistration: false`.
  3. In `src/gateway/invocation.ts`, declare `ExecutionLookup { executionOf(executionId: string): ExecutionProofRow | undefined }` and take it as an optional fifth constructor argument of `Invocation` (`:54–64`).
  4. In `execute` (`:202–373`), after the registration check (`:265–275`) and before the idempotency reservation (`:276`), run the proof for an operation with `requiresExecution: true`. Take the execution identity from `input.params.executionId` when it is a string, else from `input.body.executionId`. Read the row through the lookup. Require a machine identity, a row, `row.runtimeIdentity === identity.runtimeIdentity`, `row.endedAt === null` and `Date.now() < row.expiredAt`. A failure throws `GatewayError(403, "gateway.invocation.execution_proof_failed", "The execution is not a live claim of this registration.")`. On success set `caller.execution` to the `ExecutionClaim` fields of the row.
  5. In `createInvocation` (`src/gateway/index.ts:15–31`), accept `lookups.scheduler?: ExecutionLookup` and pass it to `Invocation`.
  6. Implement `executionOf(executionId)` in `SchedulerService`: one `store.transaction` read of the row, as `resolveWorkerBinding` does (`src/project/service.ts:565–583`).
  7. In `src/apps/server/index.ts`, add `scheduler: { executionOf: (id) => scheduler.executionOf(id) }` to `lookups` (`:84–92`).
  8. Add invocation tests with a test operation and a fake lookup: the handler receives `caller.execution`; each failure answers 403 before the handler (an absent row, another runtime identity, an ended row, a reading equal to `expired_at`, a human identity, a machine identity without a registration); a proof failure reserves no idempotency key. Complete a release-shaped test mutation with key K, end its row in the fake lookup, and retry with the same identity, key K and payload: the answer is 403 `gateway.invocation.execution_proof_failed` and no replay of the recorded success. Add registry tests for the two refusals of step 2.
- Rules:
  - The chain proves the execution identity once before the handler: the claimant equals the runtime identity of the live registration that the machine identity names, `ended_at` is null and the time is before `expired_at`. `architecture.impl.md:646–653`; decision D10.
  - A failed proof answers 403 `gateway.invocation.execution_proof_failed` before the handler runs. `architecture.impl.md:655`.
  - The chain passes the node, the attempt and the pinned revision of the claim to the handler, and the handler reads none of them from the input. `architecture.impl.md:654`; decision D10.
  - A release retry after the end meets the refusal of the proof, so the proof precedes the replay of the idempotency record. `scheduler-service.impl.md:68–69`, `:137`; `02-execution.md:218`.
  - The proof establishes ownership and liveness and grants no operation authority. `architecture.impl.md:659`.
  - The chain reads the row outside the handler transaction, as the registration lookup does. Decisions D10, D11.
  - Gap: `gateway.invocation.execution_proof_failed` stands on no error table of `engine/docs/cli/`; Aelita adds the row to `engine/docs/cli/other.md` "Error codes" before the commit of this plan.
  - Gap: two live processes of one machine JWT pass every proof; Ulrich accepts the risk until the B9 item lands (`docs/brainstorm/HANDOFF.md:115`).
- Done when: `pnpm run verify` passes; the new invocation and registry tests pass; every ERD 1 gateway test passes unchanged.

### 03.7 Implement the claim transaction

- Files: `src/scheduler/claim.ts` (create), `src/scheduler/claim.test.ts` (create)
- Do:
  1. Declare the closed set `ClaimOutcome` (`running`, `claimed`, `refused`, `none`) and implement `claimOnce(tx, dependencies, identity, pull, now): { outcome: ClaimOutcome; row: ExecutionRow | null; settled: boolean }` in this order:
     1. Call `settleRuntime(tx, dependencies, pull.runtimeIdentity, now)` and set `settled` when it declared a loss. Read the unended row of the runtime identity; when it is `running`, answer `running` with that row and write nothing more.
     2. Call `registrations.instanceHealthcheck(tx, runtimeIdentity)`. False answers `refused` before any claim write.
     3. Read `bindings.workerBindingOf(tx, identity.projectId, identity.resourceIdentity)`. Null, a tombstone or `instanceCount < 1` answers `none`.
     4. Read `declarations.declarationOf(binding.workerName)` and assert a value. Assert that every field of `requiredNodeFormat` is a member of `NodeFormatField`.
     5. When `countRunningOfGroup(tx, projectId, resourceIdentity, now) >= binding.instanceCount`, answer `none`.
     6. Mint `executionId = createIdentity("execution")`. Read the jobs of the project in the order `priority DESC, id ASC`. For each job, call `settleNode(tx, dependencies, nodeId, now)`, then `transitions.claim(tx, nodeId, declaration.declaredNodeStates, { kind: "execution", executionId, clientId: identity.clientId, name: identity.name }, now)`. Take the first non-null answer. With no answer, answer `none`.
     7. Assert that the answer names the project of the identity. Mint the trace values with `traceIdentity.mint()` and assert them with `traceIdSchema` and `spanIdSchema`.
     8. Insert the row: `project_id`, `node_id`, `worker_binding_id = binding.bindingId`, `resource_identity`, `runtime_identity`, `attempt` and `pinned_revision` from the answer, `credentials = []`, `expired_at = now + wallTimeMs + 1000 × config.releaseReserve` with `wallTimeMs = binding.resourceBudget?.wallTimeMs ?? declaration.resourceBudget.wallTimeMs`, `trace_id`, `root_span_id`, `created_at = now`, `ended_at = null`. Answer `claimed` with the row.
  2. `claimOnce` writes only through the transaction and its Kind 2 collaborations. It calls no client, no wakeup and no timer, so a rollback undoes every effect of it.
  3. Add tests with fakes: a steps claim and an evaluation claim of the declared states; the job order by priority and by identity; a stale job (`claim` answers null) is skipped; a running row of the runtime identity answers `running` and calls no `claim`; an expired row of the runtime identity is settled before the admission and sets `settled`; a binding at its count, a tombstone and `instanceCount: 0` answer `none`; the deadline from a binding override of `wallTimeMs`, from the catalog default and with the reserve `600`; a later configuration change leaves an inserted deadline unchanged; a failed healthcheck answers `refused` with no claim write; a job whose node holds an expired unended row settles that row before `claim`; the row holds no claim kind.
- Rules:
  - The work pull settles the expired row of its runtime identity, then answers its `running` row and inserts nothing. `02-execution.md:214`; `scheduler-service.impl.md:58–63`.
  - The claim admits a node only in a state that the worker of the binding declares, and the Mission Service rechecks the state and the condition. `02-execution.md:212`; `scheduler-service.md:174–179`.
  - A stale job suggests a node and never authorizes it. `scheduler-service.md:67`.
  - The claim reads the latest row of the group through the Project Service in its transaction, and `worker_binding_id` holds that row. `02-execution.md:210`; `scheduler-service.impl.md:36`.
  - The claim admits an execution only while the live executions of the binding are fewer than its instance count; an instance count of 0 makes the binding unavailable. `02-execution.md:195`, `:209`; `scheduler-service.md:188–189`.
  - The deadline is `created_at + wallTimeMs + 1000 × scheduler.releaseReserve` from the pinned binding row, and nothing moves it. `02-execution.md:215`; `scheduler-service.impl.md:84–87`; `worker-service.impl.md:445–451`.
  - The claim transaction inserts the row, and the Mission Service sets the state, opens attempt 1 when the node holds none and deletes the job in the same transaction; `attempt` and `pinned_revision` equal the open attempt and its revision. `02-execution.md:213`.
  - The row holds no kind. `02-execution.md:212`; root `AGENTS.md` "Rejected proposals".
  - The opener of an attempt that a claim opens is the execution. `02-execution.md:234`; plan 01 task 01.19.
  - The instance healthcheck is taken for the claim and once more immediately before the commit; a failed check returns the pull empty. Each probe of task 03.9 takes the check for the pull, and the commit transaction takes it once more; no other transaction runs between that check and the commit. `scheduler-service.md:101`, `:143–144`; `worker-service.md:209`; `.dev/erd-02/decisions-log.md` 2026-09-30.
  - The Mission content schema requires every field of the required node format (`src/mission/contract.ts:177–183`), and every worker requires that same closed set, so the claim checks the format of the declaration once and reads no revision. `worker-service.vocabulary.md:276–285`; `worker-service.md:36`.
  - The claim serializes with every other write, because every write is one `BEGIN IMMEDIATE` transaction on one connection. `scheduler-service.md:147`; `architecture.impl.md` "The connection and the transaction".
  - Gap: the processor pool and its fairness bound have no numeric value (`docs/brainstorm/HANDOFF.md:35`); the claim reads the jobs of one project in one transaction.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.8 Add the wakeups and the waiting pulls

- Files: `src/scheduler/wakeup.ts` (create), `src/scheduler/wakeup.test.ts` (create), `src/scheduler/service.ts` (edit)
- Do:
  1. Implement the class `WaitingPulls`. `park(projectId, runtimeIdentity, remainingMs, context): Promise<void>` adds one waiter to the project set in arrival order and resolves on the first of a wakeup of the project, the end of `remainingMs` and the cancellation of `context`. It removes the waiter on resolution and clears its timer.
  2. `wake(projectId)` coalesces: it schedules one `setImmediate` per project while none is scheduled, and that callback resolves every waiter of the project in arrival order. A project with no waiter schedules nothing.
  3. `wakeAll()` resolves every waiter. `pulling(runtimeIdentity)` answers whether a waiter of that runtime identity exists. `size()` answers the count of waiters.
  4. Expose `wake` and `pulling` on `SchedulerService`.
  5. Add tests: two wakes before the callback resolve each waiter once; the arrival order holds; a wake of another project resolves nothing; the timer and the cancellation resolve the waiter and remove it; `pulling` is true only while the waiter exists; no timer remains after resolution.
- Rules:
  - The Scheduler coalesces the wakeups of the Mission Service and serves the waiting pulls of the project by the order of the work queue. `scheduler-service.md:29`, `:116`; decision D20.
  - Waiting holds no lock, no processor permit and no node reservation. `scheduler-service.md:122`.
  - The wakeup is an in-process notification after a commit and takes no transaction. `mission-service.md:691–692`; `00-index.md` "Seams".
  - A waiting pull of an instance shows as the activity `pulling`. `worker-service.impl.md:189`.
  - The count of waiters is bounded by the live registrations, because an instance holds at most one outstanding pull. `worker-service.md:203`; `scheduler-service.md:123`.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.9 Implement `scheduler.work.pull` with its CLI leaf

- Files: `src/scheduler/contract.ts`, `src/scheduler/service.ts`, `src/scheduler/work-pull.ts` (create), `src/scheduler/work-pull.test.ts` (create), `src/apps/cli/scheduler.ts`, `src/apps/cli/scheduler-execution.ts` (create), `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/scheduler/*` (regenerated)
- Do:
  1. Declare `workPull` in `schedulerOperations`: id `scheduler.work.pull`, `POST /api/scheduler/work/pull`, access `client`, `lifetime: OperationLifetime.Wait`, `timeoutMs: WORK_PULL_TIMEOUT_MS`, `mutation: true`, `body: true`, input `{ params: {}, query: {}, body: workPullSchema }`, output `workPullResultSchema`.
  2. Implement `workPull(input, caller)` in `work-pull.ts`:
     1. Require a machine identity. When `body.runtimeIdentity !== identity.runtimeIdentity` or `body.resourceIdentity !== identity.resourceIdentity`, throw `OperationError(403, "scheduler.work.claimant_mismatch", …)` (code: proposed).
     2. Set the deadline of the window to `performance.now() + WORK_PULL_WAIT_MS`.
     3. Probe. Run `store.transaction((tx) => { throw new Probe(claimOnce(tx, …, Date.now())) })` and catch only `Probe`. The probe always rolls back, so it commits no row, no settlement and no Mission write.
     4. Commit when the probe answers `running`, `claimed` or `refused`, when it sets `settled`, when the window ends, or when quiescence starts. In the same synchronous tick, with no `await` after the probe, call `caller.commit((tx) => answerOf(claimOnce(tx, …, Date.now())))` once. `answerOf` maps `running` and `claimed` to `{ kind: "claimed", execution: executionRecord(…) }`, and `refused` and `none` to `{ kind: "no-work" }`. The commit keeps the settlement of the runtime identity. After quiescence starts, the commit answers `{ kind: "no-work" }` with the settlement alone.
     5. Else await `WaitingPulls.park(projectId, runtimeIdentity, remaining, caller.context)`, then probe again. Each probe takes a fresh instance healthcheck.
     6. When `caller.context` is cancelled before the commit, throw `OperationError(503, "gateway.invocation.cancelled", "Request cancelled.")`. No row commits, so no accepted claim ends.
     7. After a commit that settled a loss, call `wake(projectId)`.
  3. Register the handler in `declare` (`src/scheduler/service.ts:111–127`). Keep the ownership assertion and extend it to the new access policies.
  4. Add a harness test that spies on `caller.commit`: every path of the handler calls it at most once, and a cancelled pull calls it never.
  5. In `src/apps/cli/scheduler-execution.ts`, export `addExecutionCommands(scheduler: Command)` and call it from `addSchedulerCommand` (`src/apps/cli/scheduler.ts:84–123`). Change the group `--token` description to "JWT (otherwise KANTHORD_TOKEN or cli.yaml)". Add the leaf `work pull --file <path> [--idempotency-key <key>]`. It reads the file with `readJsonFileAs(path, workPullSchema)`, resolves the key with `resolveKey`, requires a token with `cli.scheduler.work.pull.token_required`, calls `workPull` and prints the result with `idempotencyKey` through `handleMutationResult` with `cli.scheduler.work.pull.indeterminate`.
  6. Regenerate OpenAPI with `pnpm run build && node bin/kanthord.mjs gateway openapi`. In `openapi-integration.test.ts`, assert the operation id of the route and the `kind` discriminator of the 200 answer.
  7. Add handler tests with the harness: a claim at the first try; a parked pull that a wake of its project serves; a wake of another project serves nothing; two parked pulls of one project and one job: the first waiter claims and the second parks again; the window end answers `no-work` and commits the settlement; a probe that settles a loss commits at once and claims the node that the loss returns to `Available`; a probe after a wake takes a fresh healthcheck, and a failed check answers `no-work` at once with no claim; a probe leaves no row, no job change and no attempt; the cancellation commits nothing; a mismatch of each field answers `scheduler.work.claimant_mismatch`; a pull after `quiesce` answers `no-work`; a lost answer repeated with the same key and with a new key answers the same execution and inserts no second row; a pull of another runtime identity of the binding never receives that execution.
- Rules:
  - The route, the access, the lifetime, the timeout of 120 s and the wait window of 90 s. `scheduler-service.impl.md:24`; `gateway-service.impl.md:300`; `engine/docs/cli/scheduler.md:170`, `:241`.
  - `WorkPull` holds `resourceIdentity` and `runtimeIdentity`; the resource identity equals that of the machine identity and the runtime identity equals its live registration. `scheduler-service.impl.md:45`; `engine/docs/cli/scheduler.md:236–239`.
  - The answer is `{ kind: "claimed", execution }` or `{ kind: "no-work" }`, each with HTTP 200. `scheduler-service.impl.md:46`; `engine/docs/cli/scheduler.md:276–281`.
  - The Scheduler parks a pull that finds no work for at most 90 s, and a wakeup, an ended execution or a Mission write rechecks every admission condition. `engine/docs/cli/scheduler.md:241`; `scheduler-service.md:121–129`.
  - The handler calls `caller.commit` once, at the end, after its asynchronous waits; the probes are rolled-back transactions of the same store with no effect outside the database. `architecture.impl.md:696–698`; decision D3; `.dev/erd-02/decisions-log.md` 2026-09-30 "the wait mechanism of the work pull" (debate, 2 rounds, `review:Ulrich`).
  - Nothing interleaves between the probe and the commit, because one connection runs every transaction synchronously and the handler awaits nothing between them. `architecture.impl.md:106–118`, `:696`.
  - The work-pull lookup settles the expired row of its runtime identity before its precondition in the transaction that commits; a probe that meets such a row commits at once. `02-execution.md:214`, `:223`; `scheduler-service.md:242–244`.
  - Cancellation ends the wait and no accepted claim. `scheduler-service.impl.md:24`; `architecture.impl.md:632–634`. The cancelled answer is 503 `gateway.invocation.cancelled` (`engine/docs/cli/other.md:791`; ERD 1 wait precedent `src/gateway/lifetime.test.ts:92–137`).
  - Gap: an accepted delivery rechecks a waiting pull through the wakeup after the Mission commit of the delivery admission, which ERD 3 delivers (`scheduler-service.md:127`; `00-index.md` "Scope").
  - Server shutdown stops new claims; the Gateway cancels waiting pulls in phase 1. `architecture.impl.md:460–461`; `scheduler-service.md:33`.
  - An empty pull opens no attempt, creates no execution and counts no live execution. `scheduler-service.md:124`.
  - A caller cannot widen its scope with another identifier. `scheduler-service.md:97`; `engine/docs/cli/scheduler.md:97–99`.
  - Code `scheduler.work.claimant_mismatch` (403): proposed in `00-index.md` "Codes for Ulrich". The condition stands at `scheduler-service.impl.md:45` and `engine/docs/cli/scheduler.md:238–239`. No code of `engine/docs/cli/other.md` covers it: `gateway.registration.required` covers only a machine without a registration (`other.md:804`).
  - The CLI codes `cli.scheduler.work.pull.token_required` and `cli.scheduler.work.pull.indeterminate` follow the shared forms. `engine/docs/cli/other.md:834–835`.
  - The task that declares a route adds its CLI leaf and regenerates OpenAPI. ERD 1 decision D13.
- Done when: `pnpm run verify` passes; the tests pass; `kanthord scheduler work pull --help` exits 0.

### 03.10 Implement `scheduler.execution.release` with its CLI leaf

- Files: `src/scheduler/contract.ts`, `src/scheduler/service.ts`, `src/scheduler/release.ts` (create), `src/scheduler/release.test.ts` (create), `src/apps/cli/scheduler-execution.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/scheduler/*` (regenerated)
- Do:
  1. Declare `executionRelease`: id `scheduler.execution.release`, `POST /api/scheduler/execution/:executionId/release`, access `client`, `lifetime: Unary`, `timeoutMs: SCHEDULER_TIMEOUT_MS`, `mutation: true`, `body: true`, `requiresExecution: true`, params `{ executionId: identitySchema("execution") }`, body `executionReleaseSchema`, output `releaseResultSchema`.
  2. Implement the handler. Inside one `caller.commit`, read the clock once. Call `requireRunning(tx, caller.execution.executionId, caller.execution.runtimeIdentity, now)`. Call `transitions.release(tx, { executionId, nodeId, attempt }, body.furtherWork, now)`. Call `endExecution(tx, executionId, now)`. Answer `{ executionId, endedAt: now }`. After the commit, call `wake(projectId)`.
  3. Add the leaf `execution release <execution-id> --file <path> [--idempotency-key <key>]`. It validates the identity with `cli.scheduler.execution.release.invalid_execution_id` (code: proposed), reads the file with `executionReleaseSchema`, and uses `cli.scheduler.execution.release.token_required` and `.indeterminate`.
  4. Regenerate OpenAPI and assert the operation id.
  5. Add handler tests with the harness: a release ends the row with the transaction reading and routes the Mission Service once; a refusal of `release` changes no row; two releases in sequence answer one success and one 409 `scheduler.execution.not_running`; a release whose transaction starts exactly at `expired_at` answers 409 and leaves the claim state `lost`; a transaction that starts before expiry commits with `ended_at` equal to its start reading and `finished`; a release after a revocation and after a loss answers 409; the wake follows the commit.
- Rules:
  - The route, the access, the input `furtherWork` and the answer `{ executionId, endedAt }`. `scheduler-service.impl.md:25`, `:47–50`; `engine/docs/cli/scheduler.md:174`, `:373–375`, `:405–406`.
  - The chain proves the live execution before the handler, and the handler repeats the full proof in its write transaction. `scheduler-service.impl.md:70–73`; `02-execution.md:216`.
  - The Mission Service checks the release predicate before the terminal write, and a failure changes no execution row, no node state and no job. `02-execution.md:217`; `engine/docs/cli/scheduler.md:395–399`, `:500`.
  - Of two terminal writes only one wins, and only the winner routes the Mission Service. `02-execution.md:216`; `scheduler-service.md:238`.
  - The Mission Service reads `furtherWork` in the transaction, and nothing stores it; no release receipt exists. `02-execution.md:218`; `scheduler-service.impl.md:49`, `:66`.
  - An ended execution of the binding rechecks a waiting pull. `scheduler-service.md:127`.
  - CLI code `cli.scheduler.execution.release.invalid_execution_id`: proposed under `architecture.impl.md:348`; the identity rule stands at `engine/docs/cli/scheduler.md:70`, `:370`.
  - Gap: the disposition of an execution that cannot progress stays B9 (`docs/brainstorm/HANDOFF.md:91`); the release holds no failure field (`engine/docs/cli/scheduler.md:416–417`).
- Done when: `pnpm run verify` passes; the tests pass.

### 03.11 Implement `scheduler.claim.get` with its CLI leaf

- Files: `src/scheduler/contract.ts`, `src/scheduler/service.ts`, `src/scheduler/execution-read.ts` (create), `src/scheduler/execution-read.test.ts` (create), `src/apps/cli/scheduler-execution.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/scheduler/*` (regenerated)
- Do:
  1. Declare `claimGet`: id `scheduler.claim.get`, `GET /api/scheduler/claim/:executionId`, access `client`, `lifetime: Unary`, `mutation: false`, `body: false`, params `{ executionId: identitySchema("execution") }`, output `executionRecordSchema`.
  2. Implement the handler with one `caller.commit`. An absent row throws `OperationError(404, "scheduler.execution.not_found", …)` (code: proposed). A row whose `runtime_identity`, `project_id` or `resource_identity` differs from the runtime identity, the project and the resource identity of the machine identity throws `OperationError(403, "scheduler.execution.not_owner", …)`. Else answer `executionRecord(…)` with the clock reading of the transaction.
  3. Add the leaf `claim get <execution-id>` with `cli.scheduler.claim.get.invalid_execution_id` (code: proposed), `cli.scheduler.claim.get.token_required` and `.indeterminate`.
  4. Regenerate OpenAPI and assert the operation id.
  5. Add tests: the owner reads `running`, then `finished` after a release and `lost` after the deadline; another runtime identity and another binding answer 403; an unknown identity answers 404; the read changes no row.
- Rules:
  - `claim get` is a `client` read with no body; it requires no live execution and checks the claimant against the machine identity and its live registration. `scheduler-service.impl.md:26`, `:74–76`; `engine/docs/cli/scheduler.md:296–302`.
  - A mismatch answers 403 `scheduler.execution.not_owner`. `engine/docs/cli/scheduler.md:498`.
  - Code `scheduler.execution.not_found` (404): proposed in `00-index.md` "Codes for Ulrich". The not-found condition stands at `engine/docs/cli/scheduler.md:332`. No code of `engine/docs/cli/other.md` and no ERD 1 Scheduler code covers it.
  - CLI code `cli.scheduler.claim.get.invalid_execution_id`: proposed under `architecture.impl.md:348`; the identity rule stands at `engine/docs/cli/scheduler.md:70`.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.12 Implement `scheduler.execution.list` and `get` with their CLI leaves

- Files: `src/scheduler/contract.ts`, `src/scheduler/service.ts`, `src/scheduler/execution-read.ts`, `src/scheduler/execution-read.test.ts`, `src/apps/cli/scheduler-execution.ts`, `src/apps/server/openapi-integration.test.ts` (edit); `static/openapi.yaml` and `static/openapi/scheduler/*` (regenerated)
- Do:
  1. Declare `executionList`: id `scheduler.execution.list`, `GET /api/scheduler/project/:projectId/execution`, access `human`, query `{ limit, cursor?, nodeId?: identitySchema("node"), attempt?: positive safe integer by coercion }` with a refinement that refuses `attempt` without `nodeId`, output `{ items: executionRecordSchema[], nextCursor }`. Declare `executionGet`: id `scheduler.execution.get`, `GET /api/scheduler/execution/:executionId`, access `human`, output `executionRecordSchema`.
  2. Generalize `decodeCursor` (`src/scheduler/service.ts:53–65`) to take the identity prefix, and use it with `execution` for the list cursor.
  3. Implement both handlers with one `caller.commit` each and the clock read once. The list answers `listExecutions` with the next cursor of the last identity. `get` answers the record or 404 `scheduler.execution.not_found` (code: proposed).
  4. Add the leaves `execution list <project-id> [--node <node-id> [--attempt <n>]] [--limit <count>] [--cursor <opaque>]` and `execution get <execution-id>`. Use these codes (code: proposed): `cli.scheduler.execution.list.invalid_project_id`, `cli.scheduler.execution.list.invalid_node_id`, `cli.scheduler.execution.list.invalid_attempt`, `cli.scheduler.execution.get.invalid_execution_id`; the shared `cli.pagination.*`, `token_required` and `indeterminate` codes. The CLI sends `--attempt` without `--node`, and the server answers the refusal.
  5. Regenerate OpenAPI and assert both operation ids and the `items` and `nextCursor` properties of the page.
  6. Add tests: the order, the cursor and the page bound; the node filter; the attempt filter; a node of another project and an absent attempt answer an empty page; `attempt` without `nodeId` answers 400 `gateway.request.validation_failed`; live and ended rows both appear; `get` of an unknown identity answers 404.
- Rules:
  - The routes, the human access and the filters. `scheduler-service.impl.md:27`, `:52–54`; `engine/docs/cli/scheduler.md:172–173`, `:306–334`.
  - `attempt` without `nodeId` answers HTTP 400 `gateway.request.validation_failed`. `scheduler-service.impl.md:53`; `engine/docs/cli/scheduler.md:319–320`.
  - The list holds every execution of the project, live and ended, for the life of the project. `scheduler-service.impl.md:104–105`; `engine/docs/cli/scheduler.md:322–323`.
  - A list answers the shared page, and a malformed cursor answers 400 `system.pagination.cursor_invalid`. `architecture.impl.md:179–189`.
  - Code `scheduler.execution.not_found` (404): proposed in task 03.11.
  - The CLI codes are proposed under `architecture.impl.md:348`; the argument rules stand at `engine/docs/cli/scheduler.md:65–71`, `:310–312`.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.13 Add the loss sweep and the lifecycle of the Scheduler

- Files: `src/scheduler/service.ts` (edit), `src/scheduler/service.test.ts` (edit)
- Do:
  1. In `run(context)` (`src/scheduler/service.ts:198–211`), after `start()`, start a `setInterval` of `LOSS_SWEEP_INTERVAL_MS` that calls `sweep()`.
  2. Implement `sweep()`. Read the identities of `readExpiredUnsettled` in one `store.transaction`. For each identity, run one `store.transaction` that reads the clock once, reads the row again and calls `declareLoss` when the row is still unended and expired. After each commit, call `wake(projectId)`. Then call `wake` for every project with a waiter, so that an idle Scheduler with jobs left serves the waiting pulls.
  3. A sweep that throws stops the timer and ends `run()` with that error.
  4. In `quiesce()` (`:189–191`), clear the timer, set the admission flag to false and call `wakeAll()`. In `stop()`, clear the timer when it still exists.
  5. Add tests with `t.mock.timers`: no sweep before `run()`; one sweep each 30 s; a sweep below and at `mission.consecutiveLossLimit` through a fake `transitions` that asserts one `loss` per row; a steps row and an evaluation row; a failed sweep ends `run()` with the error; `quiesce` clears the timer, ends every waiting pull with `no-work` and refuses a new claim; no sweep deletes a row.
- Rules:
  - Every 30 s the Scheduler settles every row whose `ended_at` is null and whose `expired_at` is reached, and the loss declaration uses the clock reading of its transaction. `02-execution.md:222`; `scheduler-service.impl.md:91–93`.
  - An idle Scheduler with jobs left serves the waiting pulls by the order of the work queue. `scheduler-service.md:117`.
  - Project configuration changes and claim changes trigger a recheck of the affected scope. `scheduler-service.md:31`.
  - A timer starts in `run()` and stops in phase 1 of the stop; the Scheduler starts no new claim in phase 1. `architecture.impl.md:457–464`; `00-index.md` "Shared conventions".
  - A `run()` that returns an error starts the stop. `architecture.impl.md:453`.
  - The sweep and the settlement of a Mission transition race to one terminal write, because each rereads the row in its own transaction. `02-execution.md:216`; `scheduler-service.impl.md:118–119`.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.14 Add the custody and attribution collaborations

- Files: `src/scheduler/settlement.ts`, `src/scheduler/settlement.test.ts`, `src/scheduler/service.ts` (edit)
- Do:
  1. Implement `pinCredential(tx, executionId, credentialId)`. Read the row. Require `ended_at` null, else throw 409 `scheduler.execution.not_running`. Append `credentialId` to `credentials` when the list does not hold it. Write the canonical JSON array.
  2. Implement `liveExecutionsPinning(tx, credentialId)`: the identities of the unended rows whose `credentials` hold `credentialId`, through `json_each`, ordered by `id`.
  3. Implement `executionAttribution(tx, executionId)`. Read the row, or answer null. Read `registrations.clientAttributionOf(tx, runtime_identity)` and `bindings.workerBindingOf(tx, project_id, resource_identity)`. Assert a binding row. Answer `{ clientId, name, workerName }` with `null` for an absent attribution.
  4. Expose the three functions on `SchedulerService`.
  5. Add tests: a pin appends once and keeps the order; a pin of an ended row answers 409; a pin keeps the list after the end; `liveExecutionsPinning` omits ended rows; the attribution of a deregistered instance keeps its client identity; the worker name of a tombstoned binding group stays readable; an unknown identity answers null.
- Rules:
  - At the first use of a credential name custody calls `pinCredential` in its transaction, and the collaboration appends the row identity to `credentials`. `custody.impl.md:161–162`; `scheduler-service.impl.md:39`.
  - `liveExecutionsPinning` reads the live execution rows alone; the list stays after the execution ends. `scheduler-service.impl.md:39`; `custody.impl.md:165–167`.
  - The Mission read derives the execution actor and `workerVersion` from the attribution and the worker of the pinned binding row. `mission-service.impl.md:205`, `:232`; `02-execution.md:35`.
  - The worker of a binding group never changes, so the latest row of the group names the worker of the pinned row. `project-service.impl.md:126`.
  - A JSON list column holds no duplicate. Decision D21.
- Done when: `pnpm run verify` passes; the tests pass.

### 03.15 Replace the stand-ins and wire the Scheduler seams

- Files: `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/unwired-import.test.ts`, `src/apps/server/e2e-mission-attempts-controls.test.ts`, `src/project/contract.ts`, `src/project/service.ts`, `src/project/service.test.ts`, `engine/AGENTS.md` (all edit)
- Do:
  1. In `composeServices`, pass the Scheduler methods to the Mission Service: `schedulerClaims: { revoke, settle, liveExecutionOf }`, `wakeup: { wake }` and `executionAttribution: { of }`. Pass `runningExecutionOfRuntime` and `activityOf` to the Worker dependency that plan 02 declares. Delete the `unwired(…)` objects and the production no-op of the wakeup.
  2. Delete every `standIns` key of these seams from `composeServices` and from `gatewayFixture`, and their fixture defaults (plan 01 task 01.4, steps 8–9, and the plan 02 key). Keep the `standIns` option for the seams of later plans.
  3. In `unwired-import.test.ts`, remove `SchedulerClaims.revoke`, `SchedulerClaims.settle`, `SchedulerClaims.liveExecutionOf`, `ExecutionAttribution.of`, `SchedulerClaims.runningExecutionOfRuntime` and `SchedulerClaims.activityOf` from `UNWIRED_SEAMS`. Accept an `index.ts` that imports no `unwired.ts` when the set is empty.
  4. Add the option `scheduler?: Partial<SchedulerConfig>` to `gatewayFixture` (`src/apps/server/test-support.ts:125–144`) and pass it to `configuration`.
  5. Delete the test block E01.24 from `e2e-mission-attempts-controls.test.ts`. Scenario E03.5 proves `mission.node.claim_live` with a real claim.
  6. Declare `SchedulerWakeup { wake(projectId: string): void }` inline in `src/project/contract.ts`, add `wakeup: SchedulerWakeup` to `Dependencies` of the Project Service (`src/project/service.ts:152–164`), and call `wakeup.wake(projectId)` after `caller.commit` of the binding-set write (`:218–222`). Pass `{ wake: (p) => scheduler.wake(p) }` in `composeServices` and a recording fake in `src/project/service.test.ts`.
  7. Update the `src/scheduler/` entry of `engine/AGENTS.md` with the new modules of this plan.
  8. Add tests in `src/project/service.test.ts`: the binding write wakes once after its commit, and a refused write wakes nothing.
- Rules:
  - The plan that wires the real peer deletes the stand-in and adds the E2E scenario that proves the real rule. ERD 1 decision D14; decision D9 (the rows placed by 01 and 02 and replaced by 03).
  - The wakeup follows the commit, never the transaction. `mission-service.md:692`; decision D20.
  - A project configuration change triggers a recheck of the affected scope. `scheduler-service.md:31`.
  - A plan edits only the construction of its own service and the dependency entries that it provides or consumes. `00-index.md` "Shared files".
  - Plan 02 calls `endRegistrations` inside the transaction of the binding-set write (`.dev/erd-02/decisions-log.md` 2026-09-30, plan 02); the wake follows the commit of that transaction and changes no answer of the operation.
  - Gap: `00-index.md` "Shared files" says that no plan changes an ERD 1 Project operation; the wake after the commit needs the same named exception as the plan 02 collaboration.
  - `unwired-import.test.ts` asserts the exact set of `unwired` seam names. Decision D6.
- Done when: `pnpm run verify` passes; every ERD 1, plan 01 and plan 02 test passes; `UNWIRED_SEAMS` holds no Scheduler seam.

### 03.16 Add the integration tests through both adapters

- Files: `src/apps/server/scheduler-integration.test.ts` (create)
- Do:
  1. Build the setup of the `## E2E` section through the direct adapter and the HTTP adapter of `gatewayFixture`, with a machine identity of each registered instance.
  2. Test: a lost pull answer repeated from the same runtime identity with the same key and with a new key answers the same execution and adds no row; a pull of another runtime identity of the binding never receives that execution; the end of the execution admits a fresh claim.
  3. Test: two concurrent releases through the direct adapter, with equal and with different `furtherWork`, answer one success, one 409 `scheduler.execution.not_running` and one Mission routing.
  4. Test with `t.mock.method(Date, "now")`: a release admitted by the chain whose transaction starts exactly at `expired_at` answers 409 and `claimState: lost`.
  5. Test: the release of an ended claim answers 403 `gateway.invocation.execution_proof_failed` through both adapters. Complete a release with key K and retry with the same identity, key K and payload: the answer is the 403 of the proof and no replay. After a lost answer and a refused retry, the owner reads `finished` through `claim get`.
  6. Test: a work pull meets an expired unsettled row of its instance and settles it before the admission, and never answers the lost execution; a registration resume meets the row of its instance and settles it before its precondition; a human pause meets an expired row and checks its precondition against the settled state.
  7. Test: the shared error envelope, the timeout, the lifetime and the body limit of every Scheduler route; an ended execution stays readable through `execution get` after a restart on a file store.
- Rules:
  - The tests of the Scheduler page. `scheduler-service.impl.md:108–142`.
  - Both adapters enter one invocation chain. `architecture.impl.md:613–617`.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
- Done when: `node --test --test-timeout=30000 src/apps/server/scheduler-integration.test.ts` passes; `pnpm run verify` passes.

### 03.E E2E proof

- Files: `src/apps/server/e2e-scheduler-execution.test.ts` (create)
- Do:
  1. Build the setup of the `## E2E` section through the CLI. Start `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }`. Start a second fixture with `scheduler: { releaseReserve: 1 }` for E03.17 to E03.19.
  2. Write one `test` block for each scenario E03.1 to E03.19, in table order, on the shared setup of each fixture.
  3. Parse stdout as JSON for every success. Assert the exit code and the start of stderr for every refusal.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, never a store read. ERD 1 decision D13.
  - The wait for a parked pull in E03.9 polls `fixture.scheduler.pulling(R)` for at most 5 s. It is a synchronization point and no state check.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
  - The fixture inputs are the inputs that the committed validation accepts. Decision D16; `src/apps/server/e2e-project-service.test.ts:43–83`; `src/apps/server/e2e-worker-app.test.ts:278–305`.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-scheduler-execution.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-scheduler-execution.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state and a timeout of 10 s. A human command uses `KANTHORD_TOKEN = fixture.token`. A machine command uses the machine token of its instance.
- Machine tokens: `kanthord jwt generate` needs a terminal on stdout, so the test runs it through the spawn of `src/apps/server/e2e-worker-app.test.ts:291–305` with `process.stdout.isTTY = true`. The server configuration file for `--config` holds `configuration({ masterKey: fixture.config.masterKey }).getProperties()` as private YAML (`e2e-worker-app.test.ts:281–287`).
- Rules: setup goes through the CLI only; the state check is a CLI read; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON.
- The node takes no evidence and no assessment in this plan, so a release with `furtherWork: false` meets the refusal of the release predicate. Plan 04 proves those releases.

Setup of fixture A, in order (each command exits 0):

1. `kanthord credential create --file anthropic.json` with `{ "name": "anthro-1", "platform": "anthropic", "metadata": null, "secret": { "key": "e2e-execution-secret" } }`.
2. `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
3. `kanthord worker agent enablement put swe@1 --file enablement.json` with `{ "agentProviders": [{ "name": "default", "provider": "anthropic", "credential": "anthro-1" }], "defaultConfiguration": { "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" } }`; then `kanthord worker agent enablement put re@1 --file enablement.json` → `revision` 1.
4. `kanthord project create --name execution` → `projectId` = `id`.
5. `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }, "general": { "kind": "worker", "config": { "worker": "general@1", "instanceCount": 1, "entries": [ENTRY("swe@1")] } }, "reviewer": { "kind": "worker", "config": { "worker": "reviewer@1", "instanceCount": 1, "entries": [ENTRY("re@1")] } } } }`, where `ENTRY(agent)` is `{ "agent": agent, "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" }` → `bindingSetVersion` 2.
6. `kanthord mission get <projectId>` → `missionId` = `id`.
7. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Recover accounts", "requirement": "Recover accounts", "criterion": "Accounts recover", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId` = `revisions[0].nodeId`.
8. `kanthord mission node create <missionId> --file objective.json` with the content, the reason and the verifications of step 7 and `"filename": "objective-1.md"`, `"kind": "objective"`, `"bindings": ["repo"]`, `"parentId": <initiativeId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 2` → `objectiveId`.
9. `kanthord mission node get <objectiveId>` → `revision` = `visibleRevision`. `M` names the mission version 3.
10. `kanthord project binding list <projectId>` → `generalBindingId` and `reviewerBindingId` = the `id` of the items `general` and `reviewer`. `kanthord jwt generate --binding <generalBindingId> --name general-a --config server.yaml` → `generalToken`; the same with `--binding <reviewerBindingId> --name reviewer-a` → `reviewerToken`; the same with `--binding <generalBindingId> --name general-b` → `spareToken`.
11. `kanthord worker register` with `generalToken` → `G` = `runtimeIdentity`; with `reviewerToken` → `R`.

`pull(X)` names the file `{ "resourceIdentity": "worker:kanthord:<binding of X>", "runtimeIdentity": X }`. `act(state, attempt)` names the file `{ "reason": "hold", "expectedMissionVersion": M, "expectedState": state, "expectedAttempt": attempt }`. A command with the suffix `[general]` or `[reviewer]` uses that machine token; every other command uses the human token.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                              | Exit       | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E03.1  | `kanthord scheduler work pull --file pull(G)` [general]; then `kanthord mission node get <objectiveId>`; then `kanthord scheduler queue list <projectId>`; then `kanthord mission attempt get <objectiveId> 1`                                                                                                                                        | 0, 0, 0, 0 | `kind` `claimed`; `execution.nodeId` = `objectiveId`, `attempt` 1, `pinnedRevision` = `revision`, `claimState` `running`, `credentials` `[]`, `endedAt` null, `claimant.runtimeIdentity` = G, `claimant.resourceIdentity` `worker:kanthord:general`, `claimant.clientId` starts with `client_identity_`, `expiredAt − createdAt` = 7800000, `traceId` matches `^[0-9a-f]{32}$`, `rootSpanId` matches `^[0-9a-f]{16}$` → `X` = `executionId`; node `state` `Executing`, `attempt` 1; no queue item with `nodeId` = `objectiveId`; `openedBy.kind` `execution`, `openedBy.executionId` = X |
| E03.2  | `kanthord scheduler work pull --file pull(G) --idempotency-key <new ULID>` [general]; then `kanthord scheduler execution list <projectId>`                                                                                                                                                                                                            | 0, 0       | `execution.executionId` = X; the list holds one item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E03.3  | `kanthord scheduler claim get X` [general]; `kanthord scheduler claim get X` [reviewer]                                                                                                                                                                                                                                                               | 0, 1       | first stdout `executionId` X, `claimState` `running`; second stderr starts with `scheduler.execution.not_owner:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E03.4  | `kanthord scheduler work pull --file pull(R)` [general]; `kanthord scheduler work pull --file pull(G)` with `spareToken`; `kanthord scheduler work pull --file pull(G)` (human token)                                                                                                                                                                 | 1, 1, 1    | stderr starts with `scheduler.work.claimant_mismatch:`, `gateway.registration.required:`, `gateway.authentication.unauthorized:`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E03.5  | `kanthord mission node priority set <objectiveId> --file priority.json` with `{ "value": 1, "expectedMissionVersion": M }`                                                                                                                                                                                                                            | 1          | stderr starts with `mission.node.claim_live:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| E03.6  | `kanthord scheduler execution release X --file release.json` with `{ "furtherWork": false }` [general]; then `kanthord scheduler execution get X`                                                                                                                                                                                                     | 1, 0       | stderr starts with `mission.release.obligation_unmet:`; `claimState` `running`, `endedAt` null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E03.7  | `kanthord scheduler execution release X --file further.json` with `{ "furtherWork": true }` [general]; then `kanthord scheduler claim get X` [general]; then `kanthord mission node get <objectiveId>`; then `kanthord scheduler queue list <projectId>`                                                                                              | 0, 0, 0, 0 | `executionId` X, `endedAt` a number, `idempotencyKey` a ULID; `claimState` `finished`; `state` `Available`, `attempt` 1; the queue holds an item with `nodeId` = `objectiveId`                                                                                                                                                                                                                                                                                                                                                                                                           |
| E03.8  | `kanthord scheduler execution release X --file further.json` [general]                                                                                                                                                                                                                                                                                | 1          | stderr starts with `gateway.invocation.execution_proof_failed:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| E03.9  | Start `kanthord scheduler work pull --file pull(R)` [reviewer]; wait until `fixture.scheduler.pulling(R)`; run `kanthord mission node ready <objectiveId> --file act(Available, 1)`; await the pull; then `kanthord mission node get <objectiveId>`                                                                                                   | 0, 0, 0    | ready stdout `node.state` `Waiting`; pull stdout `kind` `claimed`, `execution.nodeId` = `objectiveId`, `attempt` 1, `pinnedRevision` = `revision`, `claimant.runtimeIdentity` = R → `E` = `executionId`; node `state` `Evaluating`                                                                                                                                                                                                                                                                                                                                                       |
| E03.10 | `kanthord scheduler execution release E --file release.json` [reviewer]                                                                                                                                                                                                                                                                               | 1          | stderr starts with `mission.release.obligation_unmet:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E03.11 | `kanthord scheduler execution list <projectId> --node <objectiveId> --attempt 1`; then `kanthord scheduler execution list <projectId> --attempt 1`                                                                                                                                                                                                    | 0, 1       | `items[].executionId` `[E, X]`, `items[].claimState` `["running", "finished"]`, `nextCursor` null; second stderr starts with `gateway.request.validation_failed:`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| E03.12 | `kanthord mission node pause <objectiveId> --file act(Evaluating, 1)`; then `kanthord scheduler claim get E` [reviewer]                                                                                                                                                                                                                               | 0, 0       | `node.state` `Paused`; `claimState` `finished`, `endedAt` a number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| E03.13 | `kanthord worker agent enablement disable re@1 --expected-revision 1`; then `kanthord scheduler work pull --file pull(R)` [reviewer]                                                                                                                                                                                                                  | 0, 0       | pull stdout `kind` `no-work`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| E03.14 | `kanthord scheduler execution get execution_01ARZ3NDEKTSV4RRFFQ69G5FAA`; then `kanthord scheduler execution get X`                                                                                                                                                                                                                                    | 1, 0       | stderr starts with `scheduler.execution.not_found:`; `claimState` `finished`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| E03.15 | `kanthord scheduler claim get invalid`; `kanthord scheduler execution get invalid`; `kanthord scheduler execution release invalid --file further.json`; `kanthord scheduler execution list invalid`; `kanthord scheduler execution list <projectId> --node invalid`; `kanthord scheduler execution list <projectId> --node <objectiveId> --attempt 0` | 1 each     | stderr starts with `cli.scheduler.claim.get.invalid_execution_id:`, `cli.scheduler.execution.get.invalid_execution_id:`, `cli.scheduler.execution.release.invalid_execution_id:`, `cli.scheduler.execution.list.invalid_project_id:`, `cli.scheduler.execution.list.invalid_node_id:`, `cli.scheduler.execution.list.invalid_attempt:`                                                                                                                                                                                                                                                   |
| E03.16 | `kanthord scheduler work pull --file absent.json` [general]; `kanthord scheduler work pull --file extra.json` [general] with pull(G) plus `"projectId": <projectId>`                                                                                                                                                                                  | 1, 1       | stderr starts with `cli.file.not_found:`, `cli.file.schema_invalid:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Setup of fixture B, in order: steps 1 to 11 of fixture A with three changes. Step 3 enables `swe@1` alone. Step 5 applies `repo` and `general` alone, and `general` also holds `"resourceBudget": { "turns": 1, "wallTimeMs": 1 }`. Steps 10 and 11 issue and register `generalToken` alone.

| Id     | Commands                                                                                                                                                | Exit    | Expect                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E03.17 | `kanthord scheduler work pull --file pull(G)` [general]                                                                                                 | 0       | `kind` `claimed`, `expiredAt − createdAt` = 1001 → `X1` = `executionId`                                                                                                   |
| E03.18 | Wait 1100 ms; then `kanthord scheduler execution get X1`; then `kanthord scheduler execution release X1 --file further.json` [general]                  | 0, 1    | `claimState` `lost`, `endedAt` null; stderr starts with `gateway.invocation.execution_proof_failed:`                                                                      |
| E03.19 | `kanthord scheduler work pull --file pull(G)` [general]; then `kanthord scheduler execution get X1`; then `kanthord mission attempt list <objectiveId>` | 0, 0, 0 | `kind` `claimed`, `execution.executionId` ≠ X1, `execution.attempt` 1; X1 `claimState` `lost`, `endedAt` ≥ `expiredAt`; `items[].attempt` `[1]`, `items[0].closedAt` null |

E03.4, E03.14 and E03.15 assert codes of the mark `code: proposed`. The test is committed after Aelita writes each accepted code on its page (ruling R3). E03.8 and E03.18 assert `gateway.invocation.execution_proof_failed`, which needs its row on `engine/docs/cli/other.md` before the commit. E03.13 depends on the instance healthcheck of plan 02: a disabled enablement fails the resolution, so the healthcheck fails (`worker-service.md:87`, `:211`).

## Blockers

None open. The debate engine settled one question:

- DEBATE: the wait mechanism of the work pull under the one-commit rule - rounds:2 - verdict: round 1 refused several `caller.commit` calls with rolled-back early calls, because the rule says one `caller.commit` and not one successful commit. Round 2 preferred one `caller.commit` at the end after rolled-back probe transactions on the same store, on three repairs that the plan applies: every probe and the commit take a fresh instance healthcheck inside their own transaction; a probe has no effect outside the database, and a probe that settles a loss commits at once; the proof precedes the idempotency reservation and a test retries an ended release with the same key. `review:Ulrich`, because the probes are transactions that `architecture.impl.md:698` does not name.
