import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { providerRegisterRequest } from "../../contract/credential.ts";
import type { ProviderView } from "../../../domain/provider-view.ts";
import type { RegisterProviderInput } from "../../../commands/provider/register-provider.ts";
import { toHttpError } from "./refusals.ts";

export type RegisterProviderHandlerDependencies = Readonly<{
  registerProvider: (input: RegisterProviderInput) => ProviderView;
}>;

export function registerProviderHandler(
  dependencies: RegisterProviderHandlerDependencies,
): Handler {
  return (context) => {
    const parsed = providerRegisterRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the provider registration body is invalid",
        parsed.error,
      );
    }
    try {
      const view = dependencies.registerProvider({
        name: parsed.data.name,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
        actor: context.actor.id,
      });
      return { status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
