import type {
  Graph,
  SerializedGraph,
  GraphSerializeInput,
  SerializedGraphNode,
  SerializedGraphEdge,
  GraphAttributes,
} from "../../src/services/graph/index.ts";

function compareIds(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function sortAttributes(attributes: GraphAttributes): GraphAttributes {
  const keys = Object.keys(attributes).sort(compareIds);
  const sorted: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    sorted[key] = attributes[key]!;
  }
  return sorted;
}

export function createGraphService(): Graph {
  return {
    topologicalOrder(_input) {
      return [];
    },
    cycles(_input) {
      return [];
    },
    children(_input, _parentId) {
      return [];
    },
    components(_input) {
      return [];
    },
    serialize(input: GraphSerializeInput): SerializedGraph {
      const sortedNodes = [...input.nodes].sort((a, b) =>
        compareIds(a.key, b.key),
      );
      const sortedEdges = [...input.edges].sort((a, b) =>
        compareIds(a.key, b.key),
      );

      const serializedNodes: SerializedGraphNode[] = sortedNodes.map(
        (node) => ({
          key: node.key,
          attributes: sortAttributes(node.attributes),
        }),
      );

      const serializedEdges: SerializedGraphEdge[] = sortedEdges.map(
        (edge) => ({
          key: edge.key,
          source: edge.source,
          target: edge.target,
          attributes: sortAttributes(edge.attributes),
        }),
      );

      return {
        attributes: sortAttributes(input.attributes),
        options: { allowSelfLoops: false, multi: false, type: "directed" },
        nodes: serializedNodes,
        edges: serializedEdges,
      };
    },
  };
}
