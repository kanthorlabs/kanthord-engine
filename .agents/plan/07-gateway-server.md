# Plan 07: Gateway Service and server app

## Scope

This plan delivers the assembly layer that wires every ERD 1 service into a running server.

Delivers:

- Task 07.0: Fix `engine/src/gateway/invocation.ts:326` so every operation may call `caller.commit` exactly once; the idempotency record completes only when a reservation exists. (`architecture.impl.md:618`, `:683`; D3.)
- Task 07.1: Replace all `unwired(...)` calls in `src/apps/server/index.ts` that Plans 03 and 05 placed; delete `src/apps/server/unwired.ts` and `src/apps/server/unwired.test.ts`; add a test that no source file imports `unwired`. (D14.)
- Task 07.2: Import `missionConfigSchema` and `MissionConfig` into `src/config/index.ts`.
- Task 07.3: Update `src/apps/server/index.ts` — full migration list; construct Custody, Scheduler and Mission; wire all cross-service collaborations with late-bound closures; state construction order and reverse stop order.
- Task 07.4: Update `src/apps/server/test-support.ts` with the full ERD 1 migration list, all six domain services and an optional `repositoryConnector` override.
- Task 07.5: Add the combined ERD 1 table-list assertion to `src/apps/server/migrations.test.ts`.
- Task 07.6: Update `src/apps/cli/index.ts:298` to include all six service operation sets; regenerate `static/openapi.yaml` and `static/openapi/**`; update `src/apps/server/openapi-integration.test.ts`.
- Task 07.7: Create `src/apps/server/erd1-setup.test.ts` — six ERD 1 setup journey integration tests.

Does not deliver:

- Custody, Scheduler, Worker, Repository, Project, Mission implementations → Plans 01–06.
- CLI command groups → Plan 08.
- Worker app lifecycle → Plan 09.
- No-op Tracking module — D8 removes Tracking wiring from ERD 1.

## Sources

- `docs/brainstorm/architecture.impl.md:398–431` — composition order: migrate, construct, declare, seal, start domain services before Gateway.
- `docs/brainstorm/architecture.impl.md:427–430` — construction cycles use closures over hoisted `let` variables.
- `docs/brainstorm/architecture.impl.md:449–469` — four shutdown phases; quiesce all at once in phase 1; release in reverse construction order in phase 4.
- `docs/brainstorm/architecture.impl.md:618` — "A handler performs one `caller.commit` at the end on the declared store."
- `docs/brainstorm/architecture.impl.md:683` — "A handler runs asynchronous work first, including every client call."
- `docs/brainstorm/architecture.impl.md:274–288` — `src/config/index.ts` combines all service fragments; only apps import this file.
- `docs/brainstorm/architecture.impl.md:574–599` — collaboration-type contract rule; composition root is the one file that imports and wires cross-service types.
- `docs/brainstorm/architecture.impl.md:17–19` — every comparison against a fixed string or number uses a named constant.
- `docs/brainstorm/architecture.impl.md:213–215` — the server derives the credential cipher key from `masterKey`; `deriveEnvelopeKey` in `src/custody/envelope.ts` performs the derivation.
- `docs/reference/erd/01-setup.md:33–153` — all ERD 1 table names for the combined table assertion.
- `docs/reference/erd/README.md` (owners-without-a-table) — Gateway owns no table; `credential` is the one unprefixed table.
- `engine/AGENTS.md` — "Regenerate OpenAPI": change declarations first, run the command, commit, verify.
- `engine/.agents/plan/00-index.md` — seams table; ownership table; `custodySuitability` consumed by Plans 03 and 05.
- Orchestrator decisions D3, D5, D8, D9, D14, D15, D16.

## Depends on

- Plan 01 → `custodyMigrations`, `CustodyComponent` constructor (accepts `envelopeKey: Buffer` derived by `deriveEnvelopeKey`), `deriveEnvelopeKey(masterKey: string): Buffer` from `src/custody/envelope.ts`, `custodySuitability(tx, req)` and `credentialMetadata(tx, name)` implementations, `custodyOperations` for the OpenAPI inventory.
- Plan 02 → `schedulerMigrations`, `SchedulerService` (constructor requires `config: Record<string, never>` and optional `health?: HealthRegistry`); `WorkQueue` interface with methods `insert`, `delete`, `priorityUpdate` (defined in `src/scheduler/contract.ts`; `src/scheduler/index.ts` does not re-export it — import `WorkQueue` from `src/scheduler/contract.ts` directly); `schedulerOperations` for the OpenAPI inventory.
- Plan 03 → `workerMigrations` with `worker_agent_enablement`; `WorkerService` extended `Dependencies` with `custodySuitability`, `credentialMetadata`, `entriesOfAgent`; implementations `validateEntry`, `agentProvidersDependentOn`, `enablementsDependentOnModel`, `workerAgentsOf`, `workerAgentView`; `unwired.ts` and its test created in Plan 03 task 03.5.
- Plan 04 → `RepositoryComponent` class from `src/repository/index.ts`; constructor runs `checkRepositoryTools()`; method `gitLsRemote(sshUrl, context, deadlineMs)`.
- Plan 05 → `projectMigrations`; `ProjectService` extended `Dependencies` with `operationalStore`, `custodySuitability`, `validateEntry`, `repositoryConnector`, `workerAgentsOf`, `workerAgentView`, `createMission`, `liveNodesPinning`; implementations `entriesOfAgent`, `bindingsNaming`, `resolveBinding`, `getBindingRevision`; `projectOperations` for the OpenAPI inventory; `unwired(...)` stubs in `src/apps/server/index.ts` placed by Plans 03 and 05.
- Plan 06 → `missionMigrations`, `MissionService`, `missionConfigSchema`, `MissionConfig`; `MissionBindings` interface (two methods: `resolveBinding`, `getBindingRevision`); implementations `createMission`, `liveNodesPinning`; `missionOperations` for the OpenAPI inventory.

## Provides

No seam for another plan. Plan 07 is the terminal assembly plan.

## Tasks

### 07.0 Fix the read commit gate in `src/gateway/invocation.ts`

- Files:
  - `engine/src/gateway/invocation.ts` (edit)
  - `engine/src/gateway/invocation.test.ts` (create or edit)
- Do:
  1. In `engine/src/gateway/invocation.ts`, change line 326.
     Current: `if (!reservation || committed) throw new Error("A mutation commits exactly once.")`.
     Replace with: `if (committed) throw new Error("caller.commit: called twice.")`.
  2. At line 340, change `this.idempotency.complete(reservation!, committed, operation.secret)` to
     guard against null: `if (reservation) this.idempotency.complete(reservation, committed, operation.secret)`.
  3. In the test file (create `invocation.test.ts` in `src/gateway/` or add to the existing test if one exists), add two tests using a minimal fake operation registry and fake store:
     - `"read operation commits once"`: register a read operation (mutation false) with no `Idempotency-Key` header; call the handler which calls `caller.commit`; assert the call returns successfully with HTTP 200.
     - `"second commit throws"`: register any operation; in the handler closure call `caller.commit` twice; assert the second call (inside the handler) throws an error whose message contains `"called twice"`. Do not assert HTTP status or invocation return value for this test — `Invocation.execute` catches errors and converts them to a generic failure response; the throw must be asserted at the handler level.
- Rules:
  - Every operation (read and mutation alike) may call `caller.commit` exactly once (`architecture.impl.md:618`).
  - The idempotency record completes only when a reservation exists (reads have no reservation; `architecture.impl.md:683`).
  - No code comments.
- Done when:
  - `node --test src/gateway/invocation.test.ts` passes both new tests.
  - The existing read handlers in Plans 01–06 (e.g. `credential.get`, `scheduler.queue.list`) can call `caller.commit` without the "mutation commits exactly once" error.
  - `pnpm run verify` passes.

### 07.1 Replace `unwired` stubs and delete the `unwired` module

- Files:
  - `engine/src/apps/server/index.ts` (edit — remove all `unwired(...)` calls; wire real implementations)
  - `engine/src/apps/server/unwired.ts` (delete)
  - `engine/src/apps/server/unwired.test.ts` (delete)
  - `engine/src/apps/server/unwired-import.test.ts` (create)
- Do:
  1. In `engine/src/apps/server/index.ts`, remove the import of `unwired` from `./unwired.ts`.
     Replace every `unwired("<seam>")` call in the `ProjectService` and `WorkerService` constructor calls with the matching real implementation closure (see Task 07.3 for the exact closures).
     After Task 07.3 adds the new service constructors, every `unwired(...)` is gone.
  2. Delete `engine/src/apps/server/unwired.ts`.
  3. Delete `engine/src/apps/server/unwired.test.ts`.
  4. Create `engine/src/apps/server/unwired-import.test.ts`. Write one test that scans the import/export specifiers of every `.ts` file under `src/` (read each file and search for `from ["'].*unwired["']` patterns) and asserts no specifier matches. Do not scan file names or file paths — the test file itself contains the word "unwired" in its path and would falsely detect itself. Also assert that neither `src/apps/server/unwired.ts` nor `src/apps/server/unwired.test.ts` exists on disk.
- Rules:
  - No `unwired` import remains after this task (D14).
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - The `unwired-import.test.ts` test passes and would fail if `unwired.ts` were re-created.

### 07.2 Import the Mission config fragment into `src/config/index.ts`

- Files:
  - `engine/src/config/index.ts` (edit)
- Do:
  1. Import `missionConfigSchema` and `type MissionConfig` from `"../mission/index.ts"`.
  2. Add `mission: missionConfigSchema` to the `fragments` object.
  3. Add `mission: MissionConfig` to the `ServerConfig` interface.
- Rules:
  - `architecture.impl.md:282–288`: only applications import `src/config/index.ts`.
  - Custody, Scheduler and Repository add no config section (D8; `00-index.md` ownership table).
  - Plans 03 and 05 already own `worker` and `project` config additions; this task adds only `mission`.
- Done when:
  - `pnpm run verify` passes.
  - `src/config/index.test.ts` (existing) asserts that `mission.consecutiveLossLimit` defaults to 3 and that `configuration({ masterKey, mission: { consecutiveLossLimit: 3 } })` passes.

### 07.3 Update the composition root: migrations, service construction and collaboration wiring

- Files:
  - `engine/src/apps/server/index.ts` (edit)
- Do:
  1. Add imports:
     - `CustodyComponent`, `custodyMigrations`, `type Dependencies as CustodyDependencies` from `"../../custody/index.ts"`.
     - `deriveEnvelopeKey` from `"../../custody/index.ts"` (the linting boundary for this server app allows `index.ts` and `contract.ts`; importing from `envelope.ts` directly violates that boundary).
     - `SchedulerService`, `schedulerMigrations` from `"../../scheduler/index.ts"`; `type WorkQueue` from `"../../scheduler/contract.ts"` — `src/scheduler/index.ts` exports only `SchedulerService` and `schedulerMigrations`; it does not re-export `WorkQueue`.
     - `MissionService`, `missionMigrations` from `"../../mission/index.ts"`.
     - `RepositoryComponent` from `"../../repository/index.ts"`.
  2. Add an optional parameter `repositoryConnector?: { gitLsRemote(sshUrl: string, context: Context, deadlineMs: number): Promise<void> }` to the `composeServices` options type. When absent, default to `new RepositoryComponent()`.
  3. Update the `store.migrate([...])` call in `Server.open` to the fixed service order:
     ```
     [
       { service: "gateway", migrations: gatewayMigrations },
       { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
       { service: "scheduler", migrations: schedulerMigrations },
       { service: "worker", migrations: workerMigrations },
       { service: "project", migrations: projectMigrations },
       { service: "mission", migrations: missionMigrations },
     ]
     ```
     Import `CUSTODY_SERVICE_NAME` from `"../../custody/contract.ts"` to avoid a bare string literal.
  4. Inside `composeServices`, before service construction, derive the envelope key:
     `const envelopeKey = deriveEnvelopeKey(options.config.masterKey)`.
     Then resolve the repository connector:
     `const repoConnector = options.repositoryConnector ?? new RepositoryComponent()`.
     (`RepositoryComponent` constructor runs `checkRepositoryTools()` synchronously per Plan 04; no separate call needed.)
  5. Declare the hoisted cycle variables:
     ```ts
     let custody: CustodyComponent;
     let worker: WorkerService;
     let mission: MissionService;
     let project: ProjectService;
     ```
  6. Construct in this order (construction order 1–6):
     a. `const scheduler = new SchedulerService({ config: {}, health: options.health })` (1). `config` is required by `SchedulerService.Dependencies` (Plan 02 task 02.3).
     b. `const workQueue: WorkQueue = { insert: (tx, n, p, pr) => scheduler.insert(tx, n, p, pr), delete: (tx, n) => scheduler.delete(tx, n), priorityUpdate: (tx, n, pr) => scheduler.priorityUpdate(tx, n, pr) }` — use exact method names from `src/scheduler/contract.ts` `WorkQueue` interface.
     c. `custody = new CustodyComponent({ envelopeKey, logger: options.logger, health: options.health, agentProvidersDependentOn: (tx, name) => worker.agentProvidersDependentOn(tx, name), enablementsDependentOnModel: (tx, name, model) => worker.enablementsDependentOnModel(tx, name, model), bindingsNaming: (tx, name) => project.bindingsNaming(tx, name) })` (2). Closures capture `worker` and `project` by reference.
     d. `worker = new WorkerService({ config: {}, health: options.health, registrations: options.registrations, custodySuitability: (tx, req) => custody.custodySuitability(tx, req), credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name), entriesOfAgent: (tx, name) => project.entriesOfAgent(tx, name) })` (3). Closure captures `project` by reference.
     e. `mission = new MissionService({ config: options.config.mission, health: options.health, workQueue, bindings: { resolveBinding: (tx, pid, name) => project.resolveBinding(tx, pid, name), getBindingRevision: (tx, bid) => project.getBindingRevision(tx, bid) } })` (4). Closures capture `project` by reference. The `bindings` object satisfies `MissionBindings` from Plan 06 `src/mission/contract.ts`.
     f. `project = new ProjectService({ config: {}, health: options.health, operationalStore: options.store, repositoryConnector: repoConnector, bindings: options.bindings, validateEntry: (tx, name, entry) => worker.validateEntry(tx, name, entry), custodySuitability: (tx, req) => custody.custodySuitability(tx, req), workerAgentsOf: (name) => worker.workerAgentsOf(name), workerAgentView: (tx, wname, aname, entry) => worker.workerAgentView(tx, wname, aname, entry), createMission: (tx, pid, actor) => mission.createMission(tx, pid, actor), liveNodesPinning: (tx, bid) => mission.liveNodesPinning(tx, bid) })` (5). Closures capture `worker`, `custody` and `mission` by reference.
     g. Construct `gateway` as before (6).
  7. Call `declare(registry)` in this order: `custody`, `scheduler`, `worker`, `project`, `mission`, `gateway`.
  8. Return `{ custody, scheduler, worker, project, mission, gateway, invocation, registry }`.
  9. In `Server.open`, set `services = [scheduler, custody, worker, mission, project, gateway]` (construction order, not alphabetical).
     Push `stop()` closures into `releases` in the same construction order (scheduler push first, gateway push last) so that the reverse-pop sequence stops gateway first and scheduler last.
     Do not add `repoConnector` to `services` or `releases`; `RepositoryComponent` has no lifecycle (Plan 04).
- Rules:
  - Construction order: scheduler(1), custody(2), worker(3), mission(4), project(5), gateway(6). (`architecture.impl.md:427–430`.)
  - Stop order (reverse of construction): gateway, project, mission, worker, custody, scheduler. (`architecture.impl.md:449–469`.)
  - `deriveEnvelopeKey(config.masterKey)` — not `hkdfSync` inline (Plan 01 `src/custody/envelope.ts` exports `deriveEnvelopeKey`; Plan 01 Provides section states this).
  - `new RepositoryComponent()` constructs the connector per D5; method is `gitLsRemote`.
  - `WorkQueue` method names are `insert`, `delete`, `priorityUpdate` — exact names from `src/scheduler/contract.ts` (Plan 02 task 02.2).
  - `MissionBindings` has two methods: `resolveBinding` and `getBindingRevision` (Plan 06 task 06.2).
  - No Tracking dependency (D8).
  - No code comments.
  - Every fixed string constant uses a named import rather than a bare literal (`architecture.impl.md:17`).
  - This file is the only file that imports cross-service types (`architecture.impl.md:574–599`).
- Done when:
  - `pnpm run verify` passes.
  - `src/apps/server/index.test.ts` (existing) asserts all six domain services start and that a stop call after start failure releases in reverse construction order.

### 07.4 Update `test-support.ts` to use the full ERD 1 assembly

- Files:
  - `engine/src/apps/server/test-support.ts` (edit)
- Do:
  1. Add an optional `repositoryConnector?` field (same type as in Task 07.3) to the fixture options. Pass it through to `composeServices`.
  2. Update `gatewayFixture` to pass the full migration list `[gateway, custody, scheduler, worker, project, mission]` in the same fixed service order as Task 07.3.
  3. In fixture startup, start all six domain services plus Gateway in construction order: custody, scheduler, worker, mission, project, gateway.
  4. In fixture teardown, stop all services in reverse construction order.
  5. Do not derive or pass `envelopeKey` from the fixture; `composeServices` derives it internally from `config.masterKey`. Ensure the fixture config includes a valid `masterKey` string.
  6. Expose the full `composeServices` return from the fixture so that tests can access `custody`, `scheduler`, `mission`, `project` etc.
- Rules:
  - `architecture.impl.md:449–469`: fixture teardown runs the same four-phase lifecycle.
  - The fixture must include the full migration list; otherwise ERD 1 tables are absent in integration tests.
  - No code comments.
- Done when:
  - Existing server integration tests (`adapter-conformance.test.ts`, `gateway-registration.test.ts` etc.) still pass.
  - `pnpm run verify` passes.

### 07.5 Add the combined ERD 1 table assertion to `migrations.test.ts`

- Files:
  - `engine/src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Add a new `test("all ERD 1 migrations produce exactly the expected tables", ...)`.
  2. Apply the full `services` array (same order as Task 07.3) to one in-memory store.
  3. Declare `const ERD1_TABLES = ["credential", "mission_dependency", "mission_mission", "mission_node", "mission_node_revision", "project_binding", "project_project", "scheduler_job", "worker_agent_enablement"]` as a named constant.
  4. Assert `tables(store).sort()` equals `ERD1_TABLES.sort()`.
  5. Assert `credential` is the one table whose name does not start with a service prefix, and that every other table name starts with the prefix of its owning service. Import `CUSTODY_SERVICE_NAME` from `src/custody/contract.ts` to identify the custody service without a bare string.
  6. Assert that no service other than custody produces an unprefixed table.
- Rules:
  - `00-index.md` B1: Plan 01 adds the prefix exemption; Plan 07 adds the combined assertion here.
  - `architecture.impl.md:17`: the expected table array is a named constant.
  - The Gateway owns no table: Ulrich removed `gateway_token_denylist` on 2026-09-27, and `gatewayMigrations` is empty.
- Done when:
  - The new test passes.
  - Removing any single name from `ERD1_TABLES` fails the test.
  - `pnpm run verify` passes.

### 07.6 Update the OpenAPI operation inventory and regenerate

- Files:
  - `engine/src/apps/cli/index.ts` (edit — line 298)
  - `engine/static/openapi.yaml` (regenerate)
  - `engine/static/openapi/**` (regenerate)
  - `engine/src/apps/server/openapi-integration.test.ts` (edit)
- Do:
  1. In `src/apps/cli/index.ts`, at line 298 where `const apiOperations = { ...gatewayOperations, ...workerOperations }` is declared:
     - Add imports for `custodyOperations` from `"../../custody/contract.ts"`, `schedulerOperations` from `"../../scheduler/contract.ts"`, `projectOperations` from `"../../project/contract.ts"`, `missionOperations` from `"../../mission/contract.ts"`.
     - Replace the spread with: `const apiOperations = { ...gatewayOperations, ...custodyOperations, ...schedulerOperations, ...workerOperations, ...projectOperations, ...missionOperations }`.
  2. Include only operations that Plans 01–06 declare and implement for ERD 1. Exclude no operation that is declared in those plans, because no Plan 06 task carries `BLOCKED: HANDOFF Mission-Service` in the final plan.
  3. Run `pnpm run build && node bin/kanthord.mjs gateway openapi` from the `engine/` directory. Commit the regenerated files under `static/`.
  4. In `src/apps/server/openapi-integration.test.ts`:
     - Import `custodyOperations`, `schedulerOperations`, `projectOperations`, `missionOperations`.
     - Spread each into `apiOperations` alongside the existing `gatewayOperations` and `workerOperations`.
     - Add schema-and-response assertions for at least one path from each new service group: one `credential.*`, one `scheduler.queue.*`, one `project.*`, one `binding.*`, and one `mission.*` path.
     - Assert that no operation whose `id` starts with a service prefix other than `gateway`, `credential`, `scheduler`, `worker`, `project` or `mission` appears in the emitted document.
- Rules:
  - `engine/AGENTS.md` (Regenerate OpenAPI): change declarations first; run the command; commit; verify.
  - `service: "credential"` on all custody operations per D9; `src/gateway/openapi.ts:51` validates the prefix match between `operation.service` and the `id` prefix; Plan 01 already sets this correctly.
  - `static/openapi.yaml` is a pre-existing deviation kept at its current path per D16; no path change.
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - `@apidevtools/swagger-parser` validates the emitted document.
  - The emitted directory matches the committed directory exactly.

### 07.7 ERD 1 setup journey integration tests

- Files:
  - `engine/src/apps/server/erd1-setup.test.ts` (create)
- Do:
  1. Each test uses a fresh `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` injected. The fake connector enables a well-formed SSH URL (`git@github.com:owner/repo.git`) as the repository address without performing SSH. This is required because `deriveResourceIdentity` for the repository kind parses only `git@github.com:<owner>/<repo>.git` addresses (Plan 05 task 05.3 step 2); `file://` URLs do not match the pattern.
  2. Declare named constants for every fixed string comparison: import credential operation error codes from `src/custody/contract.ts`, scheduler constants from `src/scheduler/contract.ts`, mission operation ids from `src/mission/contract.ts`, project operation ids from `src/project/contract.ts`.
  3. Write `test("credential: create and get")`:
     - POST `credential.create` with platform `"anthropic"`, a unique name and a valid API key secret. Assert 200 and an identity starting with `"credential_"`. Send the same request with the same `Idempotency-Key`; assert 200 and the same identity (replay).
     - GET `credential.get`; assert `platform === "anthropic"` and `revision === 1`.
  4. Write `test("agent enablement: put, get and disable")`:
     - POST the credential create from test 3 to set up a provider credential.
     - PUT `worker.agent.enablement.put` for agent `"swe@1"` with `agentProviders: [{ name: "default", provider: "anthropic", credential: <credentialName> }]` and valid `defaultConfiguration`. Assert 200 and `state === "enabled"`.
     - GET `worker.agent.enablement.get` for `"swe@1"`; assert state is `"enabled"`.
     - POST `worker.agent.enablement.disable` with `expectedRevision: 1`; assert 200 and `state === "disabled"`.
  5. Write `test("project: create triggers mission creation")`:
     - POST `project.create` with a unique name. Assert 200 and a `"project_"` identity.
     - GET `mission.get` for the returned `projectId`; assert 200 and a `"mission_"` identity. This proves `createMission` ran in the same transaction as `project.create`.
     - GET `scheduler.queue.list` for `projectId`; assert zero jobs (no plan imported yet).
  6. Write `test("binding set write: validates credential suitability and writes bindings")`:
     - Create an `anthropic` credential, a `github` credential (for repository access), and an `s3` credential.
     - Create a project.
     - Enable `swe@1` agent with the anthropic credential as a provider.
     - PUT `project.bindingSet.write` with:
       - A repository binding: `{ kind: "repository", config: { available: true, platform: "github", address: "git@github.com:owner/repo.git", strategy: { baseBranch: "main" }, credential: <githubCredName> } }` — the repository kind requires a `github` platform credential; using an `anthropic` credential here would fail suitability validation with a platform mismatch error.
       - A worker binding: `{ kind: "worker", config: { worker: "general@1", instanceCount: 1 } }`.
       - A storage binding: `{ kind: "storage", config: { available: true, endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "test-bucket", region: "us-east-1", prefix: "", credential: <s3CredName> } }`.
     - Assert 200 and `bindingSetVersion === 2`.
     - PUT with a nonexistent credential name for the repository binding; assert 404 and error code `"credential.credential.not_found"` (three-part code from Plan 01 task 01.6).
  7. Write `test("mission import: plan lands in job queue")`:
     - Create a project (mission auto-created).
     - POST `mission.import.apply` with a minimal import containing one initiative and one objective. Assert 200.
     - GET `scheduler.queue.list` for `projectId`; assert the queue contains at least one job whose `nodeId` matches the initiative returned by the import.
     - Assert no job `nodeId` equals any task node id (tasks are not claimable per Plan 06 task 06.10 and `01-setup.md`).
  8. Write `test("credential metadata update refused: model in use by enablement")`:
     - Create an `openai-compatible` credential with a metadata block that lists model `"gpt-4o"` in its approved models.
     - Enable `swe@1` with that credential as the provider and `defaultConfiguration.modelIdentifier: "gpt-4o"`.
     - PUT `credential.update_metadata` with a new metadata that omits `"gpt-4o"` from the approved models list; assert 409 and error code `"credential.metadata.model_in_use"` (Plan 01 task 01.7, `docs/brainstorm/custody.impl.md:67–69`). The dependency check calls `enablementsDependentOnModel` from Plan 03 and refuses the update because an active enablement names the removed model.
  9. Each test is self-contained: creates its own credential and project; no cross-test state sharing.
- Rules:
  - No TDD; this file is created after Plans 01–06 deliver behavior code (planning brief).
  - Every comparison uses a named constant imported from the owning service's `contract.ts` (`architecture.impl.md:17`).
  - Every mutation carries an `Idempotency-Key` header; include replay assertion for at least credential create.
  - Error codes verbatim from Plans 01–06 (tests do not invent codes).
  - No code comments.
- Done when:
  - All six tests pass through the composed HTTP server.
  - `pnpm run verify` passes.
  - Each test proves one ERD 1 setup step end-to-end including idempotency replay for credential create.

## Blockers

None. All old blockers from the prior draft are resolved or superseded:

- Old B1 (`gateway_token_denylist`) — removed by Ulrich on 2026-09-27; the Gateway owns no table.
- Old B2 (TrackingInterface method set) — D8 removes Tracking from ERD 1.
- Old B3 (two-part error codes) — resolved globally by `00-index.md` B3 ruling; every plan uses three-part codes.
- Old B4 (`credential.credential.not_found` code form) — code is `credential.credential.not_found` (three parts) per Plan 01 task 01.6; Task 07.7 uses this verbatim.
- Old B5 (OpenAPI service key) — D9 resolves: Plan 01 sets `service: "credential"` for all custody operations; `openapi.ts:51` passes.
- Old B6 (`static/openapi.yaml` path) — pre-existing deviation; unchanged per D16.
