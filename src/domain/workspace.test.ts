import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workspaceRow } from "./workspace.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);
const OID = "a".repeat(40);

describe("src/domain/workspace.test", () => {
  const validRow = {
    id: "workspace_" + ULID_A,
    nodeId: "objective_" + ULID_A,
    repositoryId: "repo_" + ULID_A,
    path: "/tmp/workspace",
    cloneBaseOid: OID,
    upstreamOidAtClone: OID,
    profileBlob: HASH,
    conventionVersion: "1",
    ambientBlob: null,
    state: "active",
    updatedAt: 0,
  };

  it("accepts a valid row", () => {
    assert.equal(workspaceRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        workspaceRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      workspaceRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for nodeId", () => {
    assert.equal(
      workspaceRow.safeParse({ ...validRow, nodeId: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for repositoryId", () => {
    assert.equal(
      workspaceRow.safeParse({
        ...validRow,
        repositoryId: "project_" + ULID_A,
      }).success,
      false,
    );
  });
});
