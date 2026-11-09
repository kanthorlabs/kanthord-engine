import assert from "node:assert/strict";
import { unattributed } from "../kernel/cause.ts";
import { asError, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  type CooldownChange,
  environmentFailureSchema,
  type ExecutionRelease,
  type ExecutionRow,
  ExecutionStopReason,
  type FailureHold,
  isAdvancingProviderFailure,
  type NodeTransition,
  ORDERED_STOP_REASONS,
  type ReleaseStop,
} from "./contract.ts";
import { ExecutionEnd } from "../tracking/contract.ts";
import { executionTrace, executionTransition } from "./telemetry.ts";
import type { Dependencies } from "./service.ts";
import type { Transaction } from "../kernel/store.ts";
import { consecutiveStalls, endExecution } from "./execution-store.ts";
import {
  consecutiveFailures,
  countsFailure,
  digestsOf,
  NO_FAILURE_STOPS,
  recordFailure,
  requireRunning,
} from "./settlement.ts";

const NO_STALLS = 0;
export const STOP_UNORDERED = "scheduler.execution.stop_unordered";
const EXECUTION_RELEASED_FAILED = "scheduler.execution.released_hook_failed";

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

function notifyReleased(
  dependencies: Dependencies,
  executionId: string,
  stop: ReleaseStop | null,
): void {
  try {
    dependencies.executionReleased(executionId, stop);
  } catch (error) {
    dependencies.logger.error(
      { err: asError(error), execution_id: executionId },
      EXECUTION_RELEASED_FAILED,
    );
  }
}

type ReleaseStopBody = NonNullable<ExecutionRelease["stop"]>;
interface ReleaseContext {
  tx: Transaction;
  dependencies: Dependencies;
  executionId: string;
  body: ExecutionRelease;
  row: ExecutionRow;
  now: number;
}
interface StopEffects {
  transition: NodeTransition;
  hold: FailureHold | null;
  environmentRepositories: string[] | null;
}

function requireStopOrder(
  dependencies: Dependencies,
  executionId: string,
  stop: ReleaseStopBody | null,
): void {
  if (
    stop &&
    ORDERED_STOP_REASONS.includes(stop.reason) &&
    dependencies.stopOrderOf(executionId) !== stop.reason
  )
    throw new OperationError(
      HttpStatus.Conflict,
      STOP_UNORDERED,
      "A worker release with this stop needs a stop order of the execution.",
      { execution_id: executionId, reason: stop.reason },
    );
}

function cooldownsOf(context: ReleaseContext): CooldownChange[] {
  const { tx, dependencies, executionId, body, row, now } = context;
  const selections = dependencies.agentChains.resolve(
    tx,
    row.worker_binding_id,
    row.agent_pins,
  );
  const code = body.stop?.code ?? null;
  if (body.stop?.reason !== ExecutionStopReason.ProviderFailed)
    return dependencies.agentChains.success(tx, row, selections, executionId);
  if (!isAdvancingProviderFailure(code)) return [];
  return dependencies.agentChains.providerFailure(
    tx,
    row,
    selections,
    code,
    executionId,
    now,
  );
}

function recordStop(
  context: ReleaseContext,
  stop: ReleaseStopBody,
): StopEffects {
  const { tx, dependencies, executionId, row, now } = context;
  endExecution(tx, executionId, now, stop);
  if (NO_FAILURE_STOPS.includes(stop.reason))
    return {
      transition: dependencies.transitions.stopped(tx, row.node_id, now),
      hold: null,
      environmentRepositories: null,
    };
  const environmentRepositories =
    stop.reason === ExecutionStopReason.EnvironmentFailed
      ? [
          ...(dependencies.facts.claimFacts(tx, row.node_id)?.repositories ??
            []),
        ]
      : null;
  const { transition, hold } = recordFailure(
    tx,
    dependencies,
    row.node_id,
    consecutiveFailures(tx, row, countsFailure(stop)),
    now,
  );
  return { transition, hold, environmentRepositories };
}

function releaseWork(context: ReleaseContext): NodeTransition {
  const { tx, dependencies, executionId, body, row, now } = context;
  endExecution(tx, executionId, now, body.stop);
  const stalled = body.stop !== null;
  return dependencies.transitions.release(
    tx,
    { execution_id: executionId, node_id: row.node_id, attempt: row.attempt },
    body.further_work,
    stalled ? consecutiveStalls(tx, row.node_id, row.attempt) : NO_STALLS,
    now,
  );
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
  requireStopOrder(dependencies, executionId, body.stop);
  let released: ExecutionRow | undefined;
  let transition: NodeTransition | undefined;
  let hold: FailureHold | null = null;
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
    const context: ReleaseContext = {
      tx,
      dependencies,
      executionId,
      body,
      row,
      now,
    };
    cooldowns = cooldownsOf(context);
    if (
      body.stop !== null &&
      body.stop.reason !== ExecutionStopReason.BudgetEnd
    ) {
      assert.ok(body.further_work);
      ({ transition, hold, environmentRepositories } = recordStop(
        context,
        body.stop,
      ));
      return { execution_id: executionId, ended_at: now };
    }
    transition = releaseWork(context);
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
  notifyReleased(dependencies, executionId, body.stop);
  dependencies.telemetry.executionTransition(
    executionTrace(released),
    executionTransition(transition, result.ended_at, hold),
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
