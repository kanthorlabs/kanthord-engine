import type { Context, Next } from "koa";

import { HttpError, errorEnvelope, httpError } from "../contract/errors.ts";

export type EnvelopeDependencies = Readonly<{
  onInternalError: (error: unknown) => void;
}>;

export function envelopeMiddleware(
  dependencies: EnvelopeDependencies,
): (context: Context, next: Next) => Promise<void> {
  return async (context, next) => {
    try {
      await next();
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        context.status = error.status;
        context.body = errorEnvelope(error);
        return;
      }
      dependencies.onInternalError(error);
      context.status = 500;
      context.body = errorEnvelope(
        httpError("internal-error", "internal error"),
      );
    }
  };
}
