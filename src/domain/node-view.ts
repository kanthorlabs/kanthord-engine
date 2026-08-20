import type { NodeKind, NodeState } from "./state.ts";
import type { StoredNode } from "./plan-graph.ts";

export type NodeListItem = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  title: string;
  state: NodeState;
  blockReason: string | null;
  discardReason: string | null;
  parentId: string | null;
  dependencies: readonly string[];
}>;

export function toNodeListItem(node: StoredNode): NodeListItem {
  return {
    id: node.id,
    projectId: node.projectId,
    kind: node.kind,
    title: node.title,
    state: node.state,
    blockReason: node.blockReason,
    discardReason: node.discardReason,
    parentId: node.parentId,
    dependencies: node.dependencies,
  };
}
