import { z } from "zod";

import { objectId } from "../../domain/column.ts";
import {
  blockReasons,
  nodeKinds,
  nodeStates,
  terminalStates,
} from "../../domain/state.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  illegalTransitionDetails,
  invalidRequestDetails,
  leaseHeldDetails,
  nodeUnblockDetails,
} from "./error-details.ts";
import { EXAMPLE_HASH as H, EXAMPLE_ULID as U } from "./example-literal.ts";
import { nodeShowResponse } from "./graph.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import { action, parameter, resource } from "./path.ts";

export const nodeReportRequest = z.discriminatedUnion("report", [
  z.strictObject({
    report: z.literal("accepted"),
    fence: z.number().int(),
    objectId,
  }),
  z.strictObject({
    report: z.literal("rejected"),
    fence: z.number().int(),
    reason: z.string().min(1).max(2000),
  }),
  z.strictObject({
    report: z.literal("failed"),
    fence: z.number().int(),
    reason: z.string().min(1).max(2000),
  }),
  z.strictObject({
    report: z.literal("cancelled"),
    fence: z.number().int(),
    reason: z.string().min(1).max(2000).optional(),
  }),
  z.strictObject({
    report: z.literal("attested"),
    fence: z.number().int(),
    objectId,
  }),
  z.strictObject({
    report: z.literal("closed"),
    acknowledgePartial: z.boolean(),
  }),
]);

export const nodeReportResponse = z.strictObject({
  nodeId: z.string(),
  kind: z.enum(nodeKinds),
  state: z.enum(nodeStates),
  blockReason: z.enum(blockReasons).nullable(),
  attemptId: z.string().nullable(),
  attemptNo: z.number().int().nullable(),
  attemptsRemaining: z.number().int().nullable(),
  objectId: objectId.nullable(),
  objectiveState: z.enum(nodeStates).nullable(),
  objectiveProjection: z.enum(terminalStates).nullable(),
});

export const nodeUnblockResponse = z.strictObject({
  node: nodeShowResponse,
});

const REPORT_OBJECT_ID = "a".repeat(40);

export const nodeReportExamples: OperationExamples = {
  request: { report: "accepted", fence: 1, objectId: REPORT_OBJECT_ID },
  success: {
    nodeId: `task_${U}`,
    kind: "task",
    state: "done",
    blockReason: null,
    attemptId: `attempt_${U}`,
    attemptNo: 1,
    attemptsRemaining: 2,
    objectId: REPORT_OBJECT_ID,
    objectiveState: "running",
    objectiveProjection: null,
  },
  error: {
    error: {
      code: "lease-held",
      message: `the lease of task_${U} is not held by the reporter at fence 1`,
      details: {
        refusal: "stale-fence",
        subject: `task_${U}`,
        presentedFence: 1,
      },
    },
  },
};

export const nodeUnblockExamples: OperationExamples = {
  success: {
    node: {
      id: `task_${U}`,
      projectId: `project_${U}`,
      kind: "task",
      title: "add the health route",
      state: "ready",
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
      updatedAt: 1738368000000,
      attestedObjectId: null,
      projection: null,
    },
  },
  error: {
    error: {
      code: "invalid-request",
      message: `a objective_${U} cannot be unblocked`,
      details: { refusal: "node-kind-invalid", blockReason: null },
    },
  },
};

export const outcome = operations([
  {
    operationId: "node.report",
    method: "POST",
    path: [resource("node"), parameter("node"), action("report")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    idempotency: "memory",
    replayable: [200],
    request: nodeReportRequest,
    response: nodeReportResponse,
    errors: {
      ...baselineErrors,
      "lease-held": leaseHeldDetails,
      "illegal-transition": illegalTransitionDetails,
      "acknowledgement-required": null,
      "actor-forbidden": null,
      "not-found": null,
      "invalid-request": invalidRequestDetails,
    },
    examples: nodeReportExamples,
  },
  {
    operationId: "node.unblock",
    method: "POST",
    path: [resource("node"), parameter("node"), action("unblock")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    response: nodeUnblockResponse,
    errors: {
      ...baselineErrors,
      "invalid-request": nodeUnblockDetails,
      "illegal-transition": nodeUnblockDetails,
    },
    examples: nodeUnblockExamples,
  },
  {
    operationId: "node.abandon",
    method: "POST",
    path: [resource("node"), parameter("node"), action("abandon")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "node.discard",
    method: "POST",
    path: [resource("node"), parameter("node"), action("discard")],
    introducedIn: "phase-3",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "node.waive",
    method: "POST",
    path: [resource("node"), parameter("node"), action("waive")],
    introducedIn: "phase-3",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
]);
