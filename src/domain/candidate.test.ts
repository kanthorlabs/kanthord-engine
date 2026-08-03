import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { candidateRow } from "./candidate.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);
const OID = "a".repeat(40);

describe("src/domain/candidate.test", () => {
  const validRow = {
    id: "candidate_" + ULID_A,
    nodeId: "objective_" + ULID_A,
    runId: "run_" + ULID_A,
    workspaceId: "workspace_" + ULID_A,
    revision: "cand-4",
    candidateOid: OID,
    landingBaseOid: OID,
    mergeOid: null,
    projectedOutcome: "done" as const,
    evidenceBlob: HASH,
    profileBlob: HASH,
    conventionVersion: "1",
    state: "open" as const,
    acknowledgedPartial: null,
    publishRequested: null,
    approvedActor: null,
    approvedAt: null,
    invalidatedAt: null,
    invalidatedReason: null,
    updatedAt: 0,
  };

  it("accepts a valid row", () => {
    assert.equal(candidateRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        candidateRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      candidateRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for nodeId", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        nodeId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("rejects wrong identity kind for runId", () => {
    assert.equal(
      candidateRow.safeParse({ ...validRow, runId: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for workspaceId", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        workspaceId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("accepts state open", () => {
    assert.equal(
      candidateRow.safeParse({ ...validRow, state: "open" }).success,
      true,
    );
  });

  it("accepts state approved", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        state: "approved",
        projectedOutcome: "done",
      }).success,
      true,
    );
  });

  it("accepts state invalidated", () => {
    assert.equal(
      candidateRow.safeParse({ ...validRow, state: "invalidated" }).success,
      true,
    );
  });

  it("rejects invalid state", () => {
    assert.equal(
      candidateRow.safeParse({ ...validRow, state: "invalid" }).success,
      false,
    );
  });

  it("accepts projectedOutcome done", () => {
    assert.equal(
      candidateRow.safeParse({ ...validRow, projectedOutcome: "done" }).success,
      true,
    );
  });

  it("accepts projectedOutcome partial", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        projectedOutcome: "partial",
      }).success,
      true,
    );
  });

  it("rejects invalid projectedOutcome", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        projectedOutcome: "invalid",
      }).success,
      false,
    );
  });

  it("refine: approved + partial + null acknowledgedPartial fails", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        state: "approved",
        projectedOutcome: "partial",
        acknowledgedPartial: null,
      }).success,
      false,
    );
  });

  it("refine: message equals the DDL CHECK expression", () => {
    const result = candidateRow.safeParse({
      ...validRow,
      state: "approved",
      projectedOutcome: "partial",
      acknowledgedPartial: null,
    });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial = 1",
    );
  });

  it("refine: approved + partial + acknowledgedPartial 1 passes", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        state: "approved",
        projectedOutcome: "partial",
        acknowledgedPartial: 1,
      }).success,
      true,
    );
  });

  it("refine: approved + done + null acknowledgedPartial passes", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        state: "approved",
        projectedOutcome: "done",
        acknowledgedPartial: null,
      }).success,
      true,
    );
  });

  it("refine: open + partial + null acknowledgedPartial passes", () => {
    assert.equal(
      candidateRow.safeParse({
        ...validRow,
        state: "open",
        projectedOutcome: "partial",
        acknowledgedPartial: null,
      }).success,
      true,
    );
  });
});
