import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { SerializedGraph } from "../../../queries/project/show-project-graph.ts";
import { toHttpError } from "./refusals.ts";

export type ShowProjectGraphHandlerDependencies = Readonly<{
  showProjectGraph: (input: Readonly<{ projectId: string }>) => SerializedGraph;
}>;

export function showProjectGraphHandler(
  dependencies: ShowProjectGraphHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    try {
      const graph = dependencies.showProjectGraph({ projectId: id });
      return { kind: "json", status: 200, body: graph };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
