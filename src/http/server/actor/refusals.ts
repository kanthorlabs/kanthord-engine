import { HttpError, httpError } from "../../contract/errors.ts";
import { ActorCommandError } from "../../../domain/actor-command-error.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof ActorCommandError) {
    if (error.refusal === "not-found") {
      return httpError("not-found", error.message);
    }
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
    });
  }
  throw error;
}
