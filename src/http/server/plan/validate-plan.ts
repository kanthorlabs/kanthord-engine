import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { planValidateRequest } from "../../contract/graph.ts";
import type {
  ValidatePlanInput,
  ValidatePlanResult,
} from "../../../queries/plan/validate-plan.ts";
import { ValidatePlanError } from "../../../queries/plan/validate-plan.ts";

export type ValidatePlanHandlerDependencies = Readonly<{
  validatePlan: (input: ValidatePlanInput) => ValidatePlanResult;
}>;

export function validatePlanHandler(
  dependencies: ValidatePlanHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    const parsed = planValidateRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the plan validation body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.validatePlan({
        projectId: id,
        fromRevision: parsed.data.fromRevision,
        documents: parsed.data.documents,
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      if (error instanceof ValidatePlanError) {
        switch (error.refusal) {
          case "project-not-found":
            throw httpError("not-found", error.message);
        }
      }
      throw error;
    }
  };
}
