import { z } from "zod";

import { epochMillis } from "../../domain/column.ts";
import { nodeIdentity } from "../../domain/identity.ts";
import { leaseOwnerKinds } from "../../domain/lease.ts";
import { leaseRelations } from "../../domain/lease-hierarchy.ts";
import { choices } from "../../domain/plan-choice.ts";
import { credentialFailures } from "../../domain/repository.ts";
import { revisionGuardClasses } from "../../domain/revision-guard.ts";
import { runDrivers } from "../../domain/run.ts";
import {
  blockReasons,
  nodeStates,
  unblockRefusals,
} from "../../domain/state.ts";
import { planFinding } from "./plan-finding.ts";

const objectId = z.string().regex(/^[0-9a-f]{40}$/);

export const staleRevisionDetails = z.strictObject({
  guard: z.enum(revisionGuardClasses),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
});

export const needsReconcileDetails = z.strictObject({
  divergedLandingOid: objectId,
  divergedUpstreamOid: objectId,
});

export const bindingInUseDetails = z.strictObject({
  blockers: z
    .array(
      z.strictObject({
        nodeId: z.string(),
        blocker: z.string(),
      }),
    )
    .min(1),
});

export const illegalTransitionDetails = z.discriminatedUnion("refusal", [
  z.strictObject({
    refusal: z.literal("node-state"),
    state: z.enum(nodeStates),
    admitted: z.array(z.enum(nodeStates)).min(1),
  }),
  z.strictObject({
    refusal: z.literal("ancestor-not-startable"),
    ancestorId: nodeIdentity,
    state: z.enum(nodeStates),
    admitted: z.array(z.enum(nodeStates)).min(1),
  }),
  z.strictObject({
    refusal: z.literal("drive-mode-pinned"),
    pinnedDriver: z.enum(runDrivers),
    claimDriver: z.enum(runDrivers),
  }),
  z.strictObject({
    refusal: z.literal("run-driver"),
    runDriver: z.enum(runDrivers),
    expectedDriver: z.enum(runDrivers),
  }),
  z.strictObject({ refusal: z.literal("no-active-run") }),
  z.strictObject({ refusal: z.literal("children-not-terminal") }),
  z.strictObject({ refusal: z.literal("projection-discarded") }),
  z.strictObject({ refusal: z.literal("object-not-attested") }),
]);

export const idempotencyMismatchDetails = z.strictObject({
  differed: z.string(),
});

export const choicesStaleDetails = z.strictObject({
  conflicts: z.array(
    z.strictObject({ id: z.string(), suggested: z.enum(choices) }),
  ),
});

export const choicesChangedDetails = z.strictObject({
  conflicts: z.array(z.strictObject({ id: z.string(), reason: z.string() })),
});

export const planInvalidDetails = z.strictObject({
  findings: z.array(planFinding),
});

export const choicesInvalidDetails = z.strictObject({
  findings: z.array(planFinding),
});

export const hostKeyMismatchDetails = z.union([
  z.strictObject({
    presented: z.array(z.string()),
    confirmed: z.string().nullable(),
  }),
  z.strictObject({ failure: z.literal("host-key-mismatch") }),
]);

export const credentialRejectedDetails = z.strictObject({
  failure: z.enum(credentialFailures),
});

export const invalidRequestDetails = z.strictObject({
  refusal: z.string().min(1),
  detail: z.string().optional(),
  ids: z.array(z.string()).optional(),
});

export const leaseHeldDetails = z.discriminatedUnion("refusal", [
  z.strictObject({
    refusal: z.literal("held-by-other"),
    subject: nodeIdentity,
    holder: z.string().min(1),
    holderKind: z.enum(leaseOwnerKinds),
    fence: z.int(),
    expiresAt: epochMillis,
    relation: z.enum(leaseRelations),
  }),
  z.strictObject({
    refusal: z.literal("stale-fence"),
    subject: nodeIdentity,
    presentedFence: z.int(),
  }),
]);

export const nodeUnblockDetails = z.strictObject({
  refusal: z.enum(unblockRefusals),
  blockReason: z.enum(blockReasons).nullable(),
});
