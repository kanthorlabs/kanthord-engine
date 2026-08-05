import { HttpError, httpError } from "../../contract/errors.ts";
import {
  GitError,
  InspectRepositoryError,
} from "../../../queries/repository/inspect-repository.ts";
import { RegisterRepositoryError } from "../../../commands/repository/register-repository.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof RegisterRepositoryError) {
    switch (error.refusal) {
      case "name-taken":
        return httpError("invalid-request", error.message, {
          refusal: "name-taken",
        });
      case "credential-not-found":
        return httpError("not-found", error.message);
      case "credential-wrong-kind":
        return httpError("invalid-request", error.message, {
          refusal: "credential-wrong-kind",
        });
      case "credential-unreadable":
        return httpError("invalid-request", error.message, {
          refusal: "credential-unreadable",
        });
      case "host-fingerprint-required":
        return httpError("invalid-request", error.message, {
          refusal: "host-fingerprint-required",
        });
      case "host-fingerprint-forbidden":
        return httpError("invalid-request", error.message, {
          refusal: "host-fingerprint-forbidden",
        });
      case "host-key-mismatch":
        return httpError("host-key-mismatch", error.message, {
          presented: error.presented,
          confirmed: error.confirmed,
        });
      case "host-key-unavailable":
        return httpError("invalid-request", error.message, {
          refusal: "host-key-unavailable",
          detail: error.detail,
        });
      case "outside-writer":
        return httpError("stale-revision", error.message, {
          expectedOid: error.expectedOid,
          observedOid: error.observedOid,
        });
    }
  }
  if (error instanceof GitError) {
    switch (error.failure) {
      case "url-refused":
        return httpError("invalid-request", error.message, {
          refusal: "url-refused",
        });
      case "auth-failed":
        return httpError("credential-rejected", error.message, {
          failure: "auth-failed",
        });
      case "permission-denied":
        return httpError("credential-rejected", error.message, {
          failure: "permission-denied",
        });
      case "host-key-mismatch":
        return httpError("host-key-mismatch", error.message, {
          failure: "host-key-mismatch",
        });
    }
  }
  if (error instanceof InspectRepositoryError) {
    switch (error.refusal) {
      case "credential-not-found":
        return httpError("not-found", error.message);
      case "credential-wrong-kind":
        return httpError("invalid-request", error.message, {
          refusal: "credential-wrong-kind",
        });
      case "credential-unreadable":
        return httpError("invalid-request", error.message, {
          refusal: "credential-unreadable",
        });
      case "host-key-unavailable":
        return httpError("invalid-request", error.message, {
          refusal: "host-key-unavailable",
          detail: error.detail,
        });
    }
  }
  throw error;
}
