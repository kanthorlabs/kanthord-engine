import { byteLength, compareBytewise } from "./bytewise.ts";

const encoder = new TextEncoder();

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const MAX_KEY_LENGTH = 255;

const KEY_GRAMMAR = /^[\x21-\x7E](?:[\x20-\x7E]{0,253}[\x21-\x7E])?$/;

export type KeyRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "ok"; key: string }>
  | Readonly<{ kind: "invalid"; message: string }>;

export function readIdempotencyKey(headers: Headers): KeyRead {
  const value = headers.get(IDEMPOTENCY_HEADER);

  if (value === null) {
    return { kind: "absent" };
  }

  if (value.includes(",")) {
    return {
      kind: "invalid",
      message: "Idempotency-Key was supplied more than once",
    };
  }

  if (!KEY_GRAMMAR.test(value)) {
    return {
      kind: "invalid",
      message:
        "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
    };
  }

  return { kind: "ok", key: value };
}

export type FingerprintInput = Readonly<{
  method: string;
  path: string;
  query: string;
  rawBody: string;
}>;

export async function fingerprint(input: FingerprintInput): Promise<string> {
  const parts = [input.method, input.path, input.query, input.rawBody];
  const joined = parts
    .map((part) => `${byteLength(part)}:${part}`)
    .join("\u0001");
  const data = encoder.encode(joined);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
