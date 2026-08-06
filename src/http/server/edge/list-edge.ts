import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { EdgeView } from "../../../queries/edge/list-edge.ts";
import { toHttpError } from "./refusals.ts";

export type ListEdgeHandlerDependencies = Readonly<{
  listEdges: (input: Readonly<{ projectId: string }>) => readonly EdgeView[];
}>;

export function listEdgeHandler(
  dependencies: ListEdgeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    try {
      const edges = dependencies.listEdges({ projectId: id });
      return { status: 200, body: { edges } };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
