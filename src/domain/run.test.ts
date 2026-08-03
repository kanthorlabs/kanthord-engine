import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runRow } from "./run.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const OID = "a".repeat(40);

describe("src/domain/run.test", () => {
  const validObjectiveRun = {
    id: "run_" + ULID_A,
    kind: "objective" as const,
    nodeId: "objective_" + ULID_A,
    parentRunId: null,
    workspaceId: "workspace_" + ULID_A,
    worker: "general@1" as const,
    leaseFence: 1,
    attemptLimit: 3,
    baseOid: OID,
    headOid: null,
    state: "active" as const,
    outcome: null,
    endedAt: null,
  };

  const validTaskRun = {
    id: "run_" + ULID_A,
    kind: "task" as const,
    nodeId: "task_" + ULID_A,
    parentRunId: "run_" + ULID_A,
    workspaceId: "workspace_" + ULID_A,
    worker: "general@1" as const,
    leaseFence: 1,
    attemptLimit: 3,
    baseOid: OID,
    headOid: null,
    state: "active" as const,
    outcome: null,
    endedAt: null,
  };

  it("accepts a valid objective run", () => {
    assert.equal(runRow.safeParse(validObjectiveRun).success, true);
  });

  it("accepts a valid task run", () => {
    assert.equal(runRow.safeParse(validTaskRun).success, true);
  });

  it("rejects missing required keys for objective run", () => {
    for (const key of Object.keys(validObjectiveRun)) {
      const copy = { ...validObjectiveRun };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        runRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for nodeId", () => {
    assert.equal(
      runRow.safeParse({
        ...validObjectiveRun,
        nodeId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("rejects mr@1 worker", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, worker: "mr@1" }).success,
      false,
    );
  });

  it("accepts general@1 worker", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, worker: "general@1" }).success,
      true,
    );
  });

  it("accepts state active", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, state: "active" }).success,
      true,
    );
  });

  it("accepts state ended", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, state: "ended" }).success,
      true,
    );
  });

  it("rejects invalid state", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, state: "invalid" }).success,
      false,
    );
  });

  it("refine: objective with non-null parentRunId fails", () => {
    assert.equal(
      runRow.safeParse({
        ...validObjectiveRun,
        parentRunId: "run_" + ULID_A,
      }).success,
      false,
    );
  });

  it("refine: message equals the DDL CHECK expression", () => {
    const result = runRow.safeParse({
      ...validObjectiveRun,
      parentRunId: "run_" + ULID_A,
    });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(kind = 'objective') = (parent_run_id IS NULL)",
    );
  });

  it("refine: task with null parentRunId fails", () => {
    assert.equal(
      runRow.safeParse({ ...validTaskRun, parentRunId: null }).success,
      false,
    );
  });

  it("refine: objective with null parentRunId passes", () => {
    assert.equal(
      runRow.safeParse({ ...validObjectiveRun, parentRunId: null }).success,
      true,
    );
  });

  it("refine: task with non-null parentRunId passes", () => {
    assert.equal(
      runRow.safeParse({
        ...validTaskRun,
        parentRunId: "run_" + ULID_A,
      }).success,
      true,
    );
  });
});
