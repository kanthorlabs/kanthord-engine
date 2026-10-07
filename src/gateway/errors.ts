import { OperationError, type ErrorBody } from "../kernel/errors.ts";
export { OperationError as GatewayError } from "../kernel/errors.ts";
import { OperationError as GatewayError } from "../kernel/errors.ts";
export function failure(
  error: unknown,
  requestId: string,
): { status: number; body: ErrorBody } {
  const safe =
    error instanceof OperationError
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
      request_id: requestId,
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
