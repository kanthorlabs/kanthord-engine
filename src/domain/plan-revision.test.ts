import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planRevisionRow } from "./plan-revision.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);

describe("src/domain/plan-revision.test", () => {
  const validRow = {
    id: "revision_" + ULID_A,
    projectId: "project_" + ULID_A,
    parentId: null,
    importId: "import-1",
    submittedBlob: HASH,
    choicesBlob: HASH,
    acceptedBlob: HASH,
  };

  it("accepts a valid row", () => {
    assert.equal(planRevisionRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        planRevisionRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      planRevisionRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for projectId", () => {
    assert.equal(
      planRevisionRow.safeParse({
        ...validRow,
        projectId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("accepts non-null parentId", () => {
    assert.equal(
      planRevisionRow.safeParse({
        ...validRow,
        parentId: "revision_" + ULID_A,
      }).success,
      true,
    );
  });
});
