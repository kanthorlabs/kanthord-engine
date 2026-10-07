import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJSON } from "../kernel/json.ts";
import { ERROR_ARRAY_MAX_BYTES, ERROR_MESSAGE_MAX_BYTES } from "./contract.ts";
import { appendError, type ErrorItem } from "./error-array.ts";

const FIRST_CODE = "a.b";
const FIRST_MESSAGE = "boom";
const FIRST_CREATED_AT = 5;
const FILL_COUNT = 200;
const NEWEST_CODE = "newest";
const BIG_CODE = "big";

function item(code: string, message: string, created_at = 1): ErrorItem {
  return { code, message, created_at };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function fill(count: number, message: string): string {
  let current: string | null = null;
  for (let index = 0; index < count; index++)
    current = appendError(current, item(`c${index}`, message, index));
  assert(current !== null);
  return current;
}

test("the first failure answers one item in canonical JSON", () => {
  const answer = appendError(
    null,
    item(FIRST_CODE, FIRST_MESSAGE, FIRST_CREATED_AT),
  );
  assert.equal(
    answer,
    canonicalJSON([
      {
        code: FIRST_CODE,
        created_at: FIRST_CREATED_AT,
        message: FIRST_MESSAGE,
      },
    ]),
  );
  assert(answer.includes('"created_at"'));
  assert.equal(answer, canonicalJSON(JSON.parse(answer)));
});

test("an append to a full array drops the oldest item and keeps the newest", () => {
  const full = fill(FILL_COUNT, "x".repeat(100));
  const stored = JSON.parse(full) as ErrorItem[];
  const first = stored[0];
  assert(first !== undefined);
  assert(stored.length < FILL_COUNT);
  const next = JSON.parse(
    appendError(full, item(NEWEST_CODE, "x".repeat(100), 999)),
  ) as ErrorItem[];
  assert.equal(next.length, stored.length);
  assert.notEqual(next[0]?.code, first.code);
  assert.equal(next[0]?.code, stored[1]?.code);
  assert.equal(next.at(-1)?.code, NEWEST_CODE);
});

test("an append can evict several items", () => {
  const full = fill(FILL_COUNT, "y".repeat(100));
  const before = (JSON.parse(full) as ErrorItem[]).length;
  const big = appendError(
    full,
    item(BIG_CODE, "z".repeat(ERROR_MESSAGE_MAX_BYTES), 1000),
  );
  const parsed = JSON.parse(big) as ErrorItem[];
  assert(parsed.length < before - 1);
  assert.equal(parsed.at(-1)?.code, BIG_CODE);
  assert(bytes(big) <= ERROR_ARRAY_MAX_BYTES);
});

test("a message cuts on a code point at the byte bound", () => {
  const emoji = "\u{1F600}";
  const message = "a" + emoji.repeat(ERROR_MESSAGE_MAX_BYTES);
  const [stored] = JSON.parse(appendError(null, item("e", message))) as [
    ErrorItem,
  ];
  assert(bytes(stored.message) <= ERROR_MESSAGE_MAX_BYTES);
  assert(stored.message.isWellFormed());
  assert.equal(bytes(stored.message), 1 + 4 * 255);
});

test("an escaping-heavy message fits the array bound", () => {
  const message = "\u0001".repeat(ERROR_MESSAGE_MAX_BYTES);
  const answer = appendError(null, item("e", message));
  assert(bytes(answer) <= ERROR_ARRAY_MAX_BYTES);
  const [stored] = JSON.parse(answer) as [ErrorItem];
  assert.equal(stored.message.length, ERROR_MESSAGE_MAX_BYTES);
});

test("malformed stored JSON throws", () => {
  assert.throws(() => appendError("{not json", item("a", "b")));
  assert.throws(() => appendError('{"a":1}', item("a", "b")));
  assert.throws(() => appendError('[{"code":"a"}]', item("a", "b")));
  assert.throws(() => appendError("", item("a", "b")));
});
