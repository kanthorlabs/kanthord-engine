import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { StoredNode, StoredEdge } from "../../domain/plan-graph.ts";
import {
  parseVerifyBlock,
  VerifyBlockError,
} from "../../domain/verify-block.ts";
import type {
  SerializedGraph,
  GraphAttributes,
  SerializedGraphNode,
  SerializedGraphEdge,
  GraphSerializeInput,
} from "../../services/graph/index.ts";

export type {
  SerializedGraph,
  SerializedGraphNode,
  SerializedGraphEdge,
  GraphAttributes,
  GraphSerializeInput,
};

export type ShowProjectGraphRefusal = "project-not-found";

export class ShowProjectGraphError extends Error {
  readonly refusal: ShowProjectGraphRefusal;

  constructor(refusal: ShowProjectGraphRefusal, message: string) {
    super(message);
    this.name = "ShowProjectGraphError";
    this.refusal = refusal;
  }
}

function nodeAttributes(node: StoredNode): GraphAttributes {
  return {
    kind: node.kind,
    title: node.title,
    state: node.state,
    blockReason: node.blockReason,
    discardReason: node.discardReason,
    parentId: node.parentId,
    repositoryId: node.repositoryId,
    deliverable: node.deliverable,
    verify: parseNodeVerifyBlock(node),
  };
}

function parseNodeVerifyBlock(node: StoredNode) {
  if (node.verifyJson === null) {
    return null;
  }
  try {
    return parseVerifyBlock(node.verifyJson);
  } catch (error) {
    if (error instanceof VerifyBlockError) {
      Object.assign(error, { nodeId: node.id });
    }
    throw error;
  }
}

function edgeAttributes(edge: StoredEdge): GraphAttributes {
  return {
    relation: "depends-on",
    waivedAt: edge.waivedAt,
  };
}

export function showProjectGraph(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore; graph: Graph }>,
  input: Readonly<{ projectId: string }>,
): SerializedGraph {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ShowProjectGraphError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }

    const { nodes: storedNodes, edges: storedEdges } =
      dependencies.plan.readGraph(transaction, input.projectId);
    const revision = dependencies.plan.newestRevision(
      transaction,
      input.projectId,
    );

    const graphAttributes: GraphAttributes = {
      projectId: input.projectId,
      revision,
    };

    const serializeInput: GraphSerializeInput = {
      attributes: graphAttributes,
      nodes: storedNodes.map((node): SerializedGraphNode => ({
        key: node.id,
        attributes: nodeAttributes(node),
      })),
      edges: storedEdges.map((edge): SerializedGraphEdge => ({
        key: edge.id,
        source: edge.fromNode,
        target: edge.toNode,
        attributes: edgeAttributes(edge),
      })),
    };

    return dependencies.graph.serialize(serializeInput);
  });
}
