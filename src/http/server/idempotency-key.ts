import { createHash } from "node:crypto";

import { compareBytewise } from "./bytewise.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const MAX_KEY_LENGTH = 255;

const KEY_GRAMMAR = /^[\x21-\x7E](?:[\x20-\x7E]{0,253}[\x21-\x7E])?$/;

export type KeyRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "ok"; key: string }>
  | Readonly<{ kind: "invalid"; message: string }>;

export type RawHeaderSource = Readonly<{ rawHeaders: readonly string[] }>;

export function readIdempotencyKey(source: RawHeaderSource): KeyRead {
  const values: string[] = [];
  for (let i = 0; i < source.rawHeaders.length; i += 2) {
    if (source.rawHeaders[i]?.toLowerCase() === IDEMPOTENCY_HEADER) {
      values.push(source.rawHeaders[i + 1] ?? "");
    }
  }

  if (values.length === 0) {
    return { kind: "absent" };
  }

  if (values.length > 1) {
    return {
      kind: "invalid",
      message: "Idempotency-Key was supplied more than once",
    };
  }

  if (!KEY_GRAMMAR.test(values[0]!)) {
    return {
      kind: "invalid",
      message:
        "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
    };
  }

  return { kind: "ok", key: values[0]! };
}

export type FingerprintInput = Readonly<{
  method: string;
  path: string;
  query: string;
  rawBody: string;
}>;

export function fingerprint(input: FingerprintInput): string {
  const parts = [input.method, input.path, input.query, input.rawBody];
  const joined = parts
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("\u0001");
  return createHash("sha256").update(Buffer.from(joined, "utf8")).digest("hex");
}

export type RecordKeyInput = Readonly<{
  operationId: string;
  parameters: Readonly<Record<string, string>>;
  actorId: string;
  key: string;
}>;

export function recordKey(input: RecordKeyInput): string {
  const names = Object.keys(input.parameters).sort(compareBytewise);
  const rendered = names
    .map((name) => `${name}=${input.parameters[name] ?? ""}`)
    .join("\u0001");
  return `${input.operationId}�${rendered}�${input.actorId}�${input.key}`;
}
