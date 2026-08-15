import type { Context, Next } from "koa";

import type { ActorRow } from "../../domain/actor.ts";
import { httpError } from "../contract/errors.ts";

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

export type AuthenticatedState = Readonly<{ actor: ActorRow }>;

export function authMiddleware(
  dependencies: AuthDependencies,
): (context: Context, next: Next) => Promise<void> {
  return async (context, next) => {
    if (dependencies.token === "") {
      const actor = dependencies.resolveActor("");
      if (actor === null) {
        throw httpError("internal-error", "the database holds no actor row");
      }
      context.state.actor = actor;
      await next();
      return;
    }
    const presented = bearerToken(context.request.headers.authorization);
    if (presented === null) {
      throw httpError("unauthenticated", "no bearer token");
    }
    const actor = dependencies.resolveActor(presented);
    if (actor === null) {
      throw httpError("unauthenticated", "the bearer token is not valid");
    }
    context.state.actor = actor;
    await next();
  };
}
