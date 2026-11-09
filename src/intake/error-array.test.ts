import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ERROR_ARRAY_MAX_BYTES,
  ERROR_MESSAGE_MAX_BYTES,
  type ErrorItem,
} from "./contract.ts";
import { appendError } from "./error-array.ts";

const FILL_COUNT = 200;
const NEWEST_CODE = "newest";
const LONE_SURROGATE_JSON = '"bad \\ud800"';
const REPLACED_MESSAGE = "bad \uFFFD";
const ERROR_ITEMS_PER_APPEND = 1;

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

test("a message with a lone surrogate is stored well-formed", () => {
  const message = JSON.parse(LONE_SURROGATE_JSON) as string;
  assert(!message.isWellFormed());
  const answer = appendError(null, item("e", message));
  const stored = JSON.parse(answer) as ErrorItem[];
  assert.equal(stored.length, ERROR_ITEMS_PER_APPEND);
  const [first] = stored as [ErrorItem];
  assert(first.message.isWellFormed());
  assert.equal(first.message, REPLACED_MESSAGE);
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
