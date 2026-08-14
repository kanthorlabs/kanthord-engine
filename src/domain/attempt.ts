import { z } from "zod";

import { identity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { runDrivers } from "./run.ts";

export const attemptOutcomes = [
  "accepted",
  "rejected",
  "failed",
  "timed-out",
  "cancelled",
] as const;
export const attemptOutcome = z.enum(attemptOutcomes);
export type AttemptOutcome = z.infer<typeof attemptOutcome>;

export const attemptRow = z
  .object({
    id: identity("attempt"),
    runId: identity("run"),
    attemptNo: z.int(),
    driver: z.enum(runDrivers),
    providerId: identity("provider").nullable(),
    providerModel: z.string().nullable(),
    timeoutMs: z.int().nullable(),
    baseOid: objectId.nullable(),
    headOid: objectId.nullable(),
    outcome: attemptOutcome.nullable(),
    endedAt: epochMillis.nullable(),
  })
  .refine(
    (row) =>
      row.driver === "internal"
        ? row.providerId !== null &&
          row.providerModel !== null &&
          row.timeoutMs !== null &&
          row.baseOid !== null
        : row.providerId === null &&
          row.providerModel === null &&
          row.timeoutMs === null &&
          row.baseOid === null,
    {
      message:
        "(driver = 'internal') = (provider_id IS NOT NULL AND provider_model IS NOT NULL AND timeout_ms IS NOT NULL AND base_oid IS NOT NULL)",
    },
  );
export type AttemptRow = z.infer<typeof attemptRow>;
