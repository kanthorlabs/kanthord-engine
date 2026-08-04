import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";

export type HostDependencies = Readonly<{
  allowedHosts: readonly string[];
}>;

export function hostMiddleware(
  dependencies: HostDependencies,
): (context: Context, next: Next) => Promise<void> {
  const allowed = new Set(
    dependencies.allowedHosts.map((entry) => entry.toLowerCase()),
  );
  return async (context, next) => {
    const host = context.request.headers.host;
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
