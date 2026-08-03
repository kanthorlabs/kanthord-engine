import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { edgeRow } from "./edge.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const ULID_B = "01HZY8QF3M4N5P6R7S8T9V0W2Y";

describe("src/domain/edge.test", () => {
  const validRow = {
    id: "edge_" + ULID_A,
    fromNode: "task_" + ULID_A,
    toNode: "task_" + ULID_B,
    waivedAt: null,
  };

  it("accepts a valid row", () => {
    assert.equal(edgeRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        edgeRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      edgeRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for fromNode", () => {
    assert.equal(
      edgeRow.safeParse({ ...validRow, fromNode: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for toNode", () => {
    assert.equal(
      edgeRow.safeParse({ ...validRow, toNode: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("refine: fromNode === toNode fails", () => {
    const nodeId = "task_" + ULID_A;
    assert.equal(
      edgeRow.safeParse({ ...validRow, fromNode: nodeId, toNode: nodeId })
        .success,
      false,
    );
  });

  it("refine: message equals the DDL CHECK expression", () => {
    const nodeId = "task_" + ULID_A;
    const result = edgeRow.safeParse({
      ...validRow,
      fromNode: nodeId,
      toNode: nodeId,
    });
    assert.equal(result.success, false);
    assert.equal(result.error!.issues[0]!.message, "from_node <> to_node");
  });

  it("refine: different node ids pass", () => {
    assert.equal(
      edgeRow.safeParse({
        ...validRow,
        fromNode: "task_" + ULID_A,
        toNode: "task_" + ULID_B,
      }).success,
      true,
    );
  });
});
