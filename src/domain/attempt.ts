import { z } from "zod";

import { identity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";

export const attemptOutcomes = [
  "accepted",
  "rejected",
  "failed",
  "timed-out",
  "cancelled",
] as const;
export const attemptOutcome = z.enum(attemptOutcomes);
export type AttemptOutcome = z.infer<typeof attemptOutcome>;

export const attemptRow = z.object({
  id: identity("attempt"),
  runId: identity("run"),
  attemptNo: z.int(),
  providerId: identity("provider"),
  providerModel: z.string(),
  timeoutMs: z.int(),
  baseOid: objectId,
  headOid: objectId.nullable(),
  outcome: attemptOutcome.nullable(),
  endedAt: epochMillis.nullable(),
});
export type AttemptRow = z.infer<typeof attemptRow>;
