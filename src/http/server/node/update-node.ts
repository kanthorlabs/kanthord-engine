import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { nodeUpdateRequest } from "../../contract/graph.ts";
import type { UpdateNodeInput } from "../../../commands/node/update-node.ts";
import type { UpdateNodeResult } from "../../../commands/node/update-node.ts";
import { toHttpError } from "./refusals.ts";

export type UpdateNodeHandlerDependencies = Readonly<{
  updateNode: (input: UpdateNodeInput) => UpdateNodeResult;
}>;

export function updateNodeHandler(
  dependencies: UpdateNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeUpdateRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the node update body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.updateNode({
        id,
        fromRevision: parsed.data.fromRevision,
        node: parsed.data.node,
        actor: context.actor,
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
