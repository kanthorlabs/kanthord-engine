import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkResultRow } from "./check-result.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);
const OID = "a".repeat(40);

describe("src/domain/check-result.test", () => {
  const validRow = {
    id: "check_" + ULID_A,
    subjectKind: "candidate" as const,
    subjectId: "candidate_" + ULID_A,
    nodeId: "objective_" + ULID_A,
    runId: "run_" + ULID_A,
    commitOid: OID,
    manifestBlob: null,
    checkName: "lint",
    commandJson: '["npm", "run", "lint"]',
    cwd: "/tmp/workspace",
    envIdentity: "default",
    toolchainVersion: "1",
    timeoutMs: 60000,
    authoritative: 1,
    result: "passed" as const,
    exitCode: 0,
    outputBlob: null,
    profileBlob: null,
    conventionVersion: "1",
    invalidatedAt: null,
    endedAt: null,
  };

  it("accepts a valid row", () => {
    assert.equal(checkResultRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        checkResultRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      checkResultRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("accepts each subjectKind", () => {
    for (const subjectKind of [
      "candidate",
      "merge",
      "task-diagnostic",
      "reconcile",
      "profile-gate",
      "initiative-e2e",
    ] as const) {
      assert.equal(
        checkResultRow.safeParse({ ...validRow, subjectKind }).success,
        true,
        `expected ${subjectKind} to be accepted`,
      );
    }
  });

  it("rejects invalid subjectKind", () => {
    assert.equal(
      checkResultRow.safeParse({
        ...validRow,
        subjectKind: "invalid",
      }).success,
      false,
    );
  });

  it("accepts each result value", () => {
    for (const result of [
      "running",
      "passed",
      "failed",
      "error",
      "timed-out",
      "cancelled",
      "not-applicable",
    ] as const) {
      assert.equal(
        checkResultRow.safeParse({ ...validRow, result }).success,
        true,
        `expected ${result} to be accepted`,
      );
    }
  });

  it("rejects invalid result", () => {
    assert.equal(
      checkResultRow.safeParse({ ...validRow, result: "invalid" }).success,
      false,
    );
  });

  it("refine: failed + null commitOid + null manifestBlob fails", () => {
    assert.equal(
      checkResultRow.safeParse({
        ...validRow,
        result: "failed",
        commitOid: null,
        manifestBlob: null,
      }).success,
      false,
    );
  });

  it("refine: message equals the DDL CHECK expression", () => {
    const result = checkResultRow.safeParse({
      ...validRow,
      result: "failed",
      commitOid: null,
      manifestBlob: null,
    });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL",
    );
  });

  it("refine: failed + non-null commitOid passes", () => {
    assert.equal(
      checkResultRow.safeParse({
        ...validRow,
        result: "failed",
        commitOid: OID,
        manifestBlob: null,
      }).success,
      true,
    );
  });

  it("refine: failed + non-null manifestBlob passes", () => {
    assert.equal(
      checkResultRow.safeParse({
        ...validRow,
        result: "failed",
        commitOid: null,
        manifestBlob: HASH,
      }).success,
      true,
    );
  });

  it("refine: not-applicable + null commitOid + null manifestBlob passes", () => {
    assert.equal(
      checkResultRow.safeParse({
        ...validRow,
        result: "not-applicable",
        commitOid: null,
        manifestBlob: null,
      }).success,
      true,
    );
  });
});
