import type { Handler } from "../app.ts";
import { invalidRequest } from "../invalid-request.ts";
import { providerLoginStartRequest } from "../../contract/credential.ts";
import type {
  StartProviderLoginInput,
  StartProviderLoginResult,
} from "../../../commands/provider/start-provider-login.ts";
import { toHttpError } from "./refusals.ts";

export type StartProviderLoginHandlerDependencies = Readonly<{
  startProviderLogin: (
    input: StartProviderLoginInput,
  ) => Promise<StartProviderLoginResult>;
}>;

export function startProviderLoginHandler(
  dependencies: StartProviderLoginHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = providerLoginStartRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the provider login body is invalid",
        parsed.error,
      );
    }
    try {
      const result = await dependencies.startProviderLogin({
        provider: parsed.data.provider,
        answers: parsed.data.answers ?? {},
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
