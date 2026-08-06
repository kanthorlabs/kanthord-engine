import type { Storage } from "../../services/storage/index.ts";
import type { ProjectView } from "../../domain/project-view.ts";

export type ListProjectDependencies = Readonly<{ storage: Storage }>;

export function listProjects(
  dependencies: ListProjectDependencies,
  input: Readonly<Record<string, never>>,
): readonly ProjectView[] {
  return dependencies.storage.transact((transaction) => {
    const rows = transaction.all(
      "SELECT id, name, updated_at FROM project ORDER BY id ASC",
    ) as readonly Readonly<{ id: string; name: string; updated_at: number }>[];
    return rows.map((row) => {
      const bindings = transaction.all(
        "SELECT target_id FROM project_binding WHERE project_id = ? AND kind = 'git' ORDER BY target_id ASC",
        [row.id],
      ) as readonly Readonly<{ target_id: string }>[];
      return {
        id: row.id,
        name: row.name,
        repositories: bindings.map((binding) => binding.target_id),
        updatedAt: row.updated_at,
      };
    });
  });
}
