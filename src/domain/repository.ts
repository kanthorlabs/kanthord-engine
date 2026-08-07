import { z } from "zod";

import { identity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";

export const repositoryStates = ["ready", "needs-reconcile"] as const;

export const credentialFailures = ["auth-failed", "permission-denied"] as const;

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
    state: z.enum(repositoryStates),
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

export type RepositoryView = Readonly<{
  id: string;
  name: string;
  remoteUrl: string;
  credential: Readonly<{ id: string; name: string }>;
  upstreamBranch: string;
  landingBranch: string;
  landingRef: string;
  trackingRef: string;
  publishRef: string;
  publishOnApproval: boolean;
  state: "ready" | "needs-reconcile";
  landingOid: string | null;
  trackingOid: string | null;
  fetchedUpstreamOid: string | null;
  divergedLandingOid: string | null;
  divergedUpstreamOid: string | null;
  updatedAt: number;
}>;
