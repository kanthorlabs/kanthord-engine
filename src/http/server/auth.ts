import type { MiddlewareHandler } from "hono";

import type { ActorRow } from "../../domain/actor.ts";
import { httpError } from "../contract/errors.ts";
import type { AppEnv } from "./variables.ts";

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
  resolveActor: (presented: string) => ActorRow | null;
}>;

export function authMiddleware(
  dependencies: AuthDependencies,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (dependencies.token === "") {
      const actor = dependencies.resolveActor("");
      if (actor === null) {
        throw httpError("internal-error", "the database holds no actor row");
      }
      c.set("actor", actor);
      await next();
      return;
    }
    const presented = bearerToken(c.req.header("authorization"));
    if (presented === null) {
      throw httpError("unauthenticated", "no bearer token");
    }
    const actor = dependencies.resolveActor(presented);
    if (actor === null) {
      throw httpError("unauthenticated", "the bearer token is not valid");
    }
    c.set("actor", actor);
    await next();
  };
}
