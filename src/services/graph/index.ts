export type GraphNodeInput = Readonly<{ id: string; parentId: string | null }>;

export type GraphEdgeInput = Readonly<{ from: string; to: string }>;

export type GraphInput = Readonly<{
  nodes: readonly GraphNodeInput[];
  edges: readonly GraphEdgeInput[];
}>;

export type GraphErrorCode =
  | "graph-cycle"
  | "graph-unknown-node"
  | "graph-duplicate-node"
  | "graph-duplicate-edge"
  | "graph-self-loop";

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = "GraphError";
    this.code = code;
  }
}

export type VerifyBlockValue = Readonly<{
  paths: readonly string[];
  commands: readonly string[];
}>;

export type GraphAttributes = Readonly<
  Record<string, string | number | boolean | null | VerifyBlockValue>
>;

export type SerializedGraphNode = Readonly<{
  key: string;
  attributes: GraphAttributes;
}>;

export type SerializedGraphEdge = Readonly<{
  key: string;
  source: string;
  target: string;
  attributes: GraphAttributes;
}>;

export type SerializedGraph = Readonly<{
  attributes: GraphAttributes;
  options: Readonly<{
    allowSelfLoops: boolean;
    multi: boolean;
    type: "directed";
  }>;
  nodes: readonly SerializedGraphNode[];
  edges: readonly SerializedGraphEdge[];
}>;

export type GraphSerializeInput = Readonly<{
  attributes: GraphAttributes;
  nodes: readonly SerializedGraphNode[];
  edges: readonly SerializedGraphEdge[];
}>;

export interface Graph {
  topologicalOrder(input: GraphInput): readonly string[];
  cycles(input: GraphInput): readonly (readonly string[])[];
  children(input: GraphInput, parentId: string | null): readonly string[];
  components(input: GraphInput): readonly (readonly string[])[];
  serialize(input: GraphSerializeInput): SerializedGraph;
}
