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

const UNAUTHORIZED_STATUS = 401;
const UNAUTHORIZED_CODE = "gateway.authentication.unauthorized";
const UNAUTHORIZED_MESSAGE = "Authentication required.";
export const unauthorized = () =>
  new GatewayError(
    UNAUTHORIZED_STATUS,
    UNAUTHORIZED_CODE,
    UNAUTHORIZED_MESSAGE,
  );
export class WorkerGroupEnded extends GatewayError {
  constructor() {
    super(UNAUTHORIZED_STATUS, UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE);
  }
}
export const JwtCause = {
  UnknownClaim: "unknown_claim",
  MissingClaim: "missing_claim",
  ForbiddenClaim: "forbidden_claim",
  InvalidType: "invalid_type",
  Expired: "expired",
  NotYetIssued: "not_yet_issued",
  InstanceEnded: "instance_ended",
  InstanceRequired: "instance_required",
  ConnectionSuperseded: "connection_superseded",
  InstanceNotListed: "instance_not_listed",
} as const;
export type JwtCause = (typeof JwtCause)[keyof typeof JwtCause];
const JWT_MESSAGES: Record<JwtCause, string> = {
  [JwtCause.UnknownClaim]: "The token holds an unknown claim.",
  [JwtCause.MissingClaim]: "The token lacks a required claim.",
  [JwtCause.ForbiddenClaim]: "The token holds a claim that its kind forbids.",
  [JwtCause.InvalidType]: "A claim of the token has an invalid value.",
  [JwtCause.Expired]: "The token expired.",
  [JwtCause.NotYetIssued]: "The token is issued after the verification time.",
  [JwtCause.InstanceEnded]: "The worker instance revision ended.",
  [JwtCause.InstanceRequired]:
    "A binding at the worker placement requires instance_id and connection_id.",
  [JwtCause.ConnectionSuperseded]:
    "Another connection of the worker instance is current.",
  [JwtCause.InstanceNotListed]:
    "The binding does not list the worker instance.",
};
export const jwtRefused = (cause: JwtCause) =>
  new GatewayError(401, `gateway.jwt.${cause}`, JWT_MESSAGES[cause]);
export const conflict = () =>
  new GatewayError(
    409,
    "gateway.idempotency.conflict",
    "The idempotency key cannot be replayed for this request.",
  );
