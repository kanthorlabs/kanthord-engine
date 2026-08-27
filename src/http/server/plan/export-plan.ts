import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { ExportPlanResult } from "../../../queries/plan/export-plan.ts";
import { ExportPlanError } from "../../../queries/plan/export-plan.ts";

export type ExportPlanHandlerDependencies = Readonly<{
  exportPlan: (input: Readonly<{ projectId: string }>) => ExportPlanResult;
}>;

export function exportPlanHandler(
  dependencies: ExportPlanHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    try {
      const result = dependencies.exportPlan({ projectId: id });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      if (error instanceof ExportPlanError) {
        switch (error.refusal) {
          case "project-not-found":
            throw httpError("not-found", error.message);
        }
      }
      throw error;
    }
  };
}
