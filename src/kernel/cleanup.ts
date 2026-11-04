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

export const FOOTPRINT_KEY_MAX_LENGTH = 512;
export const FOOTPRINT_CLEANUP_KEYS_MAX = 1000;
export const FOOTPRINT_REPORT_ITEMS_MAX = 10000;
export const TOOL_OUTPUT_NAME_PATTERN =
  /^pi-[a-z0-9-]+-[0-9a-f]{16}(\.[A-Za-z0-9]+)?$/;
export const WORKSPACE_KEY_PATTERN =
  /^(?:node|execution)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const InstanceFootprintKind = {
  Session: "session",
  Workspace: "workspace",
  ToolOutput: "tool_output",
  Log: "log",
  SlotResidue: "slot_residue",
} as const;
export type InstanceFootprintKind =
  (typeof InstanceFootprintKind)[keyof typeof InstanceFootprintKind];

export const InstanceCleanableKind = {
  Session: InstanceFootprintKind.Session,
  Workspace: InstanceFootprintKind.Workspace,
  ToolOutput: InstanceFootprintKind.ToolOutput,
} as const;
export type InstanceCleanableKind =
  (typeof InstanceCleanableKind)[keyof typeof InstanceCleanableKind];

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
