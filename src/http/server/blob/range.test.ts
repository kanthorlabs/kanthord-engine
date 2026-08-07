import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRange } from "./range.ts";

describe("src/http/server/blob/range.test", () => {
  const cases: readonly [
    string | undefined,
    number,
    { start: number; end: number } | null,
  ][] = [
    [undefined, 10, null],
    ["bytes=0-4", 10, { start: 0, end: 4 }],
    ["bytes=2-2", 10, { start: 2, end: 2 }],
    ["bytes=0-99", 10, { start: 0, end: 9 }],
    ["bytes=5-", 10, { start: 5, end: 9 }],
    ["bytes=-3", 10, { start: 7, end: 9 }],
    ["bytes=-99", 10, { start: 0, end: 9 }],
    ["bytes=-0", 10, null],
    ["bytes=-", 10, null],
    ["bytes=10-12", 10, null],
    ["bytes=6-4", 10, null],
    ["bytes=0-4, 6-8", 10, null],
    ["items=0-4", 10, null],
    ["0-4", 10, null],
    ["bytes=0-4", 0, null],
    ["bytes=abc-4", 10, null],
    ["bytes=0-99999999999999999999", 10, null],
    ["  bytes=0-4  ", 10, { start: 0, end: 4 }],
  ];

  for (const [header, size, expected] of cases) {
    it(`parseRange(${JSON.stringify(header)}, ${size}) is ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(parseRange(header, size), expected);
    });
  }
});
