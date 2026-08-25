import type { MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

const EXPOSED_HEADERS = "etag, accept-ranges, content-range";

export type OriginDependencies = Readonly<{
  allowedOrigins: readonly string[];
}>;

export function originMiddleware(
  dependencies: OriginDependencies,
): MiddlewareHandler<AppEnv> {
  const allowed = new Set(dependencies.allowedOrigins);
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        throw httpError(
          "origin-forbidden",
          `the Origin header ${origin} is outside the allow list`,
        );
      }
      const headers = demand(c, "headers");
      headers.set("Access-Control-Allow-Origin", origin);
      if (c.req.method !== "OPTIONS") {
        headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
      }
      c.set("allowedOrigin", origin);
    }
    demand(c, "headers").append("vary", "Origin");
    await next();
  };
}
