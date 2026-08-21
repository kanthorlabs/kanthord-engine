import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cursorRequest } from "./cursor.ts";

describe("src/http/contract/cursor.test", () => {
  it("defaults limit to 100 when absent", () => {
    const parsed = cursorRequest.parse({});
    assert.equal(parsed.limit, 100);
  });

  it("defaults order to asc and limit to 100 on an empty request", () => {
    assert.deepEqual(cursorRequest.parse({}), { order: "asc", limit: 100 });
  });

  it("parses desc order", () => {
    assert.equal(cursorRequest.parse({ order: "desc" }).order, "desc");
  });

  it("throws on an unknown order", () => {
    assert.throws(() => cursorRequest.parse({ order: "sideways" }));
  });

  it("throws on an empty order", () => {
    assert.throws(() => cursorRequest.parse({ order: "" }));
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

  it("omits after when absent", () => {
    assert.equal("after" in cursorRequest.parse({}), false);
  });

  it("keeps after when present", () => {
    assert.equal(cursorRequest.parse({ after: "x" }).after, "x");
  });

  it("omits before when absent", () => {
    assert.equal("before" in cursorRequest.parse({}), false);
  });

  it("keeps before when present", () => {
    assert.equal(cursorRequest.parse({ before: "x" }).before, "x");
  });

  it("throws on an empty after", () => {
    assert.throws(() => cursorRequest.parse({ after: "" }));
  });

  it("throws on an empty before", () => {
    assert.throws(() => cursorRequest.parse({ before: "" }));
  });

  it("carries both exclusive bounds", () => {
    assert.deepEqual(cursorRequest.parse({ after: "a", before: "b" }), {
      after: "a",
      before: "b",
      order: "asc",
      limit: 100,
    });
  });

  it("throws on an unknown key", () => {
    assert.throws(() => cursorRequest.parse({ nope: 1 }));
  });
});
