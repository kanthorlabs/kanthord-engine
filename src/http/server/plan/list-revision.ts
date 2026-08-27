import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { RevisionEntry } from "../../../queries/plan/list-revision.ts";
import { ListRevisionError } from "../../../queries/plan/list-revision.ts";

export type ListRevisionHandlerDependencies = Readonly<{
  listRevisions: (
    input: Readonly<{ projectId: string }>,
  ) => readonly RevisionEntry[];
}>;

export function listRevisionHandler(
  dependencies: ListRevisionHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no project id in the request path");
    }
    try {
      const revisions = dependencies.listRevisions({ projectId: id });
      return { kind: "json", status: 200, body: { revisions } };
    } catch (error) {
      if (error instanceof ListRevisionError) {
        switch (error.refusal) {
          case "project-not-found":
            throw httpError("not-found", error.message);
        }
      }
      throw error;
    }
  };
}
