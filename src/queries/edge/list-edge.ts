import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";

export type EdgeView = Readonly<{
  id: string;
  fromNode: string;
  toNode: string;
  waivedAt: number | null;
}>;

export type ListEdgeRefusal = "project-not-found";

export class ListEdgeError extends Error {
  readonly refusal: ListEdgeRefusal;

  constructor(refusal: ListEdgeRefusal, message: string) {
    super(message);
    this.name = "ListEdgeError";
    this.refusal = refusal;
  }
}

export function listEdges(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<{ projectId: string }>,
): readonly EdgeView[] {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ListEdgeError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    return dependencies.plan.readGraph(transaction, input.projectId).edges;
  });
}
