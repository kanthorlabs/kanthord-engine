import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { migrationRow } from "./migration.ts";

describe("src/domain/migration.test", () => {
  const validRow = {
    version: 1,
    name: "initial",
    appliedAt: 0,
  };

  it("accepts a valid row", () => {
    assert.equal(migrationRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        migrationRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("accepts integer version", () => {
    assert.equal(
      migrationRow.safeParse({ ...validRow, version: 1 }).success,
      true,
    );
  });

  it("rejects string version", () => {
    assert.equal(
      migrationRow.safeParse({ ...validRow, version: "1" }).success,
      false,
    );
  });

  it("row carries no id key", () => {
    assert.equal("id" in validRow, false);
  });
});
