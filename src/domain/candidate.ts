import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { blobHash } from "./blob.ts";

export const candidateRow = z
  .object({
    id: identity("candidate"),
    nodeId: nodeIdentity,
    runId: identity("run"),
    workspaceId: identity("workspace"),
    revision: z.string(),
    candidateOid: objectId,
    landingBaseOid: objectId,
    mergeOid: objectId.nullable(),
    projectedOutcome: z.enum(["done", "partial"]),
    evidenceBlob: blobHash,
    profileBlob: blobHash,
    conventionVersion: z.string(),
    state: z.enum(["open", "approved", "invalidated"]),
    acknowledgedPartial: z.int().nullable(),
    publishRequested: z.int().nullable(),
    approvedActor: z.string().nullable(),
    approvedAt: epochMillis.nullable(),
    invalidatedAt: epochMillis.nullable(),
    invalidatedReason: z.string().nullable(),
    updatedAt: epochMillis,
  })
  .refine(
    (row) =>
      row.state !== "approved" ||
      row.projectedOutcome === "done" ||
      row.acknowledgedPartial === 1,
    {
      message:
        "state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial = 1",
    },
  );
export type CandidateRow = z.infer<typeof candidateRow>;
