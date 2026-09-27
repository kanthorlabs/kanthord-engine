import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDependencyClosureOf,
  closureEdges,
  detectCycle,
  type DepEdge,
} from "./graph.ts";

const edge = (dependent: string, dependsOn: string): DepEdge => ({
  dependent,
  dependsOn,
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

test("closure inherits direct dependencies but not transitive dependencies", () => {
  const parents = new Map([
    ["t", "o"],
    ["o", "i"],
  ]);
  const edges = [edge("o", "x"), edge("i", "y"), edge("x", "z")];
  assert.deepEqual(
    buildDependencyClosureOf("o", edges, parents),
    new Set(["x", "y"]),
  );
  assert.deepEqual(
    buildDependencyClosureOf("t", edges, parents),
    new Set(["x", "y"]),
  );
  assert.deepEqual(
    buildDependencyClosureOf("i", edges, parents),
    new Set(["y"]),
  );
});

test("shared dependencies occur once in a closure", () => {
  const parents = new Map([["o", "i"]]);
  const edges = [edge("o", "x"), edge("i", "x")];
  assert.deepEqual(
    buildDependencyClosureOf("o", edges, parents),
    new Set(["x"]),
  );
  assert.deepEqual(closureEdges(["o"], edges, parents), [edge("o", "x")]);
});

test("closure refuses a loop in the parent map", () => {
  const parents = new Map([
    ["a", "b"],
    ["b", "a"],
  ]);
  assert.throws(() => buildDependencyClosureOf("a", [], parents), /loop/);
  assert.throws(() => closureEdges(["a"], [], parents), /loop/);
});

test("inherited dependency on a child produces a self cycle", () => {
  const parents = new Map([["o", "i"]]);
  const edges = [edge("i", "o")];
  assert.equal(detectCycle(edges), false);
  assert.deepEqual(closureEdges(["i", "o"], edges, parents), [
    edge("i", "o"),
    edge("o", "o"),
  ]);
  assert.equal(detectCycle(closureEdges(["i", "o"], edges, parents)), true);
});

test("cross-initiative inheritance reveals a cycle absent from raw edges", () => {
  const parents = new Map([
    ["a", "A"],
    ["b", "B"],
  ]);
  const edges = [edge("a", "b"), edge("B", "a")];
  assert.equal(detectCycle(edges), false);
  assert.equal(
    detectCycle(closureEdges(["a", "A", "b", "B"], edges, parents)),
    true,
  );
});

test("a DAG with inherited dependencies has no closure cycle", () => {
  const parents = new Map([
    ["a", "A"],
    ["b", "B"],
  ]);
  const edges = [edge("A", "b"), edge("b", "c")];
  const inherited = closureEdges(["A", "a", "B", "b", "c"], edges, parents);
  assert.deepEqual(
    buildDependencyClosureOf("a", edges, parents),
    new Set(["b"]),
  );
  assert.equal(detectCycle(inherited), false);
});
