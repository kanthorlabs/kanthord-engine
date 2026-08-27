import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { projectRepositoriesRequest } from "../../contract/project.ts";
import type { ReplaceProjectRepositoriesInput } from "../../../commands/project/replace-project-repositories.ts";
import type { ProjectView } from "../../../domain/project-view.ts";
import { toHttpError } from "./refusals.ts";

export type ReplaceProjectRepositoriesHandlerDependencies = Readonly<{
  replaceProjectRepositories: (
    input: ReplaceProjectRepositoriesInput,
  ) => ProjectView;
}>;

export function replaceProjectRepositoriesHandler(
  dependencies: ReplaceProjectRepositoriesHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    const parsed = projectRepositoriesRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the project repositories body is invalid",
        parsed.error,
      );
    }
    try {
      const view = dependencies.replaceProjectRepositories({
        id,
        repositories: parsed.data.repositories,
        actor: context.actor.id,
      });
      return { kind: "json", status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
