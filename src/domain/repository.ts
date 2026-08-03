import { z } from "zod";

import { identity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";

export const repositoryRow = z
  .object({
    id: identity("repository"),
    name: z.string(),
    remoteUrl: z.string(),
    credentialId: identity("provider"),
    homePath: z.string(),
    upstreamBranch: z.string(),
    landingBranch: z.string(),
    publishRef: z.string(),
    publishOnApproval: z.int(),
    state: z.enum(["ready", "needs-reconcile"]),
    divergedLandingOid: objectId.nullable(),
    divergedUpstreamOid: objectId.nullable(),
    fetchedUpstreamOid: objectId.nullable(),
    updatedAt: epochMillis,
  })
  .refine(
    (row) =>
      (row.state === "needs-reconcile") ===
      (row.divergedLandingOid !== null && row.divergedUpstreamOid !== null),
    {
      message:
        "(state = 'needs-reconcile') = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)",
    },
  );
export type RepositoryRow = z.infer<typeof repositoryRow>;
