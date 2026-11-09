import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatus } from "../kernel/http.ts";
import { createIdempotencyKey } from "../kernel/identity.ts";
import {
  type ClientOptions,
  OperationResultType,
} from "../kernel/operation.ts";
import {
  testHumanIdentity,
  testServiceIdentity,
} from "../kernel/test-identity.ts";
import { trackingOperations } from "../tracking/contract.ts";
import {
  CleanableKind,
  CleanupRule,
  CleanupState,
  DEFAULT_AGE_DAYS,
  FOOTPRINT_CLEANUP_BATCH_ROWS,
  FOOTPRINT_SERVICE_NAME,
  FootprintErrorCode,
} from "./contract.ts";
import { cleanupOf, updateCleanup } from "./cleanup-store.ts";
import {
  type CleanupDeleter,
  type DeleteCall,
  ownerDeleter,
} from "./cleanup-task.ts";
import { footprintFixture, HUMAN_ACTOR, insertTrace } from "./test-support.ts";

const HUMAN = testHumanIdentity("ulrich", "Ulrich", "jti-ulrich");

const KEY_COUNT = 45;
const FIRST_RESUME = 20;
const PENDING_AFTER_ONE = 1;
const ENDED_TRACES = 2;
const REPEATED_TRACES = 1;

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function recordingDeleter(calls: DeleteCall[]): CleanupDeleter {
  return (call) => {
    calls.push(call);
    return Promise.resolve({
      removed: call.keys.length,
      absent: 0,
      refused: [],
      removed_bytes: null,
    });
  };
}

async function create(
  fixture: ReturnType<typeof footprintFixture>,
  keys: string[],
) {
  const result = await fixture.footprint["cleanup.create"](
    {
      params: {},
      query: {},
      body: {
        kind: CleanableKind.Trace,
        instance_name: null,
        rule: { name: "older_than", older_than_days: DEFAULT_AGE_DAYS },
        keys,
      },
    },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(result.type, OperationResultType.Completed);
  return result;
}

test("create answers 201 with a queued record and the read computes pending", async (t) => {
  const fixture = footprintFixture(t);
  const result = await create(fixture, [traceId(1), traceId(2)]);
  assert.equal(result.status, HttpStatus.Created);
  assert.equal(result.data.state, CleanupState.Queued);
  assert.deepEqual(result.data.requested_by, HUMAN_ACTOR);
  fixture.store.transaction((tx) =>
    updateCleanup(
      tx,
      result.data.cleanup_id,
      CleanupState.Running,
      { removed: 1, removed_bytes: null, absent: 0, refused: [] },
      null,
    ),
  );
  const read = await fixture.footprint["cleanup.get"](
    { params: { cleanup_id: result.data.cleanup_id }, query: {}, body: null },
    { identity: HUMAN },
  );
  assert.equal(read.type, OperationResultType.Completed);
  assert.equal(read.data.outcome?.pending, PENDING_AFTER_ONE);
});

test("the task runs batches of 20 keys in key order and ends completed", async (t) => {
  const calls: DeleteCall[] = [];
  const fixture = footprintFixture(t, {
    deleters: { [CleanableKind.Trace]: recordingDeleter(calls) },
  });
  const keys = Array.from({ length: KEY_COUNT }, (_, index) => traceId(index));
  const { data } = await create(fixture, keys);
  await fixture.service.runCleanups();
  assert.deepEqual(
    calls.map((call) => call.keys.length),
    [FOOTPRINT_CLEANUP_BATCH_ROWS, FOOTPRINT_CLEANUP_BATCH_ROWS, 5],
  );
  assert.deepEqual(
    calls.flatMap((call) => call.keys),
    keys,
  );
  assert.ok(
    calls.every((call) => call.requested_by.account === HUMAN_ACTOR.account),
  );
  const stored = fixture.store.transaction((tx) =>
    cleanupOf(tx, data.cleanup_id),
  );
  assert.equal(stored?.state, CleanupState.Completed);
  assert.equal(stored?.outcome?.removed, KEY_COUNT);
});

test("a restart between two batches resumes at the stored outcome", async (t) => {
  const calls: DeleteCall[] = [];
  const fixture = footprintFixture(t, {
    deleters: { [CleanableKind.Trace]: recordingDeleter(calls) },
  });
  const keys = Array.from({ length: KEY_COUNT }, (_, index) => traceId(index));
  const { data } = await create(fixture, keys);
  fixture.store.transaction((tx) =>
    updateCleanup(
      tx,
      data.cleanup_id,
      CleanupState.Running,
      {
        removed: 15,
        removed_bytes: null,
        absent: 4,
        refused: [{ key: keys[19]!, reason: "live" }],
      },
      null,
    ),
  );
  await fixture.service.runCleanups();
  assert.equal(calls[0]?.keys[0], keys[FIRST_RESUME]);
  const stored = fixture.store.transaction((tx) =>
    cleanupOf(tx, data.cleanup_id),
  );
  assert.equal(stored?.state, CleanupState.Completed);
  assert.equal(
    (stored?.outcome?.removed ?? 0) +
      (stored?.outcome?.absent ?? 0) +
      (stored?.outcome?.refused.length ?? 0),
    KEY_COUNT,
  );
});

test("a server cleanup runs end to end through tracking.trace.delete and a repeat answers absent", async (t) => {
  const identity = testServiceIdentity(FOOTPRINT_SERVICE_NAME);
  const fixture = footprintFixture(t, {
    deleters: {
      [CleanableKind.Trace]: (call) =>
        ownerDeleter(
          fixture.invoke,
          identity,
          trackingOperations.traceDelete,
          "trace_ids",
        )(call),
    },
  });
  insertTrace(fixture.trackingStore, traceId(1), 1);
  insertTrace(fixture.trackingStore, traceId(2), 2);
  insertTrace(fixture.trackingStore, traceId(3), 3, "open");
  const first = await create(fixture, [traceId(1), traceId(2), traceId(3)]);
  await fixture.service.runCleanups();
  const done = fixture.store.transaction((tx) =>
    cleanupOf(tx, first.data.cleanup_id),
  );
  assert.equal(done?.state, CleanupState.Completed);
  assert.equal(done?.outcome?.removed, ENDED_TRACES);
  assert.deepEqual(done?.outcome?.refused, [
    { key: traceId(3), reason: "live" },
  ]);
  const second = await create(fixture, [traceId(1)]);
  await fixture.service.runCleanups();
  const repeat = fixture.store.transaction((tx) =>
    cleanupOf(tx, second.data.cleanup_id),
  );
  assert.equal(repeat?.outcome?.absent, REPEATED_TRACES);
});

test("the task calls the owner with the Footprint service identity and requested_by in the body", async () => {
  const seen: { body: unknown; options: ClientOptions }[] = [];
  const identity = testServiceIdentity(FOOTPRINT_SERVICE_NAME);
  const deleter = ownerDeleter(
    (_operation, input, options) => {
      seen.push({ body: (input as { body: unknown }).body, options });
      return Promise.resolve({
        type: OperationResultType.Completed,
        status: 200,
        data: { removed: 1, absent: 0, refused: [] },
      });
    },
    identity,
    trackingOperations.traceDelete,
    "trace_ids",
  );
  await deleter({
    cleanup_id: "cleanup_01JZ8R2B3C4D5E6F7G8H9J0K1M",
    instance_name: null,
    keys: [traceId(1)],
    requested_by: HUMAN_ACTOR,
  });
  assert.equal(seen[0]?.options.identity, identity);
  assert.deepEqual(seen[0]?.body, {
    trace_ids: [traceId(1)],
    requested_by: HUMAN_ACTOR,
  });
});

test("cancel accepts only a queued record", async (t) => {
  const fixture = footprintFixture(t);
  const { data } = await create(fixture, [traceId(1)]);
  const cancelled = await fixture.footprint["cleanup.cancel"](
    { params: { cleanup_id: data.cleanup_id }, query: {}, body: null },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(cancelled.type, OperationResultType.Completed);
  assert.equal(cancelled.data.state, CleanupState.Cancelled);
  const again = await fixture.footprint["cleanup.cancel"](
    { params: { cleanup_id: data.cleanup_id }, query: {}, body: null },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(again.type, OperationResultType.Failure);
  assert.equal(again.error.error.code, FootprintErrorCode.CleanupNotQueued);
});

test("create refuses a repeated key and a key of the wrong form", async (t) => {
  const fixture = footprintFixture(t);
  for (const keys of [[traceId(1), traceId(1)], ["not-a-trace"]]) {
    const result = await fixture.footprint["cleanup.create"](
      {
        params: {},
        query: {},
        body: {
          kind: CleanableKind.Trace,
          instance_name: null,
          rule: null,
          keys,
        },
      },
      { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
    );
    assert.equal(result.type, OperationResultType.Failure);
    assert.equal(result.error.error.code, FootprintErrorCode.ValidationFailed);
  }
});

test("create checks the host of the kind and the instance", async (t) => {
  const fixture = footprintFixture(t, {
    instances: { "e2e-coder-1": { archived: true } },
  });
  const cases = [
    {
      instance_name: "e2e-coder-1",
      kind: CleanableKind.Trace,
      keys: [traceId(1)],
      code: "footprint.kind.host_mismatch",
    },
    {
      instance_name: "absent-1",
      kind: CleanableKind.Session,
      keys: ["execution_01JZ8R2B3C4D5E6F7G8H9J0K1M"],
      code: "footprint.instance.not_found",
    },
    {
      instance_name: "e2e-coder-1",
      kind: CleanableKind.Session,
      keys: ["execution_01JZ8R2B3C4D5E6F7G8H9J0K1M"],
      code: "footprint.instance.archived",
    },
  ];
  for (const entry of cases) {
    const result = await fixture.footprint["cleanup.create"](
      {
        params: {},
        query: {},
        body: {
          kind: entry.kind,
          instance_name: entry.instance_name,
          rule: null,
          keys: entry.keys,
        },
      },
      { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
    );
    assert.equal(result.type, OperationResultType.Failure);
    assert.equal(result.error.error.code, entry.code);
  }
});

test("a cleanup of an instance kind with no owner delete ends failed", async (t) => {
  const fixture = footprintFixture(t, {
    instances: { "e2e-coder-1": { archived: false } },
  });
  const result = await fixture.footprint["cleanup.create"](
    {
      params: {},
      query: {},
      body: {
        kind: CleanableKind.Workspace,
        instance_name: "e2e-coder-1",
        rule: { name: CleanupRule.NodeClosed },
        keys: ["node_01JZ8R2B3C4D5E6F7G8H9J0K1M"],
      },
    },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(result.type, OperationResultType.Completed);
  await fixture.service.runCleanups();
  const stored = fixture.store.transaction((tx) =>
    cleanupOf(tx, result.data.cleanup_id),
  );
  assert.equal(stored?.state, CleanupState.Failed);
  assert.equal(stored?.outcome, null);
});

test("cleanup get and cancel answer footprint.cleanup.not_found for an unknown id", async (t) => {
  const fixture = footprintFixture(t);
  const params = { cleanup_id: "cleanup_01JZ8R2B3C4D5E6F7G8H9J0K1M" };
  const read = await fixture.footprint["cleanup.get"](
    { params, query: {}, body: null },
    { identity: HUMAN },
  );
  const cancel = await fixture.footprint["cleanup.cancel"](
    { params, query: {}, body: null },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  for (const result of [read, cancel]) {
    assert.equal(result.type, OperationResultType.Failure);
    assert.equal(result.error.error.code, FootprintErrorCode.CleanupNotFound);
  }
});
