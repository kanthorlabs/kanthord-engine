import assert from "node:assert/strict";
import { test } from "node:test";
import { background, CancellationContext } from "../../kernel/context.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import {
  EXECUTION_NOT_RUNNING,
  EXECUTION_PROOF_FAILED,
  ExecutionRun,
} from "./execution-run.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionStop,
} from "./execution-stop.ts";
import type { MethodClients } from "./method-clients.ts";
import { ProviderFailure } from "../../scheduler/contract.ts";
import { CodedError, Diagnostic, OperationError } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { AgentErrorCode, PromptSourceReason } from "../../agent/contract.ts";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
  unattributed,
} from "../../kernel/cause.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { GIT_COMMIT_FAILED } from "./stop-codes.ts";
import { RepositoryErrorCode } from "../../repository/contract.ts";
import { GitStage, GitWriteError } from "../../repository/connector.ts";
import { stopAfter } from "../../kernel/stop-test-support.ts";

const SETTLE_CALL_COUNT = 1;
const CALLS = 2;
const NO_CALLS = 0;
const VALUE = "value";
const ERROR = "test.operation.failed";
const CLAIM = {
  execution_id: "execution",
  node_id: "node",
  attempt: 1,
  pinned_revision: 2,
  node_branch: `kanthord/${"node"}`,
  created_at: Date.now(),
  expired_at: Date.now() + 60000,
  trace_id: "trace",
  root_span_id: "1".repeat(16),
};
const RUN_SECRET = "short-run-secret";
function fixture(
  release = async () => {},
  secrets: () => Promise<readonly string[]> = async () => [RUN_SECRET],
  environmentDigests: Readonly<Record<string, string>> = {},
) {
  return new ExecutionRun({
    claim: CLAIM,
    clients: {} as MethodClients,
    credentials: { release },
    context: background,
    secrets,
    environmentDigests,
  });
}

test("execution calls return data with fresh canonical keys and settle credentials once", async (t) => {
  let reports = 0;
  const run = fixture(async () => {
    reports++;
  });
  stopAfter(t, () => run.dispose());
  const keys = new Set<string>();
  for (let i = 0; i < CALLS; i++) {
    const value = await run.call(async (options) => {
      assert.match(
        options.idempotencyKey!,
        /^idempotency_key_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
      );
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
  stopAfter(t, () => run.dispose());
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
    dependency_outcome_ids: [],
    result: "undetermined",
    rationale: "unknown",
    tested_input: { kind: "produced", sha256: "a".repeat(64) },
  });
  assert.deepEqual(order, ["credential", "assessment"]);
});

test("lost release answers reconcile only a finished claim", async (t) => {
  for (const claimState of ["finished", "running"] as const) {
    const run = fixture();
    stopAfter(t, () => run.dispose());
    const calls: string[] = [];
    run.clients.scheduler = {
      executionRelease: async (input: { body: unknown }) => {
        assert.deepEqual(input.body, { further_work: false, stop: null });
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
  stopAfter(t, () => run.dispose());
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
  const sent = {
    ...stop,
    cause: unattributed([CauseCategory.Model, CauseCategory.Prompt]),
  };
  for (const recorded of [sent, null]) {
    let reports = 0;
    const run = fixture(async () => {
      reports++;
    });
    stopAfter(t, () => run.dispose());
    const stopped = await run.stopOf(new ExecutionStop(stop.reason, stop.code));
    assert.ok(run.operationContext.signal.aborted);
    run.clients.scheduler = {
      executionRelease: async (
        input: { body: unknown },
        options: { context: { signal: AbortSignal } },
      ) => {
        assert.deepEqual(input.body, { further_work: true, stop: sent });
        assert.equal(options.context.signal.aborted, false);
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
        ? { kind: "released", furtherWork: true, stop: sent }
        : { kind: "ended", ...stop },
    );
    assert.equal(reports, SETTLE_CALL_COUNT);
  }
});

test("a stop of an uncoded error carries its cause with the run secrets removed", async (t) => {
  const run = fixture();
  stopAfter(t, () => run.dispose());
  const stopped = await run.stopOf(
    new Error(`hook refused with ${RUN_SECRET}`),
  );
  assert.deepEqual(
    {
      reason: stopped.reason,
      code: stopped.code,
      detail: stopped.detail,
    },
    {
      reason: EndReason.OperationFailed,
      code: null,
      detail: "Error: hook refused with [redacted]",
    },
  );
});

test("a stop of an uncoded error halts and releases with no detail when the secrets read fails", async (t) => {
  const run = fixture(undefined, async () => {
    throw new Error("store unreadable");
  });
  stopAfter(t, () => run.dispose());
  assert.equal(await run.reasonOf(new Error("hook refused")), null);
  const stopped = await run.stopOf(new Error("hook refused"));
  assert.ok(run.operationContext.signal.aborted);
  const stop = {
    reason: EndReason.OperationFailed,
    code: null,
    cause: unattributed([
      CauseCategory.Infrastructure,
      CauseCategory.WorkerAction,
    ]),
  };
  assert.deepEqual(
    { reason: stopped.reason, code: stopped.code, detail: stopped.detail },
    { reason: stop.reason, code: stop.code, detail: null },
  );
  const bodies: unknown[] = [];
  run.clients.scheduler = {
    executionRelease: async (input: { body: unknown }) => {
      bodies.push(input.body);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { execution_id: "execution", ended_at: 1 },
      };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await run.releaseStop(stopped), {
    kind: "released",
    furtherWork: true,
    stop,
  });
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
});

test("a stop release sends the cause detail of a provider failure", async (t) => {
  const run = fixture();
  stopAfter(t, () => run.dispose());
  const stop = {
    reason: EndReason.ProviderFailed,
    code: ProviderFailure.Unavailable,
    detail: "OAuth auth derivation failed for anthropic",
    cause: attributed(CauseCategory.LlmProvider, CauseSubcategory.Unavailable),
  };
  const stopped = await run.stopOf(
    new ExecutionStop(stop.reason, stop.code, { detail: stop.detail }),
  );
  const bodies: unknown[] = [];
  run.clients.scheduler = {
    executionRelease: async (input: { body: unknown }) => {
      bodies.push(input.body);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { execution_id: "execution", ended_at: 1 },
      };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await run.releaseStop(stopped), {
    kind: "released",
    furtherWork: true,
    stop,
  });
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
});

test("a stop release that the scheduler refuses as ended ends the run as revoked", async (t) => {
  for (const [status, code] of [
    [409, EXECUTION_NOT_RUNNING],
    [403, EXECUTION_PROOF_FAILED],
  ] as const) {
    const run = fixture();
    stopAfter(t, () => run.dispose());
    const stopped = await run.stopOf(
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

test("a stop release whose credential report the server refuses as ended ends the run as revoked", async (t) => {
  for (const [status, code] of [
    [403, EXECUTION_PROOF_FAILED],
    [409, EXECUTION_NOT_RUNNING],
  ] as const) {
    const run = fixture(async () => {
      throw new CodedError(code, `Refused with ${status}`);
    });
    stopAfter(t, () => run.dispose());
    let releases = 0;
    run.clients.scheduler = {
      executionRelease: async () => {
        releases++;
      },
    } as unknown as MethodClients["scheduler"];
    const stopped = await run.stopOf(
      new ExecutionStop(EndReason.OperationFailed, null),
    );
    assert.deepEqual(await run.releaseStop(stopped), {
      kind: "ended",
      reason: EndReason.Revoked,
      code,
    });
    assert.equal(releases, NO_CALLS);
  }
});

test("a lost release answer with a claim read that the server refuses as ended ends the run as revoked", async (t) => {
  const run = fixture();
  stopAfter(t, () => run.dispose());
  const stopped = await run.stopOf(
    new ExecutionStop(EndReason.OperationFailed, null),
  );
  run.clients.scheduler = {
    executionRelease: async () => ({
      type: OperationResultType.Indeterminate,
    }),
    claimGet: async () => ({
      type: OperationResultType.Failure,
      status: 403,
      error: {
        error: {
          code: EXECUTION_PROOF_FAILED,
          message: "Ended",
          details: null,
        },
        request_id: "test",
      },
    }),
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await run.releaseStop(stopped), {
    kind: "ended",
    reason: EndReason.Revoked,
    code: EXECUTION_PROOF_FAILED,
  });
});

function claimAnswer(state: string): () => Promise<OperationResult<unknown>> {
  return async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: { claim_state: state },
  });
}

function fencedRun(answer: () => Promise<OperationResult<unknown>>) {
  const run = fixture();
  run.clients.scheduler = {
    claimGet: answer,
  } as unknown as MethodClients["scheduler"];
  return run;
}

test("the fence lets the push continue on a running claim, another answer and a thrown error", async (t) => {
  for (const answer of [
    claimAnswer("running"),
    async () => {
      throw new Error("network down");
    },
    async (): Promise<OperationResult<unknown>> => ({
      type: OperationResultType.Failure,
      status: 500,
      error: {
        request_id: "test",
        error: { code: ERROR, message: "down", details: null },
      },
    }),
    async (): Promise<OperationResult<unknown>> => ({
      type: OperationResultType.Indeterminate,
    }),
  ]) {
    const run = fencedRun(answer);
    stopAfter(t, () => run.dispose());
    assert.equal(await run.fence(run.operationContext), true);
    assert.equal(run.operationContext.signal.aborted, false);
  }
});

test("the fence revokes the run on a claim that is not running and on an execution-end answer", async (t) => {
  for (const answer of [
    claimAnswer("finished"),
    async (): Promise<OperationResult<unknown>> => ({
      type: OperationResultType.Failure,
      status: 409,
      error: {
        request_id: "test",
        error: { code: EXECUTION_NOT_RUNNING, message: "ended", details: null },
      },
    }),
    async (): Promise<OperationResult<unknown>> => ({
      type: OperationResultType.Failure,
      status: 403,
      error: {
        request_id: "test",
        error: {
          code: EXECUTION_PROOF_FAILED,
          message: "ended",
          details: null,
        },
      },
    }),
  ]) {
    const run = fencedRun(answer);
    stopAfter(t, () => run.dispose());
    assert.equal(await run.fence(run.operationContext), false);
    const stopped = await run.stopOf(new Error("later"));
    assert.equal(stopped.reason, EndReason.Revoked);
    assert.equal(run.operationContext.signal.aborted, true);
  }
});

test("the fence of a revoked run answers false and reads no claim", async (t) => {
  let reads = 0;
  const run = fencedRun(async () => {
    reads++;
    return claimAnswer("running")();
  });
  stopAfter(t, () => run.dispose());
  run.revoke();
  assert.equal(await run.fence(run.cleanupContext()), false);
  assert.equal(reads, NO_CALLS);
});

function lateRevocation(revocation: CancellationContext): void {
  revocation.cancel(
    new ExecutionStop(EndReason.Revoked, EXECUTION_PROOF_FAILED),
  );
}

test("regression: C3 B1 a late execution-end answer of the proof hook during a final call keeps the end of the final call", async (t) => {
  const revocation = new CancellationContext();
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {
      scheduler: {
        executionRelease: async () => {
          lateRevocation(revocation);
          return {
            type: OperationResultType.Completed,
            status: 200,
            data: { execution_id: CLAIM.execution_id, ended_at: Date.now() },
          };
        },
      },
      mission: {
        "assessment.submit": async () => {
          lateRevocation(revocation);
          return {
            type: OperationResultType.Completed,
            status: 200,
            data: { outcome: { id: "outcome" } },
          };
        },
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    revocation,
  });
  stopAfter(t, () => run.dispose());
  assert.deepEqual(await run.submitAssessment(CLAIM.node_id, {} as never), {
    outcome: { id: "outcome" },
  });
  assert.deepEqual(await run.release(false), {
    kind: ExecutionEndKind.Released,
    furtherWork: false,
  });
  assert.equal(run.operationContext.signal.aborted, false);
});

test("the fence after a stop reads the claim with the cleanup context and keeps the stored stop", async (t) => {
  const contexts: AbortSignal[] = [];
  const run = fencedRun(claimAnswer("finished"));
  run.clients.scheduler = {
    claimGet: async (
      _input: unknown,
      options: { context: { signal: AbortSignal } },
    ) => {
      contexts.push(options.context.signal);
      return claimAnswer("finished")();
    },
  } as unknown as MethodClients["scheduler"];
  stopAfter(t, () => run.dispose());
  const stored = await run.stopOf(
    new ExecutionStop(EndReason.OperationFailed, ERROR),
  );
  const cleanup = run.cleanupContext();
  assert.equal(await run.fence(cleanup), false);
  assert.deepEqual(contexts, [cleanup.signal]);
  assert.equal(contexts[0]!.aborted, false);
  assert.equal(await run.stopOf(new Error("later")), stored);
  assert.equal(stored.reason, EndReason.OperationFailed);
});

test("an execution-end answer of the revocation context revokes the run with its code", async (t) => {
  const revocation = new CancellationContext();
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    revocation,
  });
  stopAfter(t, () => run.dispose());
  revocation.cancel(
    new ExecutionStop(EndReason.Revoked, EXECUTION_PROOF_FAILED),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.operationContext.signal.aborted, true);
  const stopped = await run.stopOf(new Error("later"));
  assert.equal(stopped.reason, EndReason.Revoked);
  assert.equal(stopped.code, EXECUTION_PROOF_FAILED);
});

const DIGESTS = { "github:acme/engine": "d".repeat(64) };

async function releasedStop(run: ExecutionRun, stop: unknown) {
  const stopped = await run.stopOf(stop);
  const bodies: { stop: { detail?: string; cause?: unknown } }[] = [];
  run.clients.scheduler = {
    executionRelease: async (input: { body: (typeof bodies)[number] }) => {
      bodies.push(input.body);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { execution_id: "execution", ended_at: 1 },
      };
    },
  } as unknown as MethodClients["scheduler"];
  await run.releaseStop(stopped);
  return bodies[0]!.stop;
}

test("an environment failure stop detail holds the digests of the environments of the setup", async (t) => {
  const run = fixture(async () => {}, undefined, DIGESTS);
  stopAfter(t, () => run.dispose());
  const stop = await releasedStop(
    run,
    new ExecutionStop(EndReason.EnvironmentFailed, "setup_failed", {
      detail: JSON.stringify({ exit_code: 3, command: "exit 3" }),
    }),
  );
  assert.deepEqual(JSON.parse(stop.detail!), {
    exit_code: 3,
    command: "exit 3",
    digests: DIGESTS,
  });
});

function capture(run: ExecutionRun) {
  const bodies: { stop: Record<string, unknown> | null }[] = [];
  run.clients.scheduler = {
    executionRelease: async (input: { body: (typeof bodies)[number] }) => {
      bodies.push(input.body);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { execution_id: "execution", ended_at: 1 },
      };
    },
  } as unknown as MethodClients["scheduler"];
  return bodies;
}

test("a budget-end release sends the cause with the timeout of the last noted verification", async (t) => {
  const run = fixture();
  stopAfter(t, () => run.dispose());
  const bodies = capture(run);
  await run.release(true, BudgetLimit.Turns);
  run.noteVerification(true);
  await run.release(true, BudgetLimit.Turns);
  assert.deepEqual(
    bodies.map((body) => body.stop?.cause),
    [
      unattributed([CauseCategory.Plan, CauseCategory.Model]),
      unattributed([
        CauseCategory.Environment,
        CauseCategory.Plan,
        CauseCategory.Model,
      ]),
    ],
  );
});

test("a git commit failure sends the redacted git stderr and its suspects", async (t) => {
  const run = fixture();
  stopAfter(t, () => run.dispose());
  const stop = await releasedStop(
    run,
    new CodedError(GIT_COMMIT_FAILED, "commit failed", {
      cause: new Error(`hook rejected ${RUN_SECRET}`),
    }),
  );
  assert.deepEqual(stop, {
    reason: EndReason.OperationFailed,
    code: GIT_COMMIT_FAILED,
    detail: "Error: hook rejected [redacted]",
    cause: unattributed([
      CauseCategory.WorkerAction,
      CauseCategory.Environment,
    ]),
  });
});

test("regression: K112 a git_failed stop carries the redacted git cause in its detail", async (t) => {
  const run = fixture();
  stopAfter(t, () => run.dispose());
  const stop = await releasedStop(
    run,
    new GitWriteError(
      GitStage.Push,
      new Diagnostic(RepositoryErrorCode.GitFailed, "push: git failed.", {
        cause: new Error(`push: rejected ${RUN_SECRET}`),
      }),
    ),
  );
  assert.deepEqual(stop, {
    reason: EndReason.OperationFailed,
    code: RepositoryErrorCode.GitFailed,
    detail: "Error: push: rejected [redacted]",
    cause: unattributed([]),
  });
});

test("a source_invalid operation failure gives its details reason as the stop detail and the cause of that reason", async (t) => {
  for (const [reason, cause] of [
    [
      PromptSourceReason.Changed,
      attributed(CauseCategory.Infrastructure, CauseSubcategory.PromptRecord),
    ],
    [
      PromptSourceReason.ControlCharacter,
      attributed(CauseCategory.Prompt, CauseSubcategory.SourceInvalid),
    ],
  ] as const) {
    const coded = fixture();
    stopAfter(t, () => coded.dispose());
    assert.deepEqual(
      await releasedStop(
        coded,
        new OperationError(
          HttpStatus.Conflict,
          AgentErrorCode.PromptSourceInvalid,
          "Prompt source is invalid.",
          { part: "role", reason },
        ),
      ),
      {
        reason: EndReason.OperationFailed,
        code: AgentErrorCode.PromptSourceInvalid,
        detail: reason,
        cause,
      },
    );
    const called = fixture();
    stopAfter(t, () => called.dispose());
    await assert.rejects(
      called.call(async () => ({
        type: OperationResultType.Failure,
        status: HttpStatus.Conflict,
        error: {
          error: {
            code: AgentErrorCode.PromptSourceInvalid,
            message: "invalid",
            details: { part: "role", reason },
          },
          request_id: "test",
        },
      })),
      (error) =>
        error instanceof ExecutionStop &&
        error.detail === reason &&
        JSON.stringify(error.cause) === JSON.stringify(cause),
    );
  }
});

test("a stop context stops the run with the requested stop and a later cancel of the parent changes nothing", async (t) => {
  const parent = new CancellationContext();
  const stops = new CancellationContext();
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: parent,
    stop: stops,
  });
  stopAfter(t, () => run.dispose());
  const requested = new ExecutionStop(EndReason.WorkerStopped, null);
  stops.cancel(requested);
  const stopped = await run
    .call(async () => assert.fail("A stopped run calls no server."))
    .catch((error: unknown) => error);
  assert.ok(stopped instanceof ExecutionStop);
  assert.equal(stopped.reason, EndReason.WorkerStopped);
  assert.equal(stopped.code, null);
  parent.cancel();
  assert.equal(await run.stopOf(new Error("later")), stopped);
  assert.equal(
    await run.stopOf(new ExecutionStop(EndReason.OperationFailed, null)),
    stopped,
  );
  assert.equal(run.cleanupContext().signal.aborted, true);
});

test("a stop context leaves the cleanup context of the run open", async (t) => {
  const stops = new CancellationContext();
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    stop: stops,
  });
  stopAfter(t, () => run.dispose());
  stops.cancel(new ExecutionStop(EndReason.WorkerStopped, null));
  assert.equal(run.operationContext.signal.aborted, true);
  const cleanup = run.cleanupContext();
  stopAfter(t, () => cleanup.cancel());
  assert.equal(cleanup.signal.aborted, false);
});
