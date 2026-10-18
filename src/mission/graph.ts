import { DirectedGraph } from "graphology";

export type DepEdge = { dependent: string; depends_on: string };

const NO_DEPENDENCIES = 0;

export function detectCycle(edges: DepEdge[]): boolean {
  const graph = new DirectedGraph();
  for (const { dependent, depends_on: dependsOn } of edges) {
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

export function directDependenciesOf(
  nodeId: string,
  deps: readonly DepEdge[],
): string[] {
  const direct = new Set<string>();
  for (const { dependent, depends_on: dependsOn } of deps) {
    if (dependent === nodeId) direct.add(dependsOn);
  }
  return [...direct];
}

export function directDependencyMap(
  deps: readonly DepEdge[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { dependent, depends_on: dependsOn } of deps) {
    const direct = map.get(dependent);
    if (direct) direct.push(dependsOn);
    else map.set(dependent, [dependsOn]);
  }
  return map;
}

export function hasDependencyCycle(edges: DepEdge[]): boolean {
  return detectCycle(edges);
}
