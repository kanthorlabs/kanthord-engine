import { z } from "zod";

import { blobHash } from "./blob.ts";
import { epochMillis } from "./column.ts";
import { identity } from "./identity.ts";

export const profileRow = z.object({
  id: identity("profile"),
  repositoryId: identity("repository"),
  contentBlob: blobHash,
  updatedAt: epochMillis,
});

export type ProfileRow = z.infer<typeof profileRow>;
