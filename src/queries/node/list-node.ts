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

export type NodeListFilter = Readonly<{
  project?: string;
  kind?: NodeKind;
  state?: NodeState;
  blockReason?: string;
  repository?: string;
}>;

export function listNodes(
  dependencies: ListNodeDependencies,
  input: NodeListFilter,
): readonly NodeListItem[] {
  return dependencies.storage.transact((transaction) => {
    const nodes = dependencies.plan.readAllNodes(transaction);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return nodes
      .filter((node) => {
        if (input.project !== undefined && node.projectId !== input.project) {
          return false;
        }
        if (input.kind !== undefined && node.kind !== input.kind) {
          return false;
        }
        if (input.state !== undefined && node.state !== input.state) {
          return false;
        }
        if (
          input.blockReason !== undefined &&
          node.blockReason !== input.blockReason
        ) {
          return false;
        }
        if (input.repository !== undefined) {
          if (node.kind === "initiative") return false;
          const repositoryId =
            node.kind === "objective"
              ? node.repositoryId
              : (byId.get(node.parentId ?? "")?.repositoryId ?? null);
          if (repositoryId !== input.repository) return false;
        }
        return true;
      })
      .map(toNodeListItem);
  });
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
