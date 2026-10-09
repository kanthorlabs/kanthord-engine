import type { ExecutionRecord } from "../../scheduler/contract.ts";

export function testClaim(): ExecutionRecord {
  return {
    execution_id: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    project_id: "project_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    node_id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    claimant: {
      worker_binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      runtime_identity: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      resource_identity: "worker:kanthord:test",
    },
    attempt: 1,
    pinned_revision: 1,
    credentials: [],
    claim_state: "running",
    expired_at: Date.now() + 60000,
    created_at: Date.now(),
    ended_at: null,
    stop: null,
    trace_id: "1".repeat(32),
    root_span_id: "2".repeat(16),
  };
}
