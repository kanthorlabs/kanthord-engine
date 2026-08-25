import type { MiddlewareHandler } from "hono";

import { demand, optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

const ALLOWED_METHODS = "DELETE, GET, POST, PUT";
const ALLOWED_HEADERS =
  "authorization, content-type, idempotency-key, if-none-match, x-kanthord-client";
const MAX_AGE = "86400";

export function preflightMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const isPreflight =
      c.req.method === "OPTIONS" && optional(c, "allowedOrigin") !== undefined;
    if (!isPreflight) {
      await next();
      return;
    }
    const headers = demand(c, "headers");
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", MAX_AGE);
    c.set("result", { kind: "empty", status: 204 });
  };
}
