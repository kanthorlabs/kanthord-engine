# Plan 03: Worker Service — Agent Enablement

## Scope

This plan delivers:

- The `worker_agent_enablement` table and its migration
- The static worker catalog module: `general@1`, `reviewer@1`, `claude@1`, `opencode@1` and their agents `swe@1`, `re@1`; worker and agent names are module keys, not rows
- All `worker.agent.*` operations: `worker.agent.enablement.list`, `.get`, `.put`, `.enable`, `.disable`, `.remove`, `worker.agent.enablement.provider.add`, `.provider.remove`
- The `validateEntry`, `agentProvidersDependentOn` and `enablementsDependentOnModel` collaborations
- The `entriesOfAgent` input dependency type declared inline in `contract.ts`
- The `workerAgentsOf` and `workerAgentView` collaborations declared in `contract.ts` and implemented by `WorkerService`

`worker.catalog.*` operations, `worker.provider.check`, registration, heartbeat, handover, credential and MCP operations belong to Plan 09 or are out of ERD 1 scope.

The static worker catalog module is created in this plan. `validateEntry` needs it to resolve agent names by worker name and to list the agents of a worker. `worker.agent.get` is out of ERD 1: its prompts (`docs/brainstorm/worker-service.impl.md:225`) and its tools (`:281`) ship with the native runtime, so ERD 1 declares no placeholder for them.

This plan also absorbs:

- Tasks 08.11 and 08.12: eight `worker agent enablement` CLI commands added to `src/apps/cli/worker.ts`.
- Worker part of 07.3: real `custodySuitability`, `credentialMetadata` and `modelListCheck` closures from `CustodyComponent` wired into `WorkerService` in `src/apps/server/index.ts`; Custody's `agentProvidersDependentOn` and `enablementsDependentOnModel` stubs replaced with real closures from `WorkerService`; `entriesOfAgent` remains `unwired("entriesOfAgent")` until Plan 05.
- Worker part of 07.6: `workerOperations` confirmed in the `apiOperations` spread; OpenAPI regenerated for the eight new operations; `openapi-integration.test.ts` updated.

## Sources

- `docs/brainstorm/worker-service.md#agent-configuration` — enablement lifecycle, validation order, refusal rules
- `docs/brainstorm/worker-service.md#workers-and-templates` — worker declarations, catalog ownership, external workers
- `docs/brainstorm/worker-service.vocabulary.md` — agent enablement, agent provider, default configuration, entry forms, effective configuration, reasoning-effort closed set, provider closed set, state closed set
- `docs/brainstorm/worker-service.impl.md#agent-configuration-validation` — `validateEntry`, override allowlist, pi model catalog, custody suitability call, `entriesOfAgent` call, snapshot read; effective-configuration merge rules for `workerAgentView`
- `docs/brainstorm/worker-service.impl.md#the-worker-template-registry` — static catalog module, option schema, zod, no runtime plugin
- `docs/brainstorm/worker-service.impl.md#stop-and-budget` — resource budget `{ turns: 200, wallTimeMs: 7200000 }`
- `docs/brainstorm/architecture.impl.md:17–20` — named `as const` objects for closed sets
- `docs/brainstorm/architecture.impl.md:339–349` — error code form (at least three parts)
- `docs/brainstorm/architecture.impl.md:583–596` — collaboration contract (Kind 2), transaction passing, co-location constraint
- `docs/brainstorm/architecture.impl.md:157–161` — identity form `agent_enablement_<ulid>`
- `docs/brainstorm/architecture.impl.md:167–174` — revision counter, `max(current)+1`, starts at 1
- `docs/brainstorm/architecture.impl.md:178–186` — pagination: `limit`, `cursor`, ascending group-key order
- `docs/brainstorm/architecture.impl.md:191–199` — canonical JSON in `agent_providers` and `default_configuration`
- `docs/reference/erd/01-setup.md#worker-service` — `worker_agent_enablement` columns, unique index, all constraint rules
- `engine/docs/cli/worker.md` — operation routes, IDs, access policies, error codes, record fields
- `engine/AGENTS.md` — file layout, `add-a-service`, `add-a-migration`, `add-a-configuration-field`

## Depends on

- Plan 01 → `custodySuitability(tx, req): void` and `credentialMetadata(tx, credentialName): CredentialMetadataRecord | null` (declared as input dependency types in `contract.ts`; implementations wired in task 03.7); `unwired(seam: string)` from `src/apps/server/unwired.ts` (created by Plan 01; used by task 03.5 for `entriesOfAgent` and by Plan 01 itself for `agentProvidersDependentOn` and `enablementsDependentOnModel` until task 03.7 replaces them); `kanthord(args, env)` from `src/apps/server/cli-support.ts` (created by Plan 01; used by task 03.E)
- Transaction-sharing mechanism (00) → `Transaction` type from `src/kernel/store.ts`

## Provides

| Seam                                     | TypeScript signature                                                                                                                                                      | Owner file               | Consumer plans          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------- |
| `validateEntry`                          | `(tx: Transaction, workerName: string, entry: WorkerEntry \| null): void`                                                                                                 | `src/worker/contract.ts` | 05                      |
| `agentProvidersDependentOn`              | `(tx: Transaction, credentialName: string): AgentProviderDependent[]`                                                                                                     | `src/worker/contract.ts` | 01                      |
| `enablementsDependentOnModel`            | `(tx: Transaction, credentialName: string, modelId: string): AgentEnablement[]`                                                                                           | `src/worker/contract.ts` | 01                      |
| `entriesOfAgent` (input dependency type) | `(tx: Transaction, agentName: string): AgentDependentBinding[]`                                                                                                           | `src/worker/contract.ts` | 05 provides; 07 injects |
| `workerAgentsOf`                         | `(workerName: string): string[]` — static catalog read, no tx; `[]` for an externally hosted worker                                                                       | `src/worker/contract.ts` | 05                      |
| `workerAgentView`                        | `(tx: Transaction, workerName: string, agentName: string, entry: WorkerEntry \| null): WorkerAgentView \| null` — effective configuration of one agent for a binding read | `src/worker/contract.ts` | 05                      |

## Tasks

### 03.1 Add `worker_agent_enablement` migration

- Files: `src/worker/migrations.ts` (create), `src/worker/migrations.test.ts` (create), `src/worker/index.ts` (edit), `src/apps/server/migrations.test.ts` (edit)

- Do:
  1. Create `src/worker/migrations.ts`.
  2. Declare one migration (version 1) that runs two SQL statements:
     - `CREATE TABLE worker_agent_enablement (id TEXT NOT NULL PRIMARY KEY, agent_name TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, agent_providers TEXT NOT NULL, default_configuration TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER)`
     - `CREATE UNIQUE INDEX worker_agent_enablement_agent_name_revision ON worker_agent_enablement (agent_name, revision)`
  3. Export `workerMigrations: readonly Migration[]` from `migrations.ts`.
  4. Create `src/worker/migrations.test.ts`. After calling `store.migrate([{ service: "worker", migrations: workerMigrations }])`, assert:
     - Table `worker_agent_enablement` exists.
     - `PRAGMA table_info(worker_agent_enablement)` returns columns in this order: `id`, `agent_name`, `revision`, `state`, `agent_providers`, `default_configuration`, `created_at`, `removed_at`; `removed_at` has `notnull = 0`.
     - `PRAGMA index_list(worker_agent_enablement)` returns exactly one index named `worker_agent_enablement_agent_name_revision` with `unique = 1`.
     - `PRAGMA integrity_check` returns `ok`.
     - `PRAGMA foreign_key_check` returns empty.
  5. Edit `src/worker/index.ts`: replace `export const workerMigrations: readonly Migration[] = []` with `export { workerMigrations } from "./migrations.ts"`.
  6. Edit `src/apps/server/migrations.test.ts`: add `"worker_agent_enablement"` to the table list in the `assert.deepEqual` call of the combined prefix test.

- Rules:
  - No `CHECK` constraint (`CLAUDE.local.md`; `01-setup.md:183`)
  - One unique index on `(agent_name, revision)` and no other non-unique index (`CLAUDE.local.md`; `01-setup.md#worker-service`)
  - `id` is the first column; `removed_at` is nullable (`01-setup.md`)
  - Table prefix `worker_` (`AGENTS.md#add-a-migration`)
  - Name the unique index `worker_agent_enablement_agent_name_revision` (one word per field, underscores)

- Done when:
  - `pnpm run verify` passes
  - The colocated migration test passes all column, nullability, index name and uniqueness assertions

### 03.2 Create static worker catalog module

- Files: `src/worker/catalog.ts` (create), `src/worker/catalog.test.ts` (create)

- Do:
  1. Create `src/worker/catalog.ts`.
  2. Declare the `WorkerHost` closed set as an `as const` object with values `Kanthord = "kanthord"` and `ExternalHarness = "external-harness"`; derive its union type.
  3. Declare the `WorkerMethod` closed set as an `as const` object with values `Steps = "steps"` and `Evaluation = "evaluation"`; derive its union type.
  4. Declare `const REQUIRED_NODE_FORMAT: readonly string[]` with values `["name", "requirement", "criterion", "verifications", "bindings"]`.
  5. Declare type `AgentDeclaration` with fields `agentName: string`, `overridableFields: readonly string[]`.
  6. Declare type `WorkerDeclaration` with fields `name: string`, `host: WorkerHost`, `method?: WorkerMethod`, `agentName?: string`, `harness?: string`, `resourceBudget?: { turns: number; wallTimeMs: number }`, `declaredNodeStates: readonly string[]`, `requiredNodeFormat: readonly string[]`.
  7. Declare `const AGENT_DECLARATIONS: Readonly<Record<string, AgentDeclaration>>` with two entries:
     - `"swe@1"`: `overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"]`
     - `"re@1"`: `overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"]`
  8. Declare `const WORKER_CATALOG: Readonly<Record<string, WorkerDeclaration>>` with four entries:
     - `"general@1"`: `host: WorkerHost.Kanthord`, `method: WorkerMethod.Steps`, `agentName: "swe@1"`, `resourceBudget: { turns: 200, wallTimeMs: 7200000 }`, `declaredNodeStates: ["Available"]`, `requiredNodeFormat: REQUIRED_NODE_FORMAT`
     - `"reviewer@1"`: `host: WorkerHost.Kanthord`, `method: WorkerMethod.Evaluation`, `agentName: "re@1"`, `resourceBudget: { turns: 200, wallTimeMs: 7200000 }`, `declaredNodeStates: ["Waiting", "External.Requested"]`, `requiredNodeFormat: REQUIRED_NODE_FORMAT`
     - `"claude@1"`: `host: WorkerHost.ExternalHarness`, `harness: "claude-code"`, `declaredNodeStates: ["Available", "Waiting", "External.Requested"]`, `requiredNodeFormat: REQUIRED_NODE_FORMAT`
     - `"opencode@1"`: `host: WorkerHost.ExternalHarness`, `harness: "opencode"`, `declaredNodeStates: ["Available", "Waiting", "External.Requested"]`, `requiredNodeFormat: REQUIRED_NODE_FORMAT`
  9. Export functions `getAgentDeclaration(agentName: string): AgentDeclaration | undefined` and `getWorkerDeclaration(workerName: string): WorkerDeclaration | undefined`.
  10. Export function `agentsOfWorker(workerName: string): string[]` — for native workers returns `[declaration.agentName]`; for external workers returns `[]`.
  11. Create `src/worker/catalog.test.ts` with tests:
      - All four worker entries exist with correct fields
      - Both agent entries exist with correct `overridableFields`
      - `agentsOfWorker("general@1")` returns `["swe@1"]`
      - `agentsOfWorker("claude@1")` returns `[]`
      - `getWorkerDeclaration("unknown")` returns `undefined`

- Rules:
  - Static module; no database; no runtime plugin loading (`01-setup.md#owners-without-a-table`)
  - Closed-set values use `as const` objects, not TypeScript `enum` (`engine/src/kernel/operation.ts:8–14`)
  - Resource budget for native workers: `{ turns: 200, wallTimeMs: 7200000 }` (`worker-service.impl.md#stop-and-budget`)
  - External workers declare no `agentName`, no `method`, no `resourceBudget` (`worker-service.md#workers-and-templates`)
  - `overridableFields` for `swe@1` and `re@1`: `["agentProvider", "modelIdentifier", "reasoningEffort"]` (`worker-service.impl.md#agent-configuration-validation`)

- Done when:
  - `pnpm run verify` passes
  - Tests assert all catalog entries and agent declarations

### 03.3 Declare collaboration types and data shapes in `contract.ts`

- Files: `src/worker/contract.ts` (edit)

- Do:
  1. Declare type `AgentProviderItem` with fields `name: string`, `provider: string`, `credential: string`.
  2. Declare type `DefaultConfiguration` with fields `agentProvider: string`, `modelIdentifier: string`, `reasoningEffort: string`.
  3. Declare type `WorkerEntry` as `{ agentProvider?: string; modelIdentifier?: string; reasoningEffort?: string }`. A tuning entry omits `agentProvider`. A complete entry sets all three fields. `validateEntry` enforces completeness.
  4. Declare type `AgentEnablement` with exactly these five fields from `engine/docs/cli/worker.md:350–360`: `agentName: string` (exact catalog key; no separate enablement identity), `state: string`, `agentProviders: AgentProviderItem[]`, `defaultConfiguration: DefaultConfiguration`, `revision: number` (positive safe integer). `id`, `created_at` and `removed_at` are internal to `EnablementRow` and are not included in this type.
  5. Declare type `AgentProviderDependent` with fields `agentName: string`, `providerName: string`. `providerName` is the `name` of the matched `AgentProviderItem`, which is unique inside one enablement (`docs/reference/erd/01-setup.md:220`); the `provider` kind is not unique.
  6. Declare type `AgentDependentBinding` with fields `bindingId: string`, `workerName: string`, `entry: WorkerEntry | null`.
  7. Declare type `CustodySuitability` as `(tx: Transaction, req: { credential: string; platform: string }) => void`.
  8. Declare type `CredentialMetadataRecord` with fields `id: string`, `name: string`, `platform: string`, `metadata: Record<string, unknown> | null` (matching Plan 01's seam return value).
  9. Declare type `CredentialMetadataFn` as `(tx: Transaction, credentialName: string) => CredentialMetadataRecord | null`.
  10. Declare type `EntriesOfAgent` as `(tx: Transaction, agentName: string) => AgentDependentBinding[]`.
  11. Declare Zod schemas for the closed field sets to be reused in operation schemas:
      - `agentProviderKindSchema`: `z.enum(["github-copilot", "anthropic", "openai-compatible"])` matching the closed set from `worker-service.vocabulary.md`
      - `reasoningEffortSchema`: `z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])`
      - `agentProviderItemSchema`: `z.strictObject({ name: z.string().min(1), provider: agentProviderKindSchema, credential: z.string().min(1) })`
      - `defaultConfigurationSchema`: `z.strictObject({ agentProvider: z.string().min(1), modelIdentifier: z.string().min(1), reasoningEffort: reasoningEffortSchema })`
  12. Declare type `WorkerAgentView` with fields: `defaults: { agentProvider: string; modelIdentifier: string; reasoningEffort: string } | null`; `effective: { agentProvider: string; provider: string; credential: string; modelIdentifier: string; reasoningEffort: string } | null`; `valid: boolean`; `issues: Array<{ path: string[]; code: string }>`. The effective shape derives from `worker-service.impl.md#agent-configuration-validation` and `engine/docs/cli/worker.md:318–324`.
  13. Declare type `WorkerAgentsOfFn` as `(workerName: string) => string[]`.
  14. Declare type `WorkerAgentViewFn` as `(tx: Transaction, workerName: string, agentName: string, entry: WorkerEntry | null) => WorkerAgentView | null`.
  15. Do NOT add new entries to the `workerOperations` const in this task. Operations are registered in task 03.5 after routes and handlers exist. This avoids breaking the OpenAPI integration test (`engine/src/apps/server/openapi-integration.test.ts`).

- Rules:
  - Collaboration types are declared inline in this file (`00-index.md` collaboration-type contract rule)
  - No import from a peer service's `contract.ts` (`00-index.md`)
  - Closed-set values use `z.enum`, not TypeScript `enum`
  - Exact domain field names (`memory/exact-entity-names-in-contracts.md`)

- Done when:
  - `pnpm run verify` passes (TypeScript compiles; existing `register` handler still works; OpenAPI integration test passes unchanged)

### 03.4 Create enablements store

- Files: `src/worker/enablements.ts` (create), `src/worker/enablements.test.ts` (create)

- Do:
  1. Create `src/worker/enablements.ts`.
  2. Declare the `EnablementState` closed set as an `as const` object with values `Enabled = "enabled"` and `Disabled = "disabled"`; derive its union type.
  3. Declare the `AgentProviderKind` closed set as an `as const` object with values `GithubCopilot = "github-copilot"`, `Anthropic = "anthropic"`, `OpenaiCompatible = "openai-compatible"`; derive its union type.
  4. Declare type `EnablementRow` with all storage columns: `id`, `agentName`, `revision`, `state`, `agentProviders` (parsed), `defaultConfiguration` (parsed), `createdAt`, `removedAt`. This type is internal to the module and is not exported as the wire type.
  5. Implement `listEnablements(tx: Transaction, limit: number, cursor: string | null): { items: EnablementRow[]; nextCursor: string | null }`:
     - Select each agent's row with the greatest `revision` (subquery or window), then exclude rows whose `removed_at IS NOT NULL` (tombstoned).
     - Order results ascending by `agent_name` (`docs/brainstorm/architecture.impl.md` pagination: a list of group keys orders by that key in ascending alphabetical order, and the next page reads the keys greater than the cursor; `engine/docs/cli/worker.md#agent-enablement-list`).
     - Cursor is base64url-encoded `agent_name` of the last item returned; the next page selects `agent_name > cursor`.
  6. Implement `getEnablement(tx: Transaction, agentName: string): EnablementRow | null`:
     - Select the row with the greatest `revision` for `agentName`.
     - Return `null` if no row exists or if that row has `removed_at IS NOT NULL` (tombstoned).
  7. Implement `getLatestRevision(tx: Transaction, agentName: string): { revision: number } | null`:
     - Select the row with the greatest `revision` for `agentName` regardless of tombstone status.
     - Returns `null` if no row has ever been inserted for `agentName`.
  8. Implement `insertEnablementRevision(tx: Transaction, agentName: string, state: string, agentProviders: AgentProviderItem[], defaultConfiguration: DefaultConfiguration, removedAt?: number): EnablementRow`:
     - Mint `agent_enablement_<ulid>` with `identitySchema("agent_enablement").parse(...)`.
     - Compute `revision = SELECT COALESCE(MAX(revision), 0) + 1 FROM worker_agent_enablement WHERE agent_name = ?`.
     - Store `agent_providers` and `default_configuration` as canonical JSON.
     - Insert and return the row.
  9. Implement `agentProvidersDependentOn(tx: Transaction, credentialName: string): AgentProviderDependent[]`:
     - For each agent: select the row with greatest revision; skip if tombstoned.
     - Parse `agent_providers`; collect items whose `credential` equals `credentialName`.
     - Return as `AgentProviderDependent[]` with `agentName: row.agentName`, `providerName: item.name`.
  10. Implement `enablementsByModel(tx: Transaction, credentialName: string, modelId: string): EnablementRow[]`:
      - Select non-tombstone latest-revision rows whose `default_configuration.agentProvider` names a provider in `agent_providers` with `credential = credentialName` and whose `default_configuration.modelIdentifier = modelId`.
  11. Create `src/worker/enablements.test.ts` with tests (use `IN_MEMORY_DATABASE` and `Store` with worker migrations):
      - `insertEnablementRevision` produces `revision = 1` for a new agent name
      - A second insert for the same agent name produces `revision = 2`
      - `getEnablement` returns the greatest-revision row when not tombstoned
      - `getEnablement` returns `null` after a tombstone is inserted as the latest revision
      - `getLatestRevision` returns the tombstone's revision after removal
      - `listEnablements` returns live rows only; orders ascending by `agent_name`; cursor advances the page
      - `agentProvidersDependentOn` returns the right items for a matching credential
      - `agentProvidersDependentOn` returns nothing for a tombstoned agent
      - `enablementsByModel` returns only enablements matching both credential and model
      - `enablementsByModel` returns nothing for a tombstoned agent

- Rules:
  - Closed-set values use `as const` objects, not TypeScript `enum` (`engine/src/kernel/operation.ts:8–14`)
  - No bare string or numeric literals in comparisons; use the declared constants
  - `agent_providers` and `default_configuration` stored as canonical JSON (`architecture.impl.md:191–199`)
  - `id` has form `agent_enablement_<ulid>` (`architecture.impl.md:157–161`)
  - `revision = max(current) + 1` inside the transaction (`architecture.impl.md:167–174`)
  - Tombstone: select greatest revision first, then check `removed_at IS NOT NULL` (`01-setup.md#worker-service`)
  - No SQL foreign key inside JSON — handlers validate references before calling these functions

- Done when:
  - `pnpm run verify` passes
  - Tests cover all store functions, revision increments, tombstone semantics, pagination order and dependency queries

### 03.5 Implement operation handlers and collaborations

- Files: `src/worker/contract.ts` (edit), `src/worker/service.ts` (edit), `src/worker/service.test.ts` (edit), `src/worker/index.ts` (edit), `engine/AGENTS.md` (edit), `static/openapi.yaml` and `static/openapi/**` (regenerate), `src/apps/server/openapi-integration.test.ts` (edit), `src/apps/server/index.ts` (edit)

- Do:
  1. In `src/worker/contract.ts`, add all eight `worker.agent.*` operations to the `workerOperations` const object using exact routes, IDs and access policies from `engine/docs/cli/worker.md`. For each operation:
     - Use `AccessPolicy.Human`, `OperationLifetime.Unary`, `StoreName.Operational`.
     - Use `mutation: false` for reads and `mutation: true` for writes.
     - Use `z.strictObject` for all input and output schemas.
     - Use exact field names from the design pages.
     - Use the reusable schemas declared in task 03.3 for provider, configuration and reasoning-effort fields.
     - Operation key uses the operation ID without the `worker.` prefix with dot notation.
     - Operations:
       - `"agent.enablement.list"`: `GET /api/worker/agent/enablement`, read; input `{ limit: z.number().int().min(1).max(1000).default(100), cursor: z.string().optional() }`; output matches the documented list record fields from `worker.md`
       - `"agent.enablement.get"`: `GET /api/worker/agent/enablement/:agentName`, read; no additional input; output matches documented record
       - `"agent.enablement.put"`: `PUT /api/worker/agent/enablement/:agentName`, mutation; input `{ expectedRevision: z.number().int().positive().optional(), agentProviders: z.array(agentProviderItemSchema).min(1), defaultConfiguration: defaultConfigurationSchema }` (strict); output matches documented record
       - `"agent.enablement.enable"`: `POST /api/worker/agent/enablement/:agentName/enable`, mutation; input `{ expectedRevision: z.number().int().positive() }`; output matches documented record
       - `"agent.enablement.disable"`: `POST /api/worker/agent/enablement/:agentName/disable`, mutation; input `{ expectedRevision: z.number().int().positive() }`; output matches documented record
       - `"agent.enablement.remove"`: `DELETE /api/worker/agent/enablement/:agentName`, mutation; input `{ expectedRevision: z.number().int().positive() }`; output `z.strictObject({ agentName: z.string(), removed: z.literal(true) })` (`worker.md:432–433`)
       - `"agent.enablement.provider.add"`: `POST /api/worker/agent/enablement/:agentName/provider`, mutation; input `{ expectedRevision: z.number().int().positive(), name: z.string().min(1), provider: agentProviderKindSchema, credential: z.string().min(1) }` (strict); output matches documented record
       - `"agent.enablement.provider.remove"`: `DELETE /api/worker/agent/enablement/:agentName/provider/:providerName`, mutation; input `{ expectedRevision: z.number().int().positive() }`; output matches documented record
  2. Extend `Dependencies` interface in `service.ts` with required collaborations (D4):
     - `custodySuitability: CustodySuitability` (required; `src/apps/server/index.ts` passes `unwired("custodySuitability")` until task 03.7 wires the real implementation)
     - `credentialMetadata: CredentialMetadataFn` (required; `src/apps/server/index.ts` passes `unwired("credentialMetadata")` until task 03.7 wires the real implementation)
     - `entriesOfAgent: EntriesOfAgent` (required; `src/apps/server/index.ts` passes `unwired("entriesOfAgent")` until Plan 05 wires the real implementation)
     - `modelListCheck` is added by task 03.6 step 3 after the type is declared
  3. Declare a private `validateEffectiveConfig(tx: Transaction, agentName: string, agentProviders: AgentProviderItem[], effectiveConfig: DefaultConfiguration): void` helper that:
     a. Resolves the effective provider: finds the item in `agentProviders` whose `name` equals `effectiveConfig.agentProvider`; throws 404 `worker.agent.enablement.provider.not_found` if absent.
     b. Calls `this.custodySuitability(tx, { credential: item.credential, platform: item.provider })`; rethrows as 400 `worker.agent.configuration.credential_unsuitable` on failure.
     c. Calls `this.credentialMetadata(tx, item.credential)`. If non-null, validates `effectiveConfig.modelIdentifier` against the returned model catalog; throws 400 `worker.agent.configuration.model_unknown` if not found.
     d. Validates `effectiveConfig.reasoningEffort` against the `reasoningEffortSchema` closed set; throws 400 `worker.agent.configuration.reasoning_effort_unsupported` if invalid.
  4. In `declare(registry)`, register all eight new operations. For each, call `registry.register(workerOperations["<key>"], handler)`.
  5. Declare no `worker.agent.get` operation and no handler for it in ERD 1 (D8). Its prompts and tools ship with the native runtime (`docs/brainstorm/worker-service.impl.md:225`, `:281`).
  6. Implement `worker.agent.enablement.list` handler: call `listEnablements(tx, limit, cursor)`; project rows to the wire type.
  7. Implement `worker.agent.enablement.get` handler: call `getEnablement(tx, agentName)`; answer 404 `worker.agent.enablement.not_found` if `null`; project to wire type.
  8. Implement `worker.agent.enablement.put` handler:
     a. Verify `agentName` is in the agent catalog: `getAgentDeclaration(agentName)` — 404 `worker.agent.not_found` if absent.
     b. Call `getLatestRevision(tx, agentName)` and `getEnablement(tx, agentName)`. If `getLatestRevision` returns `null`, `expectedRevision` must be absent or `null`; else `expectedRevision` must equal the latest revision (including tombstone revision); mismatch answers 409 `worker.agent.enablement.revision_conflict` with current revision in `details`.
     c. Validate `agentProviders` is non-empty (this is enforced by the schema `min(1)`, but verify explicitly in the handler too for clarity): 400 `worker.agent.enablement.provider.required`.
     d. Check provider name uniqueness in the submitted list: 409 `worker.agent.enablement.provider.name_conflict` on duplicate name.
     e. Validate `defaultConfiguration.agentProvider` names an item in `agentProviders`: 404 `worker.agent.enablement.provider.not_found` if absent.
     f. Call `validateEffectiveConfig(tx, agentName, agentProviders, defaultConfiguration)` to validate provider suitability and model/effort.
     g. For a replacement (when an existing live enablement has providers): verify retained provider names keep their `provider` kind: 409 `worker.agent.enablement.provider.fixed`.
     h. For providers present in the current enablement but absent from the submitted list: call `entriesOfAgent(tx, agentName)` and check if any binding entry's effective `agentProvider` names the omitted provider: 409 `worker.agent.enablement.provider.in_use` with dependents.
     i. Call `entriesOfAgent(tx, agentName)` for every binding of this agent. For each non-null entry, compute the effective configuration and call `validateEffectiveConfig`. Collect failures and answer 409 `worker.agent.enablement.invalidates_bindings` with the list.
     j. Insert the next revision with `state: current?.state ?? EnablementState.Enabled`.
     k. Return the inserted row projected to the wire type.
  9. Implement `worker.agent.enablement.enable` handler: call `getLatestRevision` and `getEnablement`, verify `expectedRevision`, call `validateEffectiveConfig` for the current configuration and for all dependent entries, insert next revision with `state: EnablementState.Enabled`, return wire type.
  10. Implement `worker.agent.enablement.disable` handler: call `getLatestRevision` and `getEnablement`, verify `expectedRevision`, insert next revision with `state: EnablementState.Disabled` — disablement skips dependent binding check per `worker-service.md#agent-configuration`, return wire type.
  11. Implement `worker.agent.enablement.remove` handler: call `getLatestRevision` and `getEnablement`, verify `expectedRevision`, call `entriesOfAgent(tx, agentName)` — if non-empty answer 409 `worker.agent.enablement.in_use`; else insert tombstone (copy current providers and configuration, set `removedAt = Date.now()`), return `{ agentName, removed: true }` (`worker.md:432–433`).
  12. Implement `worker.agent.enablement.provider.add` handler: call `getLatestRevision` and `getEnablement`, verify `expectedRevision`, check name uniqueness (409 `worker.agent.enablement.provider.name_conflict`), validate new provider suitability with `validateEffectiveConfig`, validate dependent entries, insert next revision with appended provider, return wire type.
  13. Implement `worker.agent.enablement.provider.remove` handler: call `getLatestRevision` and `getEnablement`, verify `expectedRevision`, find provider by name (404 `worker.agent.enablement.provider.not_found`), check at least one provider remains after removal (400 `worker.agent.enablement.provider.required`), call `entriesOfAgent(tx, agentName)` and check if any entry names the removed provider (409 `worker.agent.enablement.provider.in_use`), check if the current `defaultConfiguration.agentProvider` names the removed provider (409 `worker.agent.enablement.provider.in_use`), validate dependent entries, insert next revision with provider removed, return wire type.
  14. Expose `validateEntry(tx, workerName, entry): void` as a method on `WorkerService`:
      a. Look up the worker in the catalog: 400 `worker.agent.configuration.invalid` if absent.
      b. For each agent of the worker: call `getEnablement(tx, agentName)`. If absent or state is `EnablementState.Disabled`, throw 400 `worker.agent.enablement.unavailable` naming the agent.
      c. If `entry` is non-null: check that each present field is in the agent's `overridableFields`; throw 400 `worker.agent.configuration.override_not_allowed` for any field not listed.
      d. Validate entry form: if `entry` is non-null and `entry.agentProvider` is present, all three fields must be present (complete form); if `agentProvider` is absent, at least one of `modelIdentifier` or `reasoningEffort` must be present (tuning form); an empty object throws 400 `worker.agent.configuration.invalid`.
      e. Compute effective configuration by merging entry over `enablement.defaultConfiguration`. Call `validateEffectiveConfig(tx, agentName, enablement.agentProviders, effectiveConfig)`.
  15. Expose `agentProvidersDependentOn(tx, credentialName): AgentProviderDependent[]` as a method on `WorkerService`: delegate to `agentProvidersDependentOn` from `enablements.ts`.
  16. Expose `enablementsDependentOnModel(tx, credentialName, modelId): AgentEnablement[]` as a method on `WorkerService`:
      a. Call `enablementsByModel(tx, credentialName, modelId)` — collect enablements whose default config names both the credential and model.
      b. For each non-tombstone latest enablement, call `this.entriesOfAgent(tx, agentName)`. For each non-null entry with an effective `modelIdentifier` equal to `modelId` and an effective `agentProvider` naming a provider with `credential = credentialName`, add the enablement to results (deduplicate by `id`).
      c. Return the deduplicated list.
  17. Expose `workerAgentsOf(workerName: string): string[]` as a method on `WorkerService`: call `agentsOfWorker(workerName)` from `src/worker/catalog.ts` and return the result. This is a static catalog read that opens no transaction (`00-index.md` seam signature).
  18. Expose `workerAgentView(tx: Transaction, workerName: string, agentName: string, entry: WorkerEntry | null): WorkerAgentView | null` as a method on `WorkerService`:
      a. Call `getAgentDeclaration(agentName)` and `getWorkerDeclaration(workerName)`; return `null` if either is absent.
      b. Call `getEnablement(tx, agentName)`; if `null` or `state` equals `EnablementState.Disabled`, return `{ defaults: null, effective: null, valid: false, issues: [{ path: [], code: "worker.agent.enablement.unavailable" }] }`.
      c. Set `defaults = enablement.defaultConfiguration`.
      d. Compute the effective configuration by merging `entry` (fields that are present in `entry`) over `defaults`.
      e. Collect validation issues without throwing: check that `effectiveConfig.agentProvider` names an item in `enablement.agentProviders`; if present, call `credentialMetadata` to validate `modelIdentifier` and check `reasoningEffort` against the closed set. Record each failure as `{ path: [<field>], code: <error-code> }`.
      f. Resolve `provider` and `credential` from the matching `agentProviders` item; set both fields to `null` when the provider item is absent (an issue is already recorded in step e).
      g. Return `{ defaults, effective: issues.length === 0 ? { agentProvider, provider, credential, modelIdentifier, reasoningEffort } : null, valid: issues.length === 0, issues }`.
  19. Import `unwired` from `"./unwired.ts"` (created by Plan 01) in `src/apps/server/index.ts`. Edit `src/apps/server/index.ts` at the `WorkerService` constructor call: pass `custodySuitability: unwired("custodySuitability")`, `credentialMetadata: unwired("credentialMetadata")` and `entriesOfAgent: unwired("entriesOfAgent")` in the dependencies object. Task 03.6 step 5 adds `modelListCheck: unwired("modelListCheck")`; task 03.7 replaces the Custody-owned stubs with real closures.
  20. Edit `engine/AGENTS.md`: update the `src/worker/` directory entry to list the new files: `migrations.ts`, `catalog.ts`, `enablements.ts`; update the description to state enablement lifecycle and collaborations.
  21. Extend `service.test.ts` with tests:
      - `worker.agent.enablement.list` pages correctly in ascending agent-name order
      - `worker.agent.enablement.get` answers 404 for an absent record
      - `worker.agent.enablement.put` creates revision 1 for a new agent; `expectedRevision` absent succeeds, present fails (revision_conflict)
      - After a tombstone, `put` requires the tombstone's revision as `expectedRevision`; absent fails
      - `worker.agent.enablement.enable` and `.disable` toggle state; `disable` skips dependent check
      - `worker.agent.enablement.remove` fails 409 when entries exist; succeeds when none exist
      - `worker.agent.enablement.provider.add` adds a provider; fails on duplicate name
      - `worker.agent.enablement.provider.remove` removes a provider; fails on last provider; fails when the default or an entry names it
      - `validateEntry` passes for an enabled enablement with a valid entry
      - `validateEntry` throws 400 for absent or disabled enablement
      - `validateEntry` throws 400 for an entry field outside the allowlist
      - `validateEntry` throws 400 for an empty entry object
      - `agentProvidersDependentOn` delegates to the enablements store
      - `enablementsDependentOnModel` returns enablements from default config; with a mock `entriesOfAgent` also finds entry-level matches
      - `workerAgentsOf` returns `["swe@1"]` for `"general@1"` and `[]` for `"claude@1"`
      - `workerAgentView` returns a valid `WorkerAgentView` for an enabled agent; returns `valid: false` with a populated `issues` array for a disabled enablement; returns `null` for an unknown agent or worker name

  22. Regenerate OpenAPI with `pnpm run build && node bin/kanthord.mjs gateway openapi` (`engine/AGENTS.md` "Regenerate OpenAPI"). `workerOperations` is already in the `apiOperations` spread of `src/apps/cli/index.ts:298` and of `src/apps/server/openapi-integration.test.ts`. In `openapi-integration.test.ts`, assert that the eight operation ids `worker.agent.enablement.list`, `worker.agent.enablement.get`, `worker.agent.enablement.put`, `worker.agent.enablement.enable`, `worker.agent.enablement.disable`, `worker.agent.enablement.remove`, `worker.agent.enablement.provider.add` and `worker.agent.enablement.provider.remove` appear in the emitted document, by exact string.
- Rules:
  - All handlers run inside `caller.commit((tx) => { ... })` (`architecture.impl.md:105–117`)
  - Collaborations receive `tx`, open no transaction and commit none (`architecture.impl.md:583–596`)
  - Every mutation is idempotent by its natural key (`architecture.impl.md:694–702`)
  - Validation order: own providers and default configuration first, then every dependent worker binding (`01-setup.md#worker-service`)
  - Disablement is always permitted and skips the dependent binding check (`worker-service.md#agent-configuration`)
  - Error codes verbatim from `engine/docs/cli/worker.md#agent-enablement-refusals` (`architecture.impl.md:339–349`)
  - No bare string or numeric literals in comparisons — use named constants from catalog and enablements modules
  - No code comments
  - `validateEntry` is exposed as a method so Plan 05 can call it as a Kind 2 collaboration (`architecture.impl.md:583–596`)
  - All collaborations (`custodySuitability`, `credentialMetadata`, `entriesOfAgent`) are required; colocated tests inject fakes; task 03.7 wires the Custody-owned ones; Plan 05 wires `entriesOfAgent`; `modelListCheck` is added and wired by tasks 03.6 and 03.7 (D4)
  - Reads use `caller.commit` per D3 (`architecture.impl.md:618`, `:683`)
  - The operations and the regenerated OpenAPI land in this task, because `src/apps/server/openapi-integration.test.ts` compares the live registry and the static files with `apiOperations` (D13)

- Done when:
  - `pnpm run verify` passes
  - `static/openapi.yaml` and `static/openapi/**` hold the eight `worker.agent.*` operations
  - Tests assert each operation, each refusal code, the validation order, tombstone-aware revision concurrency, and the five collaboration behaviors (`validateEntry`, `agentProvidersDependentOn`, `enablementsDependentOnModel`, `workerAgentsOf`, `workerAgentView`)
  - All `worker.agent.*` error codes match exactly the strings in `worker.md`

### 03.6 Declare and implement the agent provider health inventory

- Files: `src/worker/contract.ts` (edit), `src/worker/service.ts` (edit), `src/worker/service.test.ts` (edit), `src/apps/server/index.ts` (edit)

- Do:
  1. In `contract.ts`, add `import { HealthScope, type ResourceCheck, type ResourceEntry } from "../kernel/health.ts"`. Declare named constants `AGENT_PROVIDER_CAPABILITY = "model-list read"` and `AGENT_PROVIDER_TARGET_KIND = "agent-provider"`.
  2. Declare type `ModelListCheckFn = (tx: Transaction, credentialName: string) => ResourceCheck` inline in `contract.ts`.
  3. Extend the `Dependencies` interface in `service.ts` with required field `modelListCheck: ModelListCheckFn`.
  4. Expose `resourceInventory(tx: Transaction): ResourceEntry[]` as a synchronous method on `WorkerService`:
     a. Declare named constant `HEALTH_PAGE_SIZE = 100`.
     b. Loop: call `listEnablements(tx, HEALTH_PAGE_SIZE, cursor)` repeatedly, starting with `cursor = null` and advancing `cursor = page.nextCursor` after each call, until `nextCursor` is `null`. Collect all rows across pages.
     c. For each row (all non-tombstoned enablements, including disabled-state rows) and for each item in `row.agentProviders`, build an entry: `scope = HealthScope.Global`, `project = null`, `name = encodeURIComponent(row.agentName) + "/" + encodeURIComponent(item.name)`, `target = AGENT_PROVIDER_TARGET_KIND + ":" + item.credential`, `capability = AGENT_PROVIDER_CAPABILITY`, `check = this.modelListCheck(tx, item.credential)`.
     d. Return the flat entry list.
  5. In `src/apps/server/index.ts`, add `modelListCheck: unwired("modelListCheck")` to the `WorkerService` constructor call.
  6. In `service.test.ts`, add tests:
     - `resourceInventory` returns one entry per agent-provider pair across all non-tombstoned enablements.
     - Disabled-state enablements contribute entries; the state does not filter the inventory.
     - Tombstoned enablements contribute no entries.
     - Entry `scope` equals `HealthScope.Global` and `project` equals `null`.
     - Entry `name` equals `encodeURIComponent(agentName) + "/" + encodeURIComponent(providerName)`.
     - Entry `target` equals `"agent-provider:" + credentialName`.
     - Entry `capability` equals `AGENT_PROVIDER_CAPABILITY`.
     - Calling `check(ctx)` delegates to the closure that the injected `modelListCheck` returns.
     - No write occurs to the store after the call.

- Rules:
  - Import `ResourceEntry`, `ResourceCheck`, `HealthScope` from `../kernel/health.ts`; declare no local `ResourceStatus` (`00-index.md` "Resource healthcheck entry").
  - `AGENT_PROVIDER_CAPABILITY` and `AGENT_PROVIDER_TARGET_KIND` are named constants; no bare literals in comparisons or assignments.
  - All non-tombstoned enablements contribute entries regardless of enablement state; perform no state filter inside `resourceInventory`.
  - The pagination loop enumerates all enablements; a fixed upper limit is not sufficient.
  - `resourceInventory` is synchronous: it reads rows inside the caller's transaction, performs no network call, and returns closures. The `modelListCheck(tx, item.credential)` call obtains the closure inside `tx`.
  - Plan 07 calls `resourceInventory` inside one `caller.commit`, then runs the closures after the commit.
  - `modelListCheck` is required in `Dependencies`; step 5 of this task adds `unwired("modelListCheck")` to the constructor call; task 03.7 replaces it with `custody.modelListCheck` (`00-index.md` Seams, `modelListCheck`).
  - No code comments.

- Done when:
  - `pnpm run verify` passes.
  - Tests assert inventory completeness across enabled and disabled enablement states, tombstone exclusion through `listEnablements`, scope and project fields, percent-encoded naming, prefixed target key, capability constant, and probe delegation without stored results.

### 03.7 Wire Custody collaborations into WorkerService

- Files: `src/apps/server/index.ts` (edit)

- Do:
  1. In `composeServices`, locate the `WorkerService` constructor call and replace:
     - `custodySuitability: unwired("custodySuitability")` → `(tx, req) => custody.custodySuitability(tx, req)`
     - `credentialMetadata: unwired("credentialMetadata")` → `(tx, name) => custody.credentialMetadata(tx, name)`
     - `modelListCheck: unwired("modelListCheck")` → `(tx, name) => custody.modelListCheck(tx, name)`
  2. Locate the `CustodyComponent` constructor call and replace the `options.standIns?.<key> ?? unwired(...)` expressions that Plan 01 task 01.14 wrote:
     - `agentProvidersDependentOn` → `(tx, name) => worker.agentProvidersDependentOn(tx, name)`
     - `enablementsDependentOnModel` → `(tx, name, model) => worker.enablementsDependentOnModel(tx, name, model)`
  3. In the `WorkerService` constructor call, pass `entriesOfAgent: options.standIns?.entriesOfAgent ?? unwired("entriesOfAgent")`. Plan 05 replaces it.
  4. In the `standIns` option type of `composeServices` (Plan 01 task 01.14), delete the keys `agentProvidersDependentOn` and `enablementsDependentOnModel`, and add `entriesOfAgent?: EntriesOfAgentFn` (the inline type of `src/worker/contract.ts`). `gatewayFixture` derives its type from `composeServices`, so it needs no edit.
  5. Declare both `custody` and `worker` as `let` variables in `composeServices` before their constructor calls so the forward-reference closures resolve at call time, not at construction time (`architecture.impl.md:427–430`).

- Rules:
  - Closures capture `custody` and `worker` by reference; neither is read before construction completes.
  - Construction order: custody(2), worker(3) (`architecture.impl.md:427–430`).
  - No new unwired stubs are added by this task.
  - The E2E fixture of this plan passes `standIns: { entriesOfAgent: () => [] }` (D14).
  - No code comments.

- Done when:
  - `pnpm run verify` passes.
  - `gatewayFixture` starts without errors; custody suitability and credential metadata calls succeed in integration tests.

### 03.8 Add agent enablement CLI commands

- Files: `src/apps/cli/worker.ts` (edit)

- Do:
  1. Add `--token <token>` option (coercion `singleUse("--token")`) to the top-level `worker` group so leaf commands inherit it.
  2. After the `register` command, add sub-group `agent` (action: help). Within it add sub-group `enablement` (action: help).
  3. Import helpers (`requireToken`, `resolveKey`, `parsePositiveInt`, `readJsonFileAs`, `handleReadResult`, `handleMutationResult`, `httpClient`) from `./shared.ts`. Import `workerOperations` from `../../worker/contract.ts` (already imported if present).
  4. Declare `agentEnablementPutBodySchema` in `worker.ts`: `z.strictObject({ expectedRevision: z.number().int().positive().optional(), agentProviders: z.array(agentProviderItemSchema).min(1), defaultConfiguration: defaultConfigurationSchema })`.
  5. Declare `providerAddBodySchema` in `worker.ts`: `z.strictObject({ expectedRevision: z.number().int().positive(), name: z.string().min(1), provider: agentProviderKindSchema, credential: z.string().min(1) })`.
  6. Add leaf `agent enablement list`:
     - Options: `--limit` and `--cursor` (coercions `singleUse`). Default limit 100.
     - `requireToken(opts.token, "cli.worker.agent.enablement.list.token_required")`.
     - Call `httpClient(workerOperations, endpoint, token)["agent.enablement.list"]({ params: {}, query: { limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.worker.agent.enablement.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  7. Add leaf `agent enablement get <agent-name>`:
     - `requireToken`.
     - Call client `["agent.enablement.get"]({ params: { agentName }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.worker.agent.enablement.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  8. Add leaf `agent enablement put <agent-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`. `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, agentEnablementPutBodySchema)` → body.
     - Call client `["agent.enablement.put"]({ params: { agentName }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.worker.agent.enablement.put.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  9. Add leaf `agent enablement enable <agent-name> --expected-revision <revision>`:
     - `--expected-revision` coercion: `singleUse`; required. `parsePositiveInt(opts.expectedRevision, "cli.worker.agent.enablement.enable.invalid_revision")` → `rev`.
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["agent.enablement.enable"]({ params: { agentName }, query: {}, body: { expectedRevision: rev } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.worker.agent.enablement.enable.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  10. Add leaf `agent enablement disable <agent-name> --expected-revision <revision>`: same as enable; calls `["agent.enablement.disable"]`; diagnostic codes `cli.worker.agent.enablement.disable.*`.
  11. Add leaf `agent enablement remove <agent-name> --expected-revision <revision>`: same revision validation; calls `["agent.enablement.remove"]`; print `JSON.stringify({ agentName: data.agentName, idempotencyKey: key })`; diagnostic codes `cli.worker.agent.enablement.remove.*`.
  12. Add sub-group `provider` under `enablement` (action: help).
  13. Add leaf `agent enablement provider add <agent-name> --file <path>`:
      - `--file` coercion: `singleUse`. `requireToken`; `resolveKey` → `key`.
      - `readJsonFileAs(opts.file, providerAddBodySchema)` → body.
      - Call client `["agent.enablement.provider.add"]({ params: { agentName }, query: {}, body }, { idempotencyKey: key })`.
      - `handleMutationResult(result, "cli.worker.agent.enablement.provider.add.indeterminate", key)` → data.
      - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  14. Add leaf `agent enablement provider remove <agent-name> <provider-name> --expected-revision <revision>`:
      - `--expected-revision` coercion: `singleUse`; required. `parsePositiveInt(opts.expectedRevision, "cli.worker.agent.enablement.provider.remove.invalid_revision")` → `rev`.
      - `requireToken`; `resolveKey` → `key`.
      - Call client `["agent.enablement.provider.remove"]({ params: { agentName, providerName }, query: {}, body: { expectedRevision: rev } }, { idempotencyKey: key })`.
      - `handleMutationResult(result, "cli.worker.agent.enablement.provider.remove.indeterminate", key)` → data.
      - Print `JSON.stringify({ ...data, idempotencyKey: key })`.

- Rules:
  - Read commands (`list`, `get`) define no `--idempotency-key`.
  - `idempotencyKey` goes in the second argument of all mutation client calls.
  - Do not remove or change the existing `register` command.
  - Operation keys use dotted form without the `worker.` prefix.
  - `readJsonFileAs` validates against the body schemas declared in this task.
  - No code comments.

- Done when:
  - `pnpm run verify` passes.
  - `worker agent enablement list --help` exits 0.
  - `worker agent enablement get --help` exits 0.
  - `worker agent enablement put --help` exits 0; stdout matches `--file`.
  - `worker agent enablement enable --help`, `disable --help`, `remove --help` exit 0.
  - `worker agent enablement provider add --help` exits 0; stdout matches `--file`.
  - `worker agent enablement provider remove --help` exits 0.
  - `worker register --help` still exits 0 (register unchanged).

### 03.E E2E proof

- Files: `src/apps/server/e2e-worker-agent-enablement.test.ts` (create)

- Do: Create `src/apps/server/e2e-worker-agent-enablement.test.ts`. Each test uses `gatewayFixture` from `test-support.ts` and `kanthord` from `cli-support.ts`. The scenarios in the `## E2E` table below are the tests. Pass `standIns: { entriesOfAgent: () => [] }` to `gatewayFixture` (D14 stand-in option introduced by Plan 01; Plan 05 replaces it and removes this key from the `standIns` type). The stand-in is sufficient for E03 because no E03 scenario exercises `in_use` or `invalidates_bindings` paths; Plan 05 wires the real implementation and proves those paths.

- Done when:
  - `node --test --test-timeout=30000 src/apps/server/e2e-worker-agent-enablement.test.ts` passes.
  - `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-worker-agent-enablement.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture({ standIns: { entriesOfAgent: () => [] } })` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store; the `entriesOfAgent` stand-in (D14, Plan 01) is replaced by Plan 05. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state, `KANTHORD_ENDPOINT = fixture.endpoint` and `KANTHORD_TOKEN = fixture.token`.
- Rules: Each table row is one self-contained test case that creates its own fresh `gatewayFixture`; "After E03.X" means the test case runs the listed prerequisite commands in order within that same fixture before the command under test — tests do not share fixtures or state across rows. Setup goes through the CLI only; the state check is a CLI read, never a store read; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON where the CLI page says the command prints JSON. No E03 scenario exercises a path that requires live bindings.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Exit          | Expect                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E03.1  | `kanthord credential create --file <anthropic-cred.json>` (name `"anthro-1"`, platform `"anthropic"`); `kanthord worker agent enablement put swe@1 --file <enablement.json>` (`agentProviders: [{name:"default",provider:"anthropic",credential:"anthro-1"}]`, `defaultConfiguration:{agentProvider:"default",modelIdentifier:"claude-3-5-sonnet-20241022",reasoningEffort:"off"}`; no `expectedRevision`)                                                                                                                                                                                                                                                                                                                                  | 0, 0          | second stdout: `agentName: "swe@1"`, `state: "enabled"`, `revision: 1`                                                                                                                                                                                                                                                                                             |
| E03.2  | After E03.1: `kanthord worker agent enablement list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0             | stdout `items` array contains one item with `agentName: "swe@1"`, `nextCursor: null`                                                                                                                                                                                                                                                                               |
| E03.3  | After E03.1: `kanthord worker agent enablement get swe@1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0             | stdout: `agentName: "swe@1"`, `revision: 1`, `state: "enabled"`                                                                                                                                                                                                                                                                                                    |
| E03.4  | After E03.1: `kanthord worker agent enablement put swe@1 --file <enablement.json>` with `expectedRevision: 99`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1             | stderr starts with `worker.agent.enablement.revision_conflict:`                                                                                                                                                                                                                                                                                                    |
| E03.5  | After E03.1: `kanthord worker agent enablement disable swe@1 --expected-revision 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 0             | stdout: `state: "disabled"`, `revision: 2`                                                                                                                                                                                                                                                                                                                         |
| E03.6  | After E03.5: `kanthord worker agent enablement enable swe@1 --expected-revision 2`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0             | stdout: `state: "enabled"`, `revision: 3`                                                                                                                                                                                                                                                                                                                          |
| E03.7  | After E03.6: `kanthord worker agent enablement provider add swe@1 --file <provider-add.json>` (`expectedRevision:3`, `name:"backup"`, `provider:"anthropic"`, `credential:"anthro-1"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 0             | stdout: `revision: 4`, `agentProviders` length 2                                                                                                                                                                                                                                                                                                                   |
| E03.8  | After E03.7: `kanthord worker agent enablement provider remove swe@1 backup --expected-revision 4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0             | stdout: `revision: 5`, `agentProviders` length 1                                                                                                                                                                                                                                                                                                                   |
| E03.9  | After E03.8: `kanthord worker agent enablement remove swe@1 --expected-revision 5`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0             | stdout: `agentName: "swe@1"`                                                                                                                                                                                                                                                                                                                                       |
| E03.10 | After E03.9: `kanthord worker agent enablement get swe@1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1             | stderr starts with `worker.agent.enablement.not_found:`                                                                                                                                                                                                                                                                                                            |
| E03.11 | `kanthord credential create --file <openai-cred.json>` (name `"oai-1"`, platform `"openai-compatible"`, no models); `kanthord credential update-metadata oai-1 --file <meta-two-models.json>` (adds models `"gpt-4o"` and `"gpt-4-turbo"`); `kanthord worker agent enablement put re@1 --file <enablement-oai.json>` (`agentProviders:[{name:"default",provider:"openai-compatible",credential:"oai-1"}]`, `modelIdentifier:"gpt-4o"`, `reasoningEffort:"off"`); `kanthord credential update-metadata oai-1 --file <meta-drop-turbo.json>` (removes only `"gpt-4-turbo"` — not referenced by the enablement); `kanthord credential update-metadata oai-1 --file <meta-drop-gpt4o.json>` (removes `"gpt-4o"` — referenced by the enablement) | 0, 0, 0, 0, 1 | fourth command exits 0 (non-referenced model removed successfully); fifth stderr starts with `credential.metadata.model_in_use:`; subsequent `kanthord credential get oai-1` confirms `"gpt-4o"` still in metadata; `kanthord worker agent enablement get re@1` confirms `modelIdentifier:"gpt-4o"` unchanged (proves `enablementsDependentOnModel` and atomicity) |
| E03.12 | `kanthord worker agent enablement put swe@1 --file <enablement.json> --idempotency-key <ulid>`; repeat same command with same `--idempotency-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0, 0          | both stdout: same `revision`; second call replays the first                                                                                                                                                                                                                                                                                                        |
| E03.13 | `kanthord worker agent enablement enable swe@1 --endpoint http://127.0.0.1:1 --token t --expected-revision abc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1             | stderr starts with `cli.worker.agent.enablement.enable.invalid_revision:`                                                                                                                                                                                                                                                                                          |
| E03.14 | `kanthord worker agent enablement put swe@1 --endpoint http://127.0.0.1:1 --file enablement.json` (no `--token` option; `KANTHORD_TOKEN` is explicitly unset in the subprocess environment so the env var does not supply a token)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 1             | stderr starts with `cli.worker.agent.enablement.put.token_required:`                                                                                                                                                                                                                                                                                               |
| E03.15 | After E03.1: `kanthord worker agent enablement put unknown-agent@1 --file <enablement.json>` (no `expectedRevision`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1             | stderr starts with `worker.agent.not_found:`                                                                                                                                                                                                                                                                                                                       |
| E03.16 | After E03.1: `kanthord worker agent enablement provider remove swe@1 default --expected-revision 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1             | stderr starts with `worker.agent.enablement.provider.required:` (last provider)                                                                                                                                                                                                                                                                                    |

Note on scope boundaries: Task 03.7 implements `agentProvidersDependentOn` as a real closure — Custody's stub is replaced with `(tx, name) => worker.agentProvidersDependentOn(tx, name)`. The write-guard is active in ERD 1 at the service level. However, plan 01 delivers no HTTP credential-delete route, so the guard cannot be exercised through an E2E test in this plan. E2E proof of the credential-delete refusal is deferred to ERD 2 when that route exists. `worker.agent.enablement.in_use` (remove while binding exists), `worker.agent.enablement.invalidates_bindings`, and `worker.agent.enablement.unavailable` (binding write) require a live `entriesOfAgent` from Plan 05; those rows do not appear in E03.

## Blockers

None.
