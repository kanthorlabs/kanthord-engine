import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planRevisionRow, revisionOrigins } from "./plan-revision.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);

describe("src/domain/plan-revision.test", () => {
  const validRow = {
    id: "revision_" + ULID_A,
    projectId: "project_" + ULID_A,
    parentId: null,
    origin: "import" as const,
    importId: "import-1",
    submittedBlob: HASH,
    choicesBlob: HASH,
    acceptedBlob: HASH,
  };

  const validNodeWriteRow = {
    ...validRow,
    origin: "node-write" as const,
    importId: null,
    submittedBlob: null,
    choicesBlob: null,
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

  it("revisionOrigins pins the two origins in order", () => {
    assert.deepEqual([...revisionOrigins], ["import", "node-write"]);
    assert.equal(revisionOrigins.length, 2);
  });

  it("accepts a node-write revision that holds no import fact", () => {
    assert.equal(planRevisionRow.safeParse(validNodeWriteRow).success, true);
  });

  it("refuses a node-write revision that carries an import fact", () => {
    for (const input of [
      { ...validNodeWriteRow, importId: "import-1" },
      { ...validNodeWriteRow, submittedBlob: HASH },
      { ...validNodeWriteRow, choicesBlob: HASH },
    ]) {
      assert.equal(planRevisionRow.safeParse(input).success, false);
    }
  });

  it("refuses an import revision that omits an import fact", () => {
    for (const input of [
      { ...validRow, importId: null },
      { ...validRow, submittedBlob: null },
      { ...validRow, choicesBlob: null },
    ]) {
      assert.equal(planRevisionRow.safeParse(input).success, false);
    }
  });

  it("acceptedBlob is required under both origins", () => {
    assert.equal(
      planRevisionRow.safeParse({ ...validRow, acceptedBlob: null }).success,
      false,
    );
    assert.equal(
      planRevisionRow.safeParse({ ...validNodeWriteRow, acceptedBlob: null })
        .success,
      false,
    );
  });

  it("origin refine: message equals the DDL CHECK expression", () => {
    const result = planRevisionRow.safeParse({ ...validRow, importId: null });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(origin = 'import') = (import_id IS NOT NULL AND submitted_blob IS NOT NULL AND choices_blob IS NOT NULL)",
    );
  });

  it("refuses an unknown origin", () => {
    assert.equal(
      planRevisionRow.safeParse({ ...validRow, origin: "restore" }).success,
      false,
    );
  });
});
