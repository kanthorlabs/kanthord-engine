import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import {
  ExecutionStopReason,
  isAdvancingProviderFailure,
  isAdvancingStop,
  type ExecutionRelease,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import { consecutiveStalls, endExecution } from "./execution-store.ts";
import { consecutiveFailures, requireRunning } from "./settlement.ts";

const NO_STALLS = 0;

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
    const code = body.stop?.code ?? null;
    if (
      body.stop?.reason === ExecutionStopReason.ProviderFailed &&
      isAdvancingProviderFailure(code)
    )
      dependencies.agentChains.providerFailure(
        tx,
        row.agent_selections,
        code,
        executionId,
        now,
      );
    else if (body.stop?.reason !== ExecutionStopReason.ProviderFailed)
      dependencies.agentChains.success(tx, row.agent_selections);
    if (
      body.stop !== null &&
      body.stop.reason !== ExecutionStopReason.BudgetEnd
    ) {
      assert.ok(body.further_work);
      endExecution(tx, executionId, now, body.stop);
      dependencies.transitions.failure(
        tx,
        row.node_id,
        consecutiveFailures(tx, row, !isAdvancingStop(body.stop)),
        now,
      );
      return { execution_id: executionId, ended_at: now };
    }
    endExecution(tx, executionId, now, body.stop);
    const stalled = body.stop !== null;
    dependencies.transitions.release(
      tx,
      { execution_id: executionId, node_id: row.node_id, attempt: row.attempt },
      body.further_work,
      stalled ? consecutiveStalls(tx, row.node_id, row.attempt) : NO_STALLS,
      now,
    );
    return { execution_id: executionId, ended_at: now };
  });
  wake(proof.projectId);
  return result;
}
