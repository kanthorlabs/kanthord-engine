import type { Storage } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { ProjectView } from "../../domain/project-view.ts";

export type ReplaceProjectRepositoriesDependencies = Readonly<{
  storage: Storage;
  clock: Clock;
  events: EventLog;
}>;

export type ReplaceProjectRepositoriesInput = Readonly<{
  id: string;
  repositories: readonly string[];
  actor: string;
}>;

export type ReplaceProjectRepositoriesRefusal =
  | "project-not-found"
  | "repository-not-found"
  | "too-many-repositories"
  | "duplicate-repository";

export class ReplaceProjectRepositoriesError extends Error {
  readonly refusal: ReplaceProjectRepositoriesRefusal;

  constructor(refusal: ReplaceProjectRepositoriesRefusal, message: string) {
    super(message);
    this.name = "ReplaceProjectRepositoriesError";
    this.refusal = refusal;
  }
}

export function replaceProjectRepositories(
  dependencies: ReplaceProjectRepositoriesDependencies,
  input: ReplaceProjectRepositoriesInput,
): ProjectView {
  return dependencies.storage.transact((transaction) => {
    const row = transaction.get(
      "SELECT id, name, updated_at FROM project WHERE id = ?",
      [input.id],
    ) as Readonly<{ id: string; name: string; updated_at: number }> | undefined;
    if (row === undefined) {
      throw new ReplaceProjectRepositoriesError(
        "project-not-found",
        `no project ${input.id}`,
      );
    }
    if (input.repositories.length > 1) {
      throw new ReplaceProjectRepositoriesError(
        "too-many-repositories",
        "the MVP binds at most one repository per project",
      );
    }
    const unique = new Set(input.repositories);
    if (unique.size !== input.repositories.length) {
      throw new ReplaceProjectRepositoriesError(
        "duplicate-repository",
        "a repository id appears more than once",
      );
    }
    for (const repositoryId of input.repositories) {
      const repository = transaction.get(
        "SELECT id FROM repository WHERE id = ?",
        [repositoryId],
      );
      if (repository === undefined) {
        throw new ReplaceProjectRepositoriesError(
          "repository-not-found",
          `no repository ${repositoryId}`,
        );
      }
    }
    transaction.run(
      "DELETE FROM project_binding WHERE project_id = ? AND kind = 'git'",
      [input.id],
    );
    for (const repositoryId of input.repositories) {
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'git', ?, ?)",
        [input.id, repositoryId, dependencies.clock.now()],
      );
    }
    dependencies.events.append(transaction, {
      subjectKind: "project",
      subjectId: input.id,
      type: "project.repositoriesReplaced",
      actorKind: "human",
      actorId: input.actor,
      payload: { repositories: input.repositories },
    });
    return {
      id: row.id,
      name: row.name,
      repositories: input.repositories,
      updatedAt: row.updated_at,
    };
  });
}
