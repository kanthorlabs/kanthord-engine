import { Buffer } from "node:buffer";

import { httpError } from "../contract/errors.ts";

export function singleValued(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, string>> {
  const keys = Object.keys(query).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const result: Record<string, string> = {};
  for (const key of keys) {
    const values = query[key] as readonly string[];
    if (values.length > 1) {
      throw httpError(
        "invalid-request",
        `the query parameter ${key} appeared more than once`,
      );
    }
    result[key] = values[0] as string;
  }
  return result;
}
