import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { planImportRequest } from "../../contract/graph.ts";
import type { ImportPlanInput } from "../../../commands/plan/import-plan.ts";
import type { ImportPlanResult } from "../../../commands/plan/import-plan.ts";
import { toHttpError } from "./refusals.ts";

export type ImportPlanHandlerDependencies = Readonly<{
  importPlan: (input: ImportPlanInput) => ImportPlanResult;
}>;

export function importPlanHandler(
  dependencies: ImportPlanHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    const parsed = planImportRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the plan import body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.importPlan({
        projectId: id,
        fromRevision: parsed.data.fromRevision,
        importId: parsed.data.importId,
        documents: parsed.data.documents,
        choices: parsed.data.choices,
        validatedRevision: parsed.data.validatedRevision,
        documentsHash: parsed.data.documentsHash,
        actor: context.actor.id,
      });
      const { retried, ...body } = result;
      void retried;
      return { kind: "json", status: 200, body };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
