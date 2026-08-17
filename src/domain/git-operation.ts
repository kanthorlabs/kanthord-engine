import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { blobHash } from "./blob.ts";

export const gitIntents = ["merge", "sync", "publish", "revert"] as const;
export type GitIntent = (typeof gitIntents)[number];

export const gitOperationRow = z
  .object({
    id: identity("gitOperation"),
    repositoryId: identity("repository"),
    intent: z.enum(gitIntents),
    nodeId: nodeIdentity.nullable(),
    runId: identity("run").nullable(),
    candidateId: identity("candidate").nullable(),
    leaseFence: z.int(),
    ref: z.string(),
    baseOid: objectId,
    proposedHeadOid: objectId,
    resultHeadOid: objectId.nullable(),
    expectedRemoteOid: objectId.nullable(),
    state: z.enum(["open", "complete", "discarded"]),
    outcome: z.string().nullable(),
    detailBlob: blobHash.nullable(),
    childToken: z.string().nullable(),
    completedAt: epochMillis.nullable(),
  })
  .refine((row) => row.state === "open" || row.childToken === null, {
    message: "a child token is recorded only while state = 'open'",
  });
export type GitOperationRow = z.infer<typeof gitOperationRow>;
