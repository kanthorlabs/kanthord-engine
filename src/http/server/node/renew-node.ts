import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { nodeRenewRequest } from "../../contract/execution.ts";
import type { RenewRunInput } from "../../../commands/run/renew-run.ts";
import { toHttpError } from "./refusals.ts";

export type RenewNodeHandlerDependencies = Readonly<{
  renewRun: (input: RenewRunInput) => unknown;
}>;

export function renewNodeHandler(
  dependencies: RenewNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeRenewRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the renew body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.renewRun({
        nodeId: id,
        fence: parsed.data.fence,
        runId: parsed.data.runId,
        runFence: parsed.data.runFence,
        actorId: context.actor.id,
        actorKind: context.actor.kind,
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error, { subject: id, fence: parsed.data.fence });
    }
  };
}
