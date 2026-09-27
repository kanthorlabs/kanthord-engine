# Plan 07: Gateway Service and server app

## Scope

Plan 07 closes the composition root. Plans 01–06 each wire their own service, CLI group and E2E slice. Plan 07 deletes the `unwired` module and the `standIns` option, moves the component health registry to `/api/liveness`, builds the resource health report from every `resourceInventory`, adds the combined table-list assertion and the final OpenAPI inventory assertion, and proves the ERD 1 journey through the CLI.

Delivers:

- Task 07.1: Delete `src/apps/server/unwired.ts`, `src/apps/server/unwired.test.ts`, and the `standIns` option of `composeServices` and `gatewayFixture`; add `src/apps/server/unwired-import.test.ts`. (D14.)
- Task 07.3: Update `src/apps/server/index.ts` to call `gateway.declare(registry, inventories, logger)` with the three `resourceInventory` closures and `inventoryOverrides`; assert the final services and releases order.
- Task 07.4: Confirm `src/apps/server/test-support.ts` forwards `inventoryOverrides` to `composeServices`.
- Task 07.5: Add the combined ERD 1 table-list assertion to `src/apps/server/migrations.test.ts`.
- Task 07.6: Assert no operation outside the six prefixes; assert `gateway.liveness` and `gateway.healthcheck` schemas in `openapi-integration.test.ts`; regenerate `static/openapi.yaml` and `static/openapi/**` for the gateway route changes from task 07.8.
- Task 07.8: Rename `gateway.healthcheck` → `gateway.liveness` in `src/gateway/contract.ts`; add `gateway.healthcheck` resource health report (human, 120 s); update `declarations.ts`, `service.ts`, `index.test.ts`, `openapi-integration.test.ts`, `health.test.ts`, `e2e-repository.test.ts`, `src/gateway/test-support.ts`, and `src/gateway/service.test.ts`. (D13, B4.)
- Task 07.E: Create `src/apps/server/e2e-gateway-server.test.ts` — the ERD 1 CLI journey plus liveness and health report HTTP rows.

Does not deliver:

- Service implementations → Plans 01–06.
- CLI command groups → Each service plan.
- Worker app lifecycle → Plan 09.
- No-op Tracking module — D8 removes Tracking wiring from ERD 1.

## Sources

- `docs/brainstorm/architecture.impl.md:427–430` — construction cycles use closures over hoisted `let` variables.
- `docs/brainstorm/architecture.impl.md:449–469` — four shutdown phases; quiesce all at once in phase 1; release in reverse construction order in phase 4.
- `docs/brainstorm/architecture.impl.md:17–19` — every comparison against a fixed string or number uses a named constant.
- `docs/brainstorm/architecture.impl.md:574–599` — collaboration-type contract rule; composition root is the one file that imports and wires cross-service types.
- `docs/brainstorm/architecture.impl.md:618` — "A handler performs one `caller.commit` at the end on the declared store."
- `docs/brainstorm/architecture.impl.md:683` — "A handler runs asynchronous work first, including every client call."
- `docs/reference/erd/01-setup.md:33–153` — all ERD 1 table names for the combined table assertion.
- `docs/reference/erd/README.md` (owners-without-a-table) — Gateway owns no table; `credential` is the one unprefixed table.
- `engine/AGENTS.md` — "Regenerate OpenAPI": change declarations first, run the command, commit, verify.
- `engine/.agents/plan/00-index.md` — seams table; ownership table; shared conventions rows "Component healthcheck" and "Resource healthcheck entry".
- `docs/brainstorm/gateway-service.impl.md:266–300` — component healthchecks and the resource healthcheck report: eight liveness maps, `GET /api/liveness` route, `GET /api/healthcheck` route, dedupe by target, 32-check limit, 10 s check deadline, `missingInventories`, entry placement by owner and scope.
- `docs/brainstorm/gateway-service.md:23–33` — health report and liveness answer: `gateway.liveness` is public; `gateway.healthcheck` is human; liveness reports internal components only.
- `docs/brainstorm/architecture.md:120–145` — resource healthcheck: inventory owners, no stored result, check on demand, dedupe by target, bounded concurrency, deadline per check.
- `docs/brainstorm/custody.impl.md:204–213` — resource healthcheck: probe attribution against the credential store record.
- `docs/brainstorm/gateway-service.impl.md:459–460` — entry paths: `GET /api/liveness` is public; `GET /api/healthcheck` is human.
- `docs/brainstorm/gateway-service.impl.md:332–334` — at most 32 concurrent checks; each check deadline 10 s.
- `docs/brainstorm/gateway-service.impl.md:338` — when the route timeout cancels, stop dispatching queued checks.
- `engine/docs/cli/gateway.md` — route table with liveness and healthcheck as API-only rows; no CLI command declared for either route.
- Orchestrator decisions D3, D8, D9, D13, D14, D16.

## Depends on

- Plan 01 → `custodyMigrations`; `CustodyComponent`; `deriveEnvelopeKey`; `custodySuitability`; `credentialMetadata`; `custodyOperations`; `resourceInventory` on `CustodyComponent`; `unwired.ts` and `unwired.test.ts` created; Custody wired into `composeServices` and `gatewayFixture`; `standIns` option introduced with keys `agentProvidersDependentOn`, `enablementsDependentOnModel`, `bindingsNaming`; `apiOperations` array form; `src/apps/server/cli-support.ts` exporting `kanthord(args, env)` and `environment(directory)`.
- Plan 02 → `schedulerMigrations`; `SchedulerService`; `WorkQueue`; `schedulerOperations`; Scheduler wired into `composeServices` and `gatewayFixture`.
- Plan 03 → `workerMigrations`; `WorkerService`; `workerOperations`; `resourceInventory` on `WorkerService`; Custody's `agentProvidersDependentOn` and `enablementsDependentOnModel` stubs replaced with real Worker closures; Worker's `entriesOfAgent` stub added; `standIns` type reduced.
- Plan 04 → `RepositoryComponent`; `repositoryConnector` option wired in `composeServices` and `gatewayFixture`.
- Plan 05 → `projectMigrations`; `ProjectService`; `projectOperations`; `resourceInventory` on `ProjectService`; Custody's `bindingsNaming` stub replaced; Worker's `entriesOfAgent` stub replaced; Project's `createMission` and `liveNodesPinning` stubs added; `standIns` type reduced.
- Plan 06 → `missionMigrations`; `MissionService`; `missionConfigSchema`; `MissionConfig`; `missionOperations`; Project's `createMission` and `liveNodesPinning` stubs replaced; `standIns` type has no remaining keys; `inventoryOverrides` option added to `composeServices` and `gatewayFixture`; `src/config/index.ts` imports `missionConfigSchema`.

## Provides

No seam for another plan. Plan 07 is the terminal assembly plan.

## Tasks

Do these tasks in this order: 07.1, 07.5, 07.8, 07.3, 07.4, 07.6, 07.E.

### 07.1 Delete the `unwired` module and the `standIns` option

- Files:
  - `engine/src/apps/server/unwired.ts` (delete)
  - `engine/src/apps/server/unwired.test.ts` (delete)
  - `engine/src/apps/server/index.ts` (edit — remove `standIns` option type and all `unwired` imports)
  - `engine/src/apps/server/test-support.ts` (edit — remove `standIns` option type and forwarding)
  - `engine/src/apps/server/unwired-import.test.ts` (create)
- Do:
  1. Delete `engine/src/apps/server/unwired.ts`.
  2. Delete `engine/src/apps/server/unwired.test.ts`.
  3. In `engine/src/apps/server/index.ts`: remove the `import` of `unwired` from `"./unwired.ts"`; remove the `standIns?` field from the `Options` type of `composeServices` (Plan 06 task 06.24 removes the last two keys; no key remains); remove any `options.standIns?.` access.
  4. In `engine/src/apps/server/test-support.ts`: remove the `standIns?` field from the fixture options type and its forwarding to `composeServices`.
  5. Create `engine/src/apps/server/unwired-import.test.ts`. Write one test that scans the import specifiers of every `.ts` file under `src/` (read each file and search for `from ["'][^"']*unwired` patterns) and asserts no specifier matches. Do not scan file names or file paths — the test file itself contains the word "unwired" in its path and would falsely detect itself. Also assert that neither `src/apps/server/unwired.ts` nor `src/apps/server/unwired.test.ts` exists on disk.
- Rules:
  - Plans 03, 05 and 06 each remove their `standIns` keys. Plan 07 removes the option type and all forwarding (D14).
  - No `unwired` import remains after this task.
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - `unwired-import.test.ts` passes and would fail if `unwired.ts` were re-created.

### 07.3 Update the `gateway.declare` call and verify construction order

This task depends on task 07.8 having added the `inventories` and `logger` parameters to `gateway.declare` in `src/gateway/service.ts`. Do this task after 07.8.

- Files:
  - `engine/src/apps/server/index.ts` (edit)
- Do:
  1. In `composeServices`, locate the `gateway.declare` call and replace it:
     ```ts
     const custodyInventory =
       options.inventoryOverrides?.custody ??
       ((tx) => custody.resourceInventory(tx));
     const workerInventory =
       options.inventoryOverrides?.worker ??
       ((tx) => worker.resourceInventory(tx));
     const projectInventory =
       options.inventoryOverrides?.project ??
       ((tx) => project.resourceInventory(tx));
     gateway.declare(
       registry,
       {
         custody: custodyInventory,
         worker: workerInventory,
         project: projectInventory,
       },
       options.logger,
     );
     ```
  2. Confirm the `services` array in `Server.open` is `[scheduler, custody, worker, mission, project, gateway]` (construction order 1–6 from plans 01–06).
  3. Confirm the `releases` closures are pushed in the same order so the reverse-pop sequence stops `gateway` first and `scheduler` last.
- Rules:
  - `inventoryOverrides` was added by Plan 06 task 06.24; this task uses it.
  - Construction order: scheduler(1), custody(2), worker(3), mission(4), project(5), gateway(6). (`architecture.impl.md:427–430`.)
  - Stop order reverses construction: gateway, project, mission, worker, custody, scheduler. (`architecture.impl.md:449–469`.)
  - `RepositoryComponent` has no lifecycle; it is not in `services` or `releases`.
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - `src/apps/server/index.test.ts` asserts all six domain services start and that a stop call after start failure releases in reverse construction order.

### 07.4 Add `inventoryOverrides` to `test-support.ts`

- Files:
  - `engine/src/apps/server/test-support.ts` (edit)
- Do:
  1. Add `inventoryOverrides?: { custody?: (tx: Transaction) => ResourceEntry[]; worker?: (tx: Transaction) => ResourceEntry[]; project?: (tx: Transaction) => ResourceEntry[] }` to the `gatewayFixture` options type and forward the field to `composeServices` (task 07.3).
- Rules:
  - `inventoryOverrides` is the only new fixture field this plan adds to `test-support.ts`; all other fields are added by plans 01–06.
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - A call to `gatewayFixture({ inventoryOverrides: { custody: (tx) => [] } })` compiles without error.

### 07.5 Add the combined ERD 1 table assertion to `migrations.test.ts`

- Files:
  - `engine/src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Add a new `test("all ERD 1 migrations produce exactly the expected tables", ...)`.
  2. Apply the full `services` array (same order as task 07.3) to one in-memory store.
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

### 07.6 Assert the final OpenAPI inventory and regenerate for gateway route changes

This task depends on task 07.8 having changed the gateway route declarations. Do this task after 07.8.

- Files:
  - `engine/src/apps/server/openapi-integration.test.ts` (edit)
  - `engine/static/openapi.yaml` (regenerate)
  - `engine/static/openapi/**` (regenerate)
- Do:
  1. In `src/apps/server/openapi-integration.test.ts`:
     a. Confirm that `apiOperations` is an array of the form set by plan 01 task 01.14 (`[...Object.values(gatewayOperations), ...Object.values(custodyOperations), ...Object.values(schedulerOperations), ...Object.values(workerOperations), ...Object.values(projectOperations), ...Object.values(missionOperations)]`), with each service plan having appended its set. Do not re-introduce an object spread.
     b. Add an assertion: no operation whose `id` starts with a prefix other than `gateway`, `credential`, `scheduler`, `worker`, `project` or `mission` appears in the emitted document.
     c. Add an assertion: the emitted document includes `gateway.liveness` at `/api/liveness` with public access (30 s) and `gateway.healthcheck` at `/api/healthcheck` with human access (120 s).
     d. Add an assertion: `gateway.healthcheck` response schema holds `services` (with `project`, `intake`, `worker`, each having `global` and `projects`) and `shared` (with `custody`).
     e. Add an assertion: `gateway.liveness` carries the component health map schema (record of component name to component health object).
  2. Run `pnpm run build && node bin/kanthord.mjs gateway openapi` from the `engine/` directory. Commit the regenerated files under `static/`.
- Rules:
  - `engine/AGENTS.md` (Regenerate OpenAPI): change declarations first; run the command; commit; verify.
  - `apiOperations` is an array; do not change it to an object (plan 01 task 01.14 sets the array form).
  - `service: "credential"` on all custody operations (D9).
  - `static/openapi.yaml` is a pre-existing deviation kept at its current path per D16; no path change.
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - `@apidevtools/swagger-parser` validates the emitted document.
  - The emitted directory matches the committed directory exactly.

### 07.8 Rename the component health route and add the resource health report

- Files:
  - `engine/src/gateway/contract.ts` (edit)
  - `engine/src/gateway/declarations.ts` (edit)
  - `engine/src/gateway/service.ts` (edit)
  - `engine/src/gateway/test-support.ts` (edit — update `gateway.declare` call to pass empty inventories and logger)
  - `engine/src/gateway/service.test.ts` (edit — update path and id references)
  - `engine/src/apps/server/index.test.ts` (edit — update path references)
  - `engine/src/apps/server/openapi-integration.test.ts` (edit — update path references)
  - `engine/src/gateway/health.test.ts` (edit — rename the error code constant to `gateway.liveness.unhealthy`)
  - `engine/src/apps/server/e2e-repository.test.ts` (edit — update E04.2 route reference)
- Do:
  1. In `src/gateway/contract.ts`:
     a. Rename the `healthcheck` entry to `liveness`. Change `id` to `"gateway.liveness"`, `path` to `"/api/liveness"`, keep `access: AccessPolicy.Public` and `timeoutMs: 30000`. Keep the existing output schema (`z.record(z.string(), componentHealthSchema)`). Keep `HEALTHCHECK_OK`.
     b. Export named constants: `MAX_CONCURRENT_CHECKS = 32`, `RESOURCE_CHECK_DEADLINE_MS = 10000`, `OWNER_CUSTODY = "custody"`, `OWNER_WORKER = "worker"`, `OWNER_PROJECT = "project"`. Import `ResourceStatus` from `"../kernel/health.ts"`; declare no local status constants.
     c. Declare and export `resourceEntrySchema = z.strictObject({ status: z.enum([ResourceStatus.Healthy, ResourceStatus.Unhealthy, ResourceStatus.Unknown]), capability: z.string().min(1) })`. Declare `const resourceMapSchema = z.record(z.string().min(1), resourceEntrySchema)` and `const ownerSchema = z.strictObject({ global: resourceMapSchema, projects: z.record(z.string().min(1), resourceMapSchema) })`.
     d. Add a new `healthcheck` entry: `id: "gateway.healthcheck"`, `method: HttpMethod.Get`, `path: "/api/healthcheck"`, `access: AccessPolicy.Human`, `timeoutMs: 120000`, `mutation: false`, `store: StoreName.Operational`, `status: HttpStatus.OK`. Input: `emptyInput`. Output: `z.strictObject({ services: z.strictObject({ project: ownerSchema, intake: ownerSchema, worker: ownerSchema }), shared: z.strictObject({ custody: ownerSchema }) })`.
  2. In `src/gateway/declarations.ts`:
     a. Add imports: `type ResourceEntry`, `HealthScope`, `ResourceStatus` from `"../kernel/health.ts"`; `MAX_CONCURRENT_CHECKS`, `RESOURCE_CHECK_DEADLINE_MS`, `OWNER_CUSTODY`, `OWNER_WORKER`, `OWNER_PROJECT` from `"./contract.ts"`; `type Logger` from `"pino"`, `type Transaction` from `"../kernel/store.ts"`, `StoreName` from `"../kernel/operation.ts"`. `isHumanIdentity` is already imported.
     b. Change `registerGatewayOperations` to accept two additional parameters: `inventories: { custody: (tx: Transaction) => ResourceEntry[]; worker: (tx: Transaction) => ResourceEntry[]; project: (tx: Transaction) => ResourceEntry[] }` and `logger: Logger`.
     c. Rename the existing `gatewayOperations.healthcheck` registration to `gatewayOperations.liveness`. Change its error code from `"gateway.healthcheck.unhealthy"` to `"gateway.liveness.unhealthy"`. Keep all other handler logic unchanged.
     d. Register `gatewayOperations.healthcheck` with the resource report handler:
     - Declare the named constant `const INTAKE_EMPTY_OWNER = { global: {}, projects: {} } as const`.
     - Assert `isHumanIdentity(caller.identity)`; the human access policy guarantees it.
     - Declare `const missingInventories: string[] = []` and `const allEntries: { owner: string; entry: ResourceEntry }[] = []`.
     - Call `caller.commit((tx) => { ... })` once. Inside: call `inventories.custody(tx)`, `inventories.worker(tx)`, `inventories.project(tx)` each in its own `try/catch`. Push the owner name into `missingInventories` on catch. On success, push each returned entry with its owner name into `allEntries`.
     - After the commit: if `missingInventories.length > 0`, throw `new GatewayError(503, "gateway.healthcheck.inventory_failed", "One or more resource owners failed to supply their inventory.", { missingInventories })`.
     - Deduplicate: build a `Map<string, ResourceEntry>` keyed by `entry.target`. For the first entry of each target, record the check. Build a `Map<string, string>` of `target → owner` for log attribution. Initialize a `Map<string, string>` of `target → status` to `ResourceStatus.Unknown` for every unique target.
     - Run at most `MAX_CONCURRENT_CHECKS` checks concurrently using a hand-rolled active-count semaphore and a promise queue. For each unique `ResourceEntry` from the deduplicated map, create a child `CancellationContext` with deadline `Date.now() + RESOURCE_CHECK_DEADLINE_MS`. Call `entry.check(context)`. Handle each check result: if the promise resolves with a status value, record it; if the promise rejects or throws, record `ResourceStatus.Unknown`. A check that exceeds its deadline also records `ResourceStatus.Unknown`. Late settlements after `caller.context` cancels do not overwrite any already-recorded status.
     - After each check settles: cancel its `CancellationContext`; call `throwIfCancelled(caller.context)`. On cancellation, cancel all remaining active check contexts and return immediately with no success answer. Emit `logger.info({ caller: caller.identity.accountId, owner: ownerByTarget.get(entry.target), target: entry.target, status }, "resource.health.check")`.
     - When `caller.context` is cancelled (including route timeout): stop dispatching queued but not-yet-started checks, cancel all active check contexts, and produce no success answer.
     - Before assembling the response, cancel any still-running check contexts. Assign `ResourceStatus.Unknown` to their targets.
     - Place each entry from `allEntries` (not the deduplicated unique set) into the response: if `entry.scope === HealthScope.Global`, place at `owner.global[entry.name]`; if `entry.scope === HealthScope.Project`, place at `owner.projects[entry.project][entry.name]` after `assert.ok(entry.project !== null)`. Use the status from the results map for that entry's target. Each `ResourceEntry.check` closure captures only row data values from the inventory query; it holds no reference to the transaction object and runs after the transaction has committed.
     - Return `{ services: { project: projectReport, intake: INTAKE_EMPTY_OWNER, worker: workerReport }, shared: { custody: custodyReport } }`.
  3. In `src/gateway/service.ts`:
     - Import `type ResourceEntry` from `"../kernel/health.ts"`, `type Logger` from `"pino"`, `type Transaction` from `"../kernel/store.ts"`. (`HealthScope` is imported in `declarations.ts`, not `service.ts`.)
     - Change `declare(registry: OperationRegistry): void` to `declare(registry: OperationRegistry, inventories: { custody: (tx: Transaction) => ResourceEntry[]; worker: (tx: Transaction) => ResourceEntry[]; project: (tx: Transaction) => ResourceEntry[] }, logger: Logger): void`.
     - Pass `inventories` and `logger` to `registerGatewayOperations`.
  4. In `src/gateway/test-support.ts`: locate every call to `gateway.declare(registry)` and add empty inventory closures and a no-op logger: `gateway.declare(registry, { custody: () => [], worker: () => [], project: () => [] }, noOpLogger)`. Import `noOpLogger` from the kernel test-support or declare it inline.
  5. In `src/gateway/service.test.ts`: replace all references to `gatewayOperations.healthcheck.path` with `gatewayOperations.liveness.path`. Replace `"gateway.healthcheck"` operation id references with `"gateway.liveness"` where the component health operation is meant.
  6. In `src/apps/server/index.test.ts`: apply the same path and id replacements as step 5.
  7. In `src/apps/server/openapi-integration.test.ts`: apply the same path and id replacements as step 5.
  8. In `src/gateway/health.test.ts`: rename the error code constant from `"gateway.healthcheck.unhealthy"` to `"gateway.liveness.unhealthy"`.
  9. In `src/apps/server/e2e-repository.test.ts`: replace `gatewayOperations.healthcheck.path` with `gatewayOperations.liveness.path` in the E04.2 test (the component health route moved from `/api/healthcheck` to `/api/liveness`).
- Rules:
  - `gateway.liveness` is public 30 s; `gateway.healthcheck` is human 120 s (`gateway-service.impl.md:459–460`).
  - `caller.commit` is called exactly once; the operation declares `store: StoreName.Operational`, which `caller.commit` opens (`architecture.impl.md:618`, D3).
  - At most `MAX_CONCURRENT_CHECKS = 32` concurrent checks; each check deadline is `RESOURCE_CHECK_DEADLINE_MS = 10000` ms (`gateway-service.impl.md:332–334`).
  - A check that rejects or throws contributes `ResourceStatus.Unknown`; a deadline expiry also contributes `ResourceStatus.Unknown`. Late settlements after `caller.context` cancels do not overwrite any already-recorded status.
  - When `caller.context` is cancelled (including route timeout), stop dispatching queued checks, cancel all active check contexts, and produce no success answer (`gateway-service.impl.md:338`).
  - Each `ResourceEntry.check` closure captures only row data values; it holds no reference to the transaction object and runs after the transaction has committed.
  - Error codes: `"gateway.liveness.unhealthy"` for 503 on unavailable components (renamed from old `"gateway.healthcheck.unhealthy"`); `"gateway.healthcheck.inventory_failed"` for 503 on missing inventories (new).
  - `intake` always returns `{ global: {}, projects: {} }` in ERD 1 (`gateway-service.impl.md:309`).
  - One Pino log record per check: `{ caller, owner, target, status }`, no secret material (`custody.impl.md:212`).
  - Named constants for all compared literals: `MAX_CONCURRENT_CHECKS`, `RESOURCE_CHECK_DEADLINE_MS`, `ResourceStatus`, `INTAKE_EMPTY_OWNER`, `OWNER_CUSTODY`, `OWNER_WORKER`, `OWNER_PROJECT`.
  - No code comments.
- Done when:
  - `GET /api/liveness` (no auth, 30 s) returns HTTP 200 with the component health map.
  - `GET /api/healthcheck` (human token, 120 s) returns HTTP 200 with `{ services: { project: { global: {}, projects: {} }, intake: { global: {}, projects: {} }, worker: { global: {}, projects: {} } }, shared: { custody: { global: {}, projects: {} } } }` when no resources are registered.
  - `pnpm run verify` passes.

### 07.E E2E proof

- Files:
  - `engine/src/apps/server/e2e-gateway-server.test.ts` (create)
- Do:
  1. Import from `node:test`, `node:assert/strict`. Import `gatewayFixture` from `./test-support.ts`. Import `kanthord`, `environment` from `./cli-support.ts`. Import `temporary` from `../../kernel/test-support.ts`. Import `gatewayOperations`, `RESOURCE_CHECK_DEADLINE_MS`, `OWNER_PROJECT` from `../../gateway/contract.ts`. Import `ResourceStatus` from `../../kernel/health.ts`.
  2. Declare named constants: `const EXIT_SUCCESS = 0`, `const EXIT_FAILURE = 1`.
  3. Write one test per scenario in the table in `## E2E`. Each test is self-contained: it creates its own credentials and project and runs all setup commands inside that test.
  4. For the CLI scenarios (E07.1–E07.6): start a fresh `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` for scenarios that write repository bindings. Build the env with `environment(temporary(t))` extended with `KANTHORD_ENDPOINT: fixture.endpoint` and `KANTHORD_TOKEN: fixture.token`. Parse stdout as JSON where the CLI page says the command prints JSON. Assert exit code and that `stderr.startsWith("<code>:")` for refusals.
  5. For the HTTP scenarios (E07.7–E07.14): use `fixture.request(path, options)` to call `GET /api/liveness` and `GET /api/healthcheck`. Pass a human bearer token in `Authorization: Bearer <token>` where the route requires it. For E07.11–E07.14, inject controlled inventory functions through `inventoryOverrides` as described in the scenario rows.
- Rules:
  - Setup goes through the CLI only.
  - State checks are CLI reads, never store reads.
  - HTTP rows use `fixture.request(path)`.
  - No code comments.
- Done when:
  - `node --test --test-timeout=30000 src/apps/server/e2e-gateway-server.test.ts` passes.
  - `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-gateway-server.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store; `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state, `KANTHORD_ENDPOINT = fixture.endpoint` and `KANTHORD_TOKEN = fixture.token`. For scenarios that write repository bindings, `gatewayFixture` is called with `repositoryConnector: { gitLsRemote: async () => {} }` to avoid SSH.
- Rules: setup goes through the CLI only; the state check is a CLI read, never a store read; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON where the CLI page says the command prints JSON. HTTP-only capabilities use `fixture.request(path)` and the row says `HTTP` with the gateway.md route table line in the Commands column. Each test is self-contained; every test creates its own credentials and project.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exit       | Expect                                                                                                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E07.1  | `kanthord credential create --file <create.json>` (`platform: "anthropic"`, `name: "anthro-1"`, valid API key secret; file mode 0600) then `kanthord credential get anthro-1`                                                                                                                                                                                                                                                            | 0, 0       | first stdout: `name` equals `anthro-1`, `platform` equals `anthropic`, `revisions[0].id` starts `credential_`, `revisions[0].revision` equals 1, `revisions[0].endedAt` is `null`, and no `secret` field (`engine/docs/cli/credential.md` "Record and platform schemas"); second stdout: the same record |
| E07.2  | After E07.1 setup: `kanthord worker agent enablement put swe@1 --file <put.json>` (`agentProviders: [{ name: "default", provider: "anthropic", credential: "anthro-1" }]`, valid `defaultConfiguration` with `modelIdentifier: "claude-3-5-sonnet-20241022"`)                                                                                                                                                                            | 0          | stdout: `state: "enabled"`, `revision: 1`                                                                                                                                                                                                                                                                |
| E07.3  | `kanthord project create --name my-project` then `kanthord mission get <projectId>`                                                                                                                                                                                                                                                                                                                                                      | 0, 0       | first stdout: `id` starts `project_`; second stdout: `id` starts `mission_` — proves `createMission` ran in the same transaction                                                                                                                                                                         |
| E07.4  | After E07.3 setup: create a `github` credential (`platform: "github"`); `kanthord project binding apply <projectId> --file <bindings.json>` (repository binding `{ kind: "repository", config: { available: true, platform: "github", address: "git@github.com:owner/repo.git", strategy: { baseBranch: "main" }, credential: "<githubCredName>" } }`; fixture passes `repositoryConnector: { gitLsRemote: async () => {} }`)            | 0          | stdout: `bindingSetVersion: 2`                                                                                                                                                                                                                                                                           |
| E07.5  | After E07.3 setup: `kanthord mission node create <missionId> --file <node.json>` (`kind: "initiative"`, `filename`, `content`, `reason`, `expectedMissionVersion: 1`) then `kanthord scheduler queue peek <projectId>`                                                                                                                                                                                                                   | 0, 0       | second stdout: `job.nodeId` equals `revisions[0].nodeId` from first stdout                                                                                                                                                                                                                               |
| E07.6  | `kanthord credential create` of `openai-compatible` credential `"compat-1"` with `metadata.models: []` (the first revision starts empty, `custody.impl.md:63`); `kanthord credential update-metadata compat-1` adds `{ id: "gpt-4o" }`; `kanthord worker agent enablement put swe@1` with `credential: "compat-1"` and `defaultConfiguration.modelIdentifier: "gpt-4o"`; `kanthord credential update-metadata compat-1` removes `gpt-4o` | 0, 0, 0, 1 | stderr starts `credential.metadata.model_in_use:`                                                                                                                                                                                                                                                        |
| E07.7  | `HTTP GET /api/liveness` (no auth; `gateway.md` route table)                                                                                                                                                                                                                                                                                                                                                                             | 200        | response body `services` map holds exactly the keys `server`, `gateway`, `custody`, `scheduler`, `worker`, `repository`, `project`, `mission`, each a nonempty object                                                                                                                                    |
| E07.8  | `HTTP GET /api/liveness` (no auth; `scheduler.stop()` called before the request)                                                                                                                                                                                                                                                                                                                                                         | 503        | `error.details.services.scheduler.queue` equals 503; all other map keys present in `error.details.services`                                                                                                                                                                                              |
| E07.9  | `HTTP GET /api/healthcheck` (human token; `gateway.md` route table)                                                                                                                                                                                                                                                                                                                                                                      | 200        | body holds `services.project`, `services.intake`, `services.worker`, `shared.custody`, each with `global: {}` and `projects: {}`; `services.intake.global` equals `{}`                                                                                                                                   |
| E07.10 | `HTTP GET /api/healthcheck` (no auth; `gateway.md` route table)                                                                                                                                                                                                                                                                                                                                                                          | 401        | `error.code` equals `"gateway.authentication.unauthorized"`                                                                                                                                                                                                                                              |
| E07.11 | `HTTP GET /api/healthcheck` (human token; `inventoryOverrides.custody` returns two `ResourceEntry` items with the same `target` but different `name`; check closure increments a shared counter)                                                                                                                                                                                                                                         | 200        | counter equals 1; both entries report the same status                                                                                                                                                                                                                                                    |
| E07.12 | `HTTP GET /api/healthcheck` (human token; `inventoryOverrides.project` throws)                                                                                                                                                                                                                                                                                                                                                           | 503        | `error.details.missingInventories` includes `OWNER_PROJECT` (`"project"`)                                                                                                                                                                                                                                |
| E07.13 | `HTTP GET /api/healthcheck` (human token; `inventoryOverrides.custody` returns one entry whose `check` waits longer than `RESOURCE_CHECK_DEADLINE_MS` before resolving)                                                                                                                                                                                                                                                                  | 200        | entry in `shared.custody.global` reports `status: ResourceStatus.Unknown`                                                                                                                                                                                                                                |
| E07.14 | `HTTP GET /api/healthcheck` (human token; `inventoryOverrides.custody` returns one entry whose `check` throws)                                                                                                                                                                                                                                                                                                                           | 200        | entry in `shared.custody.global` reports `status: ResourceStatus.Unknown`                                                                                                                                                                                                                                |

## Blockers

None. All old blockers from the prior draft are resolved or superseded:

- Old B1 (`gateway_token_denylist`) — removed by Ulrich on 2026-09-27; the Gateway owns no table.
- Old B2 (TrackingInterface method set) — D8 removes Tracking from ERD 1.
- Old B3 (two-part error codes) — resolved globally by `00-index.md` B3 ruling; every plan uses three-part codes.
- Old B4 (healthcheck rulings) — resolved: tasks 07.8 (route rename and resource health report) and the liveness/healthcheck E2E rows are settled decisions (liveness error code `gateway.liveness.unhealthy`; inventory failure code `gateway.healthcheck.inventory_failed`).
- Old B5 (OpenAPI service key) — D9 resolves: Plan 01 sets `service: "credential"` for all custody operations.
- Old B6 (`static/openapi.yaml` path) — pre-existing deviation; unchanged per D16.
