import type { Context } from "koa";

import { compareBytewise } from "./bytewise.ts";

export type StoredAnswer = Readonly<{
  status: number;
  body: unknown;
  headers: readonly (readonly [string, readonly string[]])[];
}>;

export const VOLATILE_HEADERS: readonly string[] = [
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "transfer-encoding",
];

function renderValue(value: string | string[] | number | undefined): string {
  return JSON.stringify(
    Array.isArray(value) ? value.map(String) : [String(value)],
  );
}

export function headerSnapshot(context: Context): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  for (const [name, value] of Object.entries(context.response.headers)) {
    snapshot.set(name.toLowerCase(), renderValue(value));
  }
  return snapshot;
}

export function captureAnswer(
  context: Context,
  before: ReadonlyMap<string, string>,
  status: number,
  body: unknown,
): StoredAnswer {
  const pairs: [string, readonly string[]][] = [];
  for (const [name, value] of Object.entries(context.response.headers)) {
    const lower = name.toLowerCase();
    if (VOLATILE_HEADERS.includes(lower)) continue;
    const rendered = renderValue(value);
    if (before.get(lower) === rendered) continue;
    pairs.push([
      lower,
      Array.isArray(value) ? value.map(String) : [String(value)],
    ]);
  }
  pairs.sort((a, b) => compareBytewise(a[0], b[0]));
  return { status, body, headers: pairs };
}

export function applyAnswer(context: Context, answer: StoredAnswer): void {
  for (const [name, values] of answer.headers) {
    context.set(
      name,
      values.length === 1 ? (values[0] as string) : [...values],
    );
  }
  context.body = answer.body;
  context.status = answer.status;
}
