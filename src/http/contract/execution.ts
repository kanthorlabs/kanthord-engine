import { z } from "zod";

import { epochMillis } from "../../domain/column.ts";
import { identity, nodeIdentity } from "../../domain/identity.ts";
import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  illegalTransitionDetails,
  leaseHeldDetails,
  planInvalidDetails,
} from "./error-details.ts";
import {
  EXAMPLE_AT as A,
  EXAMPLE_HASH as H,
  EXAMPLE_ULID as U,
} from "./example-literal.ts";
import { nodeShowResponse } from "./graph.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";

const claimedLease = z.strictObject({
  subjectId: nodeIdentity,
  owner: z.string().min(1),
  ownerKind: z.literal("actor"),
  fence: z.int(),
  expiresAt: epochMillis,
});

export const nodeClaimRequest = z.strictObject({});

export const nodeHeartbeatRequest = z.strictObject({
  fence: z.int().min(1),
});

export const nodeReleaseRequest = z.strictObject({
  fence: z.int().min(1),
});

export const nodeClaimResponse = z.strictObject({
  lease: claimedLease,
  objectiveLease: claimedLease,
  runId: identity("run"),
  objectiveRunId: identity("run"),
  attemptId: identity("attempt").nullable(),
  attemptNo: z.int().nullable(),
  heartbeatIntervalMs: z.int(),
  node: nodeShowResponse,
});

export const nodeHeartbeatResponse = z.strictObject({
  lease: claimedLease,
  objectiveLease: claimedLease,
  heartbeatIntervalMs: z.int(),
});

export const nodeReleaseResponse = z.strictObject({
  node: nodeShowResponse,
});

const nodeClaim_node = {
  id: `task_${U}`,
  projectId: `project_${U}`,
  kind: "task",
  title: "add the health route",
  state: "running",
  blockReason: null,
  discardReason: null,
  parentId: `objective_${U}`,
  dependencies: [],
  instructionBlob: H,
  acceptanceBlob: null,
  instruction: "# atlas\n",
  acceptance: null,
  worker: null,
  deliverable: null,
  verify: null,
  repositoryId: `repo_${U}`,
  repo: "atlas",
  revision: `revision_${U}`,
  updatedAt: A,
  attestedObjectId: null,
  projection: null,
};

const nodeRelease_node = {
  ...nodeClaim_node,
  state: "ready",
};

export const nodeClaimExamples: OperationExamples = {
  request: {},
  success: {
    lease: {
      subjectId: `task_${U}`,
      owner: `actor_${U}`,
      ownerKind: "actor",
      fence: 1,
      expiresAt: 1722800300000,
    },
    objectiveLease: {
      subjectId: `objective_${U}`,
      owner: `actor_${U}`,
      ownerKind: "actor",
      fence: 1,
      expiresAt: 1722800300000,
    },
    runId: `run_${U}`,
    objectiveRunId: `run_${U}`,
    attemptId: `attempt_${U}`,
    attemptNo: 1,
    heartbeatIntervalMs: 100000,
    node: nodeClaim_node,
  },
  error: {
    error: {
      code: "lease-held",
      message: `the claim of task_${U} conflicts with a lease held by another owner`,
      details: {
        refusal: "held-by-other",
        subject: `objective_${U}`,
        holder: `actor_${U}`,
        holderKind: "actor",
        fence: 1,
        expiresAt: 1722800300000,
        relation: "ancestor",
      },
    },
  },
};

export const nodeHeartbeatExamples: OperationExamples = {
  request: { fence: 1 },
  success: {
    lease: {
      subjectId: `task_${U}`,
      owner: `actor_${U}`,
      ownerKind: "actor",
      fence: 1,
      expiresAt: 1722800300000,
    },
    objectiveLease: {
      subjectId: `objective_${U}`,
      owner: `actor_${U}`,
      ownerKind: "actor",
      fence: 1,
      expiresAt: 1722800300000,
    },
    heartbeatIntervalMs: 100000,
  },
  error: {
    error: {
      code: "lease-held",
      message: `the lease of task_${U} is not held at fence 2`,
      details: {
        refusal: "stale-fence",
        subject: `task_${U}`,
        presentedFence: 2,
      },
    },
  },
};

export const nodeReleaseExamples: OperationExamples = {
  request: { fence: 1 },
  success: { node: nodeRelease_node },
  error: {
    error: {
      code: "illegal-transition",
      message: `the node task_${U} is not releasable`,
      details: {
        refusal: "node-state",
        state: "running",
        admitted: ["ready", "running"],
      },
    },
  },
};

export const execution = operations([
  {
    operationId: "run.start",
    method: "POST",
    path: [resource("project"), parameter("project"), sub("run")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "run.cancel",
    method: "POST",
    path: [resource("run"), parameter("run"), action("cancel")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "run.list",
    method: "GET",
    path: [resource("run")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "run.show",
    method: "GET",
    path: [resource("run"), parameter("run")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "node.attempts",
    method: "GET",
    path: [resource("node"), parameter("node"), sub("attempt")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "attempt.show",
    method: "GET",
    path: [resource("attempt"), parameter("attempt")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "node.checks",
    method: "GET",
    path: [resource("node"), parameter("node"), sub("check")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "worker.list",
    method: "GET",
    path: [resource("worker")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "node.claim",
    method: "POST",
    path: [resource("node"), parameter("node"), action("claim")],
    introducedIn: "phase-1",
    status: "routed",
    idempotency: "memory",
    replayable: [200],
    allowedActors: ["human", "harness"],
    request: nodeClaimRequest,
    response: nodeClaimResponse,
    errors: {
      ...baselineErrors,
      "lease-held": leaseHeldDetails,
      "illegal-transition": illegalTransitionDetails,
      "plan-invalid": planInvalidDetails,
    },
    examples: nodeClaimExamples,
  },
  {
    operationId: "node.heartbeat",
    method: "POST",
    path: [resource("node"), parameter("node"), action("heartbeat")],
    introducedIn: "phase-1",
    status: "routed",
    idempotency: "memory",
    replayable: [200],
    allowedActors: ["human", "harness"],
    request: nodeHeartbeatRequest,
    response: nodeHeartbeatResponse,
    errors: {
      ...baselineErrors,
      "lease-held": leaseHeldDetails,
      "illegal-transition": illegalTransitionDetails,
      "plan-invalid": planInvalidDetails,
    },
    examples: nodeHeartbeatExamples,
  },
  {
    operationId: "node.release",
    method: "POST",
    path: [resource("node"), parameter("node"), action("release")],
    introducedIn: "phase-1",
    status: "routed",
    idempotency: "memory",
    replayable: [200],
    allowedActors: ["human", "harness"],
    request: nodeReleaseRequest,
    response: nodeReleaseResponse,
    errors: {
      ...baselineErrors,
      "lease-held": leaseHeldDetails,
      "illegal-transition": illegalTransitionDetails,
      "plan-invalid": planInvalidDetails,
    },
    examples: nodeReleaseExamples,
  },
]);
