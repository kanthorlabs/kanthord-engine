import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { ProjectView } from "../../domain/project-view.ts";

export type CreateProjectDependencies = Readonly<{
  storage: Storage;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
}>;

export type CreateProjectInput = Readonly<{ name: string; actor: string }>;

export type CreateProjectRefusal = "name-taken";

export class CreateProjectError extends Error {
  readonly refusal: CreateProjectRefusal;

  constructor(refusal: CreateProjectRefusal, message: string) {
    super(message);
    this.name = "CreateProjectError";
    this.refusal = refusal;
  }
}

export function createProject(
  dependencies: CreateProjectDependencies,
  input: CreateProjectInput,
): ProjectView {
  const id = dependencies.ids.mint("project");
  const updatedAt = dependencies.clock.now();
  dependencies.storage.transact((transaction) => {
    const existing = transaction.get("SELECT id FROM project WHERE name = ?", [
      input.name,
    ]);
    if (existing !== undefined) {
      throw new CreateProjectError(
        "name-taken",
        `a project named ${input.name} is already registered`,
      );
    }
    transaction.run(
      "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, input.name, null, null, updatedAt],
    );
    dependencies.events.append(transaction, {
      subjectKind: "project",
      subjectId: id,
      type: "project.created",
      actorKind: "human",
      actorId: input.actor,
      payload: { name: input.name },
    });
  });
  return {
    id,
    name: input.name,
    repositories: [],
    updatedAt,
  };
}
