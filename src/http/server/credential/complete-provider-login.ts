import type { Handler } from "../app.ts";
import { invalidRequest } from "../invalid-request.ts";
import { providerLoginCompleteRequest } from "../../contract/credential.ts";
import type {
  CompleteProviderLoginInput,
  CompleteProviderLoginResult,
} from "../../../commands/provider/complete-provider-login.ts";
import { toHttpError } from "./refusals.ts";

export type CompleteProviderLoginHandlerDependencies = Readonly<{
  completeProviderLogin: (
    input: CompleteProviderLoginInput,
  ) => Promise<CompleteProviderLoginResult>;
}>;

export function completeProviderLoginHandler(
  dependencies: CompleteProviderLoginHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = providerLoginCompleteRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the provider login completion body is invalid",
        parsed.error,
      );
    }
    try {
      const result = await dependencies.completeProviderLogin({
        loginId: parsed.data.loginId,
        ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
