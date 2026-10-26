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
  releaseStopSchema,
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
    row.runtime_identity.slice("worker_registration_".length),
    row.runtime_identity.replace("worker_registration", "runtime_identity"),
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
    agent_pins: agentPins,
    ...row
  } = executionFixture();
  assert.deepEqual(agentPins, []);
  const record = {
    ...row,
    agent_selections: [],
    node_branch: `kanthord/${row.node_id}`,
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

test("a release stop carries an optional cause detail of at most 2048 characters", () => {
  const stop = { reason: "provider_failed", code: "unavailable" };
  const parse = (detail: unknown) =>
    releaseStopSchema.safeParse({ ...stop, detail });
  assert.deepEqual(releaseStopSchema.parse(stop), stop);
  assert.deepEqual(parse("Cannot find module").data, {
    ...stop,
    detail: "Cannot find module",
  });
  assert.equal(parse("x".repeat(2048)).success, true);
  assert.equal(parse("x".repeat(2049)).success, false);
  assert.equal(parse("").success, false);
  assert.equal(parse(null).success, false);
});

test("a release stop accepts a valid cause and refuses an invalid cause", () => {
  const stop = { reason: "provider_failed", code: "unavailable" };
  const cause = {
    category: "llm_provider",
    assigner: "rule",
    subcategory: "unavailable",
  };
  assert.deepEqual(releaseStopSchema.parse({ ...stop, cause }), {
    ...stop,
    cause,
  });
  for (const invalid of [
    { ...cause, subcategory: "network" },
    { ...cause, assigner: "human" },
    { category: "unattributed", assigner: "rule" },
  ])
    assert.equal(
      releaseStopSchema.safeParse({ ...stop, cause: invalid }).success,
      false,
    );
});

test("a release stop code fits its reason", () => {
  const fits = (reason: string, code: string | null) =>
    releaseStopSchema.safeParse({ reason, code }).success;
  assert.equal(fits("provider_failed", "quota_exhausted"), true);
  assert.equal(fits("provider_failed", null), false);
  assert.equal(fits("provider_failed", "turns"), false);
  assert.equal(fits("no_progress", null), true);
  assert.equal(fits("no_progress", "rate_limited"), false);
  assert.equal(fits("operation_failed", "rate_limited"), false);
  assert.equal(fits("operation_failed", "gateway.request.invalid"), true);
  assert.equal(fits("budget_end", "turns"), true);
  assert.equal(fits("budget_end", null), false);
  assert.equal(fits("environment_failed", "setup_failed"), true);
  assert.equal(fits("environment_failed", "command_absent"), true);
  assert.equal(fits("environment_failed", "affected_invalid"), true);
  assert.equal(fits("environment_failed", "affected_timeout"), true);
  assert.equal(fits("environment_failed", null), false);
  assert.equal(fits("environment_failed", "turns"), false);
  assert.equal(fits("operation_failed", "setup_failed"), false);
  assert.equal(fits("operation_failed", "affected_invalid"), false);
  assert.equal(fits("operation_failed", "affected_timeout"), false);
});
