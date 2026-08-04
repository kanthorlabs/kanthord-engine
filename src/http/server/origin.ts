import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";

export function originMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void> {
  return async (context, next) => {
    if (context.request.headers.origin !== undefined) {
      throw httpError(
        "origin-forbidden",
        "the request carried an Origin header",
      );
    }
    await next();
  };
}
