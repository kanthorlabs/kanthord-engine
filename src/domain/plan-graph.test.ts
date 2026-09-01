import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  StoredNode,
  StoredEdge,
  ContainmentFacts,
  ValidationContext,
} from "./plan-graph.ts";

describe("src/domain/plan-graph.test", () => {
  it("StoredNode carries exactly its eighteen members", () => {
    const node: StoredNode = {
      id: "task_a",
      projectId: "project_a",
      kind: "task",
      parentId: "objective_a",
      title: "Harden the verify CLI",
      instructionBlob: `sha256:${"0".repeat(64)}`,
      acceptanceBlob: `sha256:${"1".repeat(64)}`,
      worker: null,
      assignment: null,
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: "revision_a",
      updatedAt: 1,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    };
    assert.deepEqual(Object.keys(node).sort(), [
      "acceptanceBlob",
      "assignment",
      "blockReason",
      "deliverable",
      "dependencies",
      "discardReason",
      "id",
      "instructionBlob",
      "kind",
      "parentId",
      "projectId",
      "repositoryId",
      "revision",
      "state",
      "title",
      "updatedAt",
      "verifyJson",
      "worker",
    ]);
  });

  it("StoredEdge carries exactly its four members", () => {
    const edge: StoredEdge = {
      id: "edge_a",
      fromNode: "task_a",
      toNode: "task_b",
      waivedAt: null,
    };
    assert.deepEqual(Object.keys(edge).sort(), [
      "fromNode",
      "id",
      "toNode",
      "waivedAt",
    ]);
  });

  it("ContainmentFacts carries exactly its four members", () => {
    const facts: ContainmentFacts = {
      lease: false,
      workspace: false,
      attemptCommit: false,
      retainedCommit: false,
    };
    assert.deepEqual(Object.keys(facts).sort(), [
      "attemptCommit",
      "lease",
      "retainedCommit",
      "workspace",
    ]);
  });

  it("ValidationContext carries exactly its three members", () => {
    const context: ValidationContext = {
      workerKinds: ["general@1"],
      boundRepositories: ["repo_a"],
      knownRepositories: ["repo_a"],
    };
    assert.deepEqual(Object.keys(context).sort(), [
      "boundRepositories",
      "knownRepositories",
      "workerKinds",
    ]);
  });

  it("the module resolves at runtime", async () => {
    await import("./plan-graph.ts");
  });
});
