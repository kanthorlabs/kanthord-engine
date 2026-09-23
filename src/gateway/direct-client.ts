import type { Operation, ServiceClient } from "../kernel/operation.ts";
import type { Invocation } from "./invocation.ts";
import { createClient } from "./client-result.ts";
export function directClient<T extends Record<string, Operation>>(
  operations: T,
  invocation: Invocation,
): ServiceClient<T> {
  return createClient(operations, (operation, input, options) =>
    invocation.invoke(operation.id, input, options),
  );
}
