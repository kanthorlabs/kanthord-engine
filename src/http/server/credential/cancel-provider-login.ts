import type { Handler } from "../app.ts";
import { invalidRequest } from "../invalid-request.ts";
import { providerLoginCancelRequest } from "../../contract/credential.ts";
import type { CancelProviderLoginInput } from "../../../commands/provider/cancel-provider-login.ts";
import { toHttpError } from "./refusals.ts";

export type CancelProviderLoginHandlerDependencies = Readonly<{
  cancelProviderLogin: (input: CancelProviderLoginInput) => Promise<void>;
}>;

export function cancelProviderLoginHandler(
  dependencies: CancelProviderLoginHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = providerLoginCancelRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the provider login cancellation body is invalid",
        parsed.error,
      );
    }
    try {
      await dependencies.cancelProviderLogin({ loginId: parsed.data.loginId });
      return { kind: "empty", status: 204 };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
