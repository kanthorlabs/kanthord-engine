import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { projectCreateRequest } from "../../contract/project.ts";
import type { CreateProjectInput } from "../../../commands/project/create-project.ts";
import type { ProjectView } from "../../../domain/project-view.ts";
import { toHttpError } from "./refusals.ts";

export type CreateProjectHandlerDependencies = Readonly<{
  createProject: (input: CreateProjectInput) => ProjectView;
  actor: string;
}>;

export function createProjectHandler(
  dependencies: CreateProjectHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = projectCreateRequest.safeParse(context.body);
    if (!parsed.success) {
      throw httpError("invalid-request", "the project create body is invalid");
    }
    try {
      const view = dependencies.createProject({
        name: parsed.data.name,
        actor: dependencies.actor,
      });
      return { status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
