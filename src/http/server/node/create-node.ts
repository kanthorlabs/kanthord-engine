import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { nodeCreateRequest } from "../../contract/graph.ts";
import type { CreateNodeInput } from "../../../commands/node/create-node.ts";
import type { CreateNodeResult } from "../../../commands/node/create-node.ts";
import { toHttpError } from "./refusals.ts";

export type CreateNodeHandlerDependencies = Readonly<{
  createNode: (input: CreateNodeInput) => CreateNodeResult;
}>;

export function createNodeHandler(
  dependencies: CreateNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    const parsed = nodeCreateRequest.safeParse(context.body);
    if (!parsed.success) {
      throw httpError("invalid-request", "the node create body is invalid");
    }
    try {
      const result = dependencies.createNode({
        projectId: id,
        fromRevision: parsed.data.fromRevision,
        node: parsed.data.node,
        actor: context.actor,
      });
      return { status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
