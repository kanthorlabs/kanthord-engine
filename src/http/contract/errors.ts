import { z } from "zod";
import type { ZodType } from "zod";

import { baselineErrors } from "./error-baseline.ts";
import type { OperationErrors } from "./operation.ts";

export const errorStatuses = {
  "invalid-request": 400,
  unauthenticated: 401,
  "origin-forbidden": 403,
  "host-forbidden": 403,
  "actor-forbidden": 403,
  "not-found": 404,
  "stale-revision": 409,
  "illegal-transition": 409,
  "binding-in-use": 409,
  "needs-reconcile": 409,
  "acknowledgement-required": 409,
  "lease-held": 409,
  "idempotency-mismatch": 409,
  "choices-stale": 409,
  "choices-changed": 409,
  "host-key-mismatch": 409,
  "pair-illegal": 409,
  "assignment-held": 409,
  unroutable: 409,
  "review-head-unavailable": 409,
  "objective-busy": 409,
  "subtree-busy": 409,
  "run-not-found": 409,
  "run-ended": 409,
  "run-expired": 409,
  "run-caller-mismatch": 409,
  "target-outside-run": 409,
  "fence-stale": 409,
  "lifetime-exceeded": 409,
  "objective-run-lost": 409,
  "plan-invalid": 422,
  "choices-invalid": 422,
  "identity-kind-mismatch": 422,
  "credential-rejected": 422,
  "internal-error": 500,
  "not-implemented": 501,
  "service-unavailable": 503,
} as const;

export type ErrorCode = keyof typeof errorStatuses;

export type PreconditionCode = {
  [K in ErrorCode]: (typeof errorStatuses)[K] extends 409 ? K : never;
}[ErrorCode];

export type ErrorDetails = Readonly<Record<string, unknown>>;

export function buildErrorEnvelope(errors: OperationErrors): ZodType {
  const members = (Object.keys(errorStatuses) as ErrorCode[])
    .filter((code) => Object.hasOwn(errors, code))
    .map((code) => {
      const details = errors[code];
      return details === null || details === undefined
        ? z.strictObject({ code: z.literal(code), message: z.string() })
        : z.strictObject({
            code: z.literal(code),
            message: z.string(),
            details,
          });
    });

  return z.strictObject({
    error: z.discriminatedUnion(
      "code",
      members as [(typeof members)[number], ...(typeof members)[number][]],
    ),
  });
}

export type ErrorEnvelope = Readonly<{
  error: Readonly<{
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
  }>;
}>;

export const errorEnvelopeSchema = buildErrorEnvelope(baselineErrors);

export const daemonErrorEnvelopeSchema = z.strictObject({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = errorStatuses[code];
    this.details = details;
  }
}

export function httpError(
  code: PreconditionCode,
  message: string,
  details: ErrorDetails,
): HttpError;
export function httpError(
  code: Exclude<ErrorCode, PreconditionCode>,
  message: string,
  details?: ErrorDetails,
): HttpError;
export function httpError(
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
): HttpError {
  return new HttpError(code, message, details);
}

export function errorEnvelope(error: HttpError): ErrorEnvelope {
  if (error.details === undefined) {
    return { error: { code: error.code, message: error.message } };
  }
  return {
    error: { code: error.code, message: error.message, details: error.details },
  };
}
