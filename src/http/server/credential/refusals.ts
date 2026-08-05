import { HttpError, httpError } from "../../contract/errors.ts";
import { PayloadError } from "../../../domain/provider-payload.ts";
import { RegisterProviderError } from "../../../commands/provider/register-provider.ts";

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
  throw error;
}
