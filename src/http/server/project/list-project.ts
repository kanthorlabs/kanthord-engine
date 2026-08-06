import type { Handler } from "../app.ts";
import type { ProjectView } from "../../../domain/project-view.ts";

export type ListProjectHandlerDependencies = Readonly<{
  listProjects: (
    input: Readonly<Record<string, never>>,
  ) => readonly ProjectView[];
}>;

export function listProjectHandler(
  dependencies: ListProjectHandlerDependencies,
): Handler {
  return async () => {
    const views = dependencies.listProjects({});
    return { status: 200, body: { projects: views } };
  };
}
