import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  bindingInUseDetails,
  choicesChangedDetails,
  choicesInvalidDetails,
  choicesStaleDetails,
  idempotencyMismatchDetails,
  illegalTransitionDetails,
  planImportInvalidRequestDetails,
  planInvalidDetails,
  staleRevisionDetails,
} from "./error-details.ts";
import {
  EXAMPLE_AT as A,
  EXAMPLE_HASH as H,
  EXAMPLE_ULID as U,
  EXAMPLE_ULID_B as UB,
} from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import { planFinding } from "./plan-finding.ts";
import { blobHash } from "../../domain/blob.ts";
import { identity } from "../../domain/identity.ts";
import { revisionOrigins } from "../../domain/plan-revision.ts";
import {
  choices,
  differingFields,
  presences,
} from "../../domain/plan-choice.ts";
import {
  blockReasons,
  nodeKinds,
  nodeStates,
  terminalStates,
} from "../../domain/state.ts";

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
  origin: z.enum(revisionOrigins),
  importId: z.string().nullable(),
  submittedBlob: blobHash.nullable(),
  choicesBlob: blobHash.nullable(),
  acceptedBlob: blobHash,
});

export const planRevisionsResponse = z.strictObject({
  revisions: z.array(planRevisionEntry),
});

export const planChoiceBody = z.strictObject({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
});

export const planChoiceValues = z.strictObject({
  body: planChoiceBody.optional(),
  depends_on: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
  repo: z.string().nullable().optional(),
  title: z.string().optional(),
  worker: z.string().nullable().optional(),
});

export const planChoiceBranch = z.strictObject({
  legal: z.boolean(),
  reason: z.string().nullable(),
  values: planChoiceValues,
});

export const planChoiceEntry = z.strictObject({
  id: z.string(),
  kind: z.enum(nodeKinds),
  presence: z.enum(presences),
  state: z.enum(nodeStates).nullable(),
  suggested: z.enum(choices),
  fields: z.array(z.enum(differingFields)),
  path: z.string().nullable(),
  submitted: planChoiceBranch,
  database: planChoiceBranch,
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
  completeness: z.array(planFinding),
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

export const nodeListQuery = z.strictObject({
  project: identity("project").optional(),
  kind: z.enum(nodeKinds).optional(),
  state: z.enum(nodeStates).optional(),
  blockReason: z.enum(blockReasons).optional(),
  repository: identity("repository").optional(),
});

export const nodeShowResponse = nodeListItem.extend({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
  instruction: z.string(),
  acceptance: z.string().nullable(),
  worker: z.string().nullable(),
  repositoryId: z.string().nullable(),
  repo: z.string().nullable(),
  revision: z.string(),
  updatedAt: z.number(),
  attestedObjectId: z.string().nullable(),
  projection: z.enum(terminalStates).nullable(),
});

export const edgeView = z.strictObject({
  id: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  waivedAt: z.number().nullable(),
});

export const edgeListResponse = z.strictObject({ edges: z.array(edgeView) });

export const graphAttributes = z.strictObject({
  projectId: z.string(),
  revision: z.string().nullable(),
});

export const nodeAttributes = z.strictObject({
  kind: z.enum(nodeKinds),
  title: z.string(),
  state: z.enum(nodeStates),
  blockReason: z.enum(blockReasons).nullable(),
  discardReason: z.string().nullable(),
  parentId: z.string().nullable(),
  repositoryId: z.string().nullable(),
});

export const edgeAttributes = z.strictObject({
  relation: z.literal("depends-on"),
  waivedAt: z.number().nullable(),
});

export const serializedGraphNode = z.strictObject({
  key: z.string(),
  attributes: nodeAttributes,
});

export const serializedGraphEdge = z.strictObject({
  key: z.string(),
  source: z.string(),
  target: z.string(),
  attributes: edgeAttributes,
});

export const projectGraphResponse = z.strictObject({
  attributes: graphAttributes,
  options: z.strictObject({
    allowSelfLoops: z.literal(false),
    multi: z.literal(false),
    type: z.literal("directed"),
  }),
  nodes: z.array(serializedGraphNode),
  edges: z.array(serializedGraphEdge),
});

const nodeInitiativeFields = z.strictObject({
  kind: z.literal("initiative"),
  title: z.string(),
  instruction: z.string(),
  worker: z.string().nullable(),
  dependsOn: z.array(z.string()),
});

const nodeObjectiveFields = z.strictObject({
  kind: z.literal("objective"),
  title: z.string(),
  parentId: z.string().min(1),
  repo: z.string().min(1),
  instruction: z.string(),
  worker: z.string().nullable(),
  dependsOn: z.array(z.string()),
});

const nodeTaskFields = z.strictObject({
  kind: z.literal("task"),
  title: z.string(),
  parentId: z.string().min(1),
  instruction: z.string(),
  acceptance: z.string(),
  worker: z.string().nullable(),
  dependsOn: z.array(z.string()),
});

const nodeWriteFields = [
  nodeInitiativeFields,
  nodeObjectiveFields,
  nodeTaskFields,
] as const;

export const nodeCreateRequest = z.strictObject({
  fromRevision: z.string().nullable(),
  node: z.discriminatedUnion("kind", nodeWriteFields),
});

export const nodeUpdateRequest = z.strictObject({
  fromRevision: z.string(),
  node: z.discriminatedUnion("kind", nodeWriteFields),
});

export const nodeDeleteRequest = z.strictObject({
  fromRevision: z.string(),
});

export const nodeCreateResponse = z.strictObject({
  revision: z.string(),
  id: z.string(),
  completeness: z.array(planFinding),
});

export const nodeUpdateResponse = z.strictObject({
  revision: z.string(),
  completeness: z.array(planFinding),
});

export const nodeDeleteResponse = z.strictObject({
  revision: z.string(),
  deleted: z.array(z.string()),
  completeness: z.array(planFinding),
});

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
    choices: [
      {
        id: `task_${U}`,
        kind: "task",
        presence: "both",
        state: "ready",
        suggested: "submitted",
        fields: ["title"],
        path: "initiative/atlas.md",
        submitted: {
          legal: true,
          reason: null,
          values: { title: "add the health route" },
        },
        database: {
          legal: true,
          reason: null,
          values: { title: "add the health check" },
        },
      },
    ],
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
    completeness: [],
  },
  error: {
    error: {
      code: "stale-revision",
      message: `the import names null, the newest revision is revision_${U}`,
      details: { guard: "project", expected: null, actual: `revision_${U}` },
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
        origin: "import",
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
  query: {
    project: `project_${U}`,
    kind: "task",
    state: "ready",
    blockReason: "dirty-recovery",
    repository: `repo_${U}`,
  },
  success: { nodes: [nodeListItem_example] },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const nodeShowExamples: OperationExamples = {
  success: {
    ...nodeListItem_example,
    instructionBlob: H,
    acceptanceBlob: null,
    instruction: "# atlas\n",
    acceptance: null,
    worker: null,
    repositoryId: `repo_${U}`,
    repo: "atlas",
    revision: `revision_${U}`,
    updatedAt: A,
    attestedObjectId: null,
    projection: null,
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

export const nodeCreateExamples: OperationExamples = {
  request: {
    fromRevision: null,
    node: {
      kind: "task",
      title: "add the health route",
      parentId: `objective_${U}`,
      instruction: "Build the route.\n",
      acceptance: "## Acceptance criteria\n- it answers 200\n",
      worker: null,
      dependsOn: [],
    },
  },
  success: {
    revision: `revision_${U}`,
    id: `task_${U}`,
    completeness: [],
  },
  error: {
    error: {
      code: "stale-revision",
      message: `the write names null, the newest revision is revision_${U}`,
      details: { guard: "project", expected: null, actual: `revision_${U}` },
    },
  },
};

export const nodeUpdateExamples: OperationExamples = {
  request: {
    fromRevision: `revision_${U}`,
    node: {
      kind: "task",
      title: "add the health route",
      parentId: `objective_${U}`,
      instruction: "Build the route.\n",
      acceptance: "## Acceptance criteria\n- it answers 200\n",
      worker: null,
      dependsOn: [],
    },
  },
  success: {
    revision: `revision_${U}`,
    completeness: [],
  },
  error: {
    error: {
      code: "illegal-transition",
      message: "the node is not editable in its state",
      details: {
        refusal: "node-state",
        state: "running",
        admitted: ["ready", "running"],
      },
    },
  },
};

export const nodeDeleteExamples: OperationExamples = {
  request: { fromRevision: `revision_${U}` },
  success: {
    revision: `revision_${U}`,
    deleted: [`task_${U}`],
    completeness: [],
  },
  error: {
    error: {
      code: "binding-in-use",
      message: "the subtree is referenced by execution rows",
      details: { blockers: [{ nodeId: `task_${U}`, blocker: "run" }] },
    },
  },
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
      "invalid-request": planImportInvalidRequestDetails.optional(),
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
    query: nodeListQuery,
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
  {
    operationId: "node.create",
    method: "POST",
    path: [resource("project"), parameter("project"), sub("node")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    idempotency: "memory",
    replayable: [200],
    request: nodeCreateRequest,
    response: nodeCreateResponse,
    errors: {
      ...baselineErrors,
      "stale-revision": staleRevisionDetails,
      "plan-invalid": planInvalidDetails,
      "illegal-transition": illegalTransitionDetails,
      "binding-in-use": bindingInUseDetails,
    },
    examples: nodeCreateExamples,
  },
  {
    operationId: "node.update",
    method: "POST",
    path: [resource("node"), parameter("node"), action("update")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    idempotency: "memory",
    replayable: [200],
    request: nodeUpdateRequest,
    response: nodeUpdateResponse,
    errors: {
      ...baselineErrors,
      "stale-revision": staleRevisionDetails,
      "plan-invalid": planInvalidDetails,
      "illegal-transition": illegalTransitionDetails,
      "binding-in-use": bindingInUseDetails,
    },
    examples: nodeUpdateExamples,
  },
  {
    operationId: "node.delete",
    method: "POST",
    path: [resource("node"), parameter("node"), action("delete")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    idempotency: "memory",
    replayable: [200],
    request: nodeDeleteRequest,
    response: nodeDeleteResponse,
    errors: {
      ...baselineErrors,
      "stale-revision": staleRevisionDetails,
      "plan-invalid": planInvalidDetails,
      "illegal-transition": illegalTransitionDetails,
      "binding-in-use": bindingInUseDetails,
    },
    examples: nodeDeleteExamples,
  },
  {
    operationId: "project.nodes",
    method: "GET",
    path: [resource("project"), parameter("project"), sub("node")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    response: nodeListResponse,
    errors: { ...baselineErrors },
    examples: {
      success: nodeListExamples.success,
      error: nodeListExamples.error,
    },
  },
  {
    operationId: "project.graph",
    method: "GET",
    path: [resource("project"), parameter("project"), sub("graph")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: projectGraphResponse,
    errors: { ...baselineErrors },
    examples: {
      success: {
        attributes: {
          projectId: `project_${U}`,
          revision: `revision_${U}`,
        },
        options: {
          allowSelfLoops: false,
          multi: false,
          type: "directed",
        },
        nodes: [
          {
            key: `initiative_${U}`,
            attributes: {
              kind: "initiative",
              title: "atlas",
              state: "ready",
              blockReason: null,
              discardReason: null,
              parentId: null,
              repositoryId: null,
            },
          },
          {
            key: `objective_${U}`,
            attributes: {
              kind: "objective",
              title: "build the health route",
              state: "ready",
              blockReason: null,
              discardReason: null,
              parentId: `initiative_${U}`,
              repositoryId: `repo_${U}`,
            },
          },
          {
            key: `task_${U}`,
            attributes: {
              kind: "task",
              title: "add the health route",
              state: "ready",
              blockReason: null,
              discardReason: null,
              parentId: `objective_${U}`,
              repositoryId: null,
            },
          },
          {
            key: `task_${UB}`,
            attributes: {
              kind: "task",
              title: "add the health check",
              state: "done",
              blockReason: null,
              discardReason: null,
              parentId: `objective_${U}`,
              repositoryId: null,
            },
          },
        ],
        edges: [
          {
            key: `edge_${U}`,
            source: `task_${U}`,
            target: `task_${UB}`,
            attributes: {
              relation: "depends-on",
              waivedAt: null,
            },
          },
        ],
      },
      error: {
        error: { code: "not-found", message: `no project project_${U}` },
      },
    },
  },
]);
