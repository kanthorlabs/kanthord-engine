import { DirectedGraph } from "graphology";

import { GraphError } from "./index.ts";
import type { Graph, GraphInput } from "./index.ts";

export class GraphologyGraph implements Graph {
  topologicalOrder(input: GraphInput): readonly string[] {
    const graph = buildGraph(input);
    const nodeIds = input.nodes.map((node) => node.id);

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of nodeIds) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }
    for (const edge of graph.directedEdges()) {
      const from = graph.source(edge);
      const to = graph.target(edge);
      inDegree.set(from, (inDegree.get(from) ?? 0) + 1);
      dependents.get(to)!.push(from);
    }

    const available: string[] = [];
    for (const id of nodeIds) {
      if (inDegree.get(id) === 0) {
        available.push(id);
      }
    }
    available.sort();

    const result: string[] = [];
    while (available.length > 0) {
      const current = available.shift()!;
      result.push(current);
      for (const dependent of dependents.get(current)!) {
        const degree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, degree);
        if (degree === 0) {
          insertSorted(available, dependent);
        }
      }
    }

    if (result.length < nodeIds.length) {
      throw new GraphError("graph-cycle", "the graph holds a cycle");
    }
    return result;
  }

  cycles(input: GraphInput): readonly (readonly string[])[] {
    const graph = buildGraph(input);
    const nodeIds = [...new Set(input.nodes.map((node) => node.id))].sort();

    const neighbours = new Map<string, string[]>();
    for (const id of nodeIds) {
      neighbours.set(id, []);
    }
    for (const edge of graph.directedEdges()) {
      neighbours.get(graph.source(edge))!.push(graph.target(edge));
    }
    for (const list of neighbours.values()) {
      list.sort();
    }

    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let nextIndex = 0;

    const strongconnect = (node: string): void => {
      index.set(node, nextIndex);
      low.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);

      for (const neighbour of neighbours.get(node)!) {
        if (!index.has(neighbour)) {
          strongconnect(neighbour);
          low.set(node, Math.min(low.get(node)!, low.get(neighbour)!));
        } else if (onStack.has(neighbour)) {
          low.set(node, Math.min(low.get(node)!, index.get(neighbour)!));
        }
      }

      if (low.get(node) === index.get(node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        components.push(component);
      }
    };

    for (const id of nodeIds) {
      if (!index.has(id)) {
        strongconnect(id);
      }
    }

    return components
      .filter(
        (component) =>
          component.length > 1 ||
          (component.length === 1 &&
            graph.hasDirectedEdge(component[0]!, component[0]!)),
      )
      .map((component) => [...component].sort())
      .sort((a, b) => compareIds(a[0]!, b[0]!));
  }

  children(input: GraphInput, parentId: string | null): readonly string[] {
    buildGraph(input);
    return input.nodes
      .filter((node) => node.parentId === parentId)
      .map((node) => node.id)
      .sort();
  }

  components(input: GraphInput): readonly (readonly string[])[] {
    const graph = buildGraph(input);
    const adjacency = new Map<string, string[]>();
    for (const node of input.nodes) {
      adjacency.set(node.id, []);
    }
    for (const edge of graph.directedEdges()) {
      const from = graph.source(edge);
      const to = graph.target(edge);
      adjacency.get(from)!.push(to);
      adjacency.get(to)!.push(from);
    }
    for (const node of input.nodes) {
      if (node.parentId !== null) {
        adjacency.get(node.id)!.push(node.parentId);
        adjacency.get(node.parentId)!.push(node.id);
      }
    }
    for (const list of adjacency.values()) {
      list.sort();
    }

    const visited = new Set<string>();
    const componentsOut: string[][] = [];
    for (const id of [...input.nodes.map((node) => node.id)].sort()) {
      if (visited.has(id)) {
        continue;
      }
      const component: string[] = [];
      const queue = [id];
      visited.add(id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);
        for (const neighbour of adjacency.get(current)!) {
          if (!visited.has(neighbour)) {
            visited.add(neighbour);
            queue.push(neighbour);
          }
        }
      }
      component.sort();
      componentsOut.push(component);
    }
    componentsOut.sort((a, b) => compareIds(a[0]!, b[0]!));
    return componentsOut;
  }
}

function buildGraph(input: GraphInput): DirectedGraph {
  const graph = new DirectedGraph();
  for (const node of input.nodes) {
    if (graph.hasNode(node.id)) {
      throw new GraphError("graph-duplicate-node", `${node.id} appears twice`);
    }
    graph.addNode(node.id);
  }
  for (const node of input.nodes) {
    if (node.parentId !== null && !graph.hasNode(node.parentId)) {
      throw new GraphError(
        "graph-unknown-node",
        `${node.parentId} is not a node of this graph`,
      );
    }
  }
  for (const edge of input.edges) {
    if (!graph.hasNode(edge.from)) {
      throw new GraphError(
        "graph-unknown-node",
        `${edge.from} is not a node of this graph`,
      );
    }
    if (!graph.hasNode(edge.to)) {
      throw new GraphError(
        "graph-unknown-node",
        `${edge.to} is not a node of this graph`,
      );
    }
    if (!graph.hasDirectedEdge(edge.from, edge.to)) {
      graph.addDirectedEdge(edge.from, edge.to);
    }
  }
  return graph;
}

function insertSorted(array: string[], value: string): void {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (array[mid]! < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  array.splice(lo, 0, value);
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
