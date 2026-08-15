import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  choicesChangedDetails,
  choicesInvalidDetails,
  choicesStaleDetails,
  idempotencyMismatchDetails,
  planInvalidDetails,
  staleRevisionDetails,
} from "./error-details.ts";
import {
  EXAMPLE_AT as A,
  EXAMPLE_HASH as H,
  EXAMPLE_ULID as U,
} from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import { planFinding } from "./plan-finding.ts";
import { blobHash } from "../../domain/blob.ts";
import {
  choices,
  differingFields,
  presences,
} from "../../domain/plan-choice.ts";
import { blockReasons, nodeKinds, nodeStates } from "../../domain/state.ts";

export const planDocument = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
});

export const planExportResponse = z.strictObject({
  revision: z.string().nullable(),
  documents: z.array(planDocument),
});

export const planRevisionEntry = z.strictObject({
  id: z.string(),
  parentId: z.string().nullable(),
  importId: z.string(),
  submittedBlob: blobHash,
  choicesBlob: blobHash,
  acceptedBlob: blobHash,
});

export const planRevisionsResponse = z.strictObject({
  revisions: z.array(planRevisionEntry),
});

export const planChoiceEntry = z.strictObject({
  id: z.string(),
  kind: z.enum(nodeKinds),
  presence: z.enum(presences),
  state: z.enum(nodeStates).nullable(),
  suggested: z.enum(choices),
  fields: z.array(z.enum(differingFields)),
  submitted: z.strictObject({
    legal: z.boolean(),
    reason: z.string().nullable(),
  }),
  database: z.strictObject({
    legal: z.boolean(),
    reason: z.string().nullable(),
  }),
});

export const planValidateRequest = z.strictObject({
  fromRevision: z.string().nullable(),
  documents: z.array(planDocument).min(1),
});

export const planValidateResponse = z.strictObject({
  findings: z.array(planFinding),
  documents: z.array(planDocument),
  documentsHash: blobHash,
  revision: z.string().nullable(),
  choices: z.array(planChoiceEntry),
});

export const planImportRequest = z.strictObject({
  fromRevision: z.string().nullable(),
  importId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\x21-\x7E](?:[\x20-\x7E]{0,98}[\x21-\x7E])?$/),
  documents: z.array(planDocument).min(1),
  choices: z.array(
    z.strictObject({ id: z.string().min(1), take: z.enum(choices) }),
  ),
  validatedRevision: z.string().nullable(),
  documentsHash: blobHash,
});

export const planImportResponse = z.strictObject({
  revision: z.string(),
  documents: z.array(planDocument),
  absent: z.array(z.string()),
});

export const nodeListItem = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(nodeKinds),
  title: z.string(),
  state: z.enum(nodeStates),
  blockReason: z.enum(blockReasons).nullable(),
  discardReason: z.string().nullable(),
  parentId: z.string().nullable(),
  dependencies: z.array(z.string()),
});

export const nodeListResponse = z.strictObject({
  nodes: z.array(nodeListItem),
});

export const nodeShowResponse = nodeListItem.extend({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
  worker: z.string().nullable(),
  repositoryId: z.string().nullable(),
  revision: z.string(),
  updatedAt: z.number(),
});

export const edgeView = z.strictObject({
  id: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  waivedAt: z.number().nullable(),
});

export const edgeListResponse = z.strictObject({ edges: z.array(edgeView) });

const planDocument_example = {
  path: "initiative/atlas.md",
  content: "# atlas\n",
};

export const planValidateExamples: OperationExamples = {
  request: { fromRevision: null, documents: [planDocument_example] },
  success: {
    findings: [],
    documents: [planDocument_example],
    documentsHash: H,
    revision: null,
    choices: [],
  },
  error: {
    error: {
      code: "plan-invalid",
      message: "the submission is not a valid plan",
      details: {
        findings: [
          {
            code: "acceptance-heading-duplicated",
            path: "initiative/atlas.md",
            id: null,
            message: "the acceptance heading appears twice",
          },
        ],
      },
    },
  },
};

export const planImportExamples: OperationExamples = {
  request: {
    fromRevision: null,
    importId: "import-0001",
    documents: [planDocument_example],
    choices: [],
    validatedRevision: null,
    documentsHash: H,
  },
  success: {
    revision: `revision_${U}`,
    documents: [planDocument_example],
    absent: [],
  },
  error: {
    error: {
      code: "stale-revision",
      message: `the import names null, the newest revision is revision_${U}`,
      details: { expected: null, current: `revision_${U}` },
    },
  },
};

export const planExportExamples: OperationExamples = {
  success: { revision: `revision_${U}`, documents: [planDocument_example] },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const planRevisionsExamples: OperationExamples = {
  success: {
    revisions: [
      {
        id: `revision_${U}`,
        parentId: null,
        importId: "import-0001",
        submittedBlob: H,
        choicesBlob: H,
        acceptedBlob: H,
      },
    ],
  },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

const nodeListItem_example = {
  id: `task_${U}`,
  projectId: `project_${U}`,
  kind: "task",
  title: "add the health route",
  state: "ready",
  blockReason: null,
  discardReason: null,
  parentId: `objective_${U}`,
  dependencies: [],
};

export const nodeListExamples: OperationExamples = {
  success: { nodes: [nodeListItem_example] },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const nodeShowExamples: OperationExamples = {
  success: {
    ...nodeListItem_example,
    instructionBlob: H,
    acceptanceBlob: null,
    worker: null,
    repositoryId: `repo_${U}`,
    revision: `revision_${U}`,
    updatedAt: A,
  },
  error: { error: { code: "not-found", message: `no node task_${U}` } },
};

export const edgeListExamples: OperationExamples = {
  success: {
    edges: [
      {
        id: `edge_${U}`,
        fromNode: `task_${U}`,
        toNode: `objective_${U}`,
        waivedAt: null,
      },
    ],
  },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const graph = operations([
  {
    operationId: "plan.validate",
    method: "POST",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      action("validate"),
    ],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: planValidateRequest,
    response: planValidateResponse,
    errors: { ...baselineErrors, "plan-invalid": planInvalidDetails },
    examples: planValidateExamples,
  },
  {
    operationId: "plan.import",
    method: "POST",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      action("import"),
    ],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "durable",
    request: planImportRequest,
    response: planImportResponse,
    errors: {
      ...baselineErrors,
      "plan-invalid": planInvalidDetails,
      "choices-invalid": choicesInvalidDetails,
      "choices-stale": choicesStaleDetails,
      "choices-changed": choicesChangedDetails,
      "stale-revision": staleRevisionDetails,
      "idempotency-mismatch": idempotencyMismatchDetails,
    },
    examples: planImportExamples,
  },
  {
    operationId: "plan.export",
    method: "GET",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      action("export"),
    ],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    response: planExportResponse,
    errors: { ...baselineErrors },
    examples: planExportExamples,
  },
  {
    operationId: "plan.revisions",
    method: "GET",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      sub("revision"),
    ],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: planRevisionsResponse,
    errors: { ...baselineErrors },
    examples: planRevisionsExamples,
  },
  {
    operationId: "node.list",
    method: "GET",
    path: [resource("node")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    response: nodeListResponse,
    errors: { ...baselineErrors },
    examples: nodeListExamples,
  },
  {
    operationId: "node.show",
    method: "GET",
    path: [resource("node"), parameter("node")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    response: nodeShowResponse,
    errors: { ...baselineErrors },
    examples: nodeShowExamples,
  },
  {
    operationId: "edge.list",
    method: "GET",
    path: [resource("project"), parameter("project"), sub("edge")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    response: edgeListResponse,
    errors: { ...baselineErrors },
    examples: edgeListExamples,
  },
]);
