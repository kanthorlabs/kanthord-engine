import { z } from "zod";
import { type HumanActor, humanActorSchema } from "./actor.ts";
import {
  type CallerIdentity,
  isHumanIdentity,
  isServiceIdentity,
} from "./caller.ts";
import { OperationError } from "./errors.ts";
import { HttpStatus } from "./http.ts";

export const CLEANUP_BATCH_ROWS = 20;
export const FOOTPRINT_SERVICE = "footprint";
export const CLEANUP_SERVICES: readonly string[] = [FOOTPRINT_SERVICE];

export const CleanupRefusal = {
  Live: "live",
  Unreadable: "unreadable",
} as const;
export type CleanupRefusal =
  (typeof CleanupRefusal)[keyof typeof CleanupRefusal];

export const cleanupRefusedSchema = z.strictObject({
  key: z.string(),
  reason: z.enum(CleanupRefusal),
});
export type CleanupRefused = z.infer<typeof cleanupRefusedSchema>;

export const ownerDeleteAnswerSchema = z.strictObject({
  removed: z.int().min(0),
  absent: z.int().min(0),
  refused: z.array(cleanupRefusedSchema),
});
export type OwnerDeleteAnswer = z.infer<typeof ownerDeleteAnswerSchema>;

export const requestedByField = {
  requested_by: humanActorSchema.optional(),
};

function requestedByInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    "gateway.request.validation_failed",
    "Request validation failed.",
    [{ path: ["body", "requested_by"], code: "custom" }],
  );
}

export function requesterOf(
  identity: CallerIdentity | undefined,
  requestedBy: HumanActor | undefined,
): HumanActor {
  if (isHumanIdentity(identity)) {
    if (requestedBy !== undefined) throw requestedByInvalid();
    return { kind: "human", account: identity.accountId, name: identity.name };
  }
  if (isServiceIdentity(identity) && requestedBy !== undefined)
    return requestedBy;
  throw requestedByInvalid();
}
