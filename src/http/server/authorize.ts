import type { MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

export function authorizeMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = demand(c, "match");
    const actor = demand(c, "actor");
    if (!match.operation.allowedActors.includes(actor.kind)) {
      throw httpError(
        "actor-forbidden",
        `${match.operation.operationId} does not admit actor kind ${actor.kind}`,
      );
    }
    await next();
  };
}
