import assert from "node:assert/strict";
import { z } from "zod";
import { canonicalJSON, timestamp } from "../kernel/json.ts";
import { ERROR_ARRAY_MAX_BYTES, ERROR_MESSAGE_MAX_BYTES } from "./contract.ts";

export const errorItemSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  created_at: timestamp,
});
export type ErrorItem = z.infer<typeof errorItemSchema>;

const errorItemsSchema = z.array(errorItemSchema);

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function cutMessage(message: string): string {
  const wellFormed = message.toWellFormed();
  assert(Number.isInteger(ERROR_MESSAGE_MAX_BYTES), "Bound must be integer.");
  if (byteLength(wellFormed) <= ERROR_MESSAGE_MAX_BYTES) return wellFormed;
  let bytes = 0;
  let end = 0;
  for (const point of wellFormed) {
    const next = bytes + byteLength(point);
    if (next > ERROR_MESSAGE_MAX_BYTES) break;
    bytes = next;
    end += point.length;
  }
  return wellFormed.slice(0, end);
}

function parseStored(current: string | null): ErrorItem[] {
  if (current === null) return [];
  return errorItemsSchema.parse(JSON.parse(current));
}

export function appendError(current: string | null, item: ErrorItem): string {
  const stored = parseStored(current);
  const next = errorItemSchema.parse({
    code: item.code,
    message: cutMessage(item.message),
    created_at: item.created_at,
  });
  assert(
    byteLength(canonicalJSON([next])) <= ERROR_ARRAY_MAX_BYTES,
    "The newest error item must fit the array bound.",
  );
  const items = [...stored, next];
  const evictionLimit = items.length;
  for (let drops = 0; drops < evictionLimit; drops++) {
    if (byteLength(canonicalJSON(items)) <= ERROR_ARRAY_MAX_BYTES) break;
    items.shift();
  }
  const answer = canonicalJSON(items);
  assert(byteLength(answer) <= ERROR_ARRAY_MAX_BYTES, "Array exceeds bound.");
  return answer;
}
