import { z } from "zod";

import { anyIdentity } from "./identity.ts";
import { epochMillis } from "./column.ts";

export const leaseRow = z.object({
  subjectKind: z.enum(["node", "repository"]),
  subjectId: anyIdentity,
  owner: z.string().nullable(),
  fence: z.int(),
  acquiredAt: epochMillis.nullable(),
  renewedAt: epochMillis.nullable(),
  expiresAt: epochMillis.nullable(),
});
export type LeaseRow = z.infer<typeof leaseRow>;
