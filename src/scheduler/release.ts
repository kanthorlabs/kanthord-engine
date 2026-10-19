import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import {
  ExecutionStopReason,
  isAdvancingProviderFailure,
  isAdvancingStop,
  type CooldownChange,
  type ExecutionRelease,
  type ExecutionRow,
} from "./contract.ts";
import { ExecutionEnd } from "../tracking/contract.ts";
import { executionTrace } from "./telemetry.ts";
import type { Dependencies } from "./service.ts";
import { consecutiveStalls, endExecution } from "./execution-store.ts";
import {
  consecutiveFailures,
  recordFailure,
  requireRunning,
} from "./settlement.ts";

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
  let released: ExecutionRow | undefined;
  let cooldowns: CooldownChange[] = [];
  const result = caller.commit((tx) => {
    const now = Date.now();
    const row = requireRunning(tx, executionId, proof.runtimeIdentity, now);
    released = row;
    const selections = dependencies.agentChains.resolve(
      tx,
      row.worker_binding_id,
      row.agent_pins,
    );
    const code = body.stop?.code ?? null;
    if (
      body.stop?.reason === ExecutionStopReason.ProviderFailed &&
      isAdvancingProviderFailure(code)
    )
      cooldowns = dependencies.agentChains.providerFailure(
        tx,
        selections,
        code,
        executionId,
        now,
      );
    else if (body.stop?.reason !== ExecutionStopReason.ProviderFailed)
      cooldowns = dependencies.agentChains.success(tx, selections, executionId);
    if (
      body.stop !== null &&
      body.stop.reason !== ExecutionStopReason.BudgetEnd
    ) {
      assert.ok(body.further_work);
      endExecution(tx, executionId, now, body.stop);
      recordFailure(
        tx,
        dependencies,
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
  assert.ok(released, "a committed release read its execution");
  dependencies.agentChains.cooldownsChanged(cooldowns);
  dependencies.telemetry.executionEnded({
    trace: executionTrace(released),
    ended_at: result.ended_at,
    end: ExecutionEnd.Finished,
    stop: body.stop,
  });
  wake(proof.projectId);
  return result;
}
