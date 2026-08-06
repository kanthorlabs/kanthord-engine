import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { GraphError } from "./index.ts";
import { GraphologyGraph } from "./graphology.ts";

const graph = new GraphologyGraph();

const taskA = { id: "task_01A", parentId: null };
const taskB = { id: "task_01B", parentId: null };
const taskC = { id: "task_01C", parentId: null };
const taskD = { id: "task_01D", parentId: null };

describe("src/services/graph/graphology.ts", () => {
  it("breaks the tie by the bytewise-smallest id", () => {
    const input = { nodes: [taskA, taskB, taskC], edges: [] };
    assert.deepEqual(graph.topologicalOrder(input), [
      "task_01A",
      "task_01B",
      "task_01C",
    ]);
    assert.deepEqual(
      graph.topologicalOrder({ nodes: [taskC, taskB, taskA], edges: [] }),
      ["task_01A", "task_01B", "task_01C"],
    );
  });

  it("re-enters a freed dependent at its sorted position", () => {
    const input = {
      nodes: [taskD, taskB, taskC, taskA],
      edges: [{ from: "task_01D", to: "task_01A" }],
    };
    const sorted = graph.topologicalOrder(input);
    assert.deepEqual(sorted, ["task_01A", "task_01B", "task_01C", "task_01D"]);
    const naiveQueue = ["task_01B", "task_01C", "task_01A", "task_01D"];
    assert.notDeepEqual(sorted, naiveQueue);
  });

  it("orders a diamond with dependencies first", () => {
    const input = {
      nodes: [taskA, taskB, taskC, taskD],
      edges: [
        { from: "task_01A", to: "task_01B" },
        { from: "task_01A", to: "task_01C" },
        { from: "task_01B", to: "task_01D" },
        { from: "task_01C", to: "task_01D" },
      ],
    };
    assert.deepEqual(graph.topologicalOrder(input), [
      "task_01D",
      "task_01B",
      "task_01C",
      "task_01A",
    ]);
  });

  it("throws graph-cycle on a cycle", () => {
    const input = {
      nodes: [taskA, taskB],
      edges: [
        { from: "task_01A", to: "task_01B" },
        { from: "task_01B", to: "task_01A" },
      ],
    };
    assert.throws(
      () => graph.topologicalOrder(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-cycle",
    );
  });

  it("reports every strongly connected cycle sorted", () => {
    const input = {
      nodes: [taskA, taskB],
      edges: [
        { from: "task_01A", to: "task_01B" },
        { from: "task_01B", to: "task_01A" },
      ],
    };
    assert.deepEqual(graph.cycles(input), [["task_01A", "task_01B"]]);
  });

  it("reports both cycles of two disjoint cycles ordered by first id", () => {
    const input = {
      nodes: [taskA, taskB, taskC, taskD],
      edges: [
        { from: "task_01A", to: "task_01B" },
        { from: "task_01B", to: "task_01A" },
        { from: "task_01C", to: "task_01D" },
        { from: "task_01D", to: "task_01C" },
      ],
    };
    assert.deepEqual(graph.cycles(input), [
      ["task_01A", "task_01B"],
      ["task_01C", "task_01D"],
    ]);
  });

  it("reports no cycles for an acyclic graph", () => {
    const input = {
      nodes: [taskA, taskB],
      edges: [{ from: "task_01A", to: "task_01B" }],
    };
    assert.deepEqual(graph.cycles(input), []);
  });

  it("reports one component of three for a three-node cycle with an acyclic node", () => {
    const input = {
      nodes: [taskA, taskB, taskC, taskD],
      edges: [
        { from: "task_01A", to: "task_01B" },
        { from: "task_01B", to: "task_01C" },
        { from: "task_01C", to: "task_01A" },
      ],
    };
    assert.deepEqual(graph.cycles(input), [
      ["task_01A", "task_01B", "task_01C"],
    ]);
  });

  it("reports a self edge as a one-node cycle", () => {
    const input = {
      nodes: [taskA],
      edges: [{ from: "task_01A", to: "task_01A" }],
    };
    assert.deepEqual(graph.cycles(input), [["task_01A"]]);
  });

  it("throws graph-unknown-node from every member for an undeclared endpoint", () => {
    const input = {
      nodes: [taskA],
      edges: [{ from: "task_01A", to: "task_01Z" }],
    };
    const isUnknownNode = (error: unknown): boolean =>
      error instanceof GraphError && error.code === "graph-unknown-node";
    assert.throws(() => graph.topologicalOrder(input), isUnknownNode);
    assert.throws(() => graph.cycles(input), isUnknownNode);
    assert.throws(() => graph.components(input), isUnknownNode);
  });

  it("throws graph-duplicate-node for a repeated node id", () => {
    const input = { nodes: [taskA, taskA], edges: [] };
    assert.throws(
      () => graph.topologicalOrder(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-duplicate-node",
    );
  });

  it("counts a duplicate edge once", () => {
    const single = {
      nodes: [taskA, taskB, taskC],
      edges: [{ from: "task_01A", to: "task_01B" }],
    };
    const duplicated = {
      nodes: [taskA, taskB, taskC],
      edges: [
        { from: "task_01A", to: "task_01B" },
        { from: "task_01A", to: "task_01B" },
      ],
    };
    assert.deepEqual(
      graph.topologicalOrder(duplicated),
      graph.topologicalOrder(single),
    );
  });

  it("returns children under a parent in bytewise order and the roots for null", () => {
    const input = {
      nodes: [
        { id: "objective_01A", parentId: null },
        { id: "objective_01B", parentId: null },
        { id: "task_01A", parentId: "objective_01A" },
        { id: "task_01B", parentId: "objective_01A" },
        { id: "task_01C", parentId: "objective_01A" },
        { id: "task_01D", parentId: "objective_01B" },
      ],
      edges: [],
    };
    assert.deepEqual(graph.children(input, "objective_01A"), [
      "task_01A",
      "task_01B",
      "task_01C",
    ]);
    assert.deepEqual(graph.children(input, "objective_01B"), ["task_01D"]);
    assert.deepEqual(graph.children(input, null), [
      "objective_01A",
      "objective_01B",
    ]);
  });

  it("merges containment and dependency into one component", () => {
    const containment = {
      nodes: [
        { id: "objective_01A", parentId: null },
        { id: "task_01A", parentId: "objective_01A" },
        { id: "task_01B", parentId: "objective_01A" },
      ],
      edges: [],
    };
    assert.deepEqual(graph.components(containment), [
      ["objective_01A", "task_01A", "task_01B"],
    ]);

    const dependency = {
      nodes: [
        { id: "objective_01A", parentId: null },
        { id: "task_01A", parentId: "objective_01A" },
        { id: "objective_01B", parentId: null },
        { id: "task_01B", parentId: "objective_01B" },
      ],
      edges: [{ from: "task_01A", to: "task_01B" }],
    };
    assert.deepEqual(graph.components(dependency), [
      ["objective_01A", "objective_01B", "task_01A", "task_01B"],
    ]);
  });

  it("keeps siblings under different parents apart without an edge", () => {
    const input = {
      nodes: [
        { id: "objective_01A", parentId: null },
        { id: "task_01A", parentId: "objective_01A" },
        { id: "objective_01B", parentId: null },
        { id: "task_01B", parentId: "objective_01B" },
      ],
      edges: [],
    };
    assert.deepEqual(graph.components(input), [
      ["objective_01A", "task_01A"],
      ["objective_01B", "task_01B"],
    ]);
  });

  it("returns one component per node for an edge-less parent-less graph", () => {
    const input = { nodes: [taskA, taskB, taskC], edges: [] };
    assert.deepEqual(graph.components(input), [
      ["task_01A"],
      ["task_01B"],
      ["task_01C"],
    ]);
  });

  it("is deterministic across two calls of every member", () => {
    const input = {
      nodes: [
        { id: "objective_01A", parentId: null },
        { id: "task_01A", parentId: "objective_01A" },
        { id: "task_01B", parentId: "objective_01A" },
      ],
      edges: [{ from: "task_01A", to: "task_01B" }],
    };
    const first = {
      order: graph.topologicalOrder(input),
      cycles: graph.cycles(input),
      children: graph.children(input, "objective_01A"),
      components: graph.components(input),
    };
    const second = {
      order: graph.topologicalOrder(input),
      cycles: graph.cycles(input),
      children: graph.children(input, "objective_01A"),
      components: graph.components(input),
    };
    assert.deepEqual(second, first);
  });

  it("keeps localeCompare and Intl out of the module", () => {
    const modulePath = resolve(import.meta.dirname, "graphology.ts");
    const source = readFileSync(modulePath, "utf8");
    assert.equal(source.includes("localeCompare"), false);
    assert.equal(source.includes("Intl"), false);
  });

  it("imports graphology exactly once, in the graphology implementation", () => {
    const srcRoot = resolve(import.meta.dirname, "../..");
    const importers = sourceFilesUnder(srcRoot).filter((path) =>
      readFileSync(path, "utf8").includes('"graphology"'),
    );
    assert.equal(importers.length, 1);
    assert.equal(
      importers[0],
      join(srcRoot, "services", "graph", "graphology.ts"),
    );
  });
});

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}
