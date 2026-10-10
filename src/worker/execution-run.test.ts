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

const SETTLE_CALL_COUNT = 1;
const CALLS = 2;
const VALUE = "value";
const ERROR = "test.operation.failed";
const CLAIM = {
  execution_id: "execution",
  node_id: "node",
  attempt: 1,
  pinned_revision: 2,
  created_at: Date.now(),
  expired_at: Date.now() + 60000,
  trace_id: "trace",
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
  assert.equal(reports, SETTLE_CALL_COUNT);
  assert.deepEqual(run.context(), {
    execution_id: CLAIM.execution_id,
    attempt: CLAIM.attempt,
    node_revision: CLAIM.pinned_revision,
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
          request_id: "test",
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
          request_id: "test",
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
          request_id: "test",
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
    assert.equal(calls, SETTLE_CALL_COUNT);
    assert.equal(stops, SETTLE_CALL_COUNT);
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
  assert.equal(reports, SETTLE_CALL_COUNT);
});

test("submissions pin claim fields and settle credentials before an assessment", async (t) => {
  const order: string[] = [];
  const run = fixture(async () => {
    order.push("credential");
  });
  t.after(() => run.dispose());
  const evidence = { id: "evidence" };
  run.clients.mission = {
    "evidence.submit": async (input: { body: unknown }) => {
      assert.deepEqual(input.body, {
        subject: "head",
        assets: [],
        ...run.context(),
      });
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { evidence },
      };
    },
    "assessment.submit": async () => {
      order.push("assessment");
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { outcome: null },
      };
    },
  } as unknown as MethodClients["mission"];
  assert.equal(
    await run.submitEvidence(CLAIM.node_id, {
      subject: "head",
      assets: [],
      ...{ execution_id: "foreign", attempt: 99, node_revision: 99 },
    }),
    evidence,
  );
  await run.submitAssessment(CLAIM.node_id, {
    evidence_ids: [],
    child_outcome_ids: [],
    result: "undetermined",
    rationale: "unknown",
    tested_input: { kind: "produced", sha256: "a".repeat(64) },
  });
  assert.deepEqual(order, ["credential", "assessment"]);
});

test("lost release answers reconcile only a finished claim", async (t) => {
  for (const claimState of ["finished", "running"] as const) {
    const run = fixture();
    t.after(() => run.dispose());
    const calls: string[] = [];
    run.clients.scheduler = {
      executionRelease: async (input: { body: unknown }) => {
        assert.deepEqual(input.body, { further_work: false, progress: true });
        calls.push("release");
        return { type: OperationResultType.Indeterminate };
      },
      claimGet: async () => {
        calls.push("read");
        return {
          type: OperationResultType.Completed,
          status: 200,
          data: { claim_state: claimState, ended_at: Date.now() },
        };
      },
    } as unknown as MethodClients["scheduler"];
    const FINISHED = "finished";
    if (claimState === FINISHED)
      assert.deepEqual(await run.release(false), {
        kind: "released",
        furtherWork: false,
      });
    else await assert.rejects(run.release(false), ExecutionStop);
    assert.deepEqual(calls, ["release", "read"]);
  }
});

test("release refusal preserves the owning error code", async (t) => {
  const code = "mission.release.obligation_unmet";
  const run = fixture();
  t.after(() => run.dispose());
  run.clients.scheduler = {
    executionRelease: async () => ({
      type: OperationResultType.Failure,
      status: 409,
      error: {
        error: { code, message: "unmet", details: null },
        request_id: "test",
      },
    }),
  } as unknown as MethodClients["scheduler"];
  await assert.rejects(
    run.release(false),
    (error: unknown) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.OperationFailed &&
      error.code === code,
  );
});

test("a stop release settles credentials under a fresh context and reconciles a lost answer only with a stopped claim", async (t) => {
  const stop = { reason: EndReason.JudgementInvalid, code: null };
  for (const recorded of [stop, null]) {
    let reports = 0;
    const run = fixture(async () => {
      reports++;
    });
    t.after(() => run.dispose());
    const stopped = run.stopOf(new ExecutionStop(stop.reason, stop.code));
    assert.ok(run.operationContext.err());
    run.clients.scheduler = {
      executionRelease: async (
        input: { body: unknown },
        options: { context: { err(): unknown } },
      ) => {
        assert.deepEqual(input.body, { further_work: true, stop });
        assert.equal(options.context.err(), null);
        return { type: OperationResultType.Indeterminate };
      },
      claimGet: async () => ({
        type: OperationResultType.Completed,
        status: 200,
        data: { claim_state: "finished", stop: recorded },
      }),
    } as unknown as MethodClients["scheduler"];
    assert.deepEqual(
      await run.releaseStop(stopped),
      recorded
        ? { kind: "released", furtherWork: true, stop }
        : { kind: "ended", ...stop },
    );
    assert.equal(reports, SETTLE_CALL_COUNT);
  }
});

test("a stop release that the scheduler refuses as ended ends the run as revoked", async (t) => {
  for (const [status, code] of [
    [409, EXECUTION_NOT_RUNNING],
    [403, EXECUTION_PROOF_FAILED],
  ] as const) {
    const run = fixture();
    t.after(() => run.dispose());
    const stopped = run.stopOf(
      new ExecutionStop(EndReason.JudgementInvalid, null),
    );
    run.clients.scheduler = {
      executionRelease: async () => ({
        type: OperationResultType.Failure,
        status,
        error: {
          error: { code, message: "Ended", details: null },
          request_id: "test",
        },
      }),
    } as unknown as MethodClients["scheduler"];
    assert.deepEqual(await run.releaseStop(stopped), {
      kind: "ended",
      reason: EndReason.Revoked,
      code,
    });
  }
});
