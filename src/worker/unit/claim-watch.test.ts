import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../../kernel/context.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { stopAfter } from "../../kernel/stop-test-support.ts";
import { CLAIM_WATCH_INTERVAL_MS, ClaimWatch } from "./claim-watch.ts";
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

const NO_READS = 0;
const ONE_READ = 1;
const TWO_READS = 2;
const JUST_BEFORE_MS = CLAIM_WATCH_INTERVAL_MS - 1;
const LATE_FIRES_MS = CLAIM_WATCH_INTERVAL_MS * 3;
const CLAIM = {
  execution_id: "execution",
  node_id: "node",
  attempt: 1,
  pinned_revision: 1,
  node_branch: "kanthord/node",
  created_at: Date.now(),
  expired_at: Date.now() + 3600000,
  trace_id: "trace",
  root_span_id: "1".repeat(16),
};

type Answer = () => Promise<OperationResult<unknown>>;

const completed = (data: unknown): OperationResult<unknown> => ({
  type: OperationResultType.Completed,
  status: 200,
  data,
});

const claimState =
  (state: string): Answer =>
  async () =>
    completed({ claim_state: state, ended_at: Date.now(), stop: null });

const executionEnd =
  (status: number, code: string): Answer =>
  async () => ({
    type: OperationResultType.Failure,
    status,
    error: {
      request_id: "test",
      error: { code, message: "ended", details: null },
    },
  });

interface Watched {
  run: ExecutionRun;
  watch: ClaimWatch;
  reads: () => number;
}

function watched(t: TestContext, answers: Answer[]): Watched {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {
      scheduler: {
        claimGet: () => {
          reads++;
          return (answers.shift() ?? claimState("running"))();
        },
        executionRelease: async () =>
          completed({ execution_id: CLAIM.execution_id, ended_at: Date.now() }),
      },
      mission: {
        "assessment.submit": async () => completed({ outcome: null }),
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  const watch = new ClaimWatch(run);
  stopAfter(t, () => {
    watch.end();
    run.dispose();
  });
  return { run, watch, reads: () => reads };
}

async function tick(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

async function storedStop(run: ExecutionRun): Promise<ExecutionStop> {
  return run.stopOf(new Error("later"));
}

test("the claim watch reads the claim 60 s after the start and every 60 s after, and a running claim changes nothing", async (t) => {
  const h = watched(t, []);
  await tick(t, JUST_BEFORE_MS);
  assert.equal(h.reads(), NO_READS);
  await tick(t, 1);
  assert.equal(h.reads(), ONE_READ);
  await tick(t, CLAIM_WATCH_INTERVAL_MS);
  assert.equal(h.reads(), TWO_READS);
  assert.equal(h.run.operationContext.signal.aborted, false);
});

test("a claim watch fire revokes the run on a claim that is not running and on an execution-end answer, then reads no more", async (t) => {
  const answers: Record<string, Answer> = {
    finished: claimState("finished"),
    [EXECUTION_NOT_RUNNING]: executionEnd(409, EXECUTION_NOT_RUNNING),
    [EXECUTION_PROOF_FAILED]: executionEnd(403, EXECUTION_PROOF_FAILED),
  };
  for (const [name, answer] of Object.entries(answers)) {
    await t.test(name, async (st) => {
      const h = watched(st, [answer]);
      await tick(st, CLAIM_WATCH_INTERVAL_MS);
      assert.equal(h.run.operationContext.signal.aborted, true);
      assert.equal((await storedStop(h.run)).reason, EndReason.Revoked);
      await tick(st, LATE_FIRES_MS);
      assert.equal(h.reads(), ONE_READ);
    });
  }
});

test("a network error of a claim watch fire ends nothing and the next fire follows the interval", async (t) => {
  const h = watched(t, [
    async () => {
      throw new Error("network down");
    },
  ]);
  await tick(t, CLAIM_WATCH_INTERVAL_MS);
  assert.equal(h.run.operationContext.signal.aborted, false);
  await tick(t, CLAIM_WATCH_INTERVAL_MS);
  assert.equal(h.reads(), TWO_READS);
  assert.equal(h.run.operationContext.signal.aborted, false);
});

test("the claim watch ends at the push fence, at each final step and at a stop", async (t) => {
  const ends: Record<string, (run: ExecutionRun) => Promise<unknown>> = {
    fence: (run) => run.fence(run.cleanupContext()),
    "assessment.submit": (run) =>
      run.submitAssessment(CLAIM.node_id, {
        result: "success",
        rationale: "met",
      } as never),
    "execution.release": (run) => run.release(false),
    releaseStop: (run) =>
      run.releaseStop(new ExecutionStop(EndReason.OperationFailed, null)),
    stop: (run) => run.stopOf(new Error("stopped")),
  };
  for (const [name, end] of Object.entries(ends)) {
    await t.test(name, async (st) => {
      const h = watched(st, []);
      await end(h.run);
      const before = h.reads();
      await tick(st, LATE_FIRES_MS);
      assert.equal(h.reads(), before);
    });
  }
});

test("a claim read in flight at a final step does not read the end of the claim as a revoke", async (t) => {
  const answer = Promise.withResolvers<OperationResult<unknown>>();
  const h = watched(t, [() => answer.promise]);
  await tick(t, CLAIM_WATCH_INTERVAL_MS);
  assert.equal(h.reads(), ONE_READ);
  const released = await h.run.release(false);
  answer.resolve(completed({ claim_state: "finished", ended_at: Date.now() }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(released, {
    kind: ExecutionEndKind.Released,
    furtherWork: false,
  });
  assert.equal(h.run.operationContext.signal.aborted, false);
});
