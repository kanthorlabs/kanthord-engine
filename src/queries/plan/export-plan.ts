import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import { RevisionError, type Revision } from "../../services/revision/index.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";

export type ExportPlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  revision: Revision;
}>;

export type ExportPlanResult = Readonly<{
  revision: string | null;
  documents: readonly RenderedDocument[];
}>;

export type ExportPlanRefusal = "project-not-found" | "repository-unknown";

export class ExportPlanError extends Error {
  readonly refusal: ExportPlanRefusal;

  constructor(refusal: ExportPlanRefusal, message: string) {
    super(message);
    this.name = "ExportPlanError";
    this.refusal = refusal;
  }
}

export function exportPlan(
  dependencies: ExportPlanDependencies,
  input: Readonly<{ projectId: string }>,
): ExportPlanResult {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ExportPlanError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    const revision = dependencies.plan.newestRevision(
      transaction,
      input.projectId,
    );
    if (revision === null) {
      return { revision: null, documents: [] };
    }
    const { nodes } = dependencies.plan.readGraph(transaction, input.projectId);
    try {
      return {
        revision,
        documents: dependencies.revision.render(transaction, { nodes }),
      };
    } catch (error) {
      if (error instanceof RevisionError) {
        throw new ExportPlanError(error.refusal, error.message);
      }
      throw error;
    }
  });
}
