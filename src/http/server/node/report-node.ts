import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { nodeReportRequest } from "../../contract/outcome.ts";
import type {
  ReportOutcomeInput,
  ReportOutcomeResult,
} from "../../../commands/outcome/report-outcome.ts";
import { toHttpError } from "./refusals.ts";

export type ReportNodeHandlerDependencies = Readonly<{
  reportOutcome: (input: ReportOutcomeInput) => ReportOutcomeResult;
}>;

export function reportNodeHandler(
  dependencies: ReportNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeReportRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the report body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.reportOutcome({
        nodeId: id,
        actorId: context.actor.id,
        actorKind: context.actor.kind,
        body: parsed.data,
      });
      return { status: 200, body: result };
    } catch (error) {
      const body = parsed.data;
      throw toHttpError(
        error,
        body.report === "closed"
          ? undefined
          : { subject: id, fence: body.fence },
      );
    }
  };
}
