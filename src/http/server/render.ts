import type { Context, MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import type { Operation } from "../contract/operation.ts";
import type { HandlerResult, HandlerStatus } from "./app.ts";
import { VariableError, demand, optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

export type MaterializedResult = Readonly<{
  status: HandlerStatus;
  body: string | Uint8Array | null;
}>;

export function materializeResult(
  result: HandlerResult,
  operation: Operation | undefined,
  headers: Headers,
): MaterializedResult {
  switch (result.kind) {
    case "json": {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      const serialized = JSON.stringify(result.body);
      if (serialized === undefined) {
        throw new TypeError("the handler result is not json serializable");
      }
      return { status: result.status, body: serialized };
    }
    case "bytes": {
      if (operation?.responseMedia === undefined) {
        throw httpError(
          "internal-error",
          operation === undefined
            ? "bytes result requires responseMedia"
            : `bytes result for ${operation.operationId} requires responseMedia`,
        );
      }
      if (!headers.has("content-type")) {
        headers.set("content-type", operation.responseMedia);
      }
      return { status: result.status, body: result.bytes };
    }
    case "empty":
      return { status: result.status, body: null };
  }
}

export function renderMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.error !== undefined) {
      return;
    }
    const replay = optional(c, "replay");
    if (replay !== undefined) {
      const headers = demand(c, "headers");
      for (const [name, value] of replay.headers) {
        headers.set(name, value);
      }
      return new Response(replay.body, {
        status: replay.status,
        headers,
      });
    }
    const result = optional(c, "result");
    if (result !== undefined) {
      const headers = demand(c, "headers");
      const operation = result.kind === "bytes" ? matchOperation(c) : undefined;
      const materialized = materializeResult(result, operation, headers);
      return new Response(materialized.body, {
        status: materialized.status,
        headers,
      });
    }
    throw httpError("internal-error", "the transport produced no result");
  };
}

function matchOperation(context: Context<AppEnv>): Operation | undefined {
  try {
    return demand(context, "match").operation;
  } catch (error: unknown) {
    if (!(error instanceof VariableError)) throw error;
    return undefined;
  }
}
