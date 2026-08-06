import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore, RevisionRecord } from "../../services/plan/index.ts";

export type RevisionEntry = RevisionRecord;

export type ListRevisionRefusal = "project-not-found";

export class ListRevisionError extends Error {
  readonly refusal: ListRevisionRefusal;

  constructor(refusal: ListRevisionRefusal, message: string) {
    super(message);
    this.name = "ListRevisionError";
    this.refusal = refusal;
  }
}

export function listRevisions(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<{ projectId: string }>,
): readonly RevisionEntry[] {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ListRevisionError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    return dependencies.plan.listRevisions(transaction, input.projectId);
  });
}
