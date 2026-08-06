import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";
import { blobHash } from "../../domain/blob.ts";
import { choices } from "../../domain/plan-choice.ts";
import { findingCodes } from "../../domain/plan-finding.ts";
import { blockReasons, nodeKinds, nodeStates } from "../../domain/state.ts";

export const planDocument = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const planExportResponse = z.object({
  revision: z.string().nullable(),
  documents: z.array(planDocument),
});

export const planRevisionEntry = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  importId: z.string(),
  submittedBlob: blobHash,
  choicesBlob: blobHash,
  acceptedBlob: blobHash,
});

export const planRevisionsResponse = z.object({
  revisions: z.array(planRevisionEntry),
});

export const planFinding = z.object({
  code: z.enum(findingCodes),
  path: z.string().nullable(),
  id: z.string().nullable(),
  message: z.string(),
});

export const planChoiceEntry = z.object({
  id: z.string(),
  kind: z.enum(nodeKinds),
  presence: z.enum(["both", "document-only", "database-only"]),
  state: z.enum(nodeStates).nullable(),
  suggested: z.enum(choices),
  fields: z.array(
    z.enum(["body", "depends_on", "parent", "repo", "title", "worker"]),
  ),
  submitted: z.object({ legal: z.boolean(), reason: z.string().nullable() }),
  database: z.object({ legal: z.boolean(), reason: z.string().nullable() }),
});

export const planValidateRequest = z.object({
  fromRevision: z.string().nullable(),
  documents: z.array(planDocument).min(1),
});

export const planValidateResponse = z.object({
  findings: z.array(planFinding),
  documents: z.array(planDocument),
  documentsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  revision: z.string().nullable(),
  choices: z.array(planChoiceEntry),
});

export const planImportRequest = z.object({
  fromRevision: z.string().nullable(),
  importId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\x21-\x7E](?:[\x20-\x7E]{0,98}[\x21-\x7E])?$/),
  documents: z.array(planDocument).min(1),
  choices: z.array(z.object({ id: z.string().min(1), take: z.enum(choices) })),
  validatedRevision: z.string().nullable(),
  documentsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const planImportResponse = z.object({
  revision: z.string(),
  documents: z.array(planDocument),
  absent: z.array(z.string()),
});

export const nodeListItem = z.object({
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

export const nodeListResponse = z.object({ nodes: z.array(nodeListItem) });

export const nodeShowResponse = nodeListItem.extend({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
  worker: z.string().nullable(),
  repositoryId: z.string().nullable(),
  revision: z.string(),
  updatedAt: z.number(),
});

export const edgeView = z.object({
  id: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  waivedAt: z.number().nullable(),
});

export const edgeListResponse = z.object({ edges: z.array(edgeView) });

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
    request: planValidateRequest,
    response: planValidateResponse,
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
    request: planImportRequest,
    response: planImportResponse,
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
    response: planExportResponse,
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
    response: planRevisionsResponse,
  },
  {
    operationId: "node.list",
    method: "GET",
    path: [resource("node")],
    introducedIn: "phase-1",
    status: "routed",
    response: nodeListResponse,
  },
  {
    operationId: "node.show",
    method: "GET",
    path: [resource("node"), parameter("node")],
    introducedIn: "phase-1",
    status: "routed",
    response: nodeShowResponse,
  },
  {
    operationId: "edge.list",
    method: "GET",
    path: [resource("project"), parameter("project"), sub("edge")],
    introducedIn: "phase-1",
    status: "routed",
    response: edgeListResponse,
  },
]);
