import { compareBytewise } from "./bytewise.ts";

export type StoredAnswer = Readonly<{
  status: number;
  body: string | Uint8Array | null;
  headers: readonly (readonly [string, string])[];
}>;

export const VOLATILE_HEADERS: readonly string[] = [
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "transfer-encoding",
];

export function headerSnapshot(
  accumulator: Headers,
): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  for (const [name, value] of accumulator.entries()) {
    snapshot.set(name.toLowerCase(), value);
  }
  return snapshot;
}

export function captureAnswer(
  accumulator: Headers,
  before: ReadonlyMap<string, string>,
  status: number,
  body: string | Uint8Array | null,
): StoredAnswer {
  const pairs: [string, string][] = [];
  for (const [name, value] of accumulator.entries()) {
    const lower = name.toLowerCase();
    if (VOLATILE_HEADERS.includes(lower)) continue;
    if (before.get(lower) === value) continue;
    pairs.push([lower, value]);
  }
  pairs.sort((a, b) => compareBytewise(a[0], b[0]));
  return { status, body, headers: pairs };
}
