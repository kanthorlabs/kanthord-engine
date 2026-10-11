import assert from "node:assert/strict";
import type { ExecutionTrace } from "../tracking/contract.ts";

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
