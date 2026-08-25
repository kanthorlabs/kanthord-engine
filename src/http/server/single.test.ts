import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { singleValued } from "./single.ts";
import { HttpError } from "../contract/errors.ts";

describe("src/http/server/single.test", () => {
  it("returns an empty object for an empty query", () => {
    assert.deepEqual(singleValued({}), {});
  });

  it("collapses each single-valued key to its value", () => {
    assert.deepEqual(singleValued({ a: ["1"], b: ["2"] }), { a: "1", b: "2" });
  });

  it("collapses a single empty-string value to an empty string", () => {
    assert.deepEqual(singleValued({ a: [""] }), { a: "" });
  });

  it("throws an HttpError naming the repeated key", () => {
    try {
      singleValued({ a: ["1", "2"] });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "invalid-request");
      assert.equal(error.status, 400);
      assert.match(error.message, /a/);
    }
  });

  it("names the bytewise-first offender when two keys repeat", () => {
    try {
      singleValued({ b: ["1", "2"], a: ["1", "2"] });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.match(error.message, /a/);
      assert.doesNotMatch(error.message, /\bb\b/);
    }
  });

  it("orders keys bytewise in the result", () => {
    assert.deepEqual(Object.keys(singleValued({ b: ["2"], a: ["1"] })), [
      "a",
      "b",
    ]);
    assert.deepEqual(
      Object.keys(singleValued({ ["\u{1F600}"]: ["1"], ["\uE000"]: ["2"] })),
      ["\uE000", "\u{1F600}"],
    );
  });
});
