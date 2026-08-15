import type { HttpError } from "../../contract/errors.ts";
import { httpError } from "../../contract/errors.ts";
import { NodeWriteError } from "../../../commands/node/refusal.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof NodeWriteError) {
    switch (error.refusal) {
      case "project-not-found":
      case "node-not-found":
        return httpError("not-found", error.message);
      case "kind-mismatch":
        return httpError("invalid-request", error.message, details(error));
      case "stale-revision":
        return httpError("stale-revision", error.message, details(error));
      case "plan-invalid":
        return httpError("plan-invalid", error.message, details(error));
      case "illegal-transition":
        return httpError("illegal-transition", error.message, details(error));
      case "binding-in-use":
        return httpError("binding-in-use", error.message, details(error));
    }
  }
  throw error;
}

function details(error: NodeWriteError): Readonly<Record<string, unknown>> {
  return (error.details ?? {}) as Readonly<Record<string, unknown>>;
}
