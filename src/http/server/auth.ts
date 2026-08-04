import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";

export function tokensMatch(configured: string, presented: string): boolean {
  const a = createHash("sha256").update(configured, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const space = header.indexOf(" ");
  if (space === -1) {
    return null;
  }
  const scheme = header.slice(0, space);
  const remainder = header.slice(space + 1);
  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }
  if (remainder === "") {
    return null;
  }
  return remainder;
}

export type AuthDependencies = Readonly<{
  token: string;
}>;

export function authMiddleware(
  dependencies: AuthDependencies,
): (context: Context, next: Next) => Promise<void> {
  return async (context, next) => {
    if (dependencies.token === "") {
      await next();
      return;
    }
    const presented = bearerToken(context.request.headers.authorization);
    if (presented === null) {
      throw httpError("unauthenticated", "no bearer token");
    }
    if (!tokensMatch(dependencies.token, presented)) {
      throw httpError("unauthenticated", "the bearer token is not valid");
    }
    await next();
  };
}
