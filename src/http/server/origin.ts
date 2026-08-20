import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";

const EXPOSED_HEADERS = "etag, accept-ranges, content-range";

export type OriginDependencies = Readonly<{
  allowedOrigins: readonly string[];
}>;

export type OriginState = Readonly<{ allowedOrigin: string | undefined }>;

export function originMiddleware(
  dependencies: OriginDependencies,
): (context: Context, next: Next) => Promise<void> {
  const allowed = new Set(dependencies.allowedOrigins);
  return async (context, next) => {
    const origin = context.request.headers.origin;
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        throw httpError(
          "origin-forbidden",
          `the Origin header ${origin} is outside the allow list`,
        );
      }
      context.set("Access-Control-Allow-Origin", origin);
      if (context.method !== "OPTIONS") {
        context.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
      }
      context.state.allowedOrigin = origin;
    }
    try {
      await next();
    } finally {
      context.vary("Origin");
    }
  };
}
