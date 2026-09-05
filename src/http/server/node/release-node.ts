import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { nodeReleaseRequest } from "../../contract/execution.ts";
import type { ReleaseNodeInput } from "../../../commands/node/release-node.ts";
import { toHttpError } from "./refusals.ts";

export type ReleaseNodeHandlerDependencies = Readonly<{
  releaseNode: (input: ReleaseNodeInput) => unknown;
}>;

export function releaseNodeHandler(
  dependencies: ReleaseNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeReleaseRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the release body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.releaseNode({
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
