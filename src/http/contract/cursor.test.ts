import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cursorRequest } from "./cursor.ts";

describe("src/http/contract/cursor.test", () => {
  it("defaults limit to 100 when absent", () => {
    const parsed = cursorRequest.parse({});
    assert.equal(parsed.limit, 100);
  });

  it("parses limit 500 and the string form to 500", () => {
    assert.equal(cursorRequest.parse({ limit: 500 }).limit, 500);
    assert.equal(cursorRequest.parse({ limit: "500" }).limit, 500);
  });

  it('parses limit "100" to 100', () => {
    assert.equal(cursorRequest.parse({ limit: "100" }).limit, 100);
  });

  it("throws on limit 501 and its string form", () => {
    assert.throws(() => cursorRequest.parse({ limit: 501 }));
    assert.throws(() => cursorRequest.parse({ limit: "501" }));
  });

  it("throws on limit 0 and its string form", () => {
    assert.throws(() => cursorRequest.parse({ limit: 0 }));
    assert.throws(() => cursorRequest.parse({ limit: "0" }));
  });

  it("throws on limit 1.5 and its string form", () => {
    assert.throws(() => cursorRequest.parse({ limit: 1.5 }));
    assert.throws(() => cursorRequest.parse({ limit: "1.5" }));
  });

  it('throws on limit "abc"', () => {
    assert.throws(() => cursorRequest.parse({ limit: "abc" }));
  });

  it("defaults after to null when absent", () => {
    assert.equal(cursorRequest.parse({}).after, null);
  });

  it("throws on an empty after", () => {
    assert.throws(() => cursorRequest.parse({ after: "" }));
  });

  it("throws on an unknown key", () => {
    assert.throws(() => cursorRequest.parse({ nope: 1 }));
  });
});
