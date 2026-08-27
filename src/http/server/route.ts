import type { MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import { matchRoute } from "../contract/registry.ts";
import type { AppEnv } from "./variables.ts";

export function routeMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    const match = matchRoute(c.req.method, pathname);
    if (match === null) {
      throw httpError(
        "not-found",
        `no operation for ${c.req.method} ${pathname}`,
      );
    }
    c.set("match", match);
    await next();
  };
}
