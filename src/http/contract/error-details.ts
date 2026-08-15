import { z } from "zod";

import { choices } from "../../domain/plan-choice.ts";
import { credentialFailures } from "../../domain/repository.ts";
import { revisionGuardClasses } from "../../domain/revision-guard.ts";
import { nodeStates } from "../../domain/state.ts";
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

export const illegalTransitionDetails = z.strictObject({
  nodes: z.array(
    z.strictObject({
      id: z.string(),
      state: z.enum(nodeStates),
    }),
  ),
});

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
