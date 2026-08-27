import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "./variables.ts";

export function headersMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("headers", new Headers());
    await next();
  };
}
