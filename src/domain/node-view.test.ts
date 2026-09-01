import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { NodeKind, NodeState } from "./state.ts";
import type { StoredNode } from "./plan-graph.ts";
import type { NodeListItem } from "./node-view.ts";
import { toNodeListItem } from "./node-view.ts";

describe("src/domain/node-view.test", () => {
  it("exports NodeListItem type and toNodeListItem function", () => {
    const _item: NodeListItem = {
      id: "test",
      projectId: "proj",
      kind: "initiative" as NodeKind,
      title: "Test",
      state: "pending" as NodeState,
      blockReason: null,
      discardReason: null,
      parentId: null,
      dependencies: [],
    };
    assert.ok(_item);
    assert.equal(typeof toNodeListItem, "function");
  });

  it("toNodeListItem maps every StoredNode field to NodeListItem", () => {
    const stored: StoredNode = {
      id: "node_1",
      projectId: "proj_a",
      kind: "task",
      parentId: "objective_1",
      title: "Implement feature",
      instructionBlob: "sha256:aaa",
      acceptanceBlob: "sha256:bbb",
      worker: "general@1",
      assignment: null,
      repositoryId: null,
      state: "ready",
      blockReason: null,
      discardReason: null,
      revision: "rev_1",
      updatedAt: 1234567890,
      deliverable: null,
      verifyJson: null,
      dependencies: ["dep_1", "dep_2"],
    };

    const result = toNodeListItem(stored);

    assert.equal(result.id, "node_1");
    assert.equal(result.projectId, "proj_a");
    assert.equal(result.kind, "task");
    assert.equal(result.title, "Implement feature");
    assert.equal(result.state, "ready");
    assert.equal(result.blockReason, null);
    assert.equal(result.discardReason, null);
    assert.equal(result.parentId, "objective_1");
    assert.deepEqual(result.dependencies, ["dep_1", "dep_2"]);
  });

  it("toNodeListItem preserves null parentId for initiative", () => {
    const stored: StoredNode = {
      id: "init_1",
      projectId: "proj_a",
      kind: "initiative",
      parentId: null,
      title: "Top level",
      instructionBlob: "sha256:aaa",
      acceptanceBlob: null,
      worker: null,
      assignment: null,
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: "rev_1",
      updatedAt: 1234567890,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    };

    const result = toNodeListItem(stored);

    assert.equal(result.parentId, null);
  });

  it("toNodeListItem preserves blockReason and discardReason when present", () => {
    const stored: StoredNode = {
      id: "node_2",
      projectId: "proj_a",
      kind: "task",
      parentId: "obj_1",
      title: "Blocked task",
      instructionBlob: "sha256:aaa",
      acceptanceBlob: "sha256:bbb",
      worker: "general@1",
      assignment: null,
      repositoryId: null,
      state: "blocked",
      blockReason: "attempt-limit",
      discardReason: "abandoned",
      revision: "rev_1",
      updatedAt: 1234567890,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    };

    const result = toNodeListItem(stored);

    assert.equal(result.blockReason, "attempt-limit");
    assert.equal(result.discardReason, "abandoned");
  });

  it("toNodeListItem returns readonly array for dependencies", () => {
    const stored: StoredNode = {
      id: "node_3",
      projectId: "proj_a",
      kind: "task",
      parentId: "obj_1",
      title: "Task with deps",
      instructionBlob: "sha256:aaa",
      acceptanceBlob: "sha256:bbb",
      worker: "general@1",
      assignment: null,
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: "rev_1",
      updatedAt: 1234567890,
      deliverable: null,
      verifyJson: null,
      dependencies: ["a", "b", "c"],
    };

    const result = toNodeListItem(stored);

    assert.ok(Array.isArray(result.dependencies));
    assert.equal(result.dependencies.length, 3);
  });
});
