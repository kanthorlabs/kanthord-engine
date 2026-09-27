# Plan 02: Scheduler Service — job table

## Scope

This plan delivers:

- The `scheduler_job` table with its `node_id` unique index.
- The `WorkQueue` collaboration interface (`insert`, `delete`, `priorityUpdate`) in `src/scheduler/contract.ts`, consumed by the Mission Service in Plan 06.
- The `scheduler.queue.list` and `scheduler.queue.peek` human read operations with their handlers.
- The `SchedulerService` skeleton that implements `Service` and `WorkQueue`, registers the two read operations, and exports `schedulerMigrations`.
- The `scheduler` component healthcheck with key `queue`, registered via `HealthRegistry`; returns 200 when started and not shut down, and 503 otherwise. The `queue` key reports lifecycle availability only: it reads the `started` flag and the `shutdown` cancellation state; it performs no SQL probe and no external resource check.

Out of scope: execution, claim, lease, observation-obligation tables and handlers; the scheduling processor pool; work pulls; delivery admission; every ERD 2 item.

## Sources

- `docs/brainstorm/scheduler-service.md#topology-and-work-queue` — insert on claimable state, delete on unclaimable state, priority change keeps `id`, selection order `priority DESC, id ASC`, peek reads first job without removing it.
- `docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service` — `job_<ulid>` prefix; `insert` mints the identity inside the Mission transaction.
- `docs/brainstorm/scheduler-service.impl.md#operation-contracts` — `Job` fields; `scheduler.queue.list` and `scheduler.queue.peek` are human reads of unary lifetime with 30 s timeout; every object is closed.
- `docs/reference/erd/01-setup.md#scheduler-service` — `scheduler_job` columns; unique index on `node_id`; `project_id` equals the project of the mission of the node; selection order `priority DESC, id ASC`; priority change keeps `id`; retirement deletes job in same transaction.
- `docs/reference/erd/01-setup.md#diagram` — four columns: `id TEXT PK`, `project_id TEXT`, `node_id TEXT UK`, `priority INTEGER`; no FK to `mission_node` or `project_project`.
- `docs/brainstorm/architecture.impl.md#pagination` — list orders by primary key descending; limit 1–1000 default 100; cursor is base64url of last key; `nextCursor` null on last page; malformed cursor returns 400.
- `docs/brainstorm/architecture.impl.md#the-identity-and-the-time` — `job_` prefix convention; `identitySchema("job")` validates the identity.
- `docs/brainstorm/architecture.impl.md:339–349` — error codes require at least three dot-separated parts.
- `docs/brainstorm/architecture.impl.md:17–20` — named constants for every fixed string or numeric value in comparisons.
- `docs/brainstorm/architecture.impl.md:583` — `WorkQueue` is a Kind 2 collaboration; takes caller's `Transaction`; opens no transaction of its own; co-locates Mission and Scheduler in one process on one database.
- `engine/docs/cli/scheduler.md#queue-discovery` — list returns items in descending job-identity order; peek returns `{ job: Job | null }` ordered by `priority DESC, id ASC`.
- `engine/src/project/service.ts:16` — collaboration types declared inline in own `contract.ts`; no import from a peer service `contract.ts`.
- `engine/AGENTS.md#add-a-service` — file layout: `contract.ts`, `service.ts`, `migrations.ts`, `index.ts`; exports: `Service`, `Dependencies`, config fragment, migrations.

## Depends on

None. This plan creates the Scheduler Service from scratch.

## Provides

| Seam                  | TypeScript signature                                                                                                                                                                                                                 | Owner file                  | Consumer plans |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------- |
| `WorkQueue` interface | `interface WorkQueue { insert(tx: Transaction, nodeId: string, projectId: string, priority: number): void; delete(tx: Transaction, nodeId: string): void; priorityUpdate(tx: Transaction, nodeId: string, priority: number): void }` | `src/scheduler/contract.ts` | 06             |
| `schedulerMigrations` | `readonly Migration[]`                                                                                                                                                                                                               | `src/scheduler/index.ts`    | 07             |

## Tasks

### 02.1 Create the scheduler_job migration

- Files:
  - `src/scheduler/migrations.ts` (create)
- Do:
  1. Import `type Migration` from `../kernel/store.ts`.
  2. Define migration function `m1` typed as `Migration` that calls `database.exec(...)` with two statements:
     - `CREATE TABLE scheduler_job (id TEXT NOT NULL, project_id TEXT NOT NULL, node_id TEXT NOT NULL, priority INTEGER NOT NULL, PRIMARY KEY (id))`
     - `CREATE UNIQUE INDEX scheduler_job_node_id ON scheduler_job (node_id)`
  3. Export `schedulerMigrations: readonly Migration[] = [m1]`.
- Rules:
  - No SQL `CHECK` constraint. (`engine/CLAUDE.local.md`)
  - Only PRIMARY KEY and unique indexes; no non-unique index. (`docs/reference/erd/README.md#constraints`)
  - Table prefix `scheduler_`. (`engine/AGENTS.md#add-a-migration`)
  - No `REFERENCES` clause on `project_id` or `node_id`. (`docs/reference/erd/01-setup.md#cross-group-references`)
- Done when: `pnpm run verify` passes; the migration function creates `scheduler_job` and the index `scheduler_job_node_id` in `sqlite_master` when applied to an empty in-memory store.

### 02.2 Declare the WorkQueue interface and scheduler operation schemas

- Files:
  - `src/scheduler/contract.ts` (create)
- Do:
  1. Import `type Transaction` from `../kernel/store.ts`; `z` from `zod`; `identitySchema` from `../kernel/identity.ts`; `AccessPolicy`, `OperationLifetime`, `StoreName`, `type Operation` from `../kernel/operation.ts`; `HttpMethod`, `HttpStatus` from `../kernel/http.ts`.
  2. Export `SCHEDULER_SERVICE_NAME = "scheduler"` as a `const`.
  3. Export `JOB_IDENTITY_PREFIX = "job"` as a `const`.
  4. Export `WorkQueue` interface:
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
  5. Export `jobSchema`:
     ```ts
     export const jobSchema = z.strictObject({
       jobId: identitySchema("job"),
       projectId: identitySchema("project"),
       nodeId: identitySchema("node"),
       priority: z
         .number()
         .int()
         .min(Number.MIN_SAFE_INTEGER)
         .max(Number.MAX_SAFE_INTEGER),
     });
     ```
  6. Export named constants `QUEUE_LIST_LIMIT_DEFAULT = 100`, `QUEUE_LIST_LIMIT_MIN = 1`, `QUEUE_LIST_LIMIT_MAX = 1000`.
  7. Export `schedulerOperations` as a `const` satisfying `Record<string, Operation>` with two entries:
     - `queueList`: `id: "scheduler.queue.list"`, `service: SCHEDULER_SERVICE_NAME`, `method: HttpMethod.Get`, `path: "/api/scheduler/project/:projectId/queue"`, `access: AccessPolicy.Human`, `lifetime: OperationLifetime.Unary`, `store: StoreName.Operational`, `mutation: false`, `timeoutMs: 30000`, `status: HttpStatus.OK`, `description: "List current jobs in the project's work queue, ordered by job identity descending."`, `input: z.strictObject({ params: z.strictObject({ projectId: identitySchema("project") }), query: z.strictObject({ limit: z.coerce.number().int().min(QUEUE_LIST_LIMIT_MIN).max(QUEUE_LIST_LIMIT_MAX).default(QUEUE_LIST_LIMIT_DEFAULT).optional(), cursor: z.string().optional() }), body: z.null() })`, `output: z.strictObject({ items: z.array(jobSchema), nextCursor: z.string().nullable() })`.
     - `queuePeek`: `id: "scheduler.queue.peek"`, same `service`, `access`, `lifetime`, `store`, `mutation`, `timeoutMs`, `status`; `method: HttpMethod.Get`, `path: "/api/scheduler/project/:projectId/queue/peek"`, `description: "Read the first job of the project's work queue by selection order without removing it."`, `input: z.strictObject({ params: z.strictObject({ projectId: identitySchema("project") }), query: z.strictObject({}), body: z.null() })`, `output: z.strictObject({ job: jobSchema.nullable() })`.
- Rules:
  - `contract.ts` must not import from any peer service `contract.ts`. (`engine/src/project/service.ts:16`, `00-index.md#collaboration-type-contract-rule`)
  - Every output object schema is closed (`strictObject`). (`docs/brainstorm/architecture.impl.md:34–37`)
  - `null` is valid only where explicitly declared: `nextCursor` (end of pagination) and `job` (empty queue). (`docs/brainstorm/architecture.impl.md:34–37`)
  - Named constants for timeout, limit bounds, and service name. (`docs/brainstorm/architecture.impl.md:17–20`)
  - Both operations are human reads of unary lifetime with 30 s timeout. (`docs/brainstorm/scheduler-service.impl.md#operation-contracts`)
- Done when: `pnpm run verify` passes; `schedulerOperations satisfies Record<string, Operation>` compiles without type errors; `jobSchema` parses a valid `Job` object and rejects an extra field.

### 02.3 Implement SchedulerService with WorkQueue methods, read handlers, and colocated test

- Files:
  - `src/scheduler/service.ts` (create)
  - `src/scheduler/service.test.ts` (create)
  - `src/scheduler/index.ts` (create)
- Do — service.ts:
  1. Import from `../kernel/`: `background`, `CancellationContext`, `type Context`, `throwIfCancelled` from `context.ts`; `Diagnostic`, `OperationError` from `errors.ts`; `HealthStatus`, `type Healthcheck`, `type Service` from `service.ts`; `type HealthRegistry` from `health.ts`; `type OperationRegistry`, `AccessPolicy` from `operation.ts`; `createIdentity`, `identitySchema` from `identity.ts`; `HttpStatus` from `http.ts`.
  2. Import from `./contract.ts`: `type WorkQueue`, `JOB_IDENTITY_PREFIX`, `SCHEDULER_SERVICE_NAME`, `schedulerOperations`, `QUEUE_LIST_LIMIT_DEFAULT`.
  3. Declare `SCHEDULER_STOPPED_CODE = "scheduler.lifecycle.stopped"` and `CURSOR_ENCODING = "base64url"` as `const`.
  4. Export `interface Dependencies { config: Record<string, never>; health?: HealthRegistry }`.
  5. Export `class SchedulerService implements Service, WorkQueue`.
  6. Constructor: accept `Dependencies`; call `dependencies.health?.register("scheduler", () => this.healthcheck())`.
  7. Implement `insert(tx, nodeId, projectId, priority)`: mint `id = createIdentity(JOB_IDENTITY_PREFIX)`; run `INSERT INTO scheduler_job (id, project_id, node_id, priority) VALUES (?, ?, ?, ?)` via `tx.database.prepare(...).run(id, projectId, nodeId, priority)`.
  8. Implement `delete(tx, nodeId)`: run `DELETE FROM scheduler_job WHERE node_id = ?` via `tx.database.prepare(...).run(nodeId)`.
  9. Implement `priorityUpdate(tx, nodeId, priority)`: run `UPDATE scheduler_job SET priority = ? WHERE node_id = ?` via `tx.database.prepare(...).run(priority, nodeId)`.
  10. Implement `declare(registry)`:
      - Assert `schedulerOperations.queueList.service === SCHEDULER_SERVICE_NAME` and `schedulerOperations.queueList.access === AccessPolicy.Human`.
      - Assert `schedulerOperations.queuePeek.service === SCHEDULER_SERVICE_NAME` and `schedulerOperations.queuePeek.access === AccessPolicy.Human`.
      - Register `schedulerOperations.queueList` handler: extract `projectId` from `input.params`, `limit` from `input.query.limit` (default `QUEUE_LIST_LIMIT_DEFAULT`), `cursor` from `input.query.cursor`. When `cursor` is present: decode with `const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString("utf8")`; verify the round-trip `Buffer.from(decoded, "utf8").toString(CURSOR_ENCODING) === cursor`; then validate `decoded` with `identitySchema("job").safeParse`; throw `OperationError(HttpStatus.BadRequest, "system.pagination.cursor_invalid", "Cursor is invalid.")` on any failure. Call `caller.commit(tx => { ... })` and run `SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ?` plus `AND id < ?` when cursor is present, `ORDER BY id DESC LIMIT ?` with `limit + 1`. Map each row to `{ jobId: row.id, projectId: row.project_id, nodeId: row.node_id, priority: row.priority }`. When row count exceeds `limit`, trim to `limit` items and set `nextCursor = Buffer.from(items[items.length - 1].jobId, "utf8").toString(CURSOR_ENCODING)`; else set `nextCursor = null`. Return `{ items, nextCursor }`.
      - Register `schedulerOperations.queuePeek` handler: extract `projectId` from `input.params`. Call `caller.commit(tx => { ... })` and run `SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ? ORDER BY priority DESC, id ASC LIMIT 1`. Map the single row to a `Job` object or return `null`. Return `{ job }`.
  11. Implement `Service` lifecycle, matching `src/project/service.ts` structure: `shutdown` as `CancellationContext`; `startTask?`, `stopTask?`; `quiesceTask = Promise.resolve(null)`; `started = false`. `start()` returns the `SCHEDULER_STOPPED_CODE` Diagnostic when `shutdown.err()`, otherwise sets `started = true` and resolves `null`. `quiesce()` returns `quiesceTask`. `stop()` calls `shutdown.cancel()`, sets `started = false`, resolves `null`. `run(context)` follows the on-cancel/start/shutdown-done pattern. `healthcheck()` returns `{ queue: started && !shutdown.err() ? HealthStatus.Healthy : HealthStatus.Unavailable }`.
- Do — service.test.ts (behavior code exists before each test):
  1. Import from `node:assert/strict`, `node:test`; from `../kernel/`: `Store`, `IN_MEMORY_DATABASE`, `HealthStatus`, `HealthRegistry`, `OperationRegistry`, `background`, `HttpStatus`, `OperationError`, `identitySchema`, `createIdentity`; from `./service.ts`: `SchedulerService`; from `./migrations.ts`: `schedulerMigrations`; from `./contract.ts`: `schedulerOperations`, `SCHEDULER_SERVICE_NAME`, `QUEUE_LIST_LIMIT_DEFAULT`.
  2. Define helper `makeStore()` that opens an in-memory store and runs `store.migrate([{ service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations }])`.
  3. Define helper `makeCallerContext(store)` that returns an object with `context: background`, `requestId: createIdentity("request")`, `commit: (work) => store.transaction(work)`.
  4. Test `"WorkQueue insert adds a row and enforces the node_id unique index"`: construct a store and scheduler; insert a job row via `store.transaction(tx => scheduler.insert(tx, nodeId, projectId, 0))`; assert a matching row exists; call insert again with the same `nodeId`; assert it throws (unique constraint violation).
  5. Test `"WorkQueue delete removes a row and is safe on a missing node_id"`: insert a job; call `store.transaction(tx => scheduler.delete(tx, nodeId))`; assert the row is absent; call delete again with the same `nodeId`; assert no error thrown.
  6. Test `"WorkQueue priorityUpdate changes priority and preserves id"`: insert a job at priority 0; call `store.transaction(tx => scheduler.priorityUpdate(tx, nodeId, 1))`; assert the `priority` column is 1 and the `id` column is unchanged.
  7. Test `"queue list handler orders by id descending and paginates"`: declare `const LIST_PAGE_LIMIT = 2`, `const LIST_TOTAL_JOBS = 3`, `const LIST_SECOND_PAGE_COUNT = 1` as const; insert `LIST_TOTAL_JOBS` jobs for one `projectId` via separate `store.transaction` calls; construct registry; call `scheduler.declare(registry)`; construct a CallerContext backed by the store; invoke the `queueList` handler with `{ params: { projectId }, query: { limit: LIST_PAGE_LIMIT }, body: null }`; assert `items.length === LIST_PAGE_LIMIT` and `items[0].jobId > items[1].jobId` (string comparison); assert `nextCursor` is non-null; invoke again with `{ params: { projectId }, query: { limit: LIST_PAGE_LIMIT, cursor: nextCursor }, body: null }`; assert `items.length === LIST_SECOND_PAGE_COUNT` and `nextCursor === null`.
  8. Test `"queue peek handler returns the first job by priority desc then id asc, or null"`: declare `const PRIORITY_LOW = 0`, `const PRIORITY_HIGH = 1` as const; insert a job at `PRIORITY_LOW` and a job at `PRIORITY_HIGH` for the same `projectId` via `store.transaction`; invoke the `queuePeek` handler; assert `job.priority === PRIORITY_HIGH`; directly insert two rows at `PRIORITY_HIGH` with fixed known ids `"job_00000000000000000000000000"` and `"job_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"` via `tx.database.prepare("INSERT INTO scheduler_job (id, project_id, node_id, priority) VALUES (?, ?, ?, ?)").run(...)` inside `store.transaction`; invoke peek; assert `job.jobId === "job_00000000000000000000000000"` (lowest id wins the `id ASC` tie-break at equal priority); invoke peek for a fresh `projectId` with no jobs; assert `job === null`.
  9. Test `"SchedulerService lifecycle and health registration"`: construct `new HealthRegistry()` and pass it as `health` in the scheduler's `Dependencies`. Assert `(await registry.check(background)).scheduler.queue === HealthStatus.Unavailable` before start. Call `start()`. Assert `(await registry.check(background)).scheduler.queue === HealthStatus.Healthy`. Call `stop()`. Assert `(await registry.check(background)).scheduler.queue === HealthStatus.Unavailable`. Call `start()` again; assert the returned error is non-null.
- Do — index.ts:
  1. Export `SchedulerService`, `type Dependencies` from `./service.ts`.
  2. Export `schedulerMigrations` from `./migrations.ts`.
  3. Export `schedulerConfigSchema = {}` as a `const`.
- Rules:
  - WorkQueue methods use `tx` from the caller and call no `store.transaction`. (`docs/brainstorm/architecture.impl.md:116`)
  - Queue peek selection order: `priority DESC, id ASC`. (`docs/reference/erd/01-setup.md#scheduler-service`)
  - Queue list inspection order: `id DESC`. (`engine/docs/cli/scheduler.md#queue-list`)
  - Named constants for every fixed string or numeric comparison value; no bare literals in comparisons or switch cases. (`docs/brainstorm/architecture.impl.md:17–20`)
  - No code comments. (user global instructions)
  - Error code `system.pagination.cursor_invalid` has three parts. (`docs/brainstorm/architecture.impl.md:339`)
- Done when: `node --test --test-timeout=30000 src/scheduler/service.test.ts` passes all 6 tests including `"SchedulerService lifecycle and health registration"`; `pnpm run verify` passes.

### 02.4 Register scheduler in the migration test and update AGENTS.md

- Files:
  - `src/apps/server/migrations.test.ts` (edit)
  - `engine/AGENTS.md` (edit)
- Do — migrations.test.ts:
  1. Add `import { schedulerMigrations } from "../../scheduler/index.ts"` at the import group.
  2. Insert `{ service: "scheduler", migrations: schedulerMigrations }` into the `services` array after the entry for `"project"`.
  3. Append `"scheduler_job"` to the expected array in the `assert.deepEqual(tables(store), [...])` call; retain the existing entries from earlier plans and place `"scheduler_job"` after them in SQLite creation order.
- Do — AGENTS.md:
  1. Replace the single line `├── scheduler/              # [planned] Queue, claims, leases, and observations` with the four-line block:
     ```
     ├── scheduler/              # Scheduler Service — job table, work queue, and queue reads
     │   ├── contract.ts         # WorkQueue collaboration and queue operation declarations
     │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
     │   ├── migrations.ts       # scheduler_job table migration
     │   └── service.ts          # Private lifecycle, WorkQueue implementation, and queue handlers
     ```
- Rules:
  - No edit to `src/apps/server/index.ts` or `src/config/index.ts`. (`00-index.md#ownership`: those are Plan 07's edits.)
  - No edit to `eslint.config.js`; `scheduler` is already in the service element pattern at `engine/eslint.config.js:28`.
  - No `schedulerConfigSchema` import in `src/config/index.ts`; Scheduler adds no config section. (`00-index.md`: "Custody, Scheduler and Repository add no config section.")
- Done when: `pnpm run verify` passes; the migration isolation test for `"scheduler"` passes and finds exactly `scheduler_job`; the combined migration test includes `"scheduler_job"` in its table assertion.

## Blockers

None.
