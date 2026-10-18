import { ulid } from "ulid";
import assert from "node:assert/strict";
import { z } from "zod";
import { resolveRequestId } from "./request-id.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  errorSchema,
  validationIssues,
  type ErrorBody,
} from "../kernel/errors.ts";
import {
  OperationResultType,
  OperationLifetime,
  type Operation,
  type ClientOptions,
  type ServiceClient,
} from "../kernel/operation.ts";
import type { RecordedResponse } from "./idempotency.ts";
export function inputValidationFailure(error: z.ZodError): RecordedResponse {
  assert.ok(error instanceof z.ZodError);
  const none = 0;
  assert.ok(error.issues.length > none);
  return {
    status: HttpStatus.BadRequest,
    body: {
      error: {
        code: "gateway.request.validation_failed",
        message: "Request validation failed.",
        details: validationIssues(error).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
        })),
      },
      request_id: resolveRequestId(),
    },
  };
}
function answerValidationFailure(error: z.ZodError): ErrorBody {
  assert.ok(error instanceof z.ZodError);
  const none = 0;
  assert.ok(error.issues.length > none);
  return {
    error: {
      code: "gateway.client.answer_invalid",
      message: "The answer fails the operation output schema.",
      details: error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
      })),
    },
    request_id: resolveRequestId(),
  };
}
export function createClient<T extends Record<string, Operation>>(
  operations: T,
  call: (
    operation: Operation,
    input: unknown,
    options: ClientOptions,
  ) => Promise<RecordedResponse>,
): ServiceClient<T> {
  return Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      async (input: unknown, options: ClientOptions = {}) => {
        const idempotencyKey = operation.mutation
          ? (options.idempotencyKey ?? ulid())
          : undefined;
        let result: RecordedResponse;
        try {
          result = await call(operation, input, {
            ...options,
            idempotencyKey,
          });
        } catch {
          return { type: OperationResultType.Indeterminate, idempotencyKey };
        }
        if (result.status === operation.status) {
          if (
            operation.lifetime === OperationLifetime.Stream &&
            result.body instanceof Response
          )
            return {
              type: OperationResultType.Completed,
              status: result.status,
              data: result.body,
              idempotencyKey,
            };
          const output = operation.output.safeParse(
            JSON.parse(JSON.stringify(result.body)),
          );
          if (output.success)
            return {
              type: OperationResultType.Completed,
              status: result.status,
              data: output.data,
              idempotencyKey,
            };
          return {
            type: OperationResultType.Failure,
            status: result.status,
            error: answerValidationFailure(output.error),
            idempotencyKey,
          };
        }
        const failure = errorSchema.safeParse(result.body);
        if (!failure.success)
          return { type: OperationResultType.Indeterminate, idempotencyKey };
        return {
          type: OperationResultType.Failure,
          status: result.status,
          error: failure.data,
          idempotencyKey,
        };
      },
    ]),
  ) as ServiceClient<T>;
}
