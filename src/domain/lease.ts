import { z } from "zod";

import { anyIdentity } from "./identity.ts";
import { epochMillis } from "./column.ts";

export const leaseSubjectKinds = ["node", "repository"] as const;

export const leaseRow = z.object({
  subjectKind: z.enum(leaseSubjectKinds),
  subjectId: anyIdentity,
  owner: z.string().nullable(),
  fence: z.int(),
  acquiredAt: epochMillis.nullable(),
  renewedAt: epochMillis.nullable(),
  expiresAt: epochMillis.nullable(),
});
export type LeaseRow = z.infer<typeof leaseRow>;
