import { Buffer } from "node:buffer";

import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import type { Handler } from "./app.ts";
import { readQuery } from "./query.ts";
import type { RoutedState } from "./route.ts";

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
    });
    context.status = result.status;
    for (const name of Object.keys(result.headers ?? {}).sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )) {
      context.set(name, (result.headers ?? {})[name] as string);
    }
    context.body = result.body;
  };
}

function readHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const value = headers[name];
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}
