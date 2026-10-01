import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import type { Dependencies } from "./service.ts";
import { endExecution } from "./execution-store.ts";
import { requireRunning } from "./settlement.ts";

export function release(
  dependencies: Dependencies,
  executionId: string,
  furtherWork: boolean,
  caller: CallerContext,
  wake: (projectId: string) => void,
) {
  const proof = caller.execution;
  assert.ok(proof, "release requires an execution proof");
  assert.equal(proof.executionId, executionId);
  const result = caller.commit((tx) => {
    const now = Date.now();
    const row = requireRunning(tx, executionId, proof.runtimeIdentity, now);
    dependencies.transitions.release(
      tx,
      { executionId, nodeId: row.nodeId, attempt: row.attempt },
      furtherWork,
      now,
    );
    endExecution(tx, executionId, now);
    return { executionId, endedAt: now };
  });
  wake(proof.projectId);
  return result;
}
