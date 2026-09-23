import { createHash, hkdfSync } from "node:crypto";
import { z } from "zod";
import { isObject, isString, ValueType } from "./values.ts";

export const timestamp = z
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Unix timestamp in milliseconds since 1970-01-01T00:00:00Z (UTC).");

/** RFC 8785: emit members directly, including numeric-looking names. */
export function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  if (isString(value)) {
    if (!value.isWellFormed()) throw new TypeError("Invalid Unicode.");
    return JSON.stringify(value);
  }
  if (typeof value === ValueType.Boolean) return JSON.stringify(value);
  if (typeof value === ValueType.Number && Number.isFinite(value))
    return JSON.stringify(value);
  if (!isObject(value)) throw new TypeError("Expected JSON data.");
  if ("toJSON" in value)
    throw new TypeError("Custom serialization is forbidden.");
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) throw new TypeError("Sparse array.");
      entries.push(canonicalJSON(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError("Expected a JSON object.");
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${canonicalJSON(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJSON(value), "utf8")
    .digest("hex");
}

export function deriveKey(masterKey: string, label: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKey, "base64"),
      Buffer.alloc(0),
      label,
      32,
    ),
  );
}
