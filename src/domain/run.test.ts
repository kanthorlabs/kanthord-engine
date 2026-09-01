import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runBaseRow, runDrivers, runRow } from "./run.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const OID = "a".repeat(40);
const REVISION = "revision_" + ULID_A;

describe("src/domain/run.test", () => {
  const validRun = {
    id: "run_" + ULID_A,
    kind: "execution" as const,
    driver: "internal" as const,
    nodeId: "task_" + ULID_A,
    workspaceId: "workspace_" + ULID_A,
    worker: "general@1" as const,
    fence: 1,
    attemptLimit: 3,
    headOid: null,
    judgedOid: null,
    graphRevision: REVISION,
    agents: ["general@1"],
    expiresAt: 1700000000000,
    maxLifetimeAt: 1700000000000,
    state: "active" as const,
    outcome: null,
    endedAt: null,
    baseCount: 0,
  };

  it("the kind enum admits exactly the three run kinds", () => {
    for (const kind of ["structural", "execution", "review"] as const) {
      assert.equal(runRow.safeParse({ ...validRun, kind }).success, true);
    }
  });

  it("the kind enum refuses objective, task and research", () => {
    for (const kind of ["objective", "task", "research"]) {
      assert.equal(runRow.safeParse({ ...validRun, kind }).success, false);
    }
  });

  it("fence is a required positive integer", () => {
    assert.equal(runRow.safeParse({ ...validRun, fence: 1 }).success, true);
    assert.equal(runRow.safeParse({ ...validRun, fence: null }).success, false);
    assert.equal(runRow.safeParse({ ...validRun, fence: 0 }).success, false);
    assert.equal(runRow.safeParse({ ...validRun, fence: 1.5 }).success, false);
  });

  it("agents accepts a worker id array and an empty array, and refuses null", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, agents: ["general@1"] }).success,
      true,
    );
    assert.equal(runRow.safeParse({ ...validRun, agents: [] }).success, true);
    assert.equal(
      runRow.safeParse({ ...validRun, agents: null }).success,
      false,
    );
  });

  it("agents refuses a value outside the worker id grammar", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, agents: ["claude.swe@1"] }).success,
      false,
    );
  });

  it("worker is required and refuses a dotted legacy name", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, worker: "general@1" }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, worker: "claude.swe@1" }).success,
      false,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, worker: null }).success,
      false,
    );
  });

  it("judgedOid accepts a forty-character object id and null", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, judgedOid: OID }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, judgedOid: null }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, judgedOid: "a".repeat(39) }).success,
      false,
    );
  });

  it("graphRevision accepts a plan revision identity and null", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, graphRevision: REVISION }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, graphRevision: null }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, graphRevision: 41 }).success,
      false,
    );
  });

  it("expiresAt and maxLifetimeAt are required", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, expiresAt: 1700000000000 }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, expiresAt: null }).success,
      false,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, maxLifetimeAt: 1700000000000 }).success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, maxLifetimeAt: null }).success,
      false,
    );
  });

  it("leaseFence, baseOid and parentRunId are not accepted", () => {
    const result = runRow.safeParse({
      ...validRun,
      leaseFence: 1,
      baseOid: OID,
      parentRunId: null,
    });
    assert.equal(result.success, true);
    assert.deepEqual(Object.keys(result.data!).sort(), [
      "agents",
      "attemptLimit",
      "baseCount",
      "driver",
      "endedAt",
      "expiresAt",
      "fence",
      "graphRevision",
      "headOid",
      "id",
      "judgedOid",
      "kind",
      "maxLifetimeAt",
      "nodeId",
      "outcome",
      "state",
      "worker",
      "workspaceId",
    ]);
  });

  it("refine: an execution run holding no run_base row passes", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "execution", baseCount: 0 })
        .success,
      true,
    );
  });

  it("refine: an execution run holding one run_base row passes", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "execution", baseCount: 1 })
        .success,
      true,
    );
  });

  it("refine: an execution run holding two run_base rows fails", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "execution", baseCount: 2 })
        .success,
      false,
    );
  });

  it("refine: a structural run holding a run_base row fails", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "structural", baseCount: 1 })
        .success,
      false,
    );
  });

  it("refine: a review run holding a run_base row fails", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "review", baseCount: 1 }).success,
      false,
    );
  });

  it("refine: a structural run holding no run_base row passes", () => {
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "structural", baseCount: 0 })
        .success,
      true,
    );
    assert.equal(
      runRow.safeParse({ ...validRun, kind: "review", baseCount: 0 }).success,
      true,
    );
  });

  it("refine: message equals the stated cardinality sentence", () => {
    const result = runRow.safeParse({ ...validRun, baseCount: 2 });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "an execution run holds at most one run_base row, and a structural or review run holds none",
    );
  });

  it("runBaseRow accepts a run id, a repository id and an object id", () => {
    assert.equal(
      runBaseRow.safeParse({
        runId: "run_" + ULID_A,
        repositoryId: "repo_" + ULID_A,
        oid: OID,
      }).success,
      true,
    );
    for (const [key, value] of [
      ["runId", "repo_" + ULID_A],
      ["repositoryId", "run_" + ULID_A],
      ["oid", "not-an-object-id"],
    ] as const) {
      assert.equal(
        runBaseRow.safeParse({
          runId: "run_" + ULID_A,
          repositoryId: "repo_" + ULID_A,
          oid: OID,
          [key]: value,
        }).success,
        false,
        `expected rejection when ${key} has the wrong value`,
      );
    }
  });

  it("the driver refine is gone: an external run carrying a worker passes", () => {
    assert.equal(
      runRow.safeParse({
        ...validRun,
        driver: "external",
        worker: "general@1",
        workspaceId: null,
        kind: "execution",
        baseCount: 0,
      }).success,
      true,
    );
  });

  it("runDrivers pins the two drivers in order", () => {
    assert.deepEqual([...runDrivers], ["internal", "external"]);
    assert.equal(runDrivers.length, 2);
  });
});
