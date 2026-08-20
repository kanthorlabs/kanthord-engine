import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import { toNodeListItem, type NodeListItem } from "../../domain/node-view.ts";

export type ListProjectNodeRefusal = "project-not-found";

export class ListProjectNodeError extends Error {
  readonly refusal: ListProjectNodeRefusal;

  constructor(refusal: ListProjectNodeRefusal, message: string) {
    super(message);
    this.name = "ListProjectNodeError";
    this.refusal = refusal;
  }
}

export function listProjectNodes(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<{ projectId: string }>,
): readonly NodeListItem[] {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ListProjectNodeError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    const nodes = dependencies.plan.readGraph(
      transaction,
      input.projectId,
    ).nodes;
    return nodes.map(toNodeListItem);
  });
}
