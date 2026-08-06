import type { Storage } from "../../services/storage/index.ts";
import type { ProjectView } from "../../domain/project-view.ts";

export type ShowProjectDependencies = Readonly<{ storage: Storage }>;

export function showProject(
  dependencies: ShowProjectDependencies,
  input: Readonly<{ id: string }>,
): ProjectView | null {
  return dependencies.storage.transact((transaction) => {
    const row = transaction.get(
      "SELECT id, name, updated_at FROM project WHERE id = ?",
      [input.id],
    ) as Readonly<{ id: string; name: string; updated_at: number }> | undefined;
    if (row === undefined) {
      return null;
    }
    const bindings = transaction.all(
      "SELECT target_id FROM project_binding WHERE project_id = ? AND kind = 'git' ORDER BY target_id ASC",
      [input.id],
    ) as readonly Readonly<{ target_id: string }>[];
    return {
      id: row.id,
      name: row.name,
      repositories: bindings.map((binding) => binding.target_id),
      updatedAt: row.updated_at,
    };
  });
}
