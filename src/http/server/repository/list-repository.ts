import type { Handler } from "../app.ts";
import type { RepositoryView } from "../../../queries/repository/show-repository.ts";

export type ListRepositoryHandlerDependencies = Readonly<{
  listRepositories: (
    input: Readonly<{ state?: "ready" | "needs-reconcile" }>,
  ) => Promise<readonly RepositoryView[]>;
}>;

export function listRepositoryHandler(
  dependencies: ListRepositoryHandlerDependencies,
): Handler {
  return async () => {
    const views = await dependencies.listRepositories({});
    return { kind: "json", status: 200, body: { repositories: views } };
  };
}
