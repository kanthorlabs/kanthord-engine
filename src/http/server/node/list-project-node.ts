import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { NodeListItem } from "../../../domain/node-view.ts";
import { toHttpError } from "./refusals.ts";

export type ListProjectNodeHandlerDependencies = Readonly<{
  listProjectNodes: (
    input: Readonly<{ projectId: string }>,
  ) => readonly NodeListItem[];
}>;

export function listProjectNodeHandler(
  dependencies: ListProjectNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    try {
      const nodes = dependencies.listProjectNodes({ projectId: id });
      return { kind: "json", status: 200, body: { nodes } };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
