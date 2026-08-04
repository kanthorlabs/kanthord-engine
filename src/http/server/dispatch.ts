import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import type { Handler } from "./app.ts";
import type { RoutedState } from "./route.ts";

export type DispatchDependencies = Readonly<{
  handlers: Readonly<Record<string, Handler>>;
}>;

export function dispatchMiddleware(
  dependencies: DispatchDependencies,
): (context: Context, next: Next) => Promise<void> {
  return async (context) => {
    const match = (context.state as RoutedState).match;
    if (match.operation.status === "stubbed") {
      throw httpError(
        "not-implemented",
        `${match.operation.operationId} ships in ${match.operation.introducedIn}`,
      );
    }
    const handler = dependencies.handlers[match.operation.operationId];
    if (handler === undefined) {
      throw httpError(
        "not-implemented",
        `${match.operation.operationId} is not implemented yet`,
      );
    }
    const result = await handler({
      operation: match.operation,
      parameters: match.parameters,
      body: context.request.body,
    });
    context.status = result.status;
    context.body = result.body;
  };
}
