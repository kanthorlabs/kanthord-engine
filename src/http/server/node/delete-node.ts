import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { nodeDeleteRequest } from "../../contract/graph.ts";
import type { DeleteNodeInput } from "../../../commands/node/delete-node.ts";
import type { DeleteNodeResult } from "../../../commands/node/delete-node.ts";
import { toHttpError } from "./refusals.ts";

export type DeleteNodeHandlerDependencies = Readonly<{
  deleteNode: (input: DeleteNodeInput) => DeleteNodeResult;
}>;

export function deleteNodeHandler(
  dependencies: DeleteNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeDeleteRequest.safeParse(context.body);
    if (!parsed.success) {
      throw httpError("invalid-request", "the node delete body is invalid");
    }
    try {
      const result = dependencies.deleteNode({
        id,
        fromRevision: parsed.data.fromRevision,
        actor: context.actor,
      });
      return { status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
