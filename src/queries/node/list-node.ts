import type { NodeKind, NodeState } from "../../domain/state.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";

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

export type ListNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
}>;

export function listNodes(
  dependencies: ListNodeDependencies,
  input: Readonly<Record<string, never>>,
): readonly NodeListItem[] {
  return dependencies.storage.transact((transaction) =>
    dependencies.plan.readAllNodes(transaction).map(toNodeListItem),
  );
}

function toNodeListItem(node: StoredNode): NodeListItem {
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
