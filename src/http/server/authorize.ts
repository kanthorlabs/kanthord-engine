import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import type { AuthenticatedState } from "./auth.ts";
import type { RoutedState } from "./route.ts";

export function authorizeMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void> {
  return async (context, next) => {
    const match = (context.state as RoutedState).match;
    const actor = (context.state as AuthenticatedState).actor;
    if (!match.operation.allowedActors.includes(actor.kind)) {
      throw httpError(
        "actor-forbidden",
        `${match.operation.operationId} does not admit actor kind ${actor.kind}`,
      );
    }
    await next();
  };
}
