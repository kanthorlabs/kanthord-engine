import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectRow } from "./project.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/domain/project.test", () => {
  const validRow = {
    id: "project_" + ULID_A,
    name: "test-project",
    worker: "general@1" as const,
    e2eJson: null,
    updatedAt: 0,
  };

  it("accepts a valid row", () => {
    assert.equal(projectRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        projectRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      projectRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects mr@1 worker", () => {
    assert.equal(
      projectRow.safeParse({ ...validRow, worker: "mr@1" }).success,
      false,
    );
  });

  it("accepts general@1 worker", () => {
    assert.equal(
      projectRow.safeParse({ ...validRow, worker: "general@1" }).success,
      true,
    );
  });

  it("accepts null worker", () => {
    assert.equal(
      projectRow.safeParse({ ...validRow, worker: null }).success,
      true,
    );
  });
});
