# Plan 05: Project Service

## Scope

Delivers the `project_project` and `project_binding` tables; the `project.create`,
`project.list`, `project.get`, `project.rename`, `project.binding.list`,
`project.binding.get`, `project.bindingSet.get`, `project.bindingSet.write`,
`project.bindingRevision.list`, `project.agentConfiguration.list`, and
`project.agentConfiguration.get` operations; and the `entriesOfAgent`,
`bindingsNaming`, `resolveBinding`, and `getBindingRevision` collaboration
implementations.

`project.sourceSecret.get` is BLOCKED: HANDOFF Intake-Service.

Binding-set operations implement three binding kinds: `repository`, `worker`, and
`storage`. Source kind is out of scope (HANDOFF Intake-Service).

Every repository binding write calls one `git ls-remote` before the transaction
(`project-service.impl.md:247`). Plan 05 implements the component healthcheck
(`{ bindings }` map, already registered at `service.ts:25`) and exposes `resourceInventory`
for the resource healthcheck report; only repository bindings are checked in ERD 1
(`project-service.impl.md:256–266`). Plan 07 calls `resourceInventory` from the health
report.

Leaves to Plan 07: replaces `unwired` stubs for `CustodySuitability`, `ValidateEntry`,
`CreateMission`, `LiveNodesPinning`, `RepositoryConnector`, `WorkerAgentViewFn`, and
`WorkerAgentsOfFn` with real implementations; adds Project to `composeServices`; registers
Project routes; regenerates OpenAPI.

Leaves to Plan 08: CLI command file for the `project` group.

## Sources

- `docs/brainstorm/project-service.impl.md#the-binding-store` → table DDL, column order,
  `binding_set_version` CAS, immutable-row rule, `createMission` in same tx.
- `docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service` →
  `binding_` prefix for all binding kinds.
- `docs/brainstorm/project-service.impl.md#the-resource-identity` →
  `<kind>:<platform>:<identifier>` derivation per kind.
- `docs/brainstorm/project-service.impl.md#the-write-of-a-binding-set` → CAS transaction,
  five comparison outcomes, revision counter, tombstone, rebind after tombstone.
- `docs/brainstorm/project-service.impl.md#validation` → per-kind zod schema,
  `superRefine`, suitability calls, `validateEntry` inside write transaction.
- `docs/brainstorm/project-service.impl.md#the-credential-dependents-of-a-binding` →
  `bindingsNaming` rules.
- `docs/brainstorm/project-service.impl.md#worker-binding-configuration` →
  `entriesOfAgent` rules.
- `docs/brainstorm/project-service.impl.md#the-network-git-operations` → `git ls-remote`
  at every repository binding write, 30 s deadline, `ssh_unreachable` code, precedes tx.
- `docs/reference/erd/01-setup.md#project-service` → table columns, unique indexes,
  constraint rules.
- `engine/docs/cli/project.md` → 11 implementable operations, config schemas, access
  policies, error codes, response fields.
- `engine/AGENTS.md` → "Add a service", "Add a migration", "Add an operation".
- `engine/.agents/plan/00-index.md` → seam signatures, collaboration-type contract rule,
  shared-file ownership.
- Orchestrator decisions D2–D8 and Aelita error-code ruling (2026-09-27).

## Depends on

- Plan 01 → `CustodySuitability` type declared inline; implementation injected by Plan 07.
- Plan 03 → `ValidateEntry` type declared inline; `WorkerAgentViewFn` and
  `WorkerAgentsOfFn` declared in Plan 03 `contract.ts` per D6; implementations
  injected by Plan 07.
- Plan 04 → `RepositoryConnector` type declared inline per D5; implementation injected
  by Plan 07.
- Plan 06 → `CreateMission` and `LiveNodesPinning` types declared inline; implementations
  injected by Plan 07.

## Provides

| Seam                 | TypeScript signature                                                                                                                                                                                                                                                                                                                            | Owner file                | Consumer plans |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| `entriesOfAgent`     | `(tx: Transaction, agentName: string): AgentDependentBinding[]`                                                                                                                                                                                                                                                                                 | `src/project/contract.ts` | 03             |
| `bindingsNaming`     | `(tx: Transaction, credentialName: string): BindingRevision[]`                                                                                                                                                                                                                                                                                  | `src/project/contract.ts` | 01             |
| `resolveBinding`     | `(tx: Transaction, projectId: string, bindingName: string): { bindingId: string; resourceIdentity: string } \| null`                                                                                                                                                                                                                            | `src/project/contract.ts` | 06 (per D7)    |
| `getBindingRevision` | `(tx: Transaction, bindingId: string): { bindingId: string; name: string; resourceIdentity: string; revision: number; tombstone: boolean; disabled: boolean } \| null`                                                                                                                                                                          | `src/project/contract.ts` | 06             |
| `resourceInventory`  | `(tx: Transaction): ResourceEntry[]` — current (non-tombstoned) repository bindings; each entry has `scope: HealthScope.Project`, project name, percent-encoded binding name, `repository:<address>` target, `network git read` capability, and a `check` closure that calls `gitLsRemote`; `ResourceEntry` imported from `../kernel/health.ts` | `src/project/service.ts`  | 07             |

## Tasks

### 05.1 Create `project_project` and `project_binding` migrations

- Files: `src/project/migrations.ts` (create), `src/project/index.ts` (edit),
  `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Create `src/project/migrations.ts`; export `projectMigrations: readonly Migration[]`
     containing one migration that executes these four statements in order:
     a. `CREATE TABLE project_project(id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, binding_set_version INTEGER NOT NULL, created_at INTEGER NOT NULL)`
     b. `CREATE UNIQUE INDEX project_project_name ON project_project(name)`
     c. `CREATE TABLE project_binding(id TEXT NOT NULL PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project_project(id), name TEXT NOT NULL, resource_identity TEXT NOT NULL, revision INTEGER NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER)`
     d. `CREATE UNIQUE INDEX project_binding_revision ON project_binding(project_id, resource_identity, revision)`
  2. Edit `src/project/index.ts`: replace the empty `projectMigrations` export with
     `export { projectMigrations } from "./migrations.ts"`.
  3. Edit `src/apps/server/migrations.test.ts`: update the existing project service entry
     to import `projectMigrations` from `../../project/index.ts`; add `"project_project"`
     and `"project_binding"` to the expected table list; use the service name string
     `"project"` (the constant `PROJECT_SERVICE_NAME` is declared in task 05.2).
- Rules:
  - `id` is the first column of each table; `project_id` is the second column of
    `project_binding` (`project-service.impl.md:37`; `01-setup.md:206`).
  - `removed_at` is nullable, no default (`01-setup.md`).
  - No `CHECK` constraint; no non-unique index (`CLAUDE.local.md`).
  - Column order matches ERD diagram column order exactly.
- Done when: `pnpm run verify` passes; the isolation test for `project` alone applies
  the migration and asserts: both tables exist with exactly the declared columns and
  nullability; `PRAGMA foreign_key_list('project_binding')` includes the FK on
  `project_id` referencing `project_project(id)`; both unique indexes
  `project_project_name` and `project_binding_revision` exist; the combined table list
  includes both tables.

### 05.2 Declare binding schemas, operation declarations, and collaboration types

- Files: `src/project/contract.ts` (edit)
- Do:
  1. Add named constants:
     - `PROJECT_SERVICE_NAME = "project"`
     - `PROJECT_ID_PREFIX = "project"`
     - `BINDING_ID_PREFIX = "binding"`
     - `BINDING_SET_INITIAL_VERSION = 1`
     - `LS_REMOTE_TIMEOUT_MS = 30000`
     - `PROJECT_PROMPT_MAX_BYTES = 32768`
     - `INSTANCE_COUNT_MIN = 0`
     - `INSTANCE_COUNT_MAX = 64`
     - `STORAGE_PLATFORM = "s3"`
     - `REPOSITORY_PLATFORM = "github"`
     - `PROJECT_OPERATION_TIMEOUT_MS = 30000`
  2. Add `BindingKind` const object: `Repository = "repository"`, `Worker = "worker"`,
     `Storage = "storage"`.
  3. Add `GitHubAction` const object: `PullRequest = "pull_request"`,
     `MergePush = "merge_push"`.
  4. Add `FollowsType` const object: `AssessmentPassed = "assessment_passed"`,
     `ActionEndState = "action_end_state"`.
  5. Add `ChangeKind` const object: `Created = "created"`, `Revised = "revised"`,
     `Removed = "removed"`, `Unchanged = "unchanged"`.
  6. Add `BindingState` const object: `Current = "current"`, `Removed = "removed"`,
     `All = "all"`.
  7. Add `projectNameSchema`: `z.string().min(1).max(63).regex(/^[a-z][a-z0-9-]*$/)`.
  8. Add `bindingNameSchema`: same regex as `projectNameSchema`.
  9. Add `isNonblank(s: string): boolean` helper returning `s.trim().length > 0`.
  10. Add per-kind `config` schemas as `z.strictObject`:
      - `repositoryConfigSchema`:
        `{ available: z.boolean(), platform: z.literal(REPOSITORY_PLATFORM), address: z.string().min(1).refine(isNonblank), strategy: z.strictObject({ baseBranch: z.string().min(1).refine(isNonblank), action: z.strictObject({ name: z.nativeEnum(GitHubAction), follows: z.discriminatedUnion("type", [z.strictObject({ type: z.literal(FollowsType.AssessmentPassed) }), z.strictObject({ type: z.literal(FollowsType.ActionEndState), binding: bindingNameSchema })]) }).optional() }), credential: z.string().min(1), projectPrompt: z.string().optional() }`
      - `workerConfigSchema`:
        `{ worker: z.string().min(1), instanceCount: z.number().int(), resourceBudget: z.strictObject({ turns: z.number().int().positive(), wallTimeMs: z.number().int().positive() }).optional(), entries: z.array(z.strictObject({ agent: z.string().min(1), agentProvider: z.string().optional(), modelIdentifier: z.string().optional(), reasoningEffort: z.string().optional() })).optional() }`
      - `storageConfigSchema`:
        `{ available: z.boolean(), endpoint: z.string().url(), bucket: z.string().min(1).refine(isNonblank), region: z.string().min(1).refine(isNonblank), prefix: z.string(), credential: z.string().min(1) }`
  11. Add `bindingEditSchema` as a `z.discriminatedUnion("kind", [...])` over all three
      `z.strictObject({ kind: z.literal(BindingKind.X), config: XConfigSchema })` variants.
  12. Add `bindingSetWriteInputSchema`:
      `z.strictObject({ version: z.number().int().positive(), bindings: z.record(bindingNameSchema, bindingEditSchema) })`.
  13. Add inline types for dependency injection:
      - `CustodySuitability`: `(tx: Transaction, req: { credential: string; platform: string }) => void`
      - `ValidateEntry`: `(tx: Transaction, workerName: string, entry: WorkerEntry | null) => void`
      - `CreateMission`: `(tx: Transaction, projectId: string, actor: HumanActor) => void`
      - `LiveNodesPinning`: `(tx: Transaction, bindingId: string) => string[]`
      - `RepositoryConnector`: `{ gitLsRemote(sshUrl: string, context: Context, deadlineMs: number): Promise<void> }` (per D5)
      - `WorkerAgentsOfFn`: `(workerName: string) => string[]` (static, no tx; returns declared agent names for a native worker, `[]` for external; per D6)
      - `WorkerAgentViewFn`: `(tx: Transaction, workerName: string, agentName: string, entry: WorkerEntry | null) => WorkerAgentView | null` (per D6)
  14. Add inline shared types:
      - `HumanActor`: `{ kind: "human"; account: string; name: string }`
      - `WorkerEntry`: `{ agentProvider?: string; modelIdentifier?: string; reasoningEffort?: string }`
      - `AgentDependentBinding`: `{ bindingId: string; workerName: string; entry: WorkerEntry | null }`
      - `BindingRevision`: `{ bindingId: string; projectId: string }` (same name and shape as Plan 01 `src/custody/contract.ts`; structural match required by the seam)
      - `BindingChange`: `{ kind: "created" | "revised" | "removed" | "unchanged"; bindingId: string }`
      - `WorkerAgentView`: `{ defaults: { agentProvider: string; modelIdentifier: string; reasoningEffort: string } | null; effective: { agentProvider: string; provider: string; credential: string; modelIdentifier: string; reasoningEffort: string } | null; valid: boolean; issues: Array<{ path: string[]; code: string }> }`
  15. Replace `projectOperations = {}` with 11 operation declarations
      (`as const satisfies Record<string, Operation>`):

      | Key                         | ID                                | Method | Path                                                          | Mutation |
      | --------------------------- | --------------------------------- | ------ | ------------------------------------------------------------- | -------- |
      | `"create"`                  | `project.create`                  | POST   | `/api/project`                                                | true     |
      | `"list"`                    | `project.list`                    | GET    | `/api/project`                                                | false    |
      | `"get"`                     | `project.get`                     | GET    | `/api/project/:projectId`                                     | false    |
      | `"rename"`                  | `project.rename`                  | PATCH  | `/api/project/:projectId`                                     | true     |
      | `"binding.list"`            | `project.binding.list`            | GET    | `/api/project/:projectId/binding`                             | false    |
      | `"binding.get"`             | `project.binding.get`             | GET    | `/api/project/:projectId/binding/:bindingId`                  | false    |
      | `"bindingSet.get"`          | `project.bindingSet.get`          | GET    | `/api/project/:projectId/binding-set`                         | false    |
      | `"bindingSet.write"`        | `project.bindingSet.write`        | PUT    | `/api/project/:projectId/binding-set`                         | true     |
      | `"bindingRevision.list"`    | `project.bindingRevision.list`    | GET    | `/api/project/:projectId/binding/:bindingId/revision`         | false    |
      | `"agentConfiguration.list"` | `project.agentConfiguration.list` | GET    | `/api/project/:projectId/binding/:bindingId/agent`            | false    |
      | `"agentConfiguration.get"`  | `project.agentConfiguration.get`  | GET    | `/api/project/:projectId/binding/:bindingId/agent/:agentName` | false    |

      Each operation: `service: PROJECT_SERVICE_NAME`, `access: AccessPolicy.Human`,
      `store: StoreName.Operational`, `lifetime: OperationLifetime.Unary`,
      `timeoutMs: PROJECT_OPERATION_TIMEOUT_MS`. Mutations set `mutation: true` and
      `body: true`. Reads set `mutation: false` and omit `body`.

      Input schemas (all `z.strictObject`, exact field names from `engine/docs/cli/project.md`):
      - `project.create` body: `{ name: projectNameSchema }`.
      - `project.list` query: `{ limit: z.coerce.number().int().min(1).max(1000).default(100).optional(), cursor: z.string().optional() }`.
      - `project.get` params: `{ projectId: z.string().min(1) }`.
      - `project.rename` params: `{ projectId: z.string().min(1) }`, body: `{ name: projectNameSchema }`.
      - `project.binding.list` params: `{ projectId: z.string().min(1) }`, query: `{ kind: z.array(z.nativeEnum(BindingKind)).optional(), state: z.nativeEnum(BindingState).optional(), limit: z.coerce.number().int().min(1).max(1000).default(100).optional(), cursor: z.string().optional() }`.
      - `project.binding.get` params: `{ projectId: z.string().min(1), bindingId: z.string().min(1) }`.
      - `project.bindingSet.get` params: `{ projectId: z.string().min(1) }`.
      - `project.bindingSet.write` params: `{ projectId: z.string().min(1) }`, body: `bindingSetWriteInputSchema`.
      - `project.bindingRevision.list` params: `{ projectId: z.string().min(1), bindingId: z.string().min(1) }`, query: `{ limit: z.coerce.number().int().min(1).max(1000).default(100).optional(), cursor: z.string().optional() }`.
      - `project.agentConfiguration.list` params: `{ projectId: z.string().min(1), bindingId: z.string().min(1) }`, query: `{ limit: z.coerce.number().int().min(1).max(1000).default(100).optional(), cursor: z.string().optional() }`.
      - `project.agentConfiguration.get` params: `{ projectId: z.string().min(1), bindingId: z.string().min(1), agentName: z.string().min(1) }`.

      Output schemas (all `z.strictObject`, fields from `engine/docs/cli/project.md`):
      - Project record: `{ id: z.string(), name: z.string(), bindingSetVersion: z.number().int().positive(), createdAt: z.number().int() }`.
      - Binding record: `{ id: z.string(), projectId: z.string(), name: z.string(), kind: z.nativeEnum(BindingKind), resourceIdentity: z.string(), revision: z.number().int().positive(), config: z.unknown(), createdAt: z.number().int(), removedAt: z.number().int().nullable() }`.
      - `project.create` and `project.rename` output: project record + `bindingSetVersion`.
      - `project.list` output: `{ items: z.array(projectRecord), nextCursor: z.string().nullable() }`.
      - `project.get` output: project record.
      - `project.binding.list` output: `{ items: z.array(bindingRecord), nextCursor: z.string().nullable() }`.
      - `project.binding.get` output: binding record.
      - `project.bindingSet.get` output: exactly `bindingSetWriteInputSchema` (`{ version, bindings: z.record(bindingNameSchema, bindingEditSchema) }`). `engine/docs/cli/project.md:232–236` rules that `binding export` prints exactly the `BindingSetWrite` shape, keyed by binding name, with binding-name references, ready for `binding apply`. The handler projects each current row to its `bindingEditSchema` form.
      - `project.bindingSet.write` output: `{ projectId: z.string(), bindingSetVersion: z.number().int().positive(), bindings: z.record(z.string(), bindingRecord), changes: z.array(z.strictObject({ kind: z.nativeEnum(ChangeKind), bindingId: z.string() })) }`.
      - `project.bindingRevision.list` output: `{ items: z.array(bindingRecord), nextCursor: z.string().nullable() }`.
      - `project.agentConfiguration.list` output: `{ items: z.array(agentConfigItem), nextCursor: z.string().nullable() }`.
      - `project.agentConfiguration.get` output: agentConfigItem.
      - agentConfigItem: `{ agent: z.string(), worker: z.string(), workerBindingId: z.string(), bindingSetVersion: z.number().int().positive(), defaults: z.unknown().nullable(), entry: z.unknown().nullable(), effective: z.unknown().nullable(), valid: z.boolean(), issues: z.array(z.strictObject({ path: z.array(z.string()), code: z.string() })) }`.

  16. Keep `ProjectBindings.resolveWorkerBinding` interface intact.
- Rules:
  - `contract.ts` imports only kernel modules and `zod`; no other service files
    (`eslint.config.js`).
  - Named constants for every fixed value; no bare literals (`architecture.impl.md:17-20`).
  - All schemas use `z.strictObject` (`architecture.impl.md:34-37`).
  - Operation service key prefix must be `project.` (D9; `openapi.ts:51`).
- Done when: TypeScript compiles without error; `pnpm run verify` passes; ESLint boundary
  check passes.

### 05.3 Implement binding store — reads, compare-and-swap write, and pagination

- Files: `src/project/store.ts` (create), `src/project/store.test.ts` (create)
- Do:
  1. Export `StoredBinding` type:
     `{ id: string; projectId: string; name: string; resourceIdentity: string; revision: number; config: unknown; createdAt: number; removedAt: number | null }`.
  2. Export `deriveResourceIdentity(kind: string, bindingName: string, config: unknown): string`:
     - `BindingKind.Repository`: parse `(config as any).address` matching
       `git@github.com:<owner>/<repo>.git`; return `repository:github:<owner>/<repo>`
       (`project-service.impl.md:74`); throw if address does not match.
     - `BindingKind.Worker`: return `worker:kanthord:<bindingName>`
       (`project-service.impl.md:75`).
     - `BindingKind.Storage`: parse `(config as any).endpoint` as URL; return
       `storage:s3:<URL.host>/<bucket>` (`project-service.impl.md:76`).
     - Any other kind: throw with a diagnostic.
  3. Export `readCurrentBindingSet(tx: Transaction, projectId: string): Map<string, StoredBinding>`:
     - SQL: for each `(project_id, resource_identity)` group select the row with
       `MAX(revision)`; filter to groups where that row has `removed_at IS NULL`.
     - Parse `config` column as JSON.
     - Return a `Map` keyed by `name`.
  4. Export `writeBindingSet(tx: Transaction, projectId: string, submittedVersion: number, submission: Map<string, { kind: string; config: unknown }>): { newVersion: number; changes: BindingChange[] }`:
     - Read `project_project WHERE id = projectId`; throw `OperationError(404,
"project.project.not_found", ...)` if absent.
     - Throw `OperationError(409, "project.binding_set.version_conflict", ...)` with `details: { bindingSetVersion: row.binding_set_version }` if `row.binding_set_version !== submittedVersion` (`project-service.impl.md:91`).
     - Call `readCurrentBindingSet(tx, projectId)` to get the current set.
     - **Phase 1 — compute the full diff without writing**:
       For each submitted name, derive `resourceIdentity`, compare canonical JSON of `config`
       with stored `config`, and classify the outcome per `project-service.impl.md:98-104`.
       For each current name absent from the submission, classify as tombstone.
       Refuse if a worker binding's stored `config.worker` differs from the submitted
       `config.worker` under the same binding name with `OperationError(409, "project.bindings.worker.resource_changed", ...)` (`project-service.impl.md:126`).
     - **Phase 2 — insert all tombstones first**:
       For each outcome that tombstones an existing group (resource-identity change or
       omission): insert a tombstone row (`revision = MAX(revision)+1` for that group,
       `removed_at = Date.now()`, `config = last config`, new `createIdentity(BINDING_ID_PREFIX)`).
       Allocate the new `revision` via `SELECT MAX(revision) FROM project_binding WHERE
project_id = ? AND resource_identity = ?` (all rows including tombstones) + 1.
     - **Phase 3 — insert new revisions**:
       For each outcome that creates or revises a row: allocate `revision` from the group
       (including any tombstone just inserted in Phase 2, so `SELECT MAX(revision) + 1`);
       insert the new row with `removed_at = NULL`.
     - Update `project_project SET binding_set_version = binding_set_version + 1`.
     - Return `{ newVersion: submittedVersion + 1, changes }`.
  5. Export `readBindingRevision(tx: Transaction, id: string): StoredBinding | null`.
  6. Export `listBindings(tx: Transaction, projectId: string, filter: { kind?: string[]; state?: string; limit: number; cursor?: string | null }): { items: StoredBinding[]; nextCursor: string | null }`:
     - For each `(project_id, resource_identity)` group select the greatest-revision row.
     - Apply `kind` filter: match the first colon-part of `resource_identity` against each
       value in `filter.kind` (OR logic).
     - Apply `state` filter: `current` (max-revision row has `removed_at IS NULL`), `removed`
       (max-revision row has `removed_at IS NOT NULL`), `all` (no filter). Default: `current`.
     - Paginate by `id DESC`; encode cursor as `base64url(id)`.
  7. Export `listRevisions(tx: Transaction, bindingId: string, filter: { limit: number; cursor?: string | null }): { items: StoredBinding[]; nextCursor: string | null }`:
     - Find `project_id` and `resource_identity` from the row with `id = bindingId`.
     - Return all rows of that group ordered by `revision DESC`; paginate by `revision`
       (cursor is `base64url(String(revision))`).
  8. Create `src/project/store.test.ts` using `IN_MEMORY_DATABASE` with full project
     migrations applied. Test all three phases of `writeBindingSet`:
     - Unchanged config (canonical JSON equal): no new row; version increments; `Unchanged`.
     - Changed config, same resource identity: next revision of group; `Revised`.
     - Changed resource identity (same name): tombstone in old group first (Phase 2), new
       row in new group (Phase 3); `Created`.
     - Two names that swap resources: both tombstones in Phase 2, both new rows in Phase 3.
     - New name (no prior group): revision 1; `Created`.
     - Omitted name: tombstone; rows retained; `Removed`.
     - Worker name changed under same binding name: refused.
     - Stale `submittedVersion`: refused with stale-version error.
     - Absent project: refused with not-found error.
     - Reordered JSON: no new revision; `Unchanged`.
     - Rebind after tombstone: next revision after tombstone; `Created`.
     - Equal submission: version increments; `Unchanged` for every binding.
     - Concurrent write (second sees incremented version): refused.
     - `listRevisions` paginates by revision descending.
     - `listBindings` state `current` excludes tombstoned groups; `removed` includes only
       tombstoned groups; `all` includes both.
     - `listBindings` kind filter matches exactly the specified kinds.
     - `deriveResourceIdentity` for each kind returns the correct prefix form.
- Rules:
  - `writeBindingSet` receives the caller's `Transaction`; opens no transaction and
    commits none (`architecture.impl.md:105-117`).
  - Tombstones are inserted in Phase 2 before new revisions in Phase 3 (ERD:210).
  - Canonical JSON comparison uses `canonicalJSON` from `../kernel/json.ts`.
  - `createIdentity` from `../kernel/identity.ts` allocates binding identities.
  - All comparisons against fixed strings use named constants (`architecture.impl.md:17-20`).
- Done when: all `store.test.ts` tests pass; `pnpm run verify` passes.

### 05.4 Register `project.create`, `project.list`, `project.get`, `project.rename`; implement `resolveWorkerBinding`

- Files: `src/project/service.ts` (edit), `src/project/service.test.ts` (edit),
  `src/apps/server/index.ts` (edit)
- Do:
  1. Extend `Dependencies` and update `src/apps/server/index.ts`:
     - Add `operationalStore: Store` (required; the composition root passes the real store
       per D4 and D14).
     - Add required fields: `createMission: CreateMission`, `liveNodesPinning: LiveNodesPinning`,
       `validateEntry: ValidateEntry`, `custodySuitability: CustodySuitability`,
       `repositoryConnector: RepositoryConnector`, `workerAgentsOf: WorkerAgentsOfFn`,
       `workerAgentView: WorkerAgentViewFn`.
       Store each injected field in a private readonly field.
       Import `Store` from `../kernel/store.ts`.
       Update the `ProjectService` constructor call in `src/apps/server/index.ts` (line 61):
       pass `operationalStore: options.store` (the real operational store already present in
       the composition root) and `unwired("<seam>")` for each peer collaboration
       (`createMission`, `liveNodesPinning`, `validateEntry`, `custodySuitability`,
       `repositoryConnector`, `workerAgentsOf`, `workerAgentView`).
       Import `unwired` from `./unwired.ts` (created by Plan 03).
       `Project` is constructed before `Worker` in `index.ts`; `workerAgentsOf` and
       `workerAgentView` use `unwired`, not a late-bound closure. Plan 07 replaces every
       `unwired(...)` with the real implementation and deletes `unwired.ts`. (D14)
  2. Register `project.create`:
     - Natural key: `{ name }`.
     - `caller.commit((tx) => { ... })`:
       - Insert `project_project` with `createIdentity(PROJECT_ID_PREFIX)`, `name`,
         `binding_set_version = BINDING_SET_INITIAL_VERSION`, `created_at = Date.now()`.
       - On unique-name constraint violation: query `project_project` by `name`; throw
         `OperationError(409, "project.name.conflict", ..., { id: holder.id })`.
       - Narrow `caller.identity` with `isHumanIdentity`; derive
         `actor = { kind: "human", account: identity.accountId, name: identity.name }`.
       - Call `this.createMission(tx, projectId, actor)` in the same transaction.
       - Return `{ id, name, bindingSetVersion: BINDING_SET_INITIAL_VERSION, createdAt }`.
  3. Register `project.list`:
     - `caller.commit((tx) => { ... })`: query `project_project ORDER BY id DESC`; paginate;
       return `{ items, nextCursor }`.
  4. Register `project.get`:
     - `caller.commit((tx) => { ... })`: select by `params.projectId`; throw
       `OperationError(404, "project.project.not_found", ...)` if absent; return record.
  5. Register `project.rename`:
     - Natural key: `{ projectId, name }`.
     - `caller.commit((tx) => { ... })`:
       - Select row; throw `OperationError(404, "project.project.not_found", ...)` if absent.
       - `UPDATE project_project SET name = ? WHERE id = ?`.
       - On unique-name violation: throw
         `OperationError(409, "project.name.conflict", ..., { id: holder.id })`.
       - Return updated record.
  6. Implement `resolveWorkerBinding(bindingId: string, context: Context): Promise<{ workerBindingId: string; projectId: string } | null>`:
     - `throwIfCancelled(context)`.
     - `this.operationalStore.transaction((tx) => { ... })`:
       - Select `project_binding WHERE id = bindingId`; return `null` if absent.
       - Return `null` if `removed_at IS NOT NULL`.
       - Derive `kind` from the first colon-part of `resource_identity`; return `null` if
         `kind !== BindingKind.Worker`.
       - Select the greatest-revision row for the same `(project_id, resource_identity)` group;
         return `null` if that row has `removed_at IS NOT NULL` (tombstoned after pin).
       - Parse `latestRow.config`; return `null` if `config.instanceCount === INSTANCE_COUNT_MIN`.
       - Return `{ workerBindingId: row.id, projectId: row.projectId }`.
  7. Update `src/project/service.test.ts`:
     - Remove `NO_OPERATIONS` assertion; assert registry contains exactly four operation IDs.
     - Create succeeds and returns correct fields.
     - Create duplicate name returns 409 `project.name.conflict` with holder `id`.
     - `createMission` stub called inside `caller.commit`.
     - Project list returns items in descending `id` order with pagination.
     - Project get returns 404 `project.project.not_found` for absent id.
     - Rename to taken name returns 409 `project.name.conflict`.
     - Rename of absent project returns 404 `project.project.not_found`.
     - `resolveWorkerBinding` returns identity for a current worker binding with `instanceCount > 0`.
     - `resolveWorkerBinding` returns `null` for: removed binding, non-worker binding,
       absent binding, binding with `instanceCount = 0`, binding where the group's latest
       revision is a tombstone after the pinned revision.
- Rules:
  - `project.create` is idempotent by `name`; retry returns 409 (`engine/docs/cli/project.md:142`).
  - No `actor` field in operation input; actor derives from `caller.identity`.
  - `project.name.conflict` is the three-part code per Aelita's 2026-09-27 ruling.
  - All collaborations are required (D4); colocated tests inject fakes.
  - `operationalStore` receives `options.store` from the composition root (D14).
  - Peer collaborations receive `unwired("<seam>")` at construction; Plan 07 wires real
    implementations (D14).
  - `resolveWorkerBinding` uses `this.operationalStore.transaction` (D3); it is not a
    handler and has no `CallerContext`.
- Done when: all `service.test.ts` tests pass; `pnpm run verify` passes.

### 05.5 Register binding-set write and binding read operations

- Files: `src/project/service.ts` (edit), `src/project/service.test.ts` (edit)
- Do:
  1. Register `project.bindingSet.write` in `declare(registry)`:
     - **Whole-set `superRefine`** on `body.bindings`:
       a. Each binding name matches `bindingNameSchema`.
       b. Removed from the schema: the handler checks unique `resourceIdentity` (step 1a below), so the domain code reaches the client instead of `gateway.request.validation_failed`.
       c. Removed with b.
       d. For each repository binding whose strategy has an action with
       `follows.type = FollowsType.ActionEndState`: `follows.binding` must name a
       repository binding in the submission that itself has a configured `action`; refuse
       absent reference or wrong-kind target (CLI:470-472).
       e. Cycle check: detect cycles in `action_end_state.follows.binding` references;
       refuse a cycle (CLI:348).
       f. For external-harness workers: refuse `config.entries` or `config.resourceBudget`
       (CLI:373).
       g. For each worker binding: agent selectors in `config.entries` must be unique
       (CLI:379); no duplicate agent name in entries.
     - For each `repository` binding in the submission, call
       `this.repositoryConnector.gitLsRemote((config as any).address, context, LS_REMOTE_TIMEOUT_MS)`
       before `caller.commit`; on failure throw
       `OperationError(422, "project.bindings.repository.ssh_unreachable", ...)`
       (`project-service.impl.md:247-250`; CLI:465).
     - Step 1a, before the `gitLsRemote` calls: derive `resourceIdentity` for every submitted binding; two bindings with one `resourceIdentity` throw `OperationError(400, "project.bindings.duplicate_resource", ...)` (`project-service.impl.md`, the binding-set write rules).
     - `caller.commit((tx) => { ... })`:
       a. For each repository binding:
       - Throw `OperationError(400, "project.bindings.repository.address_invalid", ...)` if the address starts with `https://` (`project-service.impl.md:135`).
       - Throw if `projectPrompt` byte-length exceeds `PROJECT_PROMPT_MAX_BYTES` (code:
         `project.bindings.repository.project_prompt_too_large`; `project-service.impl.md:132`).
       - Call `this.custodySuitability(tx, { credential: config.credential, platform: REPOSITORY_PLATFORM })`.
         b. For each worker binding:
       - Throw if `config.instanceCount < INSTANCE_COUNT_MIN ||
config.instanceCount > INSTANCE_COUNT_MAX` (code:
         `project.bindings.worker.instance_count_range`; `project-service.impl.md:129`).
       - For each declared agent of the worker (from `this.workerAgentsOf(config.worker)`):
         find the matching entry in `config.entries` if present; strip the `agent` field
         to produce `WorkerEntry | null`; call
         `this.validateEntry(tx, config.worker, workerEntry)`.
       - For an agent name in `config.entries` that `workerAgentsOf` does not declare:
         throw `OperationError(400, "project.bindings.worker.agent_unknown", ...)`.
         c. For each storage binding:
       - Call `this.custodySuitability(tx, { credential: config.credential, platform: STORAGE_PLATFORM })`.
         d. Call `writeBindingSet(tx, projectId, body.version, submissionMap)` from store.
         e. Construct `bindings` response object: map each current name to its binding record
         with `kind` derived from `resource_identity` first colon-part.
         f. Return `{ projectId, bindingSetVersion: newVersion, bindings, changes }`.
  2. Register `project.bindingSet.get`:
     - `caller.commit((tx) => { ... })`:
       - Select `project_project WHERE id = params.projectId`; throw
         `OperationError(404, "project.project.not_found", ...)` if absent.
       - Call `readCurrentBindingSet(tx, projectId)`.
       - Return `{ version: row.binding_set_version, bindings: <object from map> }`.
  3. Register `project.binding.list`:
     - `caller.commit((tx) => { ... })`:
       - Call `listBindings(tx, projectId, { kind: query.kind, state: query.state ?? BindingState.Current, limit, cursor })`.
       - Return `{ items, nextCursor }`.
  4. Register `project.binding.get`:
     - `caller.commit((tx) => { ... })`:
       - Call `readBindingRevision(tx, bindingId)`.
       - Throw `OperationError(404, "project.binding.not_found", ...)` if absent.
       - Throw `OperationError(404, "project.binding.not_found", ...)` if
         `row.projectId !== params.projectId`.
       - Derive `kind` from first colon-part of `row.resourceIdentity`.
       - Return binding record with `kind`.
  5. Register `project.bindingRevision.list`:
     - `caller.commit((tx) => { ... })`:
       - Call `readBindingRevision(tx, bindingId)`; throw
         `OperationError(404, "project.binding.not_found", ...)` if absent or wrong project.
       - Call `listRevisions(tx, bindingId, { limit, cursor })`.
       - Return `{ items, nextCursor }`.
  6. Update `src/project/service.test.ts`:
     - Binding-set write: success; stale version refused; worker name changed refused;
       HTTPS address refused; `instanceCount` out of range refused; `projectPrompt` above
       32768 bytes refused; reordered JSON creates no revision; equal submission increments
       version; concurrent write refused; SSH failure leaves rows unchanged.
     - Write calls `repositoryConnector.gitLsRemote` for every repository binding.
     - `custodySuitability` stub called for repository with `{ credential, platform: "github" }`.
     - `custodySuitability` stub called for storage with `{ credential, platform: "s3" }`.
     - `validateEntry` stub called for every agent of each worker binding.
     - External worker with `entries` refused; external worker with `resourceBudget` refused.
     - Duplicate agent selector in entries refused.
     - `action_end_state.follows.binding` pointing to a non-repository binding refused.
     - Absent `action_end_state.follows.binding` name refused.
     - `bindingSet.get` returns 404 for absent project.
     - Binding list: `kind` filter; `state` filter; pagination.
     - Binding get: found; absent 404; wrong-project 404.
     - Binding revision list: revision descending; pagination.
- Rules:
  - `git ls-remote` is called for every repository binding before `BEGIN IMMEDIATE`
    (`project-service.impl.md:247`; CLI:465); not only when address changes.
  - No network call inside the transaction.
  - Equal submission still increments `binding_set_version` (`project-service.impl.md:104`).
  - `custodySuitability` and `validateEntry` run inside the transaction
    (`project-service.impl.md:127-128`; `architecture.impl.md:591`).
  - `repositoryConnector`, `custodySuitability`, `validateEntry`, and `workerAgentsOf` are
    required (D4); tests inject stubs.
  - `instanceCount` range check runs in the handler (domain error code); zod schema uses
    `z.number().int()` without `.min()/.max()`.
  - Worker entries: strip `agent` selector before calling `validateEntry` (seam type is
    `WorkerEntry`, not `AgentEntry`).
- Done when: all new `service.test.ts` tests pass; `pnpm run verify` passes.

### 05.6 Register agent configuration views

- Files: `src/project/service.ts` (edit), `src/project/service.test.ts` (edit)
- Do:
  1. Register `project.agentConfiguration.list` in `declare(registry)`:
     - `caller.commit((tx) => { ... })`:
       - Call `readBindingRevision(tx, bindingId)`; throw
         `OperationError(404, "project.binding.not_found", ...)` if absent or wrong project.
       - Derive `kind`; throw `OperationError(404, "project.binding.not_found", ...)` if
         `kind !== BindingKind.Worker`.
       - Call `this.workerAgentsOf(config.worker)` to get declared agent names.
       - For each declared agent: find the binding entry for that agent (if any); strip
         `agent` field to produce `WorkerEntry | null`; call
         `this.workerAgentView(tx, config.worker, agentName, entry)`.
       - Paginate agent names alphabetically; return `{ items, nextCursor }` with each
         item populated from the `WorkerAgentView` result.
  2. Register `project.agentConfiguration.get`:
     - Same as list but for one `agentName`; throw
       `OperationError(404, "project.binding.not_found", ...)` if `agentName` is not in
       `workerAgentsOf(config.worker)`.
  3. Update `src/project/service.test.ts`:
     - List agents: stub `workerAgentsOf` returns two agent names; stub `workerAgentView`
       returns a filled view; assert items and pagination.
     - Get one agent: found; not-found agent name returns 404.
     - Non-worker binding returns 404 `project.binding.not_found`.
     - Absent binding returns 404 `project.binding.not_found`.
- Rules:
  - Read operations; no mutation, no remote call.
  - `workerAgentsOf` and `workerAgentView` are declared in Plan 03 `contract.ts` per D6;
    implementations are required (D4); tests inject stubs.
- Done when: agent-view tests pass; `pnpm run verify` passes.

### 05.7 Implement `entriesOfAgent`, `bindingsNaming`, `resolveBinding`, and `getBindingRevision` collaborations

- Files: `src/project/contract.ts` (edit), `src/project/service.ts` (edit), `src/project/service.test.ts` (edit)
- Do:
  1. Implement `entriesOfAgent(tx: Transaction, agentName: string): AgentDependentBinding[]`
     as a public method on `ProjectService`:
     - Query each group's max-revision non-tombstone row across all projects.
     - Parse `config`; skip rows whose `resource_identity` first part is not
       `BindingKind.Worker`.
     - For each worker binding: call `this.workerAgentsOf(config.worker)`; if `agentName`
       is in the returned list, include this binding.
     - Find the explicit entry for `agentName` in `config.entries`; strip `agent` field to
       produce `WorkerEntry | null` (null when no explicit entry).
     - Return `{ bindingId: row.id, workerName: config.worker, entry: WorkerEntry | null }`.
  2. Implement `bindingsNaming(tx: Transaction, credentialName: string): BindingRevision[]`
     as a public method:
     - For each group's max-revision non-tombstone row: check if `config` JSON names
       `credentialName` as the value of a `credential` key at any level of the config
       (`project-service.impl.md:175-179`).
     - Also include: any non-tombstone row where no tombstone follows it AND the row's
       config names `credentialName` AND
       `this.liveNodesPinning(tx, row.id)` returns a non-empty array.
     - Deduplicate by `row.id`.
     - Return `{ bindingId: row.id, projectId: row.projectId }` for each included row.
  3. Implement `resolveBinding(tx: Transaction, projectId: string, bindingName: string): { bindingId: string; resourceIdentity: string } | null`
     as a public method (per D7):
     - Use a subquery to find the `resource_identity` of each group whose max-revision row
       has `removed_at IS NULL AND project_id = projectId AND name = bindingName`; then
       select that max-revision row.
     - Return `{ bindingId: row.id, resourceIdentity: row.resourceIdentity }` or `null`.
  4. Declare `BindingRevisionResult` type in `contract.ts`:
     `{ bindingId: string; name: string; resourceIdentity: string; revision: number; tombstone: boolean; disabled: boolean }`.
  5. Implement `getBindingRevision(tx: Transaction, bindingId: string): BindingRevisionResult | null`
     as a public method on `ProjectService`:
     - Select the row with `id = bindingId`; return null if absent.
     - Compute `tombstone`: true when `row.removed_at IS NOT NULL` or when a later row
       of the same group (same `project_id` and `resource_identity`) has
       `removed_at IS NOT NULL`. Cite `01-setup.md:204`.
     - Compute `disabled` from the max-revision row of the group: derive kind from the
       first colon-part of `resource_identity`; for a worker kind (`BindingKind.Worker`),
       disabled when `config.instanceCount === INSTANCE_COUNT_MIN`; for other kinds,
       disabled when `config.available === false`. Cite `01-setup.md:205`.
     - Return `{ bindingId: row.id, name: row.name, resourceIdentity: row.resource_identity,
revision: row.revision, tombstone, disabled }`.
  6. Update `src/project/service.test.ts`:
     - `entriesOfAgent`: explicit entry present; no explicit entry returns `entry: null`;
       two projects with same agent both appear; non-worker bindings excluded.
     - `bindingsNaming`: latest-revision dependent included when config names credential;
       older pinned revision included when `liveNodesPinning` stub returns a node id and
       config names the credential; rebinding frees it once `liveNodesPinning` returns empty.
     - `resolveBinding`: returns `{ bindingId, resourceIdentity }` for a current binding;
       returns `null` for a tombstoned name; returns `null` for an absent name; correctly
       selects the new group after a resource-identity change.
     - `getBindingRevision`: returns the struct for an existing row; returns null for an
       absent `bindingId`; `tombstone=true` when the row itself has `removed_at IS NOT NULL`;
       `tombstone=true` when a later revision of the same group has `removed_at IS NOT NULL`
       and the queried row does not; `tombstone=false` for an active row with no later
       tombstone; `disabled=true` for a repository binding when the max-revision row has
       `available=false`; `disabled=true` for a worker binding when the max-revision row has
       `instanceCount=0`; `disabled=false` when neither condition holds.
- Rules:
  - Collaborations receive `Transaction`; open no transaction and commit none.
  - `liveNodesPinning`, `workerAgentsOf` are required (D4); tests inject stubs.
  - `entriesOfAgent` includes bindings with no explicit entry
    (`project-service.impl.md:170-171`).
  - `bindingsNaming` checks credential name in BOTH branches (current row and pinned row).
  - `getBindingRevision` derives `tombstone` and `disabled` from `01-setup.md:204–205`.
- Done when: all collaboration tests pass; `pnpm run verify` passes.

### 05.8 Update AGENTS.md entry for Project Service

- Files: `engine/AGENTS.md` (edit)
- Do:
  1. In the `src/project/` block, update the file list:
     - `contract.ts` — constants, enums, binding schemas, operation declarations,
       collaboration interfaces, and inline dependency types.
     - `migrations.ts` — DDL migrations for `project_project` and `project_binding`.
     - `store.ts` — binding set read, compare-and-swap write, pagination, and resource
       identity derivation.
     - `service.ts` — service lifecycle, operation handlers, and collaboration
       implementations.
     - `index.ts` — service, dependencies, configuration fragment, and migrations.
  2. Remove the skeleton description if present.
- Rules:
  - Edit only the `src/project/` section; leave all other sections unchanged.
- Done when: `pnpm run verify` passes; AGENTS.md reflects the delivered files.

### 05.9 Component healthcheck and resource inventory

- Files: `src/project/contract.ts` (edit), `src/project/service.ts` (edit),
  `src/project/service.test.ts` (edit)
- Do:
  1. Add to `contract.ts`:
     a. Add named constant `RESOURCE_CAPABILITY_NETWORK_GIT_READ = "network git read"`.
     b. Add named constant `RESOURCE_TARGET_KIND_REPOSITORY = "repository"`.
     c. Import `ResourceEntry`, `ResourceStatus`, `ResourceCheck`, `HealthScope` from
     `../kernel/health.ts`. Declare no local equivalents.
  2. Verify `healthcheck()` in `service.ts` returns
     `{ bindings: this.started && !this.shutdown.err() ? HealthStatus.Healthy : HealthStatus.Unavailable }`.
     No logic change is needed; this method reads only in-process state and performs no
     remote call (`architecture.impl.md:369`).
  3. Add `resourceInventory(tx: Transaction): ResourceEntry[]` as a public method on
     `ProjectService`:
     - For each `(project_id, resource_identity)` group where `resource_identity LIKE
'repository:%'`, select the max-revision row inside `tx`; include only groups whose
       max-revision row has `removed_at IS NULL`.
     - Join `project_project WHERE id = row.project_id` inside the same `tx` to get the
       project name.
     - Parse each `config` column as JSON; extract `config.address` as the SSH URL.
     - Build one `ResourceEntry` per row:
       - `scope`: `HealthScope.Project`.
       - `project`: project name from the join.
       - `name`: `encodeURIComponent(row.name)`.
       - `target`: `RESOURCE_TARGET_KIND_REPOSITORY + ":" + config.address`.
       - `capability`: `RESOURCE_CAPABILITY_NETWORK_GIT_READ`.
       - `check`: async closure that captures `config.address` at build time:
         `const deadline = context.deadline(); assert.ok(deadline !== null);`
         call `this.repositoryConnector.gitLsRemote(address, context, deadline - Date.now())`;
         on success return `ResourceStatus.Healthy`; in the catch block return
         `context.err() ? ResourceStatus.Unknown : ResourceStatus.Unhealthy`.
         No check result is stored (`project-service.impl.md:266`). No credential record
         appears in the attribution (`project-service.impl.md:265`; Repository component uses
         host SSH config only, per `repository.impl.md`).
     - The method receives `tx`, reads rows inside it, opens no transaction, and performs no
       network call (`00-index.md` Seams, `resourceInventory`).
  4. Update `src/project/service.test.ts`:
     - `healthcheck()`: started service returns `{ bindings: HealthStatus.Healthy }`; stopped
       service returns `{ bindings: HealthStatus.Unavailable }`.
     - `resourceInventory(tx)`:
       - Two current repository bindings in one project return two `ResourceEntry` items with
         correct `scope`, `project`, `name`, `target`, `capability` fields.
       - A tombstoned repository binding is excluded.
       - A worker binding is excluded.
       - A storage binding is excluded.
       - Calling `entry.check(ctx)` with a stub `repositoryConnector` that resolves returns
         `ResourceStatus.Healthy`.
       - Calling `entry.check(ctx)` with a stub that rejects returns `ResourceStatus.Unhealthy`.
       - Calling `entry.check(ctx)` where `ctx` is already cancelled returns
         `ResourceStatus.Unknown`.
       - `resourceInventory` itself performs no network call.
       - Two entries with the same address produce two independent `check` closures.
       - `name` is the percent-encoded binding name; `target` is
         `"repository:" + config.address`.
- Rules:
  - `healthcheck()` reads only in-process state; performs no remote call
    (`architecture.impl.md:369`).
  - `resourceInventory` receives `tx`, opens no transaction, and performs no network call (`00-index.md` Seams, `resourceInventory`).
  - `check` honours the caller-supplied context; it sets no deadline of its own.
  - Named constants for every fixed string (`architecture.impl.md:17-20`).
  - Import `ResourceEntry`, `ResourceStatus`, `ResourceCheck`, `HealthScope` from
    `../kernel/health.ts`; declare no local equivalents.
- Done when: all new `service.test.ts` tests pass; `pnpm run verify` passes.

## Blockers

None.
