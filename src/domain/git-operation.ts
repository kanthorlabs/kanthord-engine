import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { blobHash } from "./blob.ts";

export const gitOperationRow = z.object({
  id: identity("gitOperation"),
  repositoryId: identity("repository"),
  intent: z.enum(["merge", "sync", "publish", "revert"]),
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
  completedAt: epochMillis.nullable(),
});
export type GitOperationRow = z.infer<typeof gitOperationRow>;
