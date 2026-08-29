import { HttpError, httpError } from "../../contract/errors.ts";
import { PayloadError } from "../../../domain/provider-payload.ts";
import { RegisterProviderError } from "../../../commands/provider/register-provider.ts";
import { SetDefaultProviderError } from "../../../commands/provider/set-default-provider.ts";
import { RenameProviderError } from "../../../commands/provider/rename-provider.ts";
import { RemoveProviderError } from "../../../commands/provider/remove-provider.ts";
import { InspectProviderError } from "../../../queries/provider/inspect-provider.ts";
import { VerifyProviderError } from "../../../queries/provider/verify-provider.ts";

export function toHttpError(error: unknown): HttpError {
  if (error instanceof PayloadError) {
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
      detail: error.detail,
    });
  }
  if (error instanceof RegisterProviderError) {
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
    });
  }
  if (error instanceof SetDefaultProviderError) {
    if (error.refusal === "not-found") {
      return httpError("not-found", error.message);
    }
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
    });
  }
  if (error instanceof RenameProviderError) {
    if (error.refusal === "not-found") {
      return httpError("not-found", error.message);
    }
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
    });
  }
  if (error instanceof InspectProviderError) {
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
      detail: error.detail,
    });
  }
  if (error instanceof RemoveProviderError) {
    if (error.refusal === "not-found") {
      return httpError("not-found", error.message);
    }
    return httpError("binding-in-use", error.message, {
      blockers: error.blockers,
    });
  }
  if (error instanceof VerifyProviderError) {
    if (error.refusal === "not-found") {
      return httpError("not-found", error.message);
    }
    if (error.refusal === "service-unavailable") {
      return httpError("service-unavailable", error.message);
    }
    return httpError("invalid-request", error.message, {
      refusal: error.refusal,
    });
  }
  throw error;
}
