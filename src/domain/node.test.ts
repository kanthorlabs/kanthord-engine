import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nodeRow } from "./node.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const ULID_B = "01HZY8QF3M4N5P6R7S8T9V0W2Y";
const HASH = "sha256:" + "0".repeat(64);

describe("src/domain/node.test", () => {
  const validObjective = {
    id: "objective_" + ULID_A,
    projectId: "project_" + ULID_A,
    kind: "objective" as const,
    parentId: "initiative_" + ULID_A,
    title: "test objective",
    instructionBlob: HASH,
    acceptanceBlob: null,
    worker: null,
    repositoryId: "repo_" + ULID_A,
    state: "ready" as const,
    blockReason: null,
    discardReason: null,
    revision: "revision_" + ULID_A,
    updatedAt: 0,
  };

  const validTask = {
    id: "task_" + ULID_A,
    projectId: "project_" + ULID_A,
    kind: "task" as const,
    parentId: "objective_" + ULID_A,
    title: "test task",
    instructionBlob: HASH,
    acceptanceBlob: HASH,
    worker: null,
    repositoryId: null,
    state: "ready" as const,
    blockReason: null,
    discardReason: null,
    revision: "revision_" + ULID_A,
    updatedAt: 0,
  };

  const validInitiative = {
    id: "initiative_" + ULID_A,
    projectId: "project_" + ULID_A,
    kind: "initiative" as const,
    parentId: null,
    title: "test initiative",
    instructionBlob: HASH,
    acceptanceBlob: null,
    worker: null,
    repositoryId: null,
    state: "pending" as const,
    blockReason: null,
    discardReason: null,
    revision: "revision_" + ULID_A,
    updatedAt: 0,
  };

  it("accepts a valid objective", () => {
    assert.equal(nodeRow.safeParse(validObjective).success, true);
  });

  it("accepts a valid task", () => {
    assert.equal(nodeRow.safeParse(validTask).success, true);
  });

  it("accepts a valid initiative", () => {
    assert.equal(nodeRow.safeParse(validInitiative).success, true);
  });

  it("rejects missing required keys for objective", () => {
    for (const key of Object.keys(validObjective)) {
      const copy = { ...validObjective };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        nodeRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      nodeRow.safeParse({ ...validObjective, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for projectId", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        projectId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("accepts each node kind for id", () => {
    for (const kind of ["initiative", "objective", "task"] as const) {
      const base =
        kind === "initiative"
          ? validInitiative
          : kind === "objective"
            ? validObjective
            : validTask;
      const prefix = kind === "objective" ? "objective_" : `${kind}_`;
      assert.equal(
        nodeRow.safeParse({ ...base, id: prefix + ULID_A, kind }).success,
        true,
        `expected ${kind} to be accepted`,
      );
    }
  });

  it("rejects repo_ prefix for id", () => {
    assert.equal(
      nodeRow.safeParse({ ...validObjective, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("accepts each node state", () => {
    for (const state of [
      "pending",
      "ready",
      "running",
      "blocked",
      "awaiting_approval",
      "done",
      "partial",
      "discarded",
    ] as const) {
      const row =
        state === "blocked"
          ? { ...validObjective, state, blockReason: "abandoned" }
          : state === "awaiting_approval"
            ? { ...validObjective, state, kind: "objective" as const }
            : state === "partial"
              ? { ...validObjective, state, kind: "objective" as const }
              : { ...validObjective, state };
      assert.equal(
        nodeRow.safeParse(row).success,
        true,
        `expected state ${state} to be accepted`,
      );
    }
  });

  it("rejects invalid state", () => {
    assert.equal(
      nodeRow.safeParse({ ...validObjective, state: "invalid" }).success,
      false,
    );
  });

  it("refine 1: initiative with non-null parentId fails", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validInitiative,
        parentId: "initiative_" + ULID_B,
      }).success,
      false,
    );
  });

  it("refine 1: objective with null parentId fails", () => {
    assert.equal(
      nodeRow.safeParse({ ...validObjective, parentId: null }).success,
      false,
    );
  });

  it("refine 1: message equals the DDL CHECK expression", () => {
    const result = nodeRow.safeParse({ ...validObjective, parentId: null });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(kind = 'initiative') = (parent_id IS NULL)",
    );
  });

  it("refine 2: objective with null repositoryId fails", () => {
    assert.equal(
      nodeRow.safeParse({ ...validObjective, repositoryId: null }).success,
      false,
    );
  });

  it("refine 2: task with non-null repositoryId fails", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validTask,
        repositoryId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("refine 2: message equals the DDL CHECK expression", () => {
    const result = nodeRow.safeParse({ ...validObjective, repositoryId: null });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(kind = 'objective') = (repository_id IS NOT NULL)",
    );
  });

  it("refine 3: task with null acceptanceBlob fails", () => {
    assert.equal(
      nodeRow.safeParse({ ...validTask, acceptanceBlob: null }).success,
      false,
    );
  });

  it("refine 3: objective with non-null acceptanceBlob fails", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        acceptanceBlob: HASH,
      }).success,
      false,
    );
  });

  it("refine 3: message equals the DDL CHECK expression", () => {
    const result = nodeRow.safeParse({ ...validTask, acceptanceBlob: null });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(kind = 'task') = (acceptance_blob IS NOT NULL)",
    );
  });

  it("refine 4: blocked with null blockReason fails", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        state: "blocked",
        blockReason: null,
      }).success,
      false,
    );
  });

  it("refine 4: ready with blockReason fails", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        state: "ready",
        blockReason: "abandoned",
      }).success,
      false,
    );
  });

  it("refine 4: message equals the DDL CHECK expression", () => {
    const result = nodeRow.safeParse({
      ...validObjective,
      state: "blocked",
      blockReason: null,
    });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(state = 'blocked') = (block_reason IS NOT NULL)",
    );
  });

  it("refine 5: task with awaiting_approval fails", () => {
    assert.equal(
      nodeRow.safeParse({ ...validTask, state: "awaiting_approval" }).success,
      false,
    );
  });

  it("refine 5: message equals the DDL CHECK expression", () => {
    const result = nodeRow.safeParse({
      ...validTask,
      state: "awaiting_approval",
    });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "state <> 'awaiting_approval' OR kind = 'objective'",
    );
  });

  it("refine 5: objective with awaiting_approval passes", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        state: "awaiting_approval",
      }).success,
      true,
    );
  });

  it("refine 6: task with partial fails", () => {
    assert.equal(
      nodeRow.safeParse({ ...validTask, state: "partial" }).success,
      false,
    );
  });

  it("refine 6: message equals the DDL CHECK expression", () => {
    const result = nodeRow.safeParse({ ...validTask, state: "partial" });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "state <> 'partial' OR kind <> 'task'",
    );
  });

  it("refine 6: objective with partial passes", () => {
    assert.equal(
      nodeRow.safeParse({ ...validObjective, state: "partial" }).success,
      true,
    );
  });

  it("refine 7: mismatched id prefix and kind fails", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        id: "task_" + ULID_A,
        kind: "objective",
      }).success,
      false,
    );
  });

  it("refine 7: matching id prefix and kind passes", () => {
    assert.equal(
      nodeRow.safeParse({
        ...validObjective,
        id: "objective_" + ULID_A,
        kind: "objective",
      }).success,
      true,
    );
  });

  it("refine 7: all three node kinds accept matching prefix", () => {
    for (const kind of ["initiative", "objective", "task"] as const) {
      const base =
        kind === "initiative"
          ? validInitiative
          : kind === "objective"
            ? validObjective
            : validTask;
      const id = `${kind}_${ULID_A}`;
      assert.equal(
        nodeRow.safeParse({ ...base, id, kind }).success,
        true,
        `expected ${kind} with matching prefix to pass`,
      );
    }
  });

  it("refine 7: all three node kinds reject repo_ prefix", () => {
    for (const kind of ["initiative", "objective", "task"] as const) {
      const base =
        kind === "initiative"
          ? validInitiative
          : kind === "objective"
            ? validObjective
            : validTask;
      assert.equal(
        nodeRow.safeParse({ ...base, id: "repo_" + ULID_A, kind }).success,
        false,
        `expected ${kind} with repo_ prefix to fail`,
      );
    }
  });

  it("refine 7: each node kind rejects the other two kinds' prefixes", () => {
    for (const kind of ["initiative", "objective", "task"] as const) {
      const base =
        kind === "initiative"
          ? validInitiative
          : kind === "objective"
            ? validObjective
            : validTask;
      const otherKinds = (["initiative", "objective", "task"] as const).filter(
        (other) => other !== kind,
      );
      for (const other of otherKinds) {
        assert.equal(
          nodeRow.safeParse({ ...base, id: `${other}_${ULID_A}`, kind })
            .success,
          false,
          `expected ${kind} with ${other}_ prefix to fail`,
        );
      }
    }
  });
});
