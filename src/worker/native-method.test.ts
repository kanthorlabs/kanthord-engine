import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import {
  EndReason,
  ExecutionRun,
  EXECUTION_NOT_RUNNING,
  EXECUTION_PROOF_FAILED,
} from "./execution-run.ts";
import { executionBoundary, stopOnEnd } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import type { NativeAgent } from "./native-agent.ts";

const ONE = 1;
const ZERO = 0;
test("refused execution evidence aborts the agent and prevents later server operations", async (t) => {
  for (const [status, code] of [
    [403, EXECUTION_PROOF_FAILED],
    [409, EXECUTION_NOT_RUNNING],
  ] as const) {
    const claim = {
      executionId: "execution",
      nodeId: "node",
      attempt: 1,
      pinnedRevision: 1,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
      traceId: "trace",
    };
    let aborts = 0;
    let releases = 0;
    const clients = {
      mission: {
        "evidence.submit": async () => ({
          type: "failure",
          status,
          error: {
            error: { code, message: "ended", details: null },
            requestId: "test",
          },
        }),
      },
      scheduler: {
        executionRelease: async () => {
          releases++;
          throw new Error("unexpected");
        },
      },
    } as unknown as MethodClients;
    const run = new ExecutionRun({
      claim,
      clients,
      credentials: { release: async () => {} },
      context: background,
    });
    t.after(() => run.dispose());
    stopOnEnd(run, {
      abort: async () => {
        aborts++;
      },
    } as unknown as NativeAgent);
    const result = await executionBoundary(run, async () => {
      await run.submitEvidence(claim.nodeId, { subject: "head", assets: [] });
      return run.release(false);
    });
    assert.deepEqual(result, {
      kind: "ended",
      reason: EndReason.Revoked,
      code,
    });
    await assert.rejects(run.release(false));
    assert.equal(aborts, ONE);
    assert.equal(releases, ZERO);
  }
});
