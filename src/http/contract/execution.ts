import { z } from "zod";

import { epochMillis } from "../../domain/column.ts";
import { identity, nodeIdentity } from "../../domain/identity.ts";
import { runDrivers } from "../../domain/run.ts";
import { compositions } from "../../domain/worker-registry.ts";
import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  assignmentHeldDetails,
  illegalTransitionDetails,
  leaseHeldDetails,
  objectiveBusyDetails,
  objectiveRunLostDetails,
  pairIllegalDetails,
  planInvalidDetails,
  reviewHeadUnavailableDetails,
  runAuthorityDetails,
  subtreeBusyDetails,
  unroutableDetails,
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

export const nodeClaimRequest = z.strictObject({
  available: z.boolean(),
});

export const nodeRenewRequest = z.strictObject({
  fence: z.int().min(1),
  runId: identity("run"),
  runFence: z.int().min(1),
});

export const nodeReleaseRequest = z.strictObject({
  fence: z.int().min(1),
  runId: identity("run"),
  runFence: z.int().min(1),
});

export const nodeClaimResponse = z.strictObject({
  lease: claimedLease,
  objectiveLease: claimedLease,
  runId: identity("run"),
  runFence: z.int().min(1),
  objectiveRunId: identity("run"),
  objectiveRunFence: z.int().min(1),
  expiresAt: z.int(),
  renewAfterMs: z.int().min(1),
  attemptId: identity("attempt").nullable(),
  attemptNo: z.int().nullable(),
  node: nodeShowResponse,
});

export const nodeRenewResponse = z.strictObject({
  lease: claimedLease,
  objectiveLease: claimedLease,
  expiresAt: z.int(),
  objectiveExpiresAt: z.int(),
  renewAfterMs: z.int().min(1),
});

export const nodeReleaseResponse = z.strictObject({
  node: nodeShowResponse,
});

export const workerListItem = z.object({
  worker: z.string(),
  driver: z.enum(runDrivers),
  agents: z.array(z.string()),
  claims: z.array(z.string()),
  deliverables: z.array(z.string()),
  harness: z.string().nullable(),
  metadata: z.object({
    composition: z.enum(compositions),
  }),
});

export const workerListResponse = z.object({
  workers: z.array(workerListItem),
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
  assignment: null,
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
  request: { available: true },
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
    runFence: 1,
    objectiveRunId: `run_${U}`,
    objectiveRunFence: 1,
    expiresAt: 1722800300000,
    renewAfterMs: 100000,
    attemptId: `attempt_${U}`,
    attemptNo: 1,
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

export const nodeRenewExamples: OperationExamples = {
  request: { fence: 1, runId: `run_${U}`, runFence: 1 },
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
    expiresAt: 1722800300000,
    objectiveExpiresAt: 1722800300000,
    renewAfterMs: 100000,
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
  request: { fence: 1, runId: `run_${U}`, runFence: 1 },
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
    status: "routed",
    allowedActors: ["human"],
    response: workerListResponse,
    errors: { ...baselineErrors },
    examples: {
      success: {
        workers: [
          {
            worker: "claude@1",
            driver: "external",
            agents: [],
            claims: ["objective", "task"],
            deliverables: ["test", "implementation", "review"],
            harness: "claude-code",
            metadata: { composition: "self-managed" },
          },
        ],
      },
      error: {
        error: {
          code: "service-unavailable",
          message: "the daemon is shutting down",
        },
      },
    },
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
      "pair-illegal": pairIllegalDetails,
      "assignment-held": assignmentHeldDetails,
      unroutable: unroutableDetails,
      "review-head-unavailable": reviewHeadUnavailableDetails,
      "objective-busy": objectiveBusyDetails,
      "subtree-busy": subtreeBusyDetails,
    },
    examples: nodeClaimExamples,
  },
  {
    operationId: "node.renew",
    method: "POST",
    path: [resource("node"), parameter("node"), action("renew")],
    introducedIn: "phase-1",
    status: "routed",
    idempotency: "memory",
    replayable: [200],
    allowedActors: ["human", "harness"],
    request: nodeRenewRequest,
    response: nodeRenewResponse,
    errors: {
      ...baselineErrors,
      "lease-held": leaseHeldDetails,
      "illegal-transition": illegalTransitionDetails,
      "plan-invalid": planInvalidDetails,
      "run-not-found": runAuthorityDetails,
      "run-ended": runAuthorityDetails,
      "run-expired": runAuthorityDetails,
      "run-caller-mismatch": runAuthorityDetails,
      "target-outside-run": runAuthorityDetails,
      "fence-stale": runAuthorityDetails,
      "lifetime-exceeded": runAuthorityDetails,
      "objective-run-lost": objectiveRunLostDetails,
    },
    examples: nodeRenewExamples,
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
      "run-not-found": runAuthorityDetails,
      "run-ended": runAuthorityDetails,
      "run-expired": runAuthorityDetails,
      "run-caller-mismatch": runAuthorityDetails,
      "target-outside-run": runAuthorityDetails,
      "fence-stale": runAuthorityDetails,
    },
    examples: nodeReleaseExamples,
  },
]);
