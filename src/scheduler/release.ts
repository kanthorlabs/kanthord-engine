import assert from "node:assert/strict";
import { z } from "zod";
import { unattributed } from "../kernel/cause.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  environmentFailureSchema,
  ExecutionStopReason,
  isAdvancingProviderFailure,
  isAdvancingStop,
  type CooldownChange,
  type ExecutionRelease,
  type ExecutionRow,
  type NodeTransition,
} from "./contract.ts";
import { ExecutionEnd } from "../tracking/contract.ts";
import { executionTrace, executionTransition } from "./telemetry.ts";
import type { Dependencies } from "./service.ts";
import { consecutiveStalls, endExecution } from "./execution-store.ts";
import {
  consecutiveFailures,
  recordFailure,
  requireRunning,
} from "./settlement.ts";

const NO_STALLS = 0;
const digestsDetailSchema = z.looseObject({
  digests: z.record(z.string(), z.string()),
});

function countsFailure(stop: ExecutionRelease["stop"]): boolean {
  return (
    !isAdvancingStop(stop) &&
    stop?.reason !== ExecutionStopReason.EnvironmentFailed
  );
}

function digestsOf(detail: string | null): Record<string, string> {
  if (detail === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return {};
  }
  const parsed = digestsDetailSchema.safeParse(value);
  return parsed.success ? parsed.data.digests : {};
}

function reportEnvironmentFailure(
  dependencies: Dependencies,
  row: ExecutionRow,
  repositories: string[],
  stop: NonNullable<ExecutionRelease["stop"]>,
): void {
  const detail = stop.detail ?? null;
  dependencies.environments.environmentFailed({
    project_id: row.project_id,
    execution_id: row.execution_id,
    resource_identities: repositories,
    digests: digestsOf(detail),
    stop: { code: environmentFailureSchema.parse(stop.code), detail },
  });
}

export function release(
  dependencies: Dependencies,
  executionId: string,
  body: ExecutionRelease,
  caller: CallerContext,
  wake: (projectId: string, runtimeIdentities: string[]) => void,
) {
  const proof = caller.execution;
  assert.ok(proof, "release requires an execution proof");
  assert.equal(proof.executionId, executionId);
  let released: ExecutionRow | undefined;
  let transition: NodeTransition | undefined;
  let siblings: string[] = [];
  let cooldowns: CooldownChange[] = [];
  let environmentRepositories: string[] | null = null;
  const result = caller.commit((tx) => {
    const now = Date.now();
    const row = requireRunning(tx, executionId, proof.runtimeIdentity, now);
    released = row;
    siblings = dependencies.registrations.registrationsOfInstance(
      tx,
      row.runtime_identity,
    );
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
        row,
        selections,
        code,
        executionId,
        now,
      );
    else if (body.stop?.reason !== ExecutionStopReason.ProviderFailed)
      cooldowns = dependencies.agentChains.success(
        tx,
        row,
        selections,
        executionId,
      );
    if (
      body.stop !== null &&
      body.stop.reason !== ExecutionStopReason.BudgetEnd
    ) {
      assert.ok(body.further_work);
      endExecution(tx, executionId, now, body.stop);
      if (body.stop.reason === ExecutionStopReason.EnvironmentFailed)
        environmentRepositories = [
          ...(dependencies.facts.claimFacts(tx, row.node_id)?.repositories ??
            []),
        ];
      transition = recordFailure(
        tx,
        dependencies,
        row.node_id,
        consecutiveFailures(tx, row, countsFailure(body.stop)),
        now,
      );
      return { execution_id: executionId, ended_at: now };
    }
    endExecution(tx, executionId, now, body.stop);
    const stalled = body.stop !== null;
    transition = dependencies.transitions.release(
      tx,
      { execution_id: executionId, node_id: row.node_id, attempt: row.attempt },
      body.further_work,
      stalled ? consecutiveStalls(tx, row.node_id, row.attempt) : NO_STALLS,
      now,
    );
    return { execution_id: executionId, ended_at: now };
  });
  assert.ok(released, "a committed release read its execution");
  assert.ok(transition, "a committed release moved its node");
  dependencies.agentChains.cooldownsChanged(cooldowns);
  dependencies.telemetry.executionEnded({
    trace: executionTrace(released),
    ended_at: result.ended_at,
    end: ExecutionEnd.Finished,
    revoke_cause: null,
    stop: body.stop,
    cause: body.stop === null ? null : (body.stop.cause ?? unattributed([])),
  });
  dependencies.telemetry.executionTransition(
    executionTrace(released),
    executionTransition(transition, result.ended_at),
  );
  if (environmentRepositories !== null && body.stop !== null)
    reportEnvironmentFailure(
      dependencies,
      released,
      environmentRepositories,
      body.stop,
    );
  wake(proof.projectId, siblings);
  return result;
}
