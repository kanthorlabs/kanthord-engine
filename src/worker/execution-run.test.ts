import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../kernel/operation.ts";
import {
  EndReason,
  ExecutionRun,
  ExecutionStop,
  EXECUTION_NOT_RUNNING,
  EXECUTION_PROOF_FAILED,
} from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";

const ONE = 1;
const CALLS = 2;
const VALUE = "value";
const ERROR = "test.operation.failed";
const CLAIM = {
  executionId: "execution",
  nodeId: "node",
  attempt: 1,
  pinnedRevision: 2,
  createdAt: Date.now(),
  expiredAt: Date.now() + 60000,
  traceId: "trace",
};
function fixture(release = async () => {}) {
  return new ExecutionRun({
    claim: CLAIM,
    clients: {} as MethodClients,
    credentials: { release },
    context: background,
  });
}

test("execution calls return data with fresh canonical keys and settle credentials once", async (t) => {
  let reports = 0;
  const run = fixture(async () => {
    reports++;
  });
  t.after(() => run.dispose());
  const keys = new Set<string>();
  for (let i = 0; i < CALLS; i++) {
    const value = await run.call(async (options) => {
      assert.match(options.idempotencyKey!, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.ok(!keys.has(options.idempotencyKey!));
      keys.add(options.idempotencyKey!);
      return { type: OperationResultType.Completed, status: 200, data: VALUE };
    });
    assert.equal(value, VALUE);
  }
  await Promise.all([run.settleCredentials(), run.settleCredentials()]);
  assert.equal(reports, ONE);
  assert.deepEqual(run.context(), {
    executionId: CLAIM.executionId,
    attempt: CLAIM.attempt,
    nodeRevision: CLAIM.pinnedRevision,
  });
});

test("proof refusals and failed calls stop once and prevent every later invocation", async () => {
  const cases: [OperationResult<unknown>, EndReason, string | null][] = [
    [
      {
        type: OperationResultType.Failure,
        status: 403,
        error: {
          error: {
            code: EXECUTION_PROOF_FAILED,
            message: "ended",
            details: null,
          },
          requestId: "test",
        },
      },
      EndReason.Revoked,
      EXECUTION_PROOF_FAILED,
    ],
    [
      {
        type: OperationResultType.Failure,
        status: 409,
        error: {
          error: {
            code: EXECUTION_NOT_RUNNING,
            message: "ended",
            details: null,
          },
          requestId: "test",
        },
      },
      EndReason.Revoked,
      EXECUTION_NOT_RUNNING,
    ],
    [
      {
        type: OperationResultType.Failure,
        status: 500,
        error: {
          error: { code: ERROR, message: "failed", details: null },
          requestId: "test",
        },
      },
      EndReason.OperationFailed,
      ERROR,
    ],
    [
      { type: OperationResultType.Indeterminate },
      EndReason.OperationFailed,
      null,
    ],
  ];
  for (const [result, reason, code] of cases) {
    const run = fixture();
    let calls = 0;
    let stops = 0;
    run.onStop(() => {
      stops++;
    });
    const invoke = async () => {
      calls++;
      return result;
    };
    const expected = (error: unknown) =>
      error instanceof ExecutionStop &&
      error.reason === reason &&
      error.code === code;
    await assert.rejects(run.call(invoke), expected);
    await assert.rejects(run.call(invoke), expected);
    assert.equal(calls, ONE);
    assert.equal(stops, ONE);
    run.dispose();
  }
});

test("credential report rejection ends the execution without a second report", async () => {
  let reports = 0;
  const run = fixture(async () => {
    reports++;
    throw new Error("report failed");
  });
  await assert.rejects(run.settleCredentials(), ExecutionStop);
  await assert.rejects(run.settleCredentials(), ExecutionStop);
  assert.equal(reports, ONE);
});
