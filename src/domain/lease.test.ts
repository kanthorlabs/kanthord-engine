import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { leaseOwnerKinds, leaseRow, leaseSubjectKinds } from "./lease.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/domain/lease.test", () => {
  const validRow = {
    subjectKind: "node" as const,
    subjectId: "objective_" + ULID_A,
    owner: "daemon-1",
    ownerKind: "daemon" as const,
    fence: 1,
    acquiredAt: 0,
    renewedAt: null,
    expiresAt: null,
  };

  it("leaseSubjectKinds deep-equals the two kinds in order", () => {
    assert.deepEqual(leaseSubjectKinds, ["node", "repository"]);
  });

  it("accepts a valid row", () => {
    assert.equal(leaseRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        leaseRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("accepts subjectKind node", () => {
    assert.equal(
      leaseRow.safeParse({ ...validRow, subjectKind: "node" }).success,
      true,
    );
  });

  it("accepts subjectKind repository", () => {
    assert.equal(
      leaseRow.safeParse({
        ...validRow,
        subjectKind: "repository",
        subjectId: "repo_" + ULID_A,
      }).success,
      true,
    );
  });

  it("rejects invalid subjectKind", () => {
    assert.equal(
      leaseRow.safeParse({ ...validRow, subjectKind: "invalid" }).success,
      false,
    );
  });

  it("leaseOwnerKinds pins the two owner kinds in order", () => {
    assert.deepEqual([...leaseOwnerKinds], ["daemon", "actor"]);
    assert.equal(leaseOwnerKinds.length, 2);
  });

  it("accepts an unheld lease with both owner fields null", () => {
    assert.equal(
      leaseRow.safeParse({ ...validRow, owner: null, ownerKind: null }).success,
      true,
    );
  });

  it("accepts an actor-held lease", () => {
    assert.equal(
      leaseRow.safeParse({
        ...validRow,
        owner: "actor_" + ULID_A,
        ownerKind: "actor",
      }).success,
      true,
    );
  });

  it("refuses a lease whose owner and owner kind disagree on null", () => {
    assert.equal(
      leaseRow.safeParse({ ...validRow, owner: null }).success,
      false,
    );
    assert.equal(
      leaseRow.safeParse({ ...validRow, ownerKind: null }).success,
      false,
    );
  });

  it("owner-kind refine: message equals the DDL CHECK expression", () => {
    const result = leaseRow.safeParse({ ...validRow, owner: null });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(owner IS NULL) = (owner_kind IS NULL)",
    );
  });

  it("refuses an unknown owner kind", () => {
    assert.equal(
      leaseRow.safeParse({ ...validRow, ownerKind: "worker" }).success,
      false,
    );
  });
});
