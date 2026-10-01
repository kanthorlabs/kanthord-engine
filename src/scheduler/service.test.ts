import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { HealthStatus } from "../kernel/service.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  schedulerOperations,
  SCHEDULER_SERVICE_NAME,
  QUEUE_LIST_LIMIT_DEFAULT,
} from "./contract.ts";
import { schedulerMigrations } from "./migrations.ts";
import { schedulerHarness } from "./test-support.ts";

const PROJECT_PREFIX = "project";
const NODE_PREFIX = "node";
const REQUEST_PREFIX = "request";
const JOB_PREFIX = "job";
const INITIAL_PRIORITY = 0;
const UPDATED_PRIORITY = 1;
const FIRST_ITEM = 0;
const SECOND_ITEM = 1;
const ONE_ROW = 1;
const NO_ROWS = 0;
const LIST_PAGE_LIMIT = 2;
const LIST_TOTAL_JOBS = 3;
const LIST_SECOND_PAGE_COUNT = 1;
const PRIORITY_LOW = 0;
const PRIORITY_HIGH = 1;
const LOWEST_JOB_ID = "job_00000000000000000000000000";
const HIGHEST_JOB_ID = "job_7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
const MALFORMED_CURSOR = "dGVzdA";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";

type StoredJob = { id: string; priority: number };

function makeStore(): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
    ]);
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

function makeCallerContext(store: Store): CallerContext {
  return {
    context: background,
    requestId: createIdentity(REQUEST_PREFIX),
    commit: (work) => store.transaction(work),
  };
}

function invokeList(
  registry: OperationRegistry,
  caller: CallerContext,
  projectId: string,
  query: { limit?: number; cursor?: string },
) {
  const op = schedulerOperations.queueList;
  return registry
    .get(op.id)
    .handler(
      op.input.parse({ params: { projectId }, query, body: null }),
      caller,
    ) as typeof op.output._output;
}

function invokePeek(
  registry: OperationRegistry,
  caller: CallerContext,
  projectId: string,
) {
  const op = schedulerOperations.queuePeek;
  return registry
    .get(op.id)
    .handler(
      op.input.parse({ params: { projectId }, query: {}, body: null }),
      caller,
    ) as typeof op.output._output;
}

test("WorkQueue insert adds a row and enforces the node_id unique index", (t) => {
  const store = makeStore();
  t.after(() => store.close());
  const scheduler = schedulerHarness(t, { store }).service;
  const nodeId = createIdentity(NODE_PREFIX);
  const projectId = createIdentity(PROJECT_PREFIX);
  store.transaction((tx) =>
    scheduler.insert(tx, nodeId, projectId, INITIAL_PRIORITY),
  );
  const row = store.database
    .prepare(
      "SELECT id, priority FROM scheduler_job WHERE node_id = ? AND project_id = ?",
    )
    .get(nodeId, projectId) as StoredJob | undefined;
  assert.ok(row);
  assert.equal(row.priority, INITIAL_PRIORITY);
  assert.ok(identitySchema(JOB_PREFIX).safeParse(row.id).success);
  assert.throws(() =>
    store.transaction((tx) =>
      scheduler.insert(tx, nodeId, projectId, INITIAL_PRIORITY),
    ),
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM scheduler_job").get()
      ?.count,
    ONE_ROW,
  );
});

test("WorkQueue delete removes a row and is safe on a missing node_id", (t) => {
  const store = makeStore();
  t.after(() => store.close());
  const scheduler = schedulerHarness(t, { store }).service;
  const nodeId = createIdentity(NODE_PREFIX);
  store.transaction((tx) =>
    scheduler.insert(
      tx,
      nodeId,
      createIdentity(PROJECT_PREFIX),
      INITIAL_PRIORITY,
    ),
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM scheduler_job").get()
      ?.count,
    ONE_ROW,
  );
  store.transaction((tx) => scheduler.delete(tx, nodeId));
  assert.equal(
    store.database
      .prepare("SELECT COUNT(*) AS count FROM scheduler_job WHERE node_id = ?")
      .get(nodeId)?.count,
    NO_ROWS,
  );
  assert.doesNotThrow(() =>
    store.transaction((tx) => scheduler.delete(tx, nodeId)),
  );
});

test("WorkQueue priorityUpdate changes priority and preserves id", (t) => {
  const store = makeStore();
  t.after(() => store.close());
  const scheduler = schedulerHarness(t, { store }).service;
  const nodeId = createIdentity(NODE_PREFIX);
  store.transaction((tx) =>
    scheduler.insert(
      tx,
      nodeId,
      createIdentity(PROJECT_PREFIX),
      INITIAL_PRIORITY,
    ),
  );
  const original = store.database
    .prepare("SELECT id, priority FROM scheduler_job WHERE node_id = ?")
    .get(nodeId) as StoredJob;
  assert.equal(original.priority, INITIAL_PRIORITY);
  store.transaction((tx) =>
    scheduler.priorityUpdate(tx, nodeId, UPDATED_PRIORITY),
  );
  const updated = store.database
    .prepare("SELECT id, priority FROM scheduler_job WHERE node_id = ?")
    .get(nodeId) as StoredJob;
  assert.equal(updated.priority, UPDATED_PRIORITY);
  assert.equal(updated.id, original.id);
});

test("queue list handler orders by id descending and paginates", (t) => {
  const store = makeStore();
  t.after(() => store.close());
  const scheduler = schedulerHarness(t, { store }).service;
  const projectId = createIdentity(PROJECT_PREFIX);
  for (let index = NO_ROWS; index < LIST_TOTAL_JOBS; index += ONE_ROW)
    store.transaction((tx) =>
      scheduler.insert(
        tx,
        createIdentity(NODE_PREFIX),
        projectId,
        INITIAL_PRIORITY,
      ),
    );
  const allIds = store.database
    .prepare("SELECT id FROM scheduler_job WHERE project_id = ?")
    .all(projectId)
    .map((row) => row.id);
  const registry = new OperationRegistry();
  scheduler.declare(registry);
  const caller = makeCallerContext(store);
  const first = invokeList(registry, caller, projectId, {
    limit: LIST_PAGE_LIMIT,
  });
  assert.equal(first.items.length, LIST_PAGE_LIMIT);
  assert.ok(first.items[FIRST_ITEM]!.jobId > first.items[SECOND_ITEM]!.jobId);
  assert.ok(first.nextCursor);
  const second = invokeList(registry, caller, projectId, {
    limit: LIST_PAGE_LIMIT,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, LIST_SECOND_PAGE_COUNT);
  assert.equal(second.nextCursor, null);
  const pageIds = [...first.items, ...second.items].map((job) => job.jobId);
  assert.equal(new Set(pageIds).size, LIST_TOTAL_JOBS);
  assert.deepEqual([...pageIds].sort(), [...allIds].sort());
  assert.throws(
    () =>
      invokeList(registry, caller, projectId, {
        limit: QUEUE_LIST_LIMIT_DEFAULT,
        cursor: MALFORMED_CURSOR,
      }),
    (error) =>
      error instanceof OperationError &&
      error.code === CURSOR_INVALID_CODE &&
      error.status === HttpStatus.BadRequest,
  );
});

test("queue peek handler returns the first job by priority desc then id asc, or null", (t) => {
  const store = makeStore();
  t.after(() => store.close());
  const scheduler = schedulerHarness(t, { store }).service;
  const projectId = createIdentity(PROJECT_PREFIX);
  store.transaction((tx) =>
    scheduler.insert(tx, createIdentity(NODE_PREFIX), projectId, PRIORITY_LOW),
  );
  store.transaction((tx) =>
    scheduler.insert(tx, createIdentity(NODE_PREFIX), projectId, PRIORITY_HIGH),
  );
  const registry = new OperationRegistry();
  scheduler.declare(registry);
  const caller = makeCallerContext(store);
  assert.equal(
    invokePeek(registry, caller, projectId).job?.priority,
    PRIORITY_HIGH,
  );
  store.transaction((tx) => {
    const insert = tx.database.prepare(
      "INSERT INTO scheduler_job (id, project_id, node_id, priority) VALUES (?, ?, ?, ?)",
    );
    insert.run(
      LOWEST_JOB_ID,
      projectId,
      createIdentity(NODE_PREFIX),
      PRIORITY_HIGH,
    );
    insert.run(
      HIGHEST_JOB_ID,
      projectId,
      createIdentity(NODE_PREFIX),
      PRIORITY_HIGH,
    );
  });
  assert.equal(
    invokePeek(registry, caller, projectId).job?.jobId,
    LOWEST_JOB_ID,
  );
  assert.deepEqual(
    invokePeek(registry, caller, createIdentity(PROJECT_PREFIX)),
    { job: null },
  );
});

test("SchedulerService lifecycle and health registration", async (t) => {
  const health = new HealthRegistry();
  const scheduler = schedulerHarness(t, { health }).service;
  assert.equal(
    (await health.check(background)).scheduler?.queue,
    HealthStatus.Unavailable,
  );
  assert.equal(await scheduler.start(), null);
  assert.equal(
    (await health.check(background)).scheduler?.queue,
    HealthStatus.Healthy,
  );
  assert.equal(await scheduler.stop(), null);
  assert.equal(
    (await health.check(background)).scheduler?.queue,
    HealthStatus.Unavailable,
  );
  assert.ok(await scheduler.start());
});
