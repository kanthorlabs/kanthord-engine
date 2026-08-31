import { HttpError, httpError } from "../../contract/errors.ts";
import { CreateProjectError } from "../../../commands/project/create-project.ts";
import { ReplaceProjectRepositoriesError } from "../../../commands/project/replace-project-repositories.ts";
import { ShowProjectGraphError } from "../../../queries/project/show-project-graph.ts";
import { VerifyBlockError } from "../../../domain/verify-block.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof CreateProjectError) {
    switch (error.refusal) {
      case "name-taken":
        return httpError("invalid-request", error.message, {
          refusal: "name-taken",
        });
    }
  }
  if (error instanceof ReplaceProjectRepositoriesError) {
    switch (error.refusal) {
      case "project-not-found":
      case "repository-not-found":
        return httpError("not-found", error.message);
      case "too-many-repositories":
        return httpError("invalid-request", error.message, {
          refusal: "too-many-repositories",
        });
      case "duplicate-repository":
        return httpError("invalid-request", error.message, {
          refusal: "duplicate-repository",
        });
      case "binding-in-use":
        return httpError("binding-in-use", error.message, details(error));
    }
  }
  if (error instanceof ShowProjectGraphError) {
    switch (error.refusal) {
      case "project-not-found":
        return httpError("not-found", error.message);
    }
  }
  if (
    error instanceof VerifyBlockError &&
    "nodeId" in error &&
    typeof error.nodeId === "string"
  ) {
    return httpError("internal-error", error.nodeId);
  }
  throw error;
}

function details(
  error: ReplaceProjectRepositoriesError,
): Readonly<Record<string, unknown>> {
  return (error.details ?? {}) as Readonly<Record<string, unknown>>;
}
