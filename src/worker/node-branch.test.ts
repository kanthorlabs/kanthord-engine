import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeBranchOf } from "./node-branch.ts";

test("node branch is deterministic across attempts and refuses malformed identities", () => {
  const nodeId = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  assert.equal(nodeBranchOf(nodeId), "kanthord/" + nodeId);
  assert.throws(() => nodeBranchOf("node_../main"), assert.AssertionError);
});
