import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectBindingRow } from "./project-binding.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/domain/project-binding.test", () => {
  const validRow = {
    projectId: "project_" + ULID_A,
    kind: "git" as const,
    targetId: "repo_" + ULID_A,
    createdAt: 0,
  };

  it("accepts a valid row", () => {
    assert.equal(projectBindingRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        projectBindingRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for projectId", () => {
    assert.equal(
      projectBindingRow.safeParse({
        ...validRow,
        projectId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("accepts kind git", () => {
    assert.equal(
      projectBindingRow.safeParse({ ...validRow, kind: "git" }).success,
      true,
    );
  });

  it("accepts kind provider", () => {
    assert.equal(
      projectBindingRow.safeParse({ ...validRow, kind: "provider" }).success,
      true,
    );
  });

  it("rejects invalid kind", () => {
    assert.equal(
      projectBindingRow.safeParse({ ...validRow, kind: "invalid" }).success,
      false,
    );
  });
});
