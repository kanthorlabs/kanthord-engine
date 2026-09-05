import type { HttpError } from "../../contract/errors.ts";
import { httpError } from "../../contract/errors.ts";
import { ImportPlanError } from "../../../commands/plan/import-plan.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof ImportPlanError) {
    switch (error.refusal) {
      case "project-not-found":
        return httpError("not-found", error.message);
      case "plan-invalid":
        return httpError("plan-invalid", error.message, {
          findings: details(error).findings,
        });
      case "choices-invalid":
        return httpError("choices-invalid", error.message, {
          findings: details(error).findings,
        });
      case "choices-stale":
        return httpError("choices-stale", error.message, details(error));
      case "choices-changed":
        return httpError("choices-changed", error.message, details(error));
      case "stale-revision":
        return httpError("stale-revision", error.message, details(error));
      case "idempotency-mismatch":
        return httpError("idempotency-mismatch", error.message, details(error));
      case "subtree-busy":
        return httpError("subtree-busy", error.message, details(error));
      case "documents-hash-mismatch":
        return httpError("invalid-request", error.message, {
          refusal: error.refusal,
        });
      case "choice-duplicate":
      case "choice-missing":
      case "choice-extra":
        return httpError("invalid-request", error.message, {
          refusal: error.refusal,
          ids: details(error).ids,
        });
    }
  }
  throw error;
}

function details(error: ImportPlanError): Readonly<Record<string, unknown>> {
  return (error.details ?? {}) as Readonly<Record<string, unknown>>;
}
