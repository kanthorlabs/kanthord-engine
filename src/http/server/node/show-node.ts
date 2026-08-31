import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { NodeView } from "../../../queries/node/show-node.ts";
import { toHttpError } from "./refusals.ts";

export type ShowNodeHandlerDependencies = Readonly<{
  showNode: (input: Readonly<{ id: string }>) => NodeView | null;
}>;

export function showNodeHandler(
  dependencies: ShowNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    try {
      const view = dependencies.showNode({ id });
      if (view === null) {
        throw httpError("not-found", `no node ${id}`);
      }
      return { kind: "json", status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
