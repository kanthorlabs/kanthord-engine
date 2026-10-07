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
      params: { project_id: row.project_id },
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
    resource_identity: row.resource_identity,
    runtime_identity: row.runtime_identity,
  };
  assert.ok(workPullSchema.safeParse(pull).success);
  assert.ok(!workPullSchema.safeParse({ ...pull, extra: true }).success);
  for (const runtimeIdentity of [
    row.runtime_identity.slice("worker_instance_".length),
    row.runtime_identity.replace("worker_instance", "runtime_identity"),
    row.runtime_identity.toLowerCase(),
  ])
    assert.ok(
      !workPullSchema.safeParse({ ...pull, runtime_identity: runtimeIdentity })
        .success,
    );
  assert.ok(executionReleaseSchema.safeParse({ further_work: true }).success);
  assert.ok(
    !executionReleaseSchema.safeParse({ further_work: true, extra: true })
      .success,
  );
});

test("Execution records omit hosted attribution and refuse null or unknown fields", () => {
  const {
    worker_binding_id: workerBindingId,
    resource_identity: resourceIdentity,
    runtime_identity: runtimeIdentity,
    ...row
  } = executionFixture();
  const record = {
    ...row,
    claimant: {
      worker_binding_id: workerBindingId,
      resource_identity: resourceIdentity,
      runtime_identity: runtimeIdentity,
    },
    claim_state: ClaimState.Running,
  };
  assert.ok(executionRecordSchema.safeParse(record).success);
  assert.ok(
    !executionRecordSchema.safeParse({
      ...record,
      claimant: { ...record.claimant, client_id: null },
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
