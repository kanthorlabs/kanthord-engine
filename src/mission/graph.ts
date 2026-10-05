import { DirectedGraph } from "graphology";

export type DepEdge = { dependent: string; dependsOn: string };

const NO_DEPENDENCIES = 0;

export function detectCycle(edges: DepEdge[]): boolean {
  const graph = new DirectedGraph();
  for (const { dependent, dependsOn } of edges) {
    graph.mergeNode(dependent);
    graph.mergeNode(dependsOn);
    if (!graph.hasEdge(dependent, dependsOn)) {
      graph.addDirectedEdge(dependent, dependsOn);
    }
  }

  const inDegrees = new Map<string, number>();
  const queue: string[] = [];
  graph.forEachNode((node) => {
    const degree = graph.inDegree(node);
    inDegrees.set(node, degree);
    if (degree === NO_DEPENDENCIES) queue.push(node);
  });

  let processed = 0;
  for (let index = 0; index < queue.length && index < graph.order; index++) {
    const node = queue[index];
    processed++;
    for (const neighbor of graph.outNeighbors(node)) {
      const degree = inDegrees.get(neighbor);
      if (degree === undefined) throw new Error("Missing node in degree map");
      const remaining = degree - 1;
      inDegrees.set(neighbor, remaining);
      if (remaining === NO_DEPENDENCIES) queue.push(neighbor);
    }
  }
  return processed < graph.order;
}

export function buildDependencyClosureOf(
  nodeId: string,
  allEdges: DepEdge[],
  parentMap: Map<string, string>,
): Set<string> {
  const chain = new Set<string>();
  const bound = parentMap.size + 1;
  let current: string | undefined = nodeId;
  for (let steps = 0; current !== undefined; steps++) {
    if (steps >= bound) throw new Error("Parent map contains a loop");
    chain.add(current);
    current = parentMap.get(current);
  }

  const closure = new Set<string>();
  for (const { dependent, dependsOn } of allEdges) {
    if (chain.has(dependent)) closure.add(dependsOn);
  }
  return closure;
}

export function waitEdges(
  nodeIds: readonly string[],
  parentMap: Map<string, string>,
): DepEdge[] {
  const edges: DepEdge[] = [];
  for (const child of nodeIds) {
    const parent = parentMap.get(child);
    if (parent !== undefined)
      edges.push({ dependent: parent, dependsOn: child });
  }
  return edges;
}

export function hasDependencyCycle(
  nodeIds: readonly string[],
  edges: DepEdge[],
  parentMap: Map<string, string>,
): boolean {
  return detectCycle([
    ...closureEdges(nodeIds, edges, parentMap),
    ...waitEdges(nodeIds, parentMap),
  ]);
}

export function closureEdges(
  nodeIds: Iterable<string>,
  allEdges: DepEdge[],
  parentMap: Map<string, string>,
): DepEdge[] {
  const edges: DepEdge[] = [];
  for (const dependent of nodeIds) {
    for (const dependsOn of buildDependencyClosureOf(
      dependent,
      allEdges,
      parentMap,
    )) {
      edges.push({ dependent, dependsOn });
    }
  }
  return edges;
}
