import type { Context, Next } from "koa";

import type { OriginState } from "./origin.ts";

const ALLOWED_METHODS = "DELETE, GET, POST, PUT";
const ALLOWED_HEADERS =
  "authorization, content-type, idempotency-key, if-none-match, x-kanthord-client";
const MAX_AGE = "86400";

export function preflightMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void> {
  return async (context, next) => {
    const isPreflight =
      context.method === "OPTIONS" &&
      (context.state as OriginState).allowedOrigin !== undefined;
    if (!isPreflight) {
      await next();
      return;
    }
    context.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    context.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    context.set("Access-Control-Max-Age", MAX_AGE);
    context.status = 204;
  };
}
