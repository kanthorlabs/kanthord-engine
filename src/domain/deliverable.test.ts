import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverable, deliverables } from "./deliverable.ts";

describe("src/domain/deliverable.ts", () => {
  it("declares the deliverables in fixed order", () => {
    assert.deepStrictEqual(deliverables, [
      "test",
      "implementation",
      "review",
      "expansion",
    ]);
  });

  it('parses "test"', () => {
    assert.equal(deliverable.parse("test"), "test");
  });

  it('parses "implementation"', () => {
    assert.equal(deliverable.parse("implementation"), "implementation");
  });

  it('parses "review"', () => {
    assert.equal(deliverable.parse("review"), "review");
  });

  it('parses "expansion"', () => {
    assert.equal(deliverable.parse("expansion"), "expansion");
  });

  it('refuses "expansions"', () => {
    assert.equal(deliverable.safeParse("expansions").success, false);
  });

  it('refuses "impl"', () => {
    assert.equal(deliverable.safeParse("impl").success, false);
  });

  it("refuses an empty value", () => {
    assert.equal(deliverable.safeParse("").success, false);
  });

  it('refuses "research"', () => {
    assert.equal(deliverable.safeParse("research").success, false);
  });
});
