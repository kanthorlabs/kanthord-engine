import assert from "node:assert/strict";
import { test } from "node:test";
import { type DepEdge, detectCycle, directDependenciesOf } from "./graph.ts";

const edge = (dependent: string, dependsOn: string): DepEdge => ({
  dependent,
  depends_on: dependsOn,
});

test("detectCycle finds two-node, three-node and self cycles", () => {
  assert.equal(detectCycle([edge("a", "b"), edge("b", "a")]), true);
  assert.equal(
    detectCycle([edge("a", "b"), edge("b", "c"), edge("c", "a")]),
    true,
  );
  assert.equal(detectCycle([edge("a", "a")]), true);
});

test("detectCycle accepts DAGs, chains and empty edges", () => {
  assert.equal(
    detectCycle([edge("a", "b"), edge("a", "c"), edge("b", "c")]),
    false,
  );
  assert.equal(detectCycle([edge("a", "b"), edge("b", "c")]), false);
  assert.equal(detectCycle([]), false);
  assert.equal(detectCycle([edge("a", "b"), edge("a", "b")]), false);
});

test("the closure of A holds B alone when A depends on B and B depends on C", () => {
  const edges = [edge("a", "b"), edge("b", "c")];
  assert.deepEqual(directDependenciesOf("a", edges), ["b"]);
  assert.deepEqual(directDependenciesOf("c", edges), []);
});
