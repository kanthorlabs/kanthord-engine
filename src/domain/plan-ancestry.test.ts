import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { terminalAncestor } from "./plan-ancestry.ts";
import type { AncestryNode } from "./plan-ancestry.ts";
import type { NodeState } from "./state.ts";

function node(
  id: string,
  parentId: string | null,
  state: NodeState,
): AncestryNode {
  return { id, parentId, state };
}

describe("src/domain/plan-ancestry.test", () => {
  it("a chain of startable ancestors names no terminal node", () => {
    const nodes = [
      node("initiative_1", null, "ready"),
      node("objective_1", "initiative_1", "running"),
    ];

    assert.equal(terminalAncestor(nodes, "objective_1"), null);
  });

  it("a null parent names no terminal node", () => {
    const nodes = [node("initiative_1", null, "done")];

    assert.equal(terminalAncestor(nodes, null), null);
  });

  it("the parent itself is named when it is terminal", () => {
    const nodes = [
      node("initiative_1", null, "ready"),
      node("objective_1", "initiative_1", "done"),
    ];

    assert.equal(terminalAncestor(nodes, "objective_1")?.id, "objective_1");
  });

  it("the nearest terminal ancestor is named, not the farthest", () => {
    const nodes = [
      node("initiative_1", null, "discarded"),
      node("objective_1", "initiative_1", "partial"),
    ];

    assert.equal(terminalAncestor(nodes, "objective_1")?.id, "objective_1");
  });

  it("a terminal grandparent is named through a startable parent", () => {
    const nodes = [
      node("initiative_1", null, "partial"),
      node("objective_1", "initiative_1", "ready"),
    ];

    assert.equal(terminalAncestor(nodes, "objective_1")?.id, "initiative_1");
  });

  it("every terminal state is named", () => {
    for (const state of ["done", "partial", "discarded"] as const) {
      const nodes = [node("objective_1", null, state)];
      assert.equal(terminalAncestor(nodes, "objective_1")?.state, state);
    }
  });

  it("an unknown parent identity names no terminal node", () => {
    const nodes = [node("initiative_1", null, "done")];

    assert.equal(terminalAncestor(nodes, "objective_absent"), null);
  });

  it("a parent cycle terminates and names the terminal node inside it", () => {
    const nodes = [
      node("objective_1", "task_1", "done"),
      node("task_1", "objective_1", "ready"),
    ];

    assert.equal(terminalAncestor(nodes, "task_1")?.id, "objective_1");
  });

  it("a parent cycle of startable nodes terminates and names no terminal node", () => {
    const nodes = [
      node("objective_1", "task_1", "ready"),
      node("task_1", "objective_1", "ready"),
    ];

    assert.equal(terminalAncestor(nodes, "task_1"), null);
  });
});
