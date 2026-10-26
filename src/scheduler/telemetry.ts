import assert from "node:assert/strict";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
} from "../kernel/cause.ts";
import {
  ExecutionEnd,
  type ExecutionKind,
  type ExecutionOpening,
  type ExecutionTelemetry,
  type ExecutionTrace,
  type ExecutionTransition,
} from "../tracking/contract.ts";
import type { EndedExecution, NodeTransition } from "./contract.ts";

const NO_WAIT = 0;
const COMPLETED_STATE = "Completed";

export function executionTransition(
  transition: NodeTransition,
  transitionedAt: number,
): ExecutionTransition {
  const leadTimeMs =
    transition.to === COMPLETED_STATE && transition.first_available_at !== null
      ? transitionedAt - transition.first_available_at
      : null;
  assert.ok(leadTimeMs === null || leadTimeMs >= NO_WAIT);
  return {
    transitioned_at: transitionedAt,
    from: transition.from,
    to: transition.to,
    rule: transition.rule,
    count: transition.count,
    limit: transition.limit,
    lead_time_ms: leadTimeMs,
  };
}

export function reportLost(
  telemetry: ExecutionTelemetry,
  lost: readonly EndedExecution[],
): void {
  for (const execution of lost) {
    telemetry.executionEnded({
      trace: execution.trace,
      ended_at: execution.ended_at,
      end: ExecutionEnd.Lost,
      revoke_cause: null,
      stop: null,
      cause: attributed(
        CauseCategory.Infrastructure,
        CauseSubcategory.ExecutionLost,
      ),
    });
    telemetry.executionTransition(
      execution.trace,
      executionTransition(execution.transition, execution.ended_at),
    );
  }
}

export function executionTrace(row: {
  execution_id: string;
  project_id: string;
  node_id: string;
  attempt: number;
  trace_id: string;
  root_span_id: string;
}): ExecutionTrace {
  assert.ok(row.trace_id);
  assert.ok(row.root_span_id);
  return {
    execution_id: row.execution_id,
    project_id: row.project_id,
    node_id: row.node_id,
    attempt: row.attempt,
    trace_id: row.trace_id,
    root_span_id: row.root_span_id,
  };
}

export function executionOpening(
  kind: ExecutionKind,
  workerName: string,
  queuedAt: number,
  claimedAt: number,
  facts: Pick<
    ExecutionOpening,
    | "worker_instance"
    | "placement"
    | "revision_turn"
    | "dependency_count"
    | "node_name"
  >,
): ExecutionOpening {
  assert.ok(workerName);
  return {
    kind,
    worker_name: workerName,
    queue_wait_ms: Math.max(NO_WAIT, claimedAt - queuedAt),
    worker_instance: facts.worker_instance,
    placement: facts.placement,
    revision_turn: facts.revision_turn,
    dependency_count: facts.dependency_count,
    node_name: facts.node_name,
  };
}
