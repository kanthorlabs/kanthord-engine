import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { repositoryRow, repositoryStates } from "./repository.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const OID = "a".repeat(40);

describe("src/domain/repository.test", () => {
  const validRow = {
    id: "repo_" + ULID_A,
    name: "test-repo",
    remoteUrl: "https://github.com/example/repo.git",
    credentialId: "provider_" + ULID_A,
    homePath: "/home/user/repos",
    upstreamBranch: "main",
    landingBranch: "main",
    publishRef: "refs/heads/main",
    publishOnApproval: 1,
    state: "ready" as const,
    divergedLandingOid: null,
    divergedUpstreamOid: null,
    fetchedUpstreamOid: null,
    updatedAt: 0,
  };

  it("repositoryStates deep-equals the two states in order", () => {
    assert.deepEqual(repositoryStates, ["ready", "needs-reconcile"]);
  });

  it("accepts a valid row", () => {
    assert.equal(repositoryRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        repositoryRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      repositoryRow.safeParse({ ...validRow, id: "project_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for credentialId", () => {
    assert.equal(
      repositoryRow.safeParse({
        ...validRow,
        credentialId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("accepts state ready", () => {
    assert.equal(
      repositoryRow.safeParse({ ...validRow, state: "ready" }).success,
      true,
    );
  });

  it("accepts state needs-reconcile with both diverged oids", () => {
    assert.equal(
      repositoryRow.safeParse({
        ...validRow,
        state: "needs-reconcile",
        divergedLandingOid: OID,
        divergedUpstreamOid: OID,
      }).success,
      true,
    );
  });

  it("rejects invalid state", () => {
    assert.equal(
      repositoryRow.safeParse({ ...validRow, state: "invalid" }).success,
      false,
    );
  });

  it("refine: needs-reconcile without divergedLandingOid fails", () => {
    assert.equal(
      repositoryRow.safeParse({
        ...validRow,
        state: "needs-reconcile",
        divergedLandingOid: null,
        divergedUpstreamOid: null,
      }).success,
      false,
    );
  });

  it("refine: ready with divergedLandingOid fails", () => {
    assert.equal(
      repositoryRow.safeParse({
        ...validRow,
        state: "ready",
        divergedLandingOid: OID,
        divergedUpstreamOid: OID,
      }).success,
      false,
    );
  });

  it("refine: message equals the DDL CHECK expression", () => {
    const result = repositoryRow.safeParse({
      ...validRow,
      state: "needs-reconcile",
      divergedLandingOid: null,
      divergedUpstreamOid: null,
    });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(state = 'needs-reconcile') = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)",
    );
  });
});
