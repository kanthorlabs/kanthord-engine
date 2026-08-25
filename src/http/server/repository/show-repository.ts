import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { RepositoryView } from "../../../queries/repository/show-repository.ts";

export type ShowRepositoryHandlerDependencies = Readonly<{
  showRepository: (
    input: Readonly<{ id: string }>,
  ) => Promise<RepositoryView | null>;
}>;

export function showRepositoryHandler(
  dependencies: ShowRepositoryHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no repository id in the request path");
    }
    const view = await dependencies.showRepository({ id });
    if (view === null) {
      throw httpError("not-found", `no repository ${id}`);
    }
    return { kind: "json", status: 200, body: view };
  };
}
