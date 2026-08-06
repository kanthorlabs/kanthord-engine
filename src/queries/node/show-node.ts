import type { NodeKind, NodeState } from "../../domain/state.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";

export type NodeView = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  title: string;
  state: NodeState;
  blockReason: string | null;
  discardReason: string | null;
  parentId: string | null;
  dependencies: readonly string[];
  instructionBlob: string;
  acceptanceBlob: string | null;
  worker: string | null;
  repositoryId: string | null;
  revision: string;
  updatedAt: number;
}>;

export type ShowNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
}>;

export function showNode(
  dependencies: ShowNodeDependencies,
  input: Readonly<{ id: string }>,
): NodeView | null {
  return dependencies.storage.transact((transaction) =>
    dependencies.plan.readNode(transaction, input.id),
  );
}
