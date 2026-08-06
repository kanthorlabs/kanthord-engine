import { z } from "zod";

export const errorStatuses = {
  "invalid-request": 400,
  unauthenticated: 401,
  "origin-forbidden": 403,
  "host-forbidden": 403,
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

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

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
