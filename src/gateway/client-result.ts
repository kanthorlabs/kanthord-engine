import { ulid } from "ulid";
import { errorSchema } from "../kernel/errors.ts";
import {
  OperationResultType,
  OperationLifetime,
  type Operation,
  type ClientOptions,
  type ServiceClient,
} from "../kernel/operation.ts";
import type { RecordedResponse } from "./idempotency.ts";
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
        try {
          const result = await call(operation, input, {
            ...options,
            idempotencyKey,
          });
          if (result.status === operation.status)
            return {
              type: OperationResultType.Completed,
              status: result.status,
              data:
                operation.lifetime === OperationLifetime.Stream &&
                result.body instanceof Response
                  ? result.body
                  : operation.output.parse(
                      JSON.parse(JSON.stringify(result.body)),
                    ),
              idempotencyKey,
            };
          return {
            type: OperationResultType.Failure,
            status: result.status,
            error: errorSchema.parse(result.body),
            idempotencyKey,
          };
        } catch {
          return { type: OperationResultType.Indeterminate, idempotencyKey };
        }
      },
    ]),
  ) as ServiceClient<T>;
}
