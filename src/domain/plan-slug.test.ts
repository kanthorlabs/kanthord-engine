import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { slug } from "./plan-slug.ts";

const table = [
  ["Harden the verify CLI", "harden-the-verify-cli"],
  ["  --Hello,   World!!  ", "hello-world"],
  ["Café ☕ time", "caf-time"],
  ["日本語", "node"],
  ["", "node"],
  ["---", "node"],
  ["!!!", "node"],
  ["A1 b2", "a1-b2"],
] as const;

describe("src/domain/plan-slug.test", () => {
  it("slugs the named table to the exact expected segments", () => {
    for (const [title, expected] of table) {
      assert.equal(slug(title), expected);
    }
  });

  it("truncates a 60-character all-a title to 48 a's", () => {
    assert.equal(slug("a".repeat(60)), "a".repeat(48));
  });

  it("re-trims a trailing dash left by truncation", () => {
    const title = "a".repeat(47) + " b".repeat(6);
    assert.equal(slug(title), "a".repeat(47));
  });

  it("is idempotent over the whole table", () => {
    for (const [title] of table) {
      assert.equal(slug(slug(title)), slug(title));
    }
    assert.equal(slug(slug("a".repeat(60))), slug("a".repeat(60)));
    assert.equal(
      slug(slug("a".repeat(47) + " b".repeat(6))),
      slug("a".repeat(47) + " b".repeat(6)),
    );
  });
});
