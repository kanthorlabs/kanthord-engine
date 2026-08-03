import { z } from "zod";

import { identity } from "./identity.ts";
import { blobHash } from "./blob.ts";

export const planRevisionRow = z.object({
  id: identity("planRevision"),
  projectId: identity("project"),
  parentId: identity("planRevision").nullable(),
  importId: z.string(),
  submittedBlob: blobHash,
  choicesBlob: blobHash,
  acceptedBlob: blobHash,
});
export type PlanRevisionRow = z.infer<typeof planRevisionRow>;
