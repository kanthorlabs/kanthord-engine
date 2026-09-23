import { z } from "zod";
import { CodedError, errorCodeSchema } from "../shared/errors.ts";
import { requestIdSchema } from "./request-id.ts";

export const errorDetailsSchema = z.json();
export const errorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    details: errorDetailsSchema.nullable(),
  }),
  requestId: requestIdSchema,
});
export type ErrorBody = z.infer<typeof errorSchema>;

export class GatewayError extends CodedError {
  readonly status: number;
  readonly details: z.infer<ReturnType<typeof z.json>> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: z.infer<ReturnType<typeof z.json>> | null = null,
  ) {
    super(code, message);
    this.status = status;
    this.details = details;
  }
}

export function failure(
  error: unknown,
  requestId: string,
): { status: number; body: ErrorBody } {
  const safe =
    error instanceof GatewayError
      ? error
      : new GatewayError(
          500,
          "gateway.invocation.unknown",
          "Internal server error.",
        );
  return {
    status: safe.status,
    body: {
      error: { code: safe.code, message: safe.message, details: safe.details },
      requestId,
    },
  };
}

/** The sole HTTP failure envelope, including middleware-owned responses. */
export function respondError(error: unknown, requestId: string): Response {
  const result = failure(error, requestId);
  return Response.json(result.body, { status: result.status });
}

export const unauthorized = () =>
  new GatewayError(
    401,
    "gateway.authentication.unauthorized",
    "Authentication required.",
  );
export const conflict = () =>
  new GatewayError(
    409,
    "gateway.idempotency.conflict",
    "The idempotency key cannot be replayed for this request.",
  );
