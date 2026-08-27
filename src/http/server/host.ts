import type { MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import type { AppEnv } from "./variables.ts";

export type HostDependencies = Readonly<{
  allowedHosts: readonly string[];
}>;

export function hostMiddleware(
  dependencies: HostDependencies,
): MiddlewareHandler<AppEnv> {
  const allowed = new Set(
    dependencies.allowedHosts.map((entry) => entry.toLowerCase()),
  );
  return async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined) {
      throw httpError("host-forbidden", "the request carried no Host header");
    }
    if (!allowed.has(host.toLowerCase())) {
      throw httpError(
        "host-forbidden",
        `the Host header ${host} is outside the allow list`,
      );
    }
    await next();
  };
}
