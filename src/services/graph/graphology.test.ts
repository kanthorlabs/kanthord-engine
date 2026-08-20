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

  it("serialize exports SerializedGraph with four top-level keys in fixed order", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_b",
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_a",
          attributes: {
            kind: "objective",
            title: "A",
            state: "active",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: "repo_01",
          },
        },
      ],
      edges: [
        {
          key: "edge_1",
          source: "node_b",
          target: "node_a",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    const result = graph.serialize(input);
    assert.deepEqual(Object.keys(result), [
      "attributes",
      "options",
      "nodes",
      "edges",
    ]);
    assert.deepEqual(result.options, {
      allowSelfLoops: false,
      multi: false,
      type: "directed",
    });
    assert.equal(result.attributes.projectId, "proj_01");
    assert.equal(result.attributes.revision, "rev_01");
    assert.equal(result.nodes.length, 2);
    assert.equal(result.edges.length, 1);
  });

  it("serialize orders nodes bytewise by key", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_c",
          attributes: {
            kind: "task",
            title: "C",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_b",
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [],
    };
    const result = graph.serialize(input);
    assert.deepEqual(
      result.nodes.map((n) => n.key),
      ["node_a", "node_b", "node_c"],
    );
  });

  it("serialize orders edges bytewise by key", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_b",
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_c",
          attributes: {
            kind: "task",
            title: "C",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_c",
          source: "node_a",
          target: "node_b",
          attributes: { relation: "depends-on", waivedAt: null },
        },
        {
          key: "edge_a",
          source: "node_b",
          target: "node_c",
          attributes: { relation: "depends-on", waivedAt: null },
        },
        {
          key: "edge_b",
          source: "node_a",
          target: "node_c",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    const result = graph.serialize(input);
    assert.deepEqual(
      result.edges.map((e) => e.key),
      ["edge_a", "edge_b", "edge_c"],
    );
  });

  it("serialize attribute key order is bytewise and insertion-independent", () => {
    const attrs1 = { z: 1, a: 2, m: 3 };
    const attrs2 = { a: 2, m: 3, z: 1 };
    const input1 = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [{ key: "node_a", attributes: attrs1 }],
      edges: [],
    };
    const input2 = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [{ key: "node_a", attributes: attrs2 }],
      edges: [],
    };
    const result1 = graph.serialize(input1);
    const result2 = graph.serialize(input2);
    assert.equal(
      Buffer.compare(
        Buffer.from(JSON.stringify(result1)),
        Buffer.from(JSON.stringify(result2)),
      ),
      0,
    );
    const nodeAttrKeys = Object.keys(result1.nodes[0]!.attributes);
    assert.deepEqual(nodeAttrKeys, ["a", "m", "z"]);
  });

  it("serialize throws graph-duplicate-node on repeated node key", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [],
    };
    assert.throws(
      () => graph.serialize(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-duplicate-node",
    );
  });

  it("serialize throws graph-unknown-node on edge naming absent node", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_1",
          source: "node_a",
          target: "node_missing",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    assert.throws(
      () => graph.serialize(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-unknown-node",
    );
  });

  it("serialize throws graph-duplicate-edge on repeated edge key", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_b",
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_1",
          source: "node_a",
          target: "node_b",
          attributes: { relation: "depends-on", waivedAt: null },
        },
        {
          key: "edge_1",
          source: "node_b",
          target: "node_a",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    assert.throws(
      () => graph.serialize(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-duplicate-edge",
    );
  });

  it("serialize throws graph-duplicate-edge on second edge between same ordered pair", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_b",
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_1",
          source: "node_a",
          target: "node_b",
          attributes: { relation: "depends-on", waivedAt: null },
        },
        {
          key: "edge_2",
          source: "node_a",
          target: "node_b",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    assert.throws(
      () => graph.serialize(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-duplicate-edge",
    );
  });

  it("serialize throws graph-self-loop when source equals target", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_1",
          source: "node_a",
          target: "node_a",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    assert.throws(
      () => graph.serialize(input),
      (error: unknown) =>
        error instanceof GraphError && error.code === "graph-self-loop",
    );
  });

  it("serialize no graphology exception escapes the capability", () => {
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_a",
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_b",
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_1",
          source: "node_a",
          target: "node_b",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    assert.doesNotThrow(() => graph.serialize(input));
    const result = graph.serialize(input);
    assert.ok(result.attributes);
    assert.ok(result.options);
    assert.ok(Array.isArray(result.nodes));
    assert.ok(Array.isArray(result.edges));
  });

  it("serialize orders nodes by bytewise key order with non-ASCII keys where UTF-16 and UTF-8 differ", () => {
    const a = "\uE000";
    const b = "\u{10000}";
    const bytewiseOrder =
      Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: bytewiseOrder[1]!,
          attributes: {
            kind: "task",
            title: "B",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: bytewiseOrder[0]!,
          attributes: {
            kind: "task",
            title: "A",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [],
    };
    const result = graph.serialize(input);
    assert.deepEqual(
      result.nodes.map((n) => n.key),
      bytewiseOrder,
    );
  });

  it("serialize orders edges by bytewise key order with non-ASCII keys where UTF-16 and UTF-8 differ", () => {
    const a = "\uE000";
    const b = "\u{10000}";
    const bytewiseOrder =
      Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    const input = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [
        {
          key: "node_1",
          attributes: {
            kind: "task",
            title: "N1",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
        {
          key: "node_2",
          attributes: {
            kind: "task",
            title: "N2",
            state: "ready",
            blockReason: null,
            discardReason: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: bytewiseOrder[1]!,
          source: "node_1",
          target: "node_2",
          attributes: { relation: "depends-on", waivedAt: null },
        },
        {
          key: bytewiseOrder[0]!,
          source: "node_2",
          target: "node_1",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };
    const result = graph.serialize(input);
    assert.deepEqual(
      result.edges.map((e) => e.key),
      bytewiseOrder,
    );
  });

  it("serialize attribute key order is bytewise with non-ASCII keys where UTF-16 and UTF-8 differ", () => {
    const a = "\uE000";
    const b = "\u{10000}";
    const bytewiseOrder =
      Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    const attrs1 = { [bytewiseOrder[1]!]: 1, [bytewiseOrder[0]!]: 2 };
    const attrs2 = { [bytewiseOrder[0]!]: 2, [bytewiseOrder[1]!]: 1 };
    const input1 = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [{ key: "node_a", attributes: attrs1 }],
      edges: [],
    };
    const input2 = {
      attributes: { projectId: "proj_01", revision: "rev_01" },
      nodes: [{ key: "node_a", attributes: attrs2 }],
      edges: [],
    };
    const result1 = graph.serialize(input1);
    const result2 = graph.serialize(input2);
    assert.deepEqual(result1, result2);
    const nodeAttrKeys = Object.keys(result1.nodes[0]!.attributes);
    assert.deepEqual(nodeAttrKeys, bytewiseOrder);
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
