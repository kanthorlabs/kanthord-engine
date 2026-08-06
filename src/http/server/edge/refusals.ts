import type { HttpError } from "../../contract/errors.ts";
import { httpError } from "../../contract/errors.ts";
import { ListEdgeError } from "../../../queries/edge/list-edge.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof ListEdgeError) {
    switch (error.refusal) {
      case "project-not-found":
        return httpError("not-found", error.message);
    }
  }
  throw error;
}
