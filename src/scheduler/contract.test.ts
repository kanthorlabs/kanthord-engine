import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClaimState,
  executionRecordSchema,
  workPullSchema,
  executionReleaseSchema,
  schedulerOperations,
  traceIdSchema,
  spanIdSchema,
} from "./contract.ts";
import {
  executionFixture,
  FIXTURE_TRACE_ID,
  FIXTURE_SPAN_ID,
} from "./test-support.ts";

test("Scheduler inputs are closed and runtime identities are canonical", () => {
  const row = executionFixture();
  for (const operation of [
    schedulerOperations.queueList,
    schedulerOperations.queuePeek,
  ]) {
    const input = {
      params: { projectId: row.projectId },
      query: {},
      body: null,
    };
    assert.ok(operation.input.safeParse(input).success);
    assert.ok(!operation.input.safeParse({ ...input, extra: true }).success);
    assert.ok(
      !operation.input.safeParse({ ...input, query: { extra: true } }).success,
    );
  }
  const pull = {
    resourceIdentity: row.resourceIdentity,
    runtimeIdentity: row.runtimeIdentity,
  };
  assert.ok(workPullSchema.safeParse(pull).success);
  assert.ok(!workPullSchema.safeParse({ ...pull, extra: true }).success);
  for (const runtimeIdentity of [
    row.runtimeIdentity.slice("worker_instance_".length),
    row.runtimeIdentity.replace("worker_instance", "runtime_identity"),
    row.runtimeIdentity.toLowerCase(),
  ])
    assert.ok(!workPullSchema.safeParse({ ...pull, runtimeIdentity }).success);
  assert.ok(executionReleaseSchema.safeParse({ furtherWork: true }).success);
  assert.ok(
    !executionReleaseSchema.safeParse({ furtherWork: true, extra: true })
      .success,
  );
});

test("Execution records omit hosted attribution and refuse null or unknown fields", () => {
  const { workerBindingId, resourceIdentity, runtimeIdentity, ...row } =
    executionFixture();
  const record = {
    ...row,
    claimant: { workerBindingId, resourceIdentity, runtimeIdentity },
    claimState: ClaimState.Running,
  };
  assert.ok(executionRecordSchema.safeParse(record).success);
  assert.ok(
    !executionRecordSchema.safeParse({
      ...record,
      claimant: { ...record.claimant, clientId: null },
    }).success,
  );
  assert.ok(
    !executionRecordSchema.safeParse({
      ...record,
      claimant: { ...record.claimant, name: " " },
    }).success,
  );
  assert.ok(
    !executionRecordSchema.safeParse({ ...record, claimKind: "steps" }).success,
  );
  assert.ok(
    !executionRecordSchema.safeParse({ ...record, attempt: 0 }).success,
  );
});

test("Trace protocol identities refuse all-zero, uppercase and wrong lengths", () => {
  for (const [schema, valid] of [
    [traceIdSchema, FIXTURE_TRACE_ID],
    [spanIdSchema, FIXTURE_SPAN_ID],
  ] as const) {
    assert.ok(schema.safeParse(valid).success);
    for (const invalid of [
      "0".repeat(valid.length),
      valid.toUpperCase(),
      valid.slice(1),
    ])
      assert.ok(!schema.safeParse(invalid).success);
  }
});
