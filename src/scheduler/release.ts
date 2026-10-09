import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import type { ExecutionRelease } from "./contract.ts";
import type { Dependencies } from "./service.ts";
import { endExecution } from "./execution-store.ts";
import { consecutiveFailures, requireRunning } from "./settlement.ts";

export function release(
  dependencies: Dependencies,
  executionId: string,
  body: ExecutionRelease,
  caller: CallerContext,
  wake: (projectId: string) => void,
) {
  const proof = caller.execution;
  assert.ok(proof, "release requires an execution proof");
  assert.equal(proof.executionId, executionId);
  const result = caller.commit((tx) => {
    const now = Date.now();
    const row = requireRunning(tx, executionId, proof.runtimeIdentity, now);
    if (body.stop !== null) {
      assert.ok(body.further_work);
      endExecution(tx, executionId, now, body.stop);
      dependencies.transitions.failure(
        tx,
        row.node_id,
        consecutiveFailures(tx, row),
        now,
      );
      return { execution_id: executionId, ended_at: now };
    }
    dependencies.transitions.release(
      tx,
      { execution_id: executionId, node_id: row.node_id, attempt: row.attempt },
      body.further_work,
      now,
    );
    endExecution(tx, executionId, now);
    return { execution_id: executionId, ended_at: now };
  });
  wake(proof.projectId);
  return result;
}
