import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import { matchRoute } from "../contract/registry.ts";
import type { RouteMatch } from "../contract/registry.ts";

export type RoutedState = Readonly<{ match: RouteMatch }>;

export function routeMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void> {
  return async (context, next) => {
    const match = matchRoute(context.method, context.path);
    if (match === null) {
      throw httpError(
        "not-found",
        `no operation for ${context.method} ${context.path}`,
      );
    }
    context.state.match = match;
    await next();
  };
}
