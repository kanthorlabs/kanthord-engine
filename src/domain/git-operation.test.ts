import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { gitOperationRow } from "./git-operation.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);
const OID = "a".repeat(40);

describe("src/domain/git-operation.test", () => {
  const validRow = {
    id: "gitop_" + ULID_A,
    repositoryId: "repo_" + ULID_A,
    intent: "merge" as const,
    nodeId: null,
    runId: null,
    candidateId: null,
    leaseFence: 1,
    ref: "refs/heads/main",
    baseOid: OID,
    proposedHeadOid: OID,
    resultHeadOid: null,
    expectedRemoteOid: null,
    state: "open" as const,
    outcome: null,
    detailBlob: null,
    completedAt: null,
  };

  it("accepts a valid row", () => {
    assert.equal(gitOperationRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        gitOperationRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      gitOperationRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for repositoryId", () => {
    assert.equal(
      gitOperationRow.safeParse({
        ...validRow,
        repositoryId: "project_" + ULID_A,
      }).success,
      false,
    );
  });

  it("accepts each intent", () => {
    for (const intent of ["merge", "sync", "publish", "revert"] as const) {
      assert.equal(
        gitOperationRow.safeParse({ ...validRow, intent }).success,
        true,
        `expected ${intent} to be accepted`,
      );
    }
  });

  it("rejects invalid intent", () => {
    assert.equal(
      gitOperationRow.safeParse({ ...validRow, intent: "invalid" }).success,
      false,
    );
  });

  it("accepts each state", () => {
    for (const state of ["open", "complete", "discarded"] as const) {
      assert.equal(
        gitOperationRow.safeParse({ ...validRow, state }).success,
        true,
        `expected ${state} to be accepted`,
      );
    }
  });

  it("rejects invalid state", () => {
    assert.equal(
      gitOperationRow.safeParse({ ...validRow, state: "invalid" }).success,
      false,
    );
  });
});
