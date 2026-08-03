export type GraphNodeInput = Readonly<{ id: string; parentId: string | null }>;

export type GraphEdgeInput = Readonly<{ from: string; to: string }>;

export type GraphInput = Readonly<{
  nodes: readonly GraphNodeInput[];
  edges: readonly GraphEdgeInput[];
}>;

export type GraphErrorCode = "graph-cycle" | "graph-unknown-node";

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = "GraphError";
    this.code = code;
  }
}

export interface Graph {
  topologicalOrder(input: GraphInput): readonly string[];
  cycles(input: GraphInput): readonly (readonly string[])[];
  children(input: GraphInput, parentId: string | null): readonly string[];
}
