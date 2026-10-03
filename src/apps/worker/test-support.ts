import type { ExecutionRecord } from "../../scheduler/contract.ts";

export function testClaim(): ExecutionRecord {
  return {
    executionId: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    projectId: "project_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    nodeId: "node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    claimant: {
      workerBindingId: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      runtimeIdentity: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      resourceIdentity: "worker:kanthord:test",
    },
    attempt: 1,
    pinnedRevision: 1,
    credentials: [],
    claimState: "running",
    expiredAt: Date.now() + 60000,
    createdAt: Date.now(),
    endedAt: null,
    traceId: "1".repeat(32),
    rootSpanId: "2".repeat(16),
  };
}
