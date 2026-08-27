import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { ReadProjectStatusResult } from "../../../queries/project/read-project-status.ts";

export type ReadProjectStatusHandlerDependencies = Readonly<{
  readProjectStatus: (
    input: Readonly<{ id: string }>,
  ) => ReadProjectStatusResult | null;
}>;

export function readProjectStatusHandler(
  dependencies: ReadProjectStatusHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    const result = dependencies.readProjectStatus({ id });
    if (result === null) {
      throw httpError("not-found", `no project ${id}`);
    }
    return { kind: "json", status: 200, body: result };
  };
}
