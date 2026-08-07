import type { Context, Next } from "koa";

import { HttpError, errorEnvelope, httpError } from "../contract/errors.ts";

export type EnvelopeDependencies = Readonly<{
  onInternalError: (error: unknown) => void;
}>;

export type Materialized = Readonly<{
  status: number;
  body: unknown;
  internal: boolean;
}>;

export function materializeError(error: unknown): Materialized {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: errorEnvelope(error),
      internal: false,
    };
  }
  return {
    status: 500,
    body: errorEnvelope(httpError("internal-error", "internal error")),
    internal: true,
  };
}

export function envelopeMiddleware(
  dependencies: EnvelopeDependencies,
): (context: Context, next: Next) => Promise<void> {
  return async (context, next) => {
    try {
      await next();
    } catch (error: unknown) {
      const materialized = materializeError(error);
      if (materialized.internal) {
        dependencies.onInternalError(error);
      }
      context.status = materialized.status;
      context.body = materialized.body;
    }
  };
}
