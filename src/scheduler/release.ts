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
      { execution_id: executionId, node_id: row.node_id, attempt: row.attempt },
      furtherWork,
      now,
    );
    endExecution(tx, executionId, now);
    return { execution_id: executionId, ended_at: now };
  });
  wake(proof.projectId);
  return result;
}
