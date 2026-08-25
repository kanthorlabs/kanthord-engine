import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import type { Handler } from "./app.ts";
import type { AuthenticatedState } from "./auth.ts";
import { compareBytewise } from "./bytewise.ts";
import { readQuery } from "./query.ts";
import type { RoutedState } from "./route.ts";
import { koaBody } from "./koa-body.ts";

export type DispatchDependencies = Readonly<{
  handlers: Readonly<Record<string, Handler>>;
}>;

export function dispatchMiddleware(
  dependencies: DispatchDependencies,
): (context: Context, next: Next) => Promise<void> {
  return async (context) => {
    const match = (context.state as RoutedState).match;
    if (match.operation.status === "stubbed") {
      throw httpError(
        "not-implemented",
        `${match.operation.operationId} ships in ${match.operation.introducedIn}`,
      );
    }
    const handler = dependencies.handlers[match.operation.operationId];
    if (handler === undefined) {
      throw httpError(
        "not-implemented",
        `${match.operation.operationId} is not implemented yet`,
      );
    }
    const result = await handler({
      operation: match.operation,
      parameters: match.parameters,
      query: readQuery(context.querystring),
      headers: readHeaders(context.headers),
      body: context.request.body,
      actor: (context.state as AuthenticatedState).actor,
    });
    switch (result.kind) {
      case "json":
        context.set("Content-Type", "application/json; charset=utf-8");
        break;
      case "bytes": {
        const media = match.operation.responseMedia;
        if (media === undefined) {
          throw httpError(
            "internal-error",
            `bytes result for ${match.operation.operationId} requires responseMedia`,
          );
        }
        context.set("Content-Type", media);
        break;
      }
      case "empty":
        break;
    }
    for (const name of Object.keys(result.headers ?? {}).sort(
      compareBytewise,
    )) {
      context.set(name, (result.headers ?? {})[name] as string);
    }
    context.status = result.status;
    if (result.kind !== "empty") {
      context.body = koaBody(result);
    }
  };
}

function readHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers).sort(compareBytewise)) {
    const value = headers[name];
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}
