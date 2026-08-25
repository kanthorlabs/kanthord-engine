import type { MiddlewareHandler } from "hono";

import { httpError } from "../contract/errors.ts";
import type { Handler } from "./app.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

export const BODY_LIMIT_BYTES = 1_048_576;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const ADMITTED_MEDIA_TYPES = new Set([
  "application/json",
  "application/json-patch+json",
  "application/vnd.api+json",
  "application/csp-report",
  "application/reports+json",
  "application/scim+json",
]);

export function bodyMiddleware(
  handlers: Readonly<Record<string, Handler>>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!BODY_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    const match = demand(c, "match");
    if (
      match.operation.status === "stubbed" ||
      handlers[match.operation.operationId] === undefined
    ) {
      await next();
      return;
    }
    const mediaType = c.req
      .header("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (mediaType === undefined || !ADMITTED_MEDIA_TYPES.has(mediaType)) {
      c.set("body", {});
      await next();
      return;
    }
    const declaredLength = c.req.raw.headers.get("content-length");
    const length = declaredLength === null ? undefined : Number(declaredLength);
    if (
      length !== undefined &&
      Number.isInteger(length) &&
      length > BODY_LIMIT_BYTES
    ) {
      throw new Error("request body exceeds the limit");
    }
    const text = await readBody(c.req.raw.body);
    c.set("rawBody", text);
    if (text === "") {
      c.set("body", {});
      await next();
      return;
    }
    if (!opensJsonObjectOrArray(text)) {
      throw httpError("invalid-request", "the request body is not valid json");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw httpError(
          "invalid-request",
          "the request body is not valid json",
        );
      }
      throw error;
    }
    c.set("body", body);
    await next();
  };
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      throw new Error("request body exceeds the limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function opensJsonObjectOrArray(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (
      character !== "\x20" &&
      character !== "\x09" &&
      character !== "\x0a" &&
      character !== "\x0d"
    ) {
      break;
    }
    index += 1;
  }
  const first = text[index];
  return first === "[" || first === "{";
}
