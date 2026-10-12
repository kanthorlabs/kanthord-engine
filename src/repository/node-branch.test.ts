import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_BRANCH_PATTERN, nodeBranchOf } from "./node-branch.ts";

const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIRST_ATTEMPT = 1;
const RESTART_ATTEMPT = 2;
const LATER_RESTART_ATTEMPT = 12;
const NO_ATTEMPT = 0;

test("node branch keeps the plain name for attempt 1 and adds the restart attempt for a later start", () => {
  assert.equal(nodeBranchOf(NODE_ID, FIRST_ATTEMPT), "kanthord/" + NODE_ID);
  assert.equal(
    nodeBranchOf(NODE_ID, RESTART_ATTEMPT),
    "kanthord/" + NODE_ID + "-a2",
  );
  assert.equal(
    nodeBranchOf(NODE_ID, LATER_RESTART_ATTEMPT),
    "kanthord/" + NODE_ID + "-a12",
  );
  assert.throws(
    () => nodeBranchOf("node_../main", FIRST_ATTEMPT),
    assert.AssertionError,
  );
  assert.throws(() => nodeBranchOf(NODE_ID, NO_ATTEMPT), assert.AssertionError);
});

test("the node branch pattern refuses a nested ref, attempt 0, attempt 1 and a leading zero", () => {
  for (const suffix of ["", "-a2", "-a10"])
    assert.match("kanthord/" + NODE_ID + suffix, NODE_BRANCH_PATTERN);
  for (const suffix of ["/a2", "-a0", "-a01", "-a1", "-a", "-b2"])
    assert.doesNotMatch("kanthord/" + NODE_ID + suffix, NODE_BRANCH_PATTERN);
});
