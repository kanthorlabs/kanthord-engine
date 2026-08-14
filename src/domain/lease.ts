import { z } from "zod";

import { anyIdentity } from "./identity.ts";
import { epochMillis } from "./column.ts";

export const leaseSubjectKinds = ["node", "repository"] as const;

export const leaseOwnerKinds = ["daemon", "actor"] as const;
export type LeaseOwnerKind = (typeof leaseOwnerKinds)[number];

export const leaseRow = z
  .object({
    subjectKind: z.enum(leaseSubjectKinds),
    subjectId: anyIdentity,
    owner: z.string().nullable(),
    ownerKind: z.enum(leaseOwnerKinds).nullable(),
    fence: z.int(),
    acquiredAt: epochMillis.nullable(),
    renewedAt: epochMillis.nullable(),
    expiresAt: epochMillis.nullable(),
  })
  .refine((row) => (row.owner === null) === (row.ownerKind === null), {
    message: "(owner IS NULL) = (owner_kind IS NULL)",
  });
export type LeaseRow = z.infer<typeof leaseRow>;
