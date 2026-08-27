import type { MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import type { Handler, HandlerContext } from "./app.ts";
import { compareBytewise } from "./bytewise.ts";
import { ThrownValueError } from "./envelope.ts";
import { readQuery } from "./query.ts";
import { demand, optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

export type DispatchDependencies = Readonly<{
  handlers: Readonly<Record<string, Handler>>;
}>;

export function dispatchMiddleware(
  dependencies: DispatchDependencies,
): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const match = demand(c, "match");
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
    const context: HandlerContext = {
      operation: match.operation,
      parameters: match.parameters,
      query: readQuery(new URL(c.req.url).search.slice(1)),
      headers: readHeaders(c.req.raw.headers),
      body: optional(c, "body"),
      actor: demand(c, "actor"),
    };
    let result: Awaited<ReturnType<Handler>>;
    try {
      result = await handler(context);
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw error;
      }
      throw new ThrownValueError(error);
    }
    const headers = demand(c, "headers");
    const resultHeaders = result.headers ?? {};
    for (const name of Object.keys(resultHeaders).sort(compareBytewise)) {
      headers.append(name, resultHeaders[name] as string);
    }
    c.set("result", result);
  };
}

function readHeaders(headers: Headers): Readonly<Record<string, string>> {
  const collected: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    collected[name] = value;
  }
  const result: Record<string, string> = {};
  for (const name of Object.keys(collected).sort(compareBytewise)) {
    const value = collected[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}
