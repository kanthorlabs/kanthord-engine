import assert from "node:assert/strict";
import {
  ExecutionEnd,
  type ExecutionTelemetry,
  type ExecutionTrace,
} from "../tracking/contract.ts";
import type { EndedExecution } from "./contract.ts";

export function reportLost(
  telemetry: ExecutionTelemetry,
  lost: readonly EndedExecution[],
): void {
  for (const execution of lost)
    telemetry.executionEnded({
      trace: execution.trace,
      ended_at: execution.ended_at,
      end: ExecutionEnd.Lost,
      revoke_cause: null,
      stop: null,
    });
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
