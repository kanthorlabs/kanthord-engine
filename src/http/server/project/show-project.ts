import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { ProjectView } from "../../../domain/project-view.ts";

export type ShowProjectHandlerDependencies = Readonly<{
  showProject: (input: Readonly<{ id: string }>) => ProjectView | null;
}>;

export function showProjectHandler(
  dependencies: ShowProjectHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    const view = dependencies.showProject({ id });
    if (view === null) {
      throw httpError("not-found", `no project ${id}`);
    }
    return { status: 200, body: view };
  };
}
