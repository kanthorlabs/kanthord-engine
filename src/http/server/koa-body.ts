import { Buffer } from "node:buffer";

import type { HandlerResult } from "./app.ts";

export function koaBody(result: HandlerResult): unknown {
  switch (result.kind) {
    case "json":
      return result.body;
    case "bytes":
      return Buffer.from(
        result.bytes.buffer,
        result.bytes.byteOffset,
        result.bytes.byteLength,
      );
    case "empty":
      return undefined;
  }
}
