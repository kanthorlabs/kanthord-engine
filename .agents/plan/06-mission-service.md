# Plan 06: Mission Service

## Scope

This plan delivers `src/mission/` with the four Mission tables (`mission_mission`,
`mission_node`, `mission_node_revision`, `mission_dependency`), the operations
that ERD 1 admits (import, export, node API, dependency edits, criterion set
and priority), the `createMission` and `liveNodesPinning` collaborations, and
the `WorkQueue` seam from Plan 02.

Tasks hold no `mission_node_revision` row. Task content lives in the `tasks`
column of the parent objective's revision. Every task path (create, update,
move, retire, read, export) reads and writes through the objective's revision.

Out of scope: human controls (pause, resume, block, unblock, ready, override,
discard) — ERD 2; attempts, outcomes, evidence, assessments, evaluations,
observations, run outputs — ERD 2; `pinCredential` and `liveExecutionsPinning`
— ERD 2.

`Text` bounds: a `Text` value is nonblank and holds at most `mission.textMaxBytes` UTF-8
bytes, 32768 by default (D11; `mission-service.impl.md` "Configuration" and "Operation contracts").

Every other ERD 1 task is unblocked.

## Sources

- `docs/brainstorm/mission-service.md` — node graph, dependency rules, cycle
  refusal, retirement, import condition, plan file name uniqueness, bindings
  rule table, priority, `expectedMissionVersion` version check, initiative steps
  condition (claimability of an initiative in `Available`).
- `docs/brainstorm/mission-service.vocabulary.md` — node content fields, binding
  counts, plan file name form, import set and retirement set definitions, twelve
  node states.
- `docs/brainstorm/mission-service.impl.md` — identities, actor JSON, node
  content validation, priority validation, configuration
  (`mission.consecutiveLossLimit`), plan file grammar, export/import formats,
  node API admission, node retire, revisions, `NodeChange`, `liveNodesPinning`,
  error codes, operation contracts, tests; wire shapes for all operations.
- `docs/reference/erd/01-setup.md` — four mission tables with columns, partial
  unique index on `(mission_id, filename)` where `retired_at` is null, Mission
  Service constraints, Scheduler constraints driven by Mission, capability limits;
  task holds no revision, no state, no attempt and no priority; task content in
  `tasks` column of objective revision.
- `engine/docs/cli/mission.md` — operation routes, IDs, access policies, input
  and output schemas verbatim.
- `docs/brainstorm/architecture.impl.md:157–161` — identity prefix convention.
- `docs/brainstorm/architecture.impl.md:339–349` — error code form (three parts).
- `docs/brainstorm/architecture.impl.md:583–600` — Kind 2 collaboration contract.
- `engine/AGENTS.md` — "Add a service", "Add an operation", "Add a migration",
  file layout.
- `engine/.agents/plan/00-index.md` — seam signatures, ownership table.
- `docs/reference/erd/01-setup.md:201` — `resource_identity` first part is the
  binding kind; kind is `repository`, `storage` or `worker`.

## Depends on

- Plan 02 — `WorkQueue` interface (`insert`, `delete`, `priorityUpdate`) in
  `src/scheduler/contract.ts`; injected into `MissionService.Dependencies`.
- Plan 05 — `resolveBinding(tx, projectId, bindingName): { bindingId: string; resourceIdentity: string } | null`
  and `getBindingRevision(tx, bindingId): { bindingId: string; name: string; resourceIdentity: string; revision: number; tombstone: boolean; disabled: boolean } | null`
  in `src/project/contract.ts`; both declared in `MissionBindings` and injected into
  `MissionService.Dependencies`. The `resourceIdentity` first colon-separated part is
  the binding kind. `tombstone` and `disabled` derived from `01-setup.md:204–205`.

## Provides

| Seam               | TypeScript signature                                            | Owner file                | Consumer plans   |
| ------------------ | --------------------------------------------------------------- | ------------------------- | ---------------- |
| `createMission`    | `(tx: Transaction, projectId: string, actor: HumanActor): void` | `src/mission/contract.ts` | 05 (wired in 07) |
| `liveNodesPinning` | `(tx: Transaction, bindingId: string): string[]`                | `src/mission/contract.ts` | 05 (wired in 07) |

## Tasks

### 06.1 Create the migration file

- Files: `src/mission/migrations.ts`
- Do:
  1. Add migration 1: create `mission_mission`, `mission_node`, `mission_node_revision`
     and `mission_dependency` with these exact columns.

     `mission_mission`: `id TEXT NOT NULL PRIMARY KEY`, `project_id TEXT NOT NULL UNIQUE`,
     `version INTEGER NOT NULL`, `created_at INTEGER NOT NULL`.

     `mission_node`: `id TEXT NOT NULL PRIMARY KEY`,
     `mission_id TEXT NOT NULL REFERENCES mission_mission(id)`,
     `kind TEXT NOT NULL`, `filename TEXT NOT NULL`,
     `parent_id TEXT REFERENCES mission_node(id)`,
     `state TEXT`, `attempt INTEGER`, `priority INTEGER`,
     `retired_at INTEGER`, `created_at INTEGER NOT NULL`.
     Partial unique index: `CREATE UNIQUE INDEX mission_node_filename_active ON mission_node(mission_id, filename) WHERE retired_at IS NULL`.

     `mission_node_revision`: `node_id TEXT NOT NULL REFERENCES mission_node(id)`,
     `revision INTEGER NOT NULL`, `filename TEXT NOT NULL`, `name TEXT NOT NULL`,
     `requirement TEXT NOT NULL`, `criterion TEXT NOT NULL`,
     `verifications TEXT NOT NULL`, `bindings TEXT NOT NULL`,
     `tasks TEXT`, `change TEXT NOT NULL`, `reason TEXT NOT NULL`,
     `actor TEXT NOT NULL`, `created_at INTEGER NOT NULL`,
     `PRIMARY KEY (node_id, revision)`.

     `mission_dependency`: `dependent_id TEXT NOT NULL REFERENCES mission_node(id)`,
     `depends_on_id TEXT NOT NULL REFERENCES mission_node(id)`,
     `mission_id TEXT NOT NULL REFERENCES mission_mission(id)`,
     `PRIMARY KEY (dependent_id, depends_on_id)`.

- Rules:
  - No `CHECK` constraint. `engine/CLAUDE.local.md`.
  - No non-unique index — the `(mission_id, filename)` index is a partial unique
    index. `engine/CLAUDE.local.md`.
  - `foreign_keys` is `ON` per `architecture.impl.md` connection rules. Self-reference
    on `parent_id` inserts the parent first, so no deferred key. `01-setup.md:179`.
  - `tasks TEXT` is nullable: null for initiatives; JSON task array for objectives.
    `01-setup.md:105`.
  - State, attempt and priority columns are nullable: null for tasks. `01-setup.md:89–92`.
  - Table prefix `mission_`. `engine/AGENTS.md`.
- Done when: `pnpm run verify` passes; the migration creates all four tables;
  `sqlite_master` lists `mission_node_filename_active` as the partial unique index
  name; `mission_node_revision` has primary key `(node_id, revision)`.

### 06.2 Create `contract.ts` with collaboration types and wire schemas

- Files: `src/mission/contract.ts`
- Do:
  1. Declare `HumanActor` interface: `{ kind: "human"; account: string; name: string }`.
  2. Declare `MissionBindings` interface (input dependency) with two methods:
     `resolveBinding(tx: Transaction, projectId: string, bindingName: string): { bindingId: string; resourceIdentity: string } | null`
     and `getBindingRevision(tx: Transaction, bindingId: string): { bindingId: string; name: string; resourceIdentity: string; revision: number; tombstone: boolean; disabled: boolean } | null`.
     `tombstone` and `disabled` follow `01-setup.md:204–205`.
  3. Declare `WorkQueue` interface (input dependency, mirroring Plan 02 method names exactly):
     ```ts
     export interface WorkQueue {
       insert(
         tx: Transaction,
         nodeId: string,
         projectId: string,
         priority: number,
       ): void;
       delete(tx: Transaction, nodeId: string): void;
       priorityUpdate(tx: Transaction, nodeId: string, priority: number): void;
     }
     ```
  4. Declare `MissionCollaborations` interface (provided to consumers):
     `createMission(tx: Transaction, projectId: string, actor: HumanActor): void`
     and `liveNodesPinning(tx: Transaction, bindingId: string): string[]`.
  5. Declare these zod schemas and export their TypeScript types. Use `z.strictObject`
     for every closed input and output schema. Named enum members for closed sets.

     `NodeKind`: `z.enum(["initiative", "objective", "task"])`.
     `NodeState`: `z.enum(["Pending", "Available", "Executing", "Waiting", "Evaluating",
  "Blocked", "Paused", "Completed", "Discarded", "External.Requested",
  "External.Success", "External.Failed"])`.
     `ContentSchema`: `z.strictObject({ name: z.string().min(1), requirement: z.string().min(1),
  criterion: z.string().min(1), verifications: z.array(z.string().min(1)).min(1),
  bindings: z.array(z.string()) })`.
     `PlanFileName`: `z.string().regex(/^[a-z][a-z0-9_-]*\.md$/)`.
     `NodeCreate`: `z.strictObject({ filename: PlanFileName, kind: NodeKind,
  content: ContentSchema, reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
  parentId: identitySchema("node").optional(),
  expectedParentRevision: z.number().int().positive().optional() })`.
     `NodeUpdate`: `z.strictObject({ filename: PlanFileName, content: ContentSchema,
  reason: z.string().min(1), expectedRevision: z.number().int().positive(),
  expectedMissionVersion: z.number().int().positive() })`.
     `Move`: `z.strictObject({ newParentId: identitySchema("node"),
  reason: z.string().min(1), expectedMissionVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
  expectedOldParentRevision: z.number().int().positive(),
  expectedNewParentRevision: z.number().int().positive() })`.
     `GraphEdit`: `z.strictObject({ reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive() })`.
     `CriterionSet`: `z.strictObject({ criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1), reason: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  expectedMissionVersion: z.number().int().positive() })`.
     `PrioritySet`: `z.strictObject({ value: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  expectedMissionVersion: z.number().int().positive() })`.
     `Rebind`: `z.strictObject({ bindingId: identitySchema("binding"),
  reason: z.string().min(1), expectedMissionVersion: z.number().int().positive(),
  nodeId: identitySchema("node").optional() })`.
     `Retire`: `z.strictObject({ reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/), force: z.boolean() })`.
     `TaskContent`: `z.strictObject({ id: identitySchema("node"),
  filename: PlanFileName, content: ContentSchema })`.
     `RevisionChange`: `z.strictObject({ write: z.enum(["import","node.create","node.update",
  "node.move","node.retire","criterion.set","unblock"]),
  previousRevision: z.number().int().positive().nullable(),
  changedFields: z.array(z.string()),
  tasks: z.array(z.strictObject({ id: identitySchema("node"),
    change: z.enum(["created","updated","moved-in","moved-out","retired"]),
    changedFields: z.array(z.string()) })).optional() })`.
     `RevisionSchema`: `z.strictObject({ nodeId: identitySchema("node"),
  filename: PlanFileName, revision: z.number().int().positive(),
  reason: z.string(), actor: ActorSchema, createdAt: z.number().int(),
  content: ContentSchema, tasks: z.array(TaskContent).optional(),
  change: RevisionChange, pinnedByAttempts: z.array(z.number().int().nonnegative()) })`.
     `ActorSchema`: `z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), account: z.string(), name: z.string() }),
  z.strictObject({ kind: z.literal("service"), service: z.string() }) ])`.
     `EdgeSchema`: `z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("containment"), parentId: identitySchema("node"),
    childId: identitySchema("node") }),
  z.strictObject({ kind: z.literal("dependency"), dependentId: identitySchema("node"),
    dependsOnId: identitySchema("node") }) ])`.
     `NodeChange`: `z.strictObject({ missionVersion: z.number().int().positive(),
  revisions: z.array(RevisionSchema), retiredNodeIds: z.array(identitySchema("node")),
  addedEdges: z.array(EdgeSchema), removedEdges: z.array(EdgeSchema),
  openAttemptsUnchanged: z.array(z.strictObject({ nodeId: identitySchema("node"),
    attempt: z.number().int().nonnegative() })) })`.
     `RetirePreview`: `z.strictObject({ nodeId: identitySchema("node"), force: z.boolean(),
  missionVersion: z.number().int().positive(), retiredNodeIds: z.array(identitySchema("node")),
  removedEdges: z.array(EdgeSchema), previewDigest: z.string().regex(/^[0-9a-f]{64}$/) })`.
     `ImportEntry`: `z.strictObject({ filename: PlanFileName, kind: NodeKind,
  name: z.string().min(1), requirement: z.string().min(1), criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1), bindings: z.array(z.string()),
  id: identitySchema("node").optional(), parent: PlanFileName.optional(),
  dependsOn: z.array(PlanFileName).optional() })`.
     `PlanFileEntry`: `z.strictObject({ filename: PlanFileName, content: z.string() })`.
     `ImportSnapshotBase`: `z.strictObject({ format: z.enum(["markdown","json"]),
  missionId: identitySchema("mission"), missionVersion: z.number().int().positive(),
  reason: z.string().min(1) })` with discriminated `files` or `entries` field by format.
     `ImportApply`: extends `ImportSnapshotBase` with `previewDigest: z.string().regex(/^[0-9a-f]{64}$/)`,
     `confirmedRetirements: z.array(identitySchema("node"))`.
     `Violation`: `z.strictObject({ code: z.string(), message: z.string(),
  filename: z.string().nullable(), nodeId: identitySchema("node").nullable(),
  details: z.unknown().nullable() })`.
     `ImportPreview`: `z.strictObject({ missionId: identitySchema("mission"),
  expectedMissionVersion: z.number().int().positive(), previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  creates: z.array(PlanFileName), updates: z.array(identitySchema("node")),
  retirements: z.array(identitySchema("node")), removedEdges: z.array(EdgeSchema),
  noOps: z.array(identitySchema("node")), violations: z.array(Violation) })`.
     `ImportResult`: `z.strictObject({ missionId: identitySchema("mission"),
  missionVersion: z.number().int().positive(),
  assignedIds: z.array(z.strictObject({ filename: PlanFileName, nodeId: identitySchema("node") })),
  changes: NodeChange, actor: ActorSchema, acceptedAt: z.number().int() })`.
     `NodeSchema` (output): `z.discriminatedUnion` or a base `z.strictObject` with
     `id: identitySchema("node")`, `filename: PlanFileName`, `missionId: identitySchema("mission")`,
     `kind: NodeKind`, `parentId: identitySchema("node").nullable()`,
     `visibleRevision: z.number().int().positive()`,
     `content: ContentSchema`, `retiredAt: z.number().int().nullable()`,
     `pinnedByAttempts: z.array(z.number().int().nonnegative())`,
     and kind-dependent fields: initiatives/objectives add `state: NodeState`,
     `attempt: z.number().int().nonnegative()`, `priority: z.number().int()`;
     tasks omit those three. `visibleRevision` counts the node's own revisions
     for initiatives/objectives, or the objective's revisions for a task.
     `engine/docs/cli/mission.md:838`.
     `MissionSchema` (output): `z.strictObject({ id: identitySchema("mission"),
  projectId: identitySchema("project"), version: z.number().int().positive(),
  createdAt: z.number().int() })`.

  6. Export `missionOperations = {} as const` as placeholder.

- Rules:
  - `MissionService` declares collaboration input types inline; never imports from a
    peer's `contract.ts`. `00-index.md` collaboration-type contract rule.
  - Every input schema is closed (`z.strictObject`). `architecture.impl.md:34–37`.
  - `WorkQueue` method names are `insert`, `delete`, `priorityUpdate` — exact names
    from `00-index.md:116` and Plan 02 `src/scheduler/contract.ts`.
  - `resolveBinding` returns `{ bindingId, resourceIdentity }` so the caller
    derives the binding kind from `resourceIdentity.split(':')[0]`.
    `01-setup.md:201`.
  - `NodeKind`, `NodeState` use named enum members. `architecture.impl.md:17–20`.
  - `PlanFileName` regex: lower-case, ends `.md`, no path separator.
    `mission-service.impl.md#the-plan-file-name`.
  - `PrioritySet` has no `reason` field; any extra field produces HTTP 400.
    `mission-service.impl.md:563`.
  - `tasks` field in `RevisionSchema` is present for objectives only.
    `01-setup.md:105`.
  - `Move` uses `newParentId` and the four precondition fields from the CLI doc
    (`engine/docs/cli/mission.md:662`). `parentId` alone is insufficient.
  - `Rebind` uses `bindingId: BindingId` per `engine/docs/cli/mission.md:660`.
  - `TaskContent` holds `{ id, filename, content }` per `engine/docs/cli/mission.md:718`.
  - `ImportResult` includes `changes: NodeChange` per `engine/docs/cli/mission.md:844`.
  - `previewDigest` schema is lowercase hex, 64 chars: `z.string().regex(/^[0-9a-f]{64}$/)`.
  - `ActorSchema` is a discriminated union (human | service), never `z.unknown()`.
  - `NodeSchema` is kind-discriminated: tasks omit `state`, `attempt`, `priority`.
- Done when: `pnpm run verify` passes; no import of another service's `contract.ts`.

### 06.3 Create `index.ts` and skeleton `service.ts`

- Files: `src/mission/index.ts`, `src/mission/service.ts`,
  `src/apps/server/migrations.test.ts`, `engine/AGENTS.md`
- Do:
  1. In `service.ts`: declare `Dependencies` interface with `config: MissionConfig`,
     `health?: HealthRegistry`, `bindings: MissionBindings`, `workQueue: WorkQueue`.
     Colocated tests inject fakes for `bindings` and `workQueue`. Plan 07 wires the
     real implementations. `D4`: collaborations are required, never optional.
     Implement `MissionService` as `Service` with `start`, `quiesce`, `stop`, `run`,
     `healthcheck`, and `declare(registry: OperationRegistry): void`.
     Implement `createMission(tx, projectId, actor)` and `liveNodesPinning(tx, bindingId)`
     as placeholders that throw `new Error("not implemented")`; task 06.4 replaces both.
  2. In `index.ts`: export `MissionService`, `type Dependencies`,
     `missionMigrations` (array from 06.1), `missionConfigSchema` (convict fragment
     with `mission.consecutiveLossLimit` as a `nat` integer defaulting to `3`, and
     `mission.textMaxBytes` as a `nat` integer defaulting to `32768`),
     and `type MissionConfig` as a plain TypeScript interface (not `z.infer`):
     ```ts
     export interface MissionConfig {
       consecutiveLossLimit: number;
       textMaxBytes: number;
     }
     ```
     Type the convict schema fragment as `Schema<MissionConfig>`.
  3. Edit `src/apps/server/migrations.test.ts`: add
     `{ service: "mission", migrations: missionMigrations }` to the `services` array
     and `mission_mission`, `mission_node`, `mission_node_revision`,
     `mission_dependency` to the expected table list.
  4. Edit `engine/AGENTS.md`: update `src/mission/` entry from `[planned]`.
- Rules:
  - Follow the `service.ts` pattern of `src/project/service.ts`. `engine/AGENTS.md`.
  - `missionConfigSchema` uses `convict` with `nat` format: `consecutiveLossLimit` default `3`, `textMaxBytes` default `32768`.
    `mission-service.impl.md#configuration`.
  - `MissionConfig` is a plain interface typed over the Convict fragment, not `z.infer`.
    `architecture.impl.md:51–53`.
  - Every domain failure is an `OperationError`, not a `Diagnostic`. Domain handlers
    throw `new OperationError(code, message, { status, details })`. The gateway maps
    `OperationError` to the HTTP response with code and status; other errors become
    HTTP 500 (`architecture.impl.md`; `engine/src/gateway/errors.ts`).
- Done when: `pnpm run verify` passes; migration test lists all four mission
  tables; `mission.consecutiveLossLimit` default is `3`.

### 06.4 Implement `createMission` and `liveNodesPinning`

- Files: `src/mission/service.ts`, `src/mission/service.test.ts`
- Do:
  1. Implement `createMission(tx, projectId, actor)`:
     - Mint `mission_<ulid>` for the mission identity.
     - Insert into `mission_mission` with `project_id`, `version = 1`,
       `created_at = Date.now()`.
     - A duplicate `project_id` raises the SQLite unique constraint error unchanged.
       No caller can cause it, because `project.create` mints a new project identity,
       so it maps to 500 `system.operation.unknown` and takes no domain code.
  2. Implement `liveNodesPinning(tx, bindingId)`:
     - Return `id` values of every `mission_node` row where:
       - `retired_at IS NULL` and `state NOT IN ('Completed', 'Discarded')`.
       - Its current revision's `bindings` JSON array contains `bindingId`.
     - Current revision = max `revision` of `mission_node_revision` for that `node_id`.
     - In ERD 1 no attempt rows exist; check current revision only.
     - Use `json_each(r.bindings)` in SQLite to check array membership.
     - Return `string[]` of node IDs.
  3. Add `service.test.ts` colocated tests:
     - `createMission` inserts a row with `version = 1`; a second call for the
       same `project_id` throws the unique constraint error.
     - `liveNodesPinning` returns IDs of nodes whose current revision `bindings`
       JSON contains the given `bindingId`; excludes retired and terminal nodes.
- Rules:
  - Both collaborations are Kind 2: take `tx`, open no transaction, commit none.
    `architecture.impl.md:583–600`.
  - Identity prefix `mission_` for `mission_mission.id`. `architecture.impl.md:157`.
  - No FK to `project_project`. `01-setup.md` cross-group references.
- Done when: `pnpm run verify` passes; tests prove both collaborations.

### 06.5 Implement node content validation helpers

- Files: `src/mission/content.ts`, `src/mission/content.test.ts`
- Do:
  1. Create `content.ts` with pure validation functions (no DB access):
     - `validateFilename(filename: string): void` — throws
       `new OperationError("mission.node.content_invalid", ..., { status: 400, details: { field: "filename" } })`
       when the name does not match the lower-case, `.md`, no-path-separator form.
     - `validateText(field: string, value: string, textMaxBytes: number): void` — throws
       `new OperationError("mission.node.content_invalid", ..., { status: 400, details: { field } })`
       when `Buffer.byteLength(value, "utf8") > textMaxBytes` (`mission-service.impl.md`,
       "Operation contracts": `Text` holds at most `mission.textMaxBytes` UTF-8 bytes). Every
       handler calls it with `this.config.textMaxBytes` for each `reason`, and
       `validateNodeContent` calls it for `name`, `requirement`, `criterion` and each
       `verifications` item. The wire schema keeps `z.string().min(1)`, because a configured
       bound cannot live in a static schema. The bound applies at a write only; a stored value
       keeps its length.
     - `validateNodeContent(kind: NodeKind, content: ContentInput, textMaxBytes: number): void` — throws
       `new OperationError("mission.node.content_invalid", ..., { status: 400, details: { field } })`
       for a missing, blank or nontext `name`, `requirement` or `criterion`; throws
       `new OperationError("mission.node.verifications_missing", ..., { status: 400 })`
       for an absent or empty `verifications` list; throws
       `new OperationError("mission.node.content_invalid", ..., { status: 400 })`
       for a nonlist, blank or nontext `verifications` item.
     - `ResolvedBinding`: `{ bindingId: string; resourceIdentity: string }`.
       `bindingKind(resolved: ResolvedBinding): "repository" | "storage" | "worker"` —
       returns `resolved.resourceIdentity.split(':')[0]` as the kind.
       `01-setup.md:201`.
     - `checkBindingRuleTable(kind: NodeKind, resolved: ResolvedBinding[]): void` —
       throws `new OperationError("mission.node.bindings_invalid", ..., { status: 400 })`
       for a rule-table violation: `repository` count must be 0 for initiative and task,
       exactly 1 for objective; `worker` count must be 0 for all kinds; `storage` count
       must be 0 for task, at most 1 for initiative and objective.
  2. Add `content.test.ts` colocated tests:
     - Each validation path with its exact error code.
     - Every cell of the binding rule table.
     - Blank, nontext and absent fields produce `mission.node.content_invalid`.
     - An absent or empty `verifications` produces `mission.node.verifications_missing`.
     - A nonlist or blank item in `verifications` produces `mission.node.content_invalid`.
     - A `Text` value of exactly `textMaxBytes` UTF-8 bytes passes, and one byte more produces
       `mission.node.content_invalid` with its `field`, for each text field, each `verifications`
       item and `reason`; the test runs with the default `32768` and with a configured `8`.
     - Upper-case filename, missing `.md`, path separator all produce
       `mission.node.content_invalid`.
- Rules:
  - `mission-service.impl.md#the-node-content` for every validation rule.
  - `mission-service.vocabulary.md#bindings-of-a-node` for the rule table.
  - Named enum members for `NodeKind`. `architecture.impl.md:17–20`.
  - Binding kind derived from `resourceIdentity.split(':')[0]`. `01-setup.md:201`.
  - All errors are `OperationError`. No `Diagnostic`.
  - No DB access in this module.
- Done when: `pnpm run verify` passes; every rule-table cell and every error
  code covered by a test.

### 06.6 Implement the Markdown plan file parser

- Files: `src/mission/parser.ts`, `src/mission/parser.test.ts`
- Do:
  1. Create `parser.ts` with `parsePlanFile(filename: string, content: string): ParsedPlanFile`:
     - Extract YAML front matter between `---` delimiters.
     - Permitted front matter keys: `id`, `kind`, `parent`, `dependsOn`, `bindings`,
       `verifications`. Refuse unknown keys with
       `new OperationError("mission.import.plan_invalid", ..., { status: 400, details: { filename } })`.
     - Parse body: exactly one H1 sets `name`; exactly one `## Requirement` section
       sets `requirement`; exactly one `## Criterion` section sets `criterion`.
       Each section extends to the next H2 or end of file.
       Refuse absent, repeated or unknown H2, or absent H1, with the same error code.
     - Require `parent` for objectives and tasks; forbid it on initiatives.
       Forbid `dependsOn` on tasks. Refuse with same error code.
     - Return `ParsedPlanFile` with `filename`, `id?`, `kind`, `parent?`,
       `dependsOn`, `bindings`, `verifications`, `name`, `requirement`, `criterion`.
  2. Add `parser.test.ts` colocated tests:
     - Accepts the canonical example from `mission-service.vocabulary.md#plan-file`.
     - Refuses each unknown front matter key and unknown H2.
     - Refuses absent or repeated H1, Requirement, Criterion.
     - Requires parent for objectives and tasks; forbids it on initiatives;
       forbids `dependsOn` on tasks.
     - Refuses each absent or repeated required section.
- Rules:
  - `mission-service.impl.md#the-plan-file-grammar` for every rule.
  - Error code verbatim: `mission.import.plan_invalid`. `mission-service.impl.md:112`.
  - All errors are `OperationError`. No DB access.
- Done when: `pnpm run verify` passes; every grammar rule covered by a test.

### 06.7 Implement cycle detection and dependency closure

- Files: `src/mission/graph.ts`, `src/mission/graph.test.ts`
- Do:
  1. Create `graph.ts`:
     - `DepEdge`: `{ dependent: string; dependsOn: string }`.
     - `detectCycle(edges: DepEdge[]): boolean` — implements Kahn's algorithm
       (topological sort) using `graphology`'s `DirectedGraph` to build the
       adjacency structure. Compute in-degree for every node. Enqueue zero-in-degree
       nodes; iteratively remove edges and enqueue newly zero-in-degree nodes. A cycle
       exists when the processed node count is less than the total node count.
       `graphology-dag` is not installed; use `graphology`'s `DirectedGraph` for the
       graph structure and implement topological-sort cycle detection without it.
     - `buildDependencyClosureOf(nodeId: string, allEdges: DepEdge[], parentMap: Map<string, string>): Set<string>` —
       computes the availability closure: the set of nodes that `nodeId` directly
       depends on, plus the set of nodes that each ancestor of `nodeId` directly
       depends on. Algorithm:
       1. Walk the `parentMap` from `nodeId` upward to collect the ancestor chain.
       2. For each node in that chain (including `nodeId`), collect its direct
          `dependsOn` entries from `allEdges`.
       3. Return the union of those direct dependency sets (not transitive).
          This matches the ERD rule: "A node waits for the nodes that its own
          dependencies name and the nodes that the dependencies of its ancestors name."
          `mission-service.md:43–45`. Cycle detection operates on dependency edges;
          run `detectCycle` on the full dependency-edge set after adding the proposed
          edge, not on the closure.
  2. Add `graph.test.ts`:
     - `detectCycle` returns `true` for a 2-node cycle and a 3-node cycle; `false`
       for a DAG, a chain, and an empty graph.
     - `buildDependencyClosureOf` returns the correct closure for a 2-level
       ancestor chain with shared dependencies; confirms inherited ancestor
       dependencies appear in the result.
- Rules:
  - Use `graphology` — already in `package.json`. No `graphology-dag` (not installed).
  - Architecture prohibits adding packages (`architecture.impl.md:12–13`).
    Implement cycle detection with Kahn's algorithm using `DirectedGraph` only.
  - Cycle detection runs on dependency edges only. Containment alone forms no cycle.
  - No DB access.
- Done when: `pnpm run verify` passes; cycle detection and closure tests pass.

### 06.8 Implement admission and claimability helpers

- Files: `src/mission/admission.ts`, `src/mission/admission.test.ts`
- Do:
  1. Create `admission.ts` with pure helper functions (no DB access except where noted):

     `isTerminal(state: string | null): boolean` — returns true for `Completed` or
     `Discarded`. `mission-service.vocabulary.md#terminal-state`.

     `importAdmissible(state: string | null, attempt: number | null): boolean` —
     returns true when `state` is `Pending` or `Available` and `attempt` is 0 (or
     null, which reads 0). Import condition: `mission-service.md:157–159`.

     `nodeApiWriteAdmissible(state: string | null): boolean` — returns false for a
     terminal state. Node API edits no terminal node. `mission-service.md:153`.

     `parentCreateAdmissible(parentState: string | null): boolean` — returns true
     when parent is in `Pending`, `Available`, `Executing`, `Blocked` or `Paused`.
     `mission-service.impl.md#node-api-admission`.

     `isObjectiveClaimable(state: string | null): boolean` — returns true when state
     is `Available`. `01-setup.md:265`.

     `computeInitiativeClaimable(tx: Transaction, nodeId: string): boolean` —
     DB read: queries `mission_node WHERE parent_id = nodeId AND retired_at IS NULL`.
     Returns true when the node's state is `Available` AND every current objective
     (non-retired child) holds a terminal state. Vacuously true when no current
     objectives exist. Initiative steps condition from the 2026-09-27 ruling.
     `mission-service.vocabulary.md#initiative-steps-condition`.

     `reconcileJob(tx: Transaction, workQueue: WorkQueue, nodeId: string, projectId: string, priority: number | null, prevClaimable: boolean, isClaimable: boolean): void` —
     idempotent reconciliation: if `!prevClaimable && isClaimable`, calls
     `workQueue.insert(tx, nodeId, projectId, priority ?? 0)`;
     if `prevClaimable && !isClaimable`, calls `workQueue.delete(tx, nodeId)`;
     otherwise does nothing. Both directions handled in every mission transaction
     that changes claimability. `01-setup.md:265`; Plan 02: duplicate insert fails
     unique constraint.

  2. Add `admission.test.ts`:
     - `isTerminal` for each of the 12 states and null.
     - `importAdmissible` for `Pending` + attempt 0 (true), `Available` + 0 (true),
       `Executing` + 0 (false), `Pending` + 1 (false), null state (false).
     - `nodeApiWriteAdmissible` true for non-terminal, false for `Completed` and
       `Discarded`.
     - `parentCreateAdmissible` true for each admitted state, false for each refused
       state (`Waiting`, `Evaluating`, `External.*`, `Completed`, `Discarded`).
     - `isObjectiveClaimable` true for `Available`, false for all others.
     - `computeInitiativeClaimable` with all objectives terminal (true), one
       non-terminal objective (false), and no objectives (true — vacuously).
     - `reconcileJob` inserts only when `prevClaimable=false, isClaimable=true`;
       deletes only when `prevClaimable=true, isClaimable=false`; does nothing
       when both are equal.
- Rules:
  - `computeInitiativeClaimable` and `reconcileJob` receive `tx`; they commit none.
    `architecture.impl.md:583–600`.
  - Named enum members for states; no bare string literals.
    `architecture.impl.md:17–20`.
  - `reconcileJob` is idempotent: a node that was already claimable and remains
    claimable produces no DB write. Prevents duplicate-insert unique-constraint
    failures from Plan 02's `WorkQueue`. `engine/.agents/plan/02-scheduler-job.md:110`.
- Done when: `pnpm run verify` passes; all helper tests pass.

### 06.9 Implement `mission.get` and the migration isolation test

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. In `contract.ts`, declare `mission.get` operation:
     - `GET /api/mission/project/:projectId`, access `human`, lifetime `unary`,
       timeout 30000 ms, mutation false.
     - Input: `z.strictObject({ params: z.strictObject({ projectId: identitySchema("project") }),
query: z.strictObject({}), body: z.null() })`.
     - Output: `MissionSchema`.
     - Error: 404 `mission.mission.not_found`.
  2. In `service.ts`, bind the handler in `declare`:
     - Query `mission_mission` by `project_id`; throw
       `new OperationError("mission.mission.not_found", ..., { status: 404 })` if absent.
  3. Add tests:
     - Returns mission for a known project; answers 404 for an unknown project.
- Rules:
  - Operation id `mission.get`. `engine/docs/cli/mission.md` row 1.
  - Error code `mission.mission.not_found` verbatim. `mission-service.impl.md:515`.
  - Access `human`; timeout 30000 ms. `mission-service.impl.md#operation-contracts`.
  - Handler uses `caller.commit` for this read operation per D3.
- Done when: `pnpm run verify` passes; tests prove 200 and 404 paths.

### 06.10 Implement `mission.node.create`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare `mission.node.create` in `contract.ts`:
     - `POST /api/mission/:missionId/node`, access `human`, lifetime `unary`,
       timeout 30000 ms, mutation true.
     - Input body: `NodeCreate`. Output: `NodeChange`.
  2. Implement the handler in `service.ts`:
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - For objectives and tasks: require `parentId` and `expectedParentRevision`;
       refuse initiative create with `parentId` (forbidden field) with 400.
     - Verify parent exists and is not retired; throw 409 `mission.node.retired`
       if the parent is retired.
     - Check parent kind: initiative may only parent objectives; objective may only
       parent tasks. Refuse wrong kind with 409 `mission.node.create_refused`.
     - Check parent belongs to the same mission. Refuse cross-mission with 409
       `mission.node.create_refused`.
     - Check `parentCreateAdmissible(parent.state)`; refuse with 409
       `mission.node.create_refused` with parent state in `details`.
     - Check `expectedParentRevision` matches parent's current revision; refuse
       stale with 409 `mission.revision.conflict`.
     - Validate `filename` with `validateFilename`; check uniqueness against
       non-retired nodes in this mission (DB unique constraint catches races;
       answer 409 `mission.node.filename_conflict`).
     - Validate content with `validateNodeContent` and bindings with
       `resolveBinding` + `checkBindingRuleTable`. Refuse unresolved binding
       name with 400 `mission.node.bindings_invalid`.
     - Mint `node_<ulid>` for the new node.
     - **Initiative create**: insert `mission_node` row with state `Pending`.
       Insert revision 1 in `mission_node_revision` with `change.write = "node.create"`,
       `change.previousRevision = null`, `change.changedFields = all content fields`,
       `tasks = null`. Compute initiative claimability: no dependencies, no current
       objectives → vacuously claimable → `Available`; call `reconcileJob` with
       `prevClaimable=false, isClaimable=true` to insert job. Update `state` to
       `Available` in the same transaction.
     - **Objective create**: insert `mission_node` row with state `Pending`.
       Insert revision 1 in `mission_node_revision` with `tasks = "[]"`.
       Compute inherited dependency closure from the parent initiative using
       `buildDependencyClosureOf`. If the closure is non-empty (parent initiative
       has unmet dependencies), set state `Pending` and call `reconcileJob` with
       `prevClaimable=false, isClaimable=false` (no insert). If the closure is empty,
       set state `Available` and call `reconcileJob` with `prevClaimable=false,
isClaimable=true` (insert job). Then recompute and reconcile parent
       initiative's job: adding a non-terminal objective makes the initiative
       non-claimable; call `reconcileJob` for the initiative with
       `prevClaimable=true, isClaimable=false` (delete the job).
     - **Task create**: insert `mission_node` row with `state = NULL`,
       `attempt = NULL`, `priority = NULL`. Read the parent objective's current
       revision. Insert next revision of the parent objective with the new task
       appended to `tasks`; `change.write = "node.create"`;
       `change.tasks = [{ id, change: "created", changedFields: all content fields }]`.
       Tasks do not change the objective's state or claimability.
     - Increment `mission_mission.version` by 1.
     - Return `NodeChange`.
  3. Add tests:
     - Initiative create at any time; it starts `Available` with a job.
     - Objective create under a dependency-free initiative: starts `Available` with
       a job; parent initiative's job is deleted.
     - Objective create under a dependency-blocked initiative: starts `Pending`,
       no job inserted.
     - Task create: no revision row for the task; objective's revision incremented
       with task in `tasks`; task row has null state/attempt/priority.
     - Wrong parent kind (e.g. task under task) answers `mission.node.create_refused`.
     - Cross-mission parent answers `mission.node.create_refused`.
     - Each refused parent state for objective/task create answers
       `mission.node.create_refused`.
     - Retired parent answers `mission.node.retired`.
     - Filename conflict (non-retired duplicate) answers `mission.node.filename_conflict`.
     - Stale `expectedMissionVersion` answers `mission.version.conflict`.
     - Stale `expectedParentRevision` answers `mission.revision.conflict`.
     - Unresolved binding answers `mission.node.bindings_invalid`.
     - Binding rule table violations answer `mission.node.bindings_invalid`.
- Rules:
  - `mission-service.impl.md#node-api-admission` for parent state admission.
  - `mission-service.md:216–219`: tasks hold no revision, no state, no attempt.
  - `01-setup.md:241–246`: task content in objective revision `tasks` column.
  - `01-setup.md:238–239`: kind/mission containment rules.
  - `WorkQueue.insert` in the same transaction.
  - `buildDependencyClosureOf` for inherited initiative dependencies.
  - Version increments once per write. `mission-service.impl.md#the-revisions`.
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; tests cover all node kinds, parent-kind
  and cross-mission refusals, inherited dependency claimability, retired parent,
  filename conflict, version conflict and binding rule table.

### 06.11 Implement node read operations

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare four read operations in `contract.ts`:
     - `mission.node.list`: `GET /api/mission/:missionId/node`, filters `kind?`,
       `state?`, `parentId?`, `includeRetired?`; output `Page<NodeSchema>`.
     - `mission.node.get`: `GET /api/mission/node/:nodeId`; output `NodeSchema`.
       Error: 404 `mission.node.not_found`.
     - `mission.node.revision.list`: `GET /api/mission/node/:nodeId/revision`;
       output `Page<RevisionSchema>` ordered by `revision` descending.
     - `mission.node.revision.get`: `GET /api/mission/node/:nodeId/revision/:revision`;
       output `RevisionSchema`. Error: 404 `mission.node.not_found`.
  2. Implement each handler in `service.ts`.
     - For `node.get` and `node.list`: `visibleRevision` is the max revision of
       the node's own revision rows for initiatives/objectives; for tasks it is the
       max revision of the parent objective's revision rows.
       Build `content` from the current revision: for tasks, read from the objective's
       revision `tasks` JSON array matching task `id`.
       For retired tasks: search all revisions of the objective (descending) for the
       last snapshot that includes the task; use that as the read content.
     - `node.list` with `includeRetired = false` (default) excludes rows where
       `retired_at IS NOT NULL`.
     - `node.revision.list` and `node.revision.get` read `mission_node_revision`;
       revisions ordered descending. These operations read objective-level revision rows;
       task revision reads are not surfaced through this route (tasks have no revision rows).
  3. Add tests:
     - `mission.node.get` returns 404 `mission.node.not_found` for unknown node.
     - `mission.node.list --include-retired` includes retired nodes; default excludes.
     - `mission.node.revision.list` orders revisions descending.
     - `mission.node.revision.get` returns the named revision; 404 for unknown.
     - Task node read: `visibleRevision` equals the objective's current revision;
       `content` comes from the objective's revision `tasks` column.
     - Retired task read: content comes from the last historical snapshot of the
       objective's revision that contains the task.
     - Pagination returns correct cursor and second page.
- Rules:
  - `mission-service.impl.md#operation-contracts` — 404 `mission.node.not_found`.
  - `architecture.impl.md` pagination: `limit` defaults to 100.
  - Tasks: content owner is the parent objective; `visibleRevision` is the
    objective's current revision. `01-setup.md:178`.
  - Tasks have no `mission_node_revision` rows to query directly. `01-setup.md:178`.
  - All handlers use `caller.commit` per D3.
- Done when: `pnpm run verify` passes; tests prove all four operations.

### 06.12 Implement dependency operations

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare three operations in `contract.ts`:
     - `mission.edge.list`: `GET /api/mission/:missionId/edge`, filters `kind?`,
       `nodeId?`; output `Page<EdgeSchema>`.
     - `mission.dependency.add`: `PUT /api/mission/node/:nodeId/dependency/:dependsOnId`,
       access `human`, mutation true; input `GraphEdit`; output `NodeChange`.
     - `mission.dependency.remove`: `DELETE /api/mission/node/:nodeId/dependency/:dependsOnId`,
       access `human`, mutation true; input `GraphEdit`; output `NodeChange`.
  2. Implement handlers:
     - `edge.list`: query `mission_dependency` for dependency edges and
       `mission_node` for containment edges (parent_id links).
     - `dependency.add`:
       - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
       - Verify both `nodeId` and `dependsOnId` are not retired; throw 409
         `mission.node.retired` for either retired node.
       - Verify `nodeId` and `dependsOnId` are initiatives or objectives (not tasks)
         of the same mission; refuse wrong kind or cross-mission.
       - Check that the edge does not already exist; if it does, return current
         `NodeChange` with empty arrays and no version increment (no-op).
       - Load all current dependency edges of the mission. Add the proposed edge.
         Run `detectCycle`; answer 409 `mission.import.cycle` on a cycle.
       - Insert row into `mission_dependency`.
       - Reroute: recompute claimability of `nodeId` and every non-retired, non-terminal
         node in its subtree using the new closure. Call `reconcileJob` for each
         affected node with `prevClaimable` (old claimability) and `isClaimable`
         (new claimability).
       - Increment version once.
     - `dependency.remove`:
       - Check `expectedMissionVersion`; refuse stale.
       - Verify `nodeId` is not retired; throw 409 `mission.node.retired` if retired.
       - Verify `nodeId` is nonterminal; refuse terminal with 409 `mission.node.terminal`.
       - Check the edge exists; if it does not, return current `NodeChange` with
         empty arrays and no version increment (no-op).
       - Delete row from `mission_dependency`.
       - Reroute freed nodes; call `reconcileJob` for each affected node.
       - Increment version once.
  3. Add tests:
     - Addition followed by addition that creates a cycle refuses with
       `mission.import.cycle`.
     - Removal on a terminal dependent refuses with `mission.node.terminal`.
     - Removal on a retired dependent refuses with `mission.node.retired`.
     - Addition of duplicate edge is a no-op (no version increment, no DB insert).
     - Removal of absent edge is a no-op.
     - Addition creating an unmet dependency: objective moves `Available → Pending`
       in the same transaction, its job deleted.
     - Removal that satisfies all remaining deps: moves `Pending → Available`,
       its job inserted.
     - Version mismatch answers `mission.version.conflict`.
- Rules:
  - `mission-service.md:51`: "A dependency removal requires a dependent that is
    not terminal."
  - `mission-service.md:54`: "The same transaction … reroutes every claim-free
    node whose closure changes."
  - `01-setup.md:252–253`: dependency edit reroutes nodes, writes jobs.
  - `WorkQueue.insert` / `delete` in the same transaction via `reconcileJob`.
  - `detectCycle` and `buildDependencyClosureOf` from `graph.ts` (06.7).
  - Retired node check precedes any other check. `mission-service.impl.md:156–157`.
- Done when: `pnpm run verify` passes; tests prove cycle detection, rerouting,
  no-op paths, terminal-dependent refusal, retired refusal and version check.

### 06.13 Implement `mission.node.update`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare in `contract.ts`:
     - `mission.node.update`: `PUT /api/mission/node/:nodeId`, access `human`, mutation true;
       input `NodeUpdate`; output `NodeChange`.
  2. Implement in `service.ts`:
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - Refuse retired node with 409 `mission.node.retired`.
     - For initiatives and objectives: refuse terminal state with 409 `mission.node.terminal`.
     - For tasks: read the parent objective; refuse if the objective is retired with
       409 `mission.node.retired`; refuse if the objective is terminal with 409
       `mission.node.terminal`. Tasks have no state; the objective owner's state governs.
     - Check `expectedRevision` against the content owner's current revision
       (objective's revision for tasks); refuse stale with 409 `mission.revision.conflict`.
     - Validate new content and bindings via `validateNodeContent`, `validateFilename`,
       `resolveBinding` + `checkBindingRuleTable`.
     - Compare each content field to the current revision. If no field changed and
       filename unchanged, return current `NodeChange` with empty arrays and no
       version increment (no-op).
     - **Objective/initiative update**: insert next revision with
       `change.write = "node.update"`, `change.changedFields` listing only changed
       fields. If `filename` changed: validate uniqueness against non-retired nodes;
       update `mission_node.filename`; map unique-constraint failure to 409
       `mission.node.filename_conflict`.
     - **Task update**: insert next revision of the parent objective with the task's
       content updated in the `tasks` JSON; `change.tasks` lists the task with
       `change: "updated"`, `changedFields` listing only changed fields. If `filename`
       changed: validate uniqueness against non-retired nodes; update the task's
       `mission_node.filename`; map unique-constraint failure to 409
       `mission.node.filename_conflict`.
     - Increment version once when content actually changes.
  3. Add tests:
     - Update on a retired node produces `mission.node.retired`.
     - Update on a terminal initiative or objective produces `mission.node.terminal`.
     - Task update where objective owner is terminal produces `mission.node.terminal`.
     - Task update where objective owner is retired produces `mission.node.retired`.
     - No-op update returns current version, empty arrays, no increment.
     - Task update inserts objective revision; no task revision row created.
     - Task filename update changes `mission_node.filename`; duplicate filename
       produces `mission.node.filename_conflict`.
     - Stale `expectedRevision` refuses with `mission.revision.conflict`.
- Rules:
  - `mission-service.impl.md#the-revisions` for `changedFields` and no-op.
  - Tasks have no state; check the objective content owner. `01-setup.md:241`.
  - `01-setup.md:245–246`: task change inserts next revision of its objective.
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; update tests pass including no-op,
  task owner state checks and filename conflict.

### 06.14 Implement `mission.node.move`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare in `contract.ts`:
     - `mission.node.move`: `POST /api/mission/node/:nodeId/move`, access `human`,
       mutation true; input `Move`; output `NodeChange`.
       `Move` fields: `newParentId`, `reason`, `expectedMissionVersion`,
       `expectedRevision`, `expectedOldParentRevision`, `expectedNewParentRevision`.
  2. Implement in `service.ts`:
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - Refuse retired node with 409 `mission.node.retired`.
     - Refuse terminal node with 409 `mission.node.terminal`.
     - Look up the current parent from the graph. Verify it matches.
     - Verify the new parent (`newParentId`) exists, is not retired, and is the
       correct kind: objectives must move under an initiative; tasks must move
       under an objective. Refuse retired new parent with 409 `mission.node.retired`.
       Refuse wrong-kind new parent with 409 `mission.node.create_refused`.
     - For tasks: check the old objective (current parent) is not terminal; check
       the new objective (new parent) is not terminal. Refuse with 409
       `mission.node.terminal` on either.
     - Check `expectedRevision` against the node's content owner's current revision.
     - Check `expectedOldParentRevision` against the old parent's current revision.
     - Check `expectedNewParentRevision` against the new parent's current revision.
       Refuse stale with 409 `mission.revision.conflict`.
     - Check same-parent is a no-op: if `newParentId` equals current parent, return
       current `NodeChange` with empty arrays and no version increment.
     - **Objective move**: update `mission_node.parent_id`. Verify no cycle arises
       from the new containment plus all dependency edges (run `detectCycle` on
       dependency edges — containment alone forms no cycle). Recompute inherited
       dependency closure for the moved objective and its subtree; call `reconcileJob`
       for each affected node. Reconcile old parent initiative's job and new parent
       initiative's job via `computeInitiativeClaimable` + `reconcileJob`. Insert no
       revision (no content change). Increment version once.
     - **Task move**: update `mission_node.parent_id`. Insert next revision of the
       old objective removing the task from `tasks`, `change.write = "node.move"`,
       `change.tasks = [{ id, change: "moved-out", changedFields: [] }]`. Insert next
       revision of the new objective adding the task to `tasks`,
       `change.tasks = [{ id, change: "moved-in", changedFields: all content fields }]`.
       Increment version once.
  3. Add tests:
     - Objective move inserts no revision; task move inserts revisions on both
       objectives.
     - Same-parent move is a no-op (no increment, empty arrays).
     - Task move where old objective is terminal refuses with `mission.node.terminal`.
     - Task move where new objective is terminal refuses with `mission.node.terminal`.
     - Retired new parent refuses with `mission.node.retired`.
     - Wrong-kind new parent refuses with `mission.node.create_refused`.
     - Objective move updates inherited deps and reconciles jobs for moved subtree.
     - Stale `expectedOldParentRevision` refuses with `mission.revision.conflict`.
     - Stale `expectedNewParentRevision` refuses with `mission.revision.conflict`.
- Rules:
  - `mission-service.md:216–219`: task has no revision; task move writes
    objective revision.
  - `01-setup.md:245–246`: objective move changes `parent_id`, inserts no revision.
  - `01-setup.md:252–253`: same-transaction rerouting/jobs for every affected node.
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; move tests pass including no-op,
  task terminal check, rerouting and version checks.

### 06.15 Implement `mission.criterion.set`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare in `contract.ts`:
     - `mission.criterion.set`: `PUT /api/mission/node/:nodeId/criterion`, access `human`,
       mutation true; input `CriterionSet`; output `NodeChange`.
  2. Implement in `service.ts`:
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - Refuse retired node with 409 `mission.node.retired`.
     - For initiatives and objectives: refuse terminal state with 409 `mission.node.terminal`.
     - For tasks: read the parent objective; refuse if the objective is retired with
       409 `mission.node.retired`; refuse if the objective is terminal with 409
       `mission.node.terminal`.
     - Check `expectedRevision` against the content owner's current revision;
       refuse stale with 409 `mission.revision.conflict`.
     - Validate `criterion` (nonblank text) and `verifications` (nonempty list).
     - Compare criterion and verifications to current values. If identical, return
       current `NodeChange` with empty arrays and no version increment (no-op).
     - **For initiatives/objectives**: insert next revision preserving `name`,
       `requirement`, `filename`, `bindings`; set `criterion` and `verifications`
       to the new values; `change.write = "criterion.set"`.
     - **For tasks**: insert next revision of the parent objective with the task's
       criterion and verifications updated in the `tasks` JSON;
       `change.tasks = [{ id, change: "updated", changedFields: ["criterion","verifications"] }]`.
     - Increment mission version once.
  3. Add tests:
     - `criterion.set` on retired node → `mission.node.retired`.
     - `criterion.set` on terminal objective → `mission.node.terminal`.
     - `criterion.set` on task whose objective is terminal → `mission.node.terminal`.
     - No-op `criterion.set` (same values) returns current version, no increment.
     - `criterion.set` inserts a revision with `change.write = "criterion.set"`.
     - `criterion.set` on a task updates the objective's revision; no task revision.
     - Stale `expectedRevision` → `mission.revision.conflict`.
- Rules:
  - `criterion.set` is ERD 1: `01-setup.md:21`. Implement fully.
  - `mission-service.impl.md#the-revisions`: `change.write = "criterion.set"`.
  - `Text` fields: `z.string().min(1)` in the wire schema; the handler applies `validateText` with `mission.textMaxBytes` (D11).
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; criterion.set tests pass.

### 06.16 Implement `mission.node.retire.preview` and `mission.node.retire`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare two operations in `contract.ts`:
     - `mission.node.retire.preview`: `GET /api/mission/node/:nodeId/retire/preview`,
       query `force: z.string().refine(v => v === "true" || v === "false").transform(v => v === "true")
.default("false")`, access `human`, mutation false. Output `RetirePreview`.
     - `mission.node.retire`: `POST /api/mission/node/:nodeId/retire`, access `human`,
       mutation true; input `Retire`; output `NodeChange`.
  2. Implement retirement logic (shared between preview and apply):
     - Refuse a retired node with 409 `mission.node.retired` — repeat retirement
       is explicitly refused. `mission-service.impl.md:156`.
     - Compute retirement set: the named node and every current non-retired descendant.
     - Check each initiative/objective itself; check each task through its objective.
     - Condition: `Pending` or `Available` with attempt 0; fail with 409
       `mission.node.retire_refused` with `details: { nodeId, state, attempt }`.
     - Nonterminal dependent outside the set with `force = false`: 409
       `mission.node.retire_has_dependents` with `details: { dependents: NodeId[] }`.
     - Compute `previewDigest`: SHA-256 of canonical JSON of sorted retirement
       identity set plus the normalized import-set content (all node IDs and filenames).
       `mission-service.impl.md#node-retire`. Digest uses lowercase hex.
  3. Implement apply (transaction):
     - Recheck every condition. Check `expectedMissionVersion`; refuse stale with
       409 `mission.version.conflict`. Check `previewDigest`; mismatch answers
       409 `mission.node.retire_mismatch`.
     - With `force = true`: delete dependency rows for nonterminal dependents
       outside the set; reroute freed dependents with `reconcileJob`.
     - Terminal dependents keep their dependency row.
     - Set `retired_at` on every node of the retirement set.
     - Delete job for each retired node via `workQueue.delete(tx, nodeId)`.
     - For each retired task whose objective is outside the retirement set: insert
       next revision of that objective removing the task from `tasks`,
       `change.write = "node.retire"`,
       `change.tasks = [{ id, change: "retired", changedFields: [] }]`.
     - Reconcile the surviving parent initiative(s) of retired objectives:
       removing objectives from the set changes the initiative steps condition.
       Call `computeInitiativeClaimable` for each surviving initiative parent
       and call `reconcileJob` with correct `prevClaimable` and `isClaimable`.
     - Reconcile all non-retired dependents whose closure changed via `reconcileJob`.
     - Increment version once.
  4. Add tests from `mission-service.impl.md#node-retire`:
     - Attempt ≥ 1 refuses with `mission.node.retire_refused`.
     - A repeated retirement (already retired node) refuses with `mission.node.retired`.
     - Nonterminal dependent outside the set refuses without `force`.
     - `force` removes the dependency and reroutes freed dependent to `Available`.
     - Terminal dependent keeps its dependency.
     - Preview changes no state; apply checks the digest.
     - Stale version refuses; changed digest refuses.
     - Retirement deletes the job of every retired node in its transaction.
     - Surviving parent initiative gains a job when the retired objective was
       its last non-terminal current objective.
     - `force=false` as a query string is parsed as `false` (not `true`).
     - Retired node row stays readable with its identity, `filename`, revisions.
- Rules:
  - `mission-service.impl.md#node-retire` for every rule.
  - `mission-service.vocabulary.md#retirement-set` for the set definition.
  - `01-setup.md:251`: "A retirement deletes the job of every retired node."
  - `workQueue.delete` in the same transaction.
  - `previewDigest` covers sorted retirement IDs. Lowercase hex SHA-256.
  - `force` query: parse exactly `"true"` or `"false"`; reject other values.
    `z.coerce.boolean()` must not be used (treats `"false"` string as `true`).
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; all named tests from the impl page pass.

### 06.17 Import: snapshot normalization and diff

- Files: `src/mission/import.ts`, `src/mission/import.test.ts`
- Do:
  1. Create `import.ts` with `normalizeImportSnapshot(snapshot: ImportSnapshotInput): NormalizedSnapshot`:
     - For `format: "markdown"`: parse each `PlanFile.content` with `parsePlanFile`;
       collect all parse errors as violations with code `mission.import.plan_invalid`.
     - For `format: "json"`: validate each `ImportEntry`; parse front matter and
       section rules do not apply.
     - For each parsed entry: run `validateNodeContent`; collect content violations.
     - Return `NormalizedSnapshot` with `entries: NormalizedEntry[]` and
       `parseViolations: Violation[]`.
  2. Create `diffImportSet(normalized: NormalizedSnapshot, tx: Transaction, missionId: string): ImportDiff`:
     - Check for duplicate filenames in the import set; add violation
       `mission.import.duplicate_file` for each.
     - For each entry with `id` present: look up the existing node by identity.
       Unknown IDs produce violation `mission.import.unknown_id` (not a create).
       Known IDs are the resolved identity regardless of filename; a different
       filename on the same ID is an update.
     - For each entry without `id`: match by filename to existing non-retired nodes.
       A match by filename without ID creates a different node (old is retired, new
       is created). A match by filename with ID uses the resolved identity.
     - Classify:
       - `create`: no `id`, no existing node with that filename.
       - `update`: resolved existing non-retired, non-terminal node with content
         or structural change (filename, parent, dependencies differ).
       - `noOp`: resolved existing node with no content or structural change.
       - `retirement`: every current non-retired node whose resolved identity does
         not appear in the import set.
     - Diff also tracks structural changes: parent links, child sets, resolved
       dependency identities. Parent/dependency references are by resolved node
       identity, not filename.
     - Return `ImportDiff` with `creates`, `updates`, `retirements`, `noOps`.
  3. Add `import.test.ts` tests:
     - Markdown import calls parser; JSON import validates entries directly.
     - A malformed plan file produces `mission.import.plan_invalid` violation.
     - Unknown supplied ID produces `mission.import.unknown_id` (not silently creates).
     - A node with no changes is `noOp`; a changed node is `update`.
     - A node absent from the set is `retirement`.
     - A file replacing a different node (same filename, no ID) produces both
       a retirement of the old node and a create for the new.
- Rules:
  - No DB writes in `normalizeImportSnapshot`; DB reads only in `diffImportSet`.
  - `mission-service.md:118–119,134`: identity reconciliation by resolved identity.
  - `mission-service.impl.md:149`: three-stage validation order.
  - All errors are `OperationError` or collected as `Violation` for preview aggregation.
- Done when: `pnpm run verify` passes; normalization and diff tests pass.

### 06.18 Import: preview validation

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare `mission.import.preview` in `contract.ts`:
     - `POST /api/mission/:missionId/import/preview`, access `human`, mutation false.
       Input: `ImportSnapshotBase`. Output: `ImportPreview`.
  2. Implement the handler in `service.ts` as a shared staged validator function:
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`
       (operation failure, not a violation).
     - **Stage 1**: Run `normalizeImportSnapshot`. If parse violations exist, return
       `ImportPreview` with those violations and stop — do not proceed to stage 2.
     - **Stage 2** (graph validation, TX read): Run `diffImportSet`. Check:
       - No unresolved `parent` or `dependsOn` reference →
         `mission.import.unresolved_reference` with `details: { reference, name }`.
       - No duplicate `id` in the set → `mission.import.duplicate_id`.
       - No `id` of another mission → `mission.import.foreign_id`.
       - No retired `id` → `mission.import.retired_id` with `details: { id }`.
       - Run `detectCycle` on full dependency closure → `mission.import.cycle`.
       - If any stage-2 violations, return `ImportPreview` with those violations
         and stop — do not proceed to stage 3.
     - **Stage 3** (admission + bindings): For each create/update/retirement, check
       `importAdmissible(node.state, node.attempt)` → `mission.import.condition_failed`
       with `details: { state, attempt }`. Check `mission.import.terminal_change` for
       changes to terminal nodes. Check `mission.node.filename_conflict` for filename
       collisions. Resolve binding names via `resolveBinding` for each node; check
       `checkBindingRuleTable` → collect binding violations.
     - Compute `previewDigest`: SHA-256 of canonical JSON of sorted normalized entry
       content plus sorted retirement IDs. Use lowercase hex. Same recipe as apply.
     - Return `ImportPreview` with violations from all stages that ran, the diff
       (creates, updates, retirements, noOps), `removedEdges` and `previewDigest`.
  3. Add tests:
     - Stage-1 violations stop the preview at stage 1.
     - Stage-2 cycle detection produces `mission.import.cycle`.
     - Stage-2 unknown ID produces `mission.import.unknown_id`.
     - Stage-3 condition failure produces `mission.import.condition_failed`.
     - Stage-3 binding violation produces `mission.node.bindings_invalid`.
     - A retired ID produces `mission.import.retired_id`.
     - Stale mission version answers 409 `mission.version.conflict` (not a violation).
- Rules:
  - `mission-service.impl.md:149`: three-stage order; preview stops at first
    failing stage.
  - Every error code verbatim from `mission-service.impl.md`.
  - Preview changes no state; no DB writes.
  - `mission-service.impl.md#export-and-the-two-formats`: import covers the
    whole mission; every omitted non-retired node is a retirement.
  - `previewDigest` covers sorted retirement IDs. `engine/docs/cli/mission.md:698`.
  - All operation-level failures are `OperationError`; violations are aggregated.
- Done when: `pnpm run verify` passes; three-stage validation tests pass.

### 06.19 Import: transactional apply

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare `mission.import.apply` in `contract.ts`:
     - `POST /api/mission/:missionId/import`, access `human`, mutation true.
       Input: `ImportApply`. Output: `ImportResult`.
  2. Implement in `service.ts`:
     - Run all three validation stages (same as preview). Any violation answers
       the shared error envelope with its code and HTTP status.
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - Inside one atomic transaction:
       - Recompute digest at commit using the same recipe as preview. Mismatch
         answers 409 `mission.import.retirement_mismatch`.
       - Check `confirmedRetirements` matches the computed retirement set exactly;
         mismatch answers 409 `mission.import.retirement_mismatch`.
       - Write ordering (collision-safe):
         1. Retirements first: set `retired_at`; delete jobs. For retired tasks
            with objectives outside the retirement set: insert next objective
            revision removing the task.
         2. Updates next: insert next revision for changed nodes with
            `change.write = "import"`. For task updates: insert next objective
            revision with updated task content.
         3. Creates last: mint `node_<ulid>`; insert `mission_node`; insert
            revision 1 with `change.write = "import"`. For new tasks: insert
            `mission_node` only; content in objective revision.
       - Update containment: write `parent_id` changes for moved nodes.
       - Resolve and reinsert `mission_dependency` rows for all nodes.
       - Reroute every affected non-retired node using full closure;
         call `reconcileJob` for each with correct `prevClaimable` and `isClaimable`.
       - Increment `mission_mission.version` once.
     - Return `ImportResult` with `assignedIds` (filename → nodeId for new nodes),
       `changes: NodeChange`, `actor`, `acceptedAt`.
  3. Add tests:
     - Apply stops at the first violation and answers the envelope.
     - Stale `expectedMissionVersion` refuses with no effect.
     - `confirmedRetirements` mismatch refuses.
     - Changed `previewDigest` refuses.
     - Successful apply is atomic: creates, updates, retirements and rerouting
       commit together.
     - Apply increments the version once.
     - Task creates produce no revision row; content in objective revision.
- Rules:
  - `mission-service.impl.md#export-and-the-two-formats` for the full apply contract.
  - Every error code verbatim.
  - One version increment. `mission-service.impl.md:488`.
  - `workQueue` in the same transaction.
  - Retirements precede creates for uniqueness (filename unique index).
  - `architecture.impl.md` canonical JSON and SHA-256 for `previewDigest`.
- Done when: `pnpm run verify` passes; apply is atomic; tests prove all refusal
  paths and a successful round-trip.

### 06.20 Implement `mission.export`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare `mission.export` in `contract.ts`:
     - `GET /api/mission/:missionId/export`, query `format: z.enum(["markdown","json"])`,
       access `human`, mutation false; answer 10 MiB max.
  2. Implement:
     - Query non-retired nodes; for each objective/initiative, read the current revision.
     - For tasks: read content from the objective's `tasks` JSON in the current revision.
     - For each node's `bindings` JSON array in `mission_node_revision.bindings`: call
       `this.bindings.getBindingRevision(tx, bindingId)` for each stored binding revision;
       map each result's `name` field into the `bindings` output array. A stored
       `bindingId` always resolves, because no sweep deletes a binding row
       (`docs/reference/erd/01-setup.md:208`). A null result throws
       a plain `Error`, which maps to 500 `system.operation.unknown`; the export never drops a binding.
     - **JSON**: produce `{ missionId, missionVersion, entries }` with one
       `ImportEntry` per node (initiatives omit `parent`; tasks omit `dependsOn`).
     - **Markdown**: produce `{ missionId, missionVersion, files }` where each
       `content` follows the plan file grammar, produced by `serializePlanFile`.
     - If the serialized answer exceeds 10 MiB, throw
       `new OperationError("mission.export.too_large", ..., { status: 413 })`.
  3. Add tests:
     - Export JSON and re-import: no change to nodes or version.
     - Export Markdown and re-import: same.
     - Export excludes retired nodes.
     - Export above 10 MiB answers 413 `mission.export.too_large`.
- Rules:
  - `mission-service.impl.md#export-and-the-two-formats` for exact answer shape.
  - Retired nodes excluded; `missionVersion` equals current version.
  - 10 MiB bound. `mission-service.impl.md:142`.
  - Task content comes from objective's `tasks` column. `01-setup.md:241`.
  - All domain errors are `OperationError`.
  - Handler uses `caller.commit` per D3.
- Done when: `pnpm run verify` passes; round-trip tests pass.

### 06.21 Implement `mission.node.rebind` and complete `liveNodesPinning`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare `mission.node.rebind` in `contract.ts`:
     - `POST /api/mission/:missionId/rebind`, access `human`, mutation true;
       input `Rebind`; output `z.strictObject({ nodeChange: NodeChange, skipped: z.array(NodeSchema) })`.
     - `Rebind` uses `bindingId: BindingId` (per `engine/docs/cli/mission.md:660`).
  2. Implement rebind:
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - Call `this.bindings.getBindingRevision(tx, body.bindingId)` to load the target
       revision. Throw 404 `mission.binding.not_found` if absent. Throw 409
       `mission.binding.removed` if `tombstone = true`. Throw 409
       `mission.binding.disabled` if `disabled = true` (`mission-service.impl.md`, the rebind).
     - For each non-terminal, non-retired node (optionally filtered to `nodeId`):
       for each stored `bindingId` in its current revision's `bindings` JSON array, call
       `this.bindings.getBindingRevision(tx, storedBindingId)` to get its `resourceIdentity`;
       if it equals the target revision's `resourceIdentity`, replace it with
       `body.bindingId`. Insert a new `mission_node_revision` with the updated `bindings`
       array for any node where a replacement occurred.
     - Equal-target: if every matched node already pins `bindingId`, return a no-op
       `NodeChange` with no version increment.
     - Keep the pinned node revision of an open attempt unchanged (ERD 1 has no open
       attempts; write the guard for ERD 2 readiness).
     - Report skipped terminal and retired nodes.
     - Increment version once (when any node changes).
  3. Replace the `liveNodesPinning` stub with the full query:
     - Query `mission_node n` joined to `mission_node_revision r` (max revision)
       where `n.retired_at IS NULL AND n.state NOT IN ('Completed', 'Discarded')`
       and the `bindings` JSON array of `r` contains `bindingId`.
     - In ERD 1 check current revision only.
  4. Add tests:
     - Non-terminal, non-retired node is rebound.
     - Terminal and retired nodes are skipped and reported.
     - Equal-target is a no-op (no revision, no version increment).
     - Version increments once when any node changes.
     - Absent target binding revision answers 404 `mission.binding.not_found`.
     - Tombstoned target answers 409 `mission.binding.removed`.
     - Disabled target answers 409 `mission.binding.disabled`.
     - `liveNodesPinning` returns IDs of nodes whose current revision bindings
       contain the given ID.
- Rules:
  - `mission-service.impl.md#the-rebind` for every rule.
  - `Rebind.bindingId` per `engine/docs/cli/mission.md:660` (not `bindingRevisionId`).
  - `liveNodesPinning` seam: `00-index.md` seam row.
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; all rebind tests pass; `liveNodesPinning`
  full query test passes.

### 06.22 Implement `mission.node.priority.set`

- Files: `src/mission/contract.ts`, `src/mission/service.ts`,
  `src/mission/service.test.ts`
- Do:
  1. Declare `mission.node.priority.set` in `contract.ts`:
     - `POST /api/mission/node/:nodeId/priority`, access `human`, mutation true;
       input `PrioritySet`; output `NodeSchema`. Input is strictly closed: a `reason`
       field in input answers HTTP 400 with an issue list.
  2. Implement:
     - Refuse retired node with 409 `mission.node.retired`.
     - Check `expectedMissionVersion`; refuse stale with 409 `mission.version.conflict`.
     - Refuse a task node with 400 `mission.node.priority_task`.
     - Refuse a terminal node with 409 `mission.node.terminal`.
     - Refuse a live claim (ERD 1: no live claims; write the guard for ERD 2).
     - Validate `value` as a signed safe integer; HTTP 400 for fraction, nonnumber,
       unsafe integer.
     - Update `mission_node.priority`; call `workQueue.priorityUpdate` in the
       same transaction.
     - No version increment. `mission-service.impl.md:483`.
  3. Add tests:
     - Retired node refuses with `mission.node.retired`.
     - Task priority answers `mission.node.priority_task`.
     - Absent priority reads 0.
     - A second act overwrites the value.
     - The job identity stays unchanged after a priority update.
     - Fraction, nonnumber, unsafe integer answer HTTP 400.
     - A `reason` field in input answers HTTP 400.
- Rules:
  - `mission-service.impl.md#priority` for the full rule set.
  - `workQueue.priorityUpdate` in the same transaction. `01-setup.md:263`.
  - No version increment for a priority act.
  - Retired-node check precedes other checks.
  - All domain errors are `OperationError`.
- Done when: `pnpm run verify` passes; all priority tests pass.

## Blockers

None.
