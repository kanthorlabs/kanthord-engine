import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { blobHash } from "./blob.ts";

export const workspaceRow = z.object({
  id: identity("workspace"),
  nodeId: nodeIdentity,
  repositoryId: identity("repository"),
  path: z.string(),
  cloneBaseOid: objectId,
  upstreamOidAtClone: objectId,
  profileBlob: blobHash,
  conventionVersion: z.string(),
  ambientBlob: blobHash.nullable(),
  state: z.string(),
  updatedAt: epochMillis,
});
export type WorkspaceRow = z.infer<typeof workspaceRow>;
