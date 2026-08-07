import { Buffer } from "node:buffer";

export function readQuery(
  querystring: string,
): Readonly<Record<string, readonly string[]>> {
  const params = new URLSearchParams(querystring);
  const result: Record<string, string[]> = {};
  for (const [key, value] of params) {
    (result[key] ??= []).push(value);
  }
  const sorted: Record<string, readonly string[]> = {};
  for (const key of Object.keys(result).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    sorted[key] = result[key] as string[];
  }
  return sorted;
}
